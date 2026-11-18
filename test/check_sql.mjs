// 用 PGlite（在 Node 裡跑的真實 Postgres）驗證 supabase/migrations 的 SQL：語法、約束、密碼函式、RLS、重跑不出錯。
// PGlite 不裝進專案（避免 node_modules 進雲端硬碟），先裝到暫存資料夾：
//   npm install --prefix "%TEMP%\contest-pglite" @electric-sql/pglite@0.4.6
// 再執行（PowerShell）：
//   $env:PGLITE_DIR="$env:TEMP\contest-pglite"; node test/check_sql.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.env.PGLITE_DIR;
if (!dir) { console.error('請先設定 PGLITE_DIR（見檔案開頭說明）'); process.exit(2); }
const base = path.join(dir, 'node_modules', '@electric-sql', 'pglite', 'dist');
const { PGlite } = await import(pathToFileURL(path.join(base, 'index.js')).href);
const { pgcrypto } = await import(pathToFileURL(path.join(base, 'contrib', 'pgcrypto.js')).href);

const migDir = new URL('../supabase/migrations/', import.meta.url);
const sql = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort()
  .map(f => fs.readFileSync(new URL(f, migDir), 'utf8')).join('\n');
const db = new PGlite({ extensions: { pgcrypto } });
// 模擬 Supabase 環境：角色與 extensions schema
await db.exec(`create role anon; create role authenticated; create role service_role; create schema extensions;`);

let pass = 0, failN = 0;
const ok = (name) => { pass++; console.log('  ✓', name); };
const bad = (name, e) => { failN++; console.log('  ✗', name, '→', e); };
async function expectOk(name, q, params) { try { const r = await db.query(q, params); ok(name); return r; } catch (e) { bad(name, e.message); } }
async function expectFail(name, q, params, re) {
  try { await db.query(q, params); bad(name, '應該失敗卻成功'); }
  catch (e) { if (re && !re.test(e.message)) bad(name, '錯誤訊息不符：' + e.message); else ok(name + '（' + e.message.slice(0, 40) + '）'); }
}

await db.exec(sql); ok('migration 執行成功');
await db.exec(sql); ok('migration 重跑一次也成功（冪等）');

const cid = (await db.query(`select create_competition('測試競賽','admin01','主辦','password123',5) as id`)).rows[0].id;
ok('create_competition 建立競賽');
const items = (await db.query(`select sum(max_score)::int s, count(*)::int n from rubric_items ri join competitions c on c.rubric_id = ri.rubric_id where c.id = $1`, [cid])).rows[0];
items.s === 100 && items.n === 4 ? ok('預設評分表 4 項、總分 100') : bad('預設評分表', JSON.stringify(items));

const good = (await db.query(`select check_password('admin01','password123') id`)).rows[0].id;
good ? ok('正確密碼回傳帳號 id') : bad('正確密碼', 'null');
const wrong = (await db.query(`select check_password('admin01','nope') id`)).rows[0].id;
wrong === null ? ok('錯誤密碼回傳 null') : bad('錯誤密碼', wrong);
const hash = (await db.query(`select password_hash from accounts where login_id='admin01'`)).rows[0].password_hash;
hash.startsWith('$2') && !hash.includes('password123') ? ok('密碼以 bcrypt 雜湊儲存') : bad('雜湊', hash);
await expectFail('密碼少於 8 個字被拒', `select set_password('admin01','short')`, [], /至少 8/);
await expectFail('不存在的帳號不能設密碼', `select set_password('nobody','password123')`, [], /找不到/);
await db.query(`update accounts set active=false where login_id='admin01'`);
(await db.query(`select check_password('admin01','password123') id`)).rows[0].id === null ? ok('停用的帳號無法登入') : bad('停用帳號', '仍可登入');
await db.query(`update accounts set active=true where login_id='admin01'`);

await expectFail('評審人數只能 3 或 5', `insert into competitions(name, judge_count) values('x', 4)`);
await expectFail('只能有一個 active 競賽', `insert into competitions(name, active) values('x', true)`);
await expectFail('帳號格式錯誤被拒', `insert into accounts(competition_id, login_id, display_name, role) values($1,'Judge 01','x','judge')`, [cid]);
await expectFail('login_id 全系統唯一', `insert into accounts(competition_id, login_id, display_name, role) values($1,'admin01','x','admin')`, [cid]);

const j = [];
for (let i = 1; i <= 5; i++) j.push((await db.query(`insert into accounts(competition_id, login_id, display_name, role) values($1,$2,$3,'judge') returning id`, [cid, 'judge0' + i, '評審' + i])).rows[0].id);
await expectOk('指派評審席位 1', `insert into judge_slots(competition_id, slot_no, account_id) values($1,1,$2)`, [cid, j[0]]);
await expectFail('同一評審不能坐兩個席位', `insert into judge_slots(competition_id, slot_no, account_id) values($1,2,$2)`, [cid, j[0]]);
await expectFail('席位編號 1～5', `insert into judge_slots(competition_id, slot_no, account_id) values($1,6,$2)`, [cid, j[1]]);

const tid = (await db.query(`insert into teams(competition_id, code, name) values($1,'team01','第一組') returning id`, [cid])).rows[0].id;
await expectFail('組別代碼格式 teamNN', `insert into teams(competition_id, code) values($1,'t1')`, [cid]);
const sha = 'a'.repeat(64);
const vid = (await db.query(`insert into video_versions(competition_id, team_id, version_no, source_filename, source_sha256, source_size, check_ok, playback_path)
  values($1,$2,1,'team01_v1.mov',$3,100,true,'videos/team01_v1.mp4') returning id`, [cid, tid, sha])).rows[0].id;
ok('建立影片版本');
await expectFail('同一支原檔（sha256）不能建兩個版本', `insert into video_versions(competition_id, team_id, version_no, source_filename, source_sha256, source_size, check_ok)
  values($1,$2,2,'x.mov',$3,100,false)`, [cid, tid, sha]);
await expectFail('檢查通過的版本必須有播放檔', `insert into video_versions(competition_id, team_id, version_no, source_filename, source_sha256, source_size, check_ok)
  values($1,$2,3,'x.mov',$3,100,true)`, [cid, tid, 'b'.repeat(64)]);
const cid2 = (await db.query(`insert into competitions(name) values('別的競賽') returning id`)).rows[0].id;
await expectFail('影片版本的組別必須屬於同一競賽', `insert into video_versions(competition_id, team_id, version_no, source_filename, source_sha256, source_size, check_ok)
  values($1,$2,9,'x.mov',$3,100,false)`, [cid2, tid, 'c'.repeat(64)]);

await expectFail('退回補件必須填原因', `insert into reviews(version_id, status) values($1,'resubmit')`, [vid]);
await expectOk('審查通過不必填原因', `insert into reviews(version_id, status) values($1,'pass')`, [vid]);
await expectOk('改判新增一筆（只增不改）', `insert into reviews(version_id, status, reason) values($1,'fail','有剪接')`, [vid]);

await expectOk('建立評分（暫存）', `insert into scores(competition_id, team_id, version_id, slot_no, account_id) values($1,$2,$3,1,$4)`, [cid, tid, vid, j[0]]);
await expectFail('同一作品同一席位只能有一份評分', `insert into scores(competition_id, team_id, version_id, slot_no, account_id) values($1,$2,$3,1,$4)`, [cid, tid, vid, j[1]]);
await expectFail('正式送出必須有總分與送出時間', `update scores set status='submitted' where team_id=$1`, [tid]);
await expectFail('總分不能超過 100', `update scores set total=101 where team_id=$1`, [tid]);

await expectOk('公布', `insert into publications(competition_id, snapshot) values($1,'{}')`, [cid]);
await expectFail('同時只能有一筆未撤回的公布', `insert into publications(competition_id, snapshot) values($1,'{}')`, [cid]);
await db.query(`update publications set revoked_at=now() where competition_id=$1`, [cid]);
await expectOk('撤回後可以重新公布', `insert into publications(competition_id, snapshot) values($1,'{}')`, [cid]);

const rls = (await db.query(`select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity`)).rows[0].n;
rls === 0 ? ok('所有資料表都開啟 RLS') : bad('RLS', rls + ' 張表沒開');
const pol = (await db.query(`select count(*)::int n from pg_policies where schemaname='public'`)).rows[0].n;
pol === 0 ? ok('沒有任何 policy（anon 完全讀不到）') : bad('policy', pol);
const anonPriv = (await db.query(`select count(*)::int n from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema='public'`)).rows[0].n;
anonPriv === 0 ? ok('anon／authenticated 沒有任何資料表權限') : bad('權限', anonPriv);
const fnPriv = (await db.query(`select has_function_privilege('anon','check_password(text,text)','execute') a, has_function_privilege('anon','set_password(text,text)','execute') b, has_function_privilege('anon','create_competition(text,text,text,text,int)','execute') c`)).rows[0];
!fnPriv.a && !fnPriv.b && !fnPriv.c ? ok('anon 不能執行密碼與建立競賽函式') : bad('函式權限', JSON.stringify(fnPriv));

/* ───── P3：評分表、鎖版 ───── */
const rid = (await db.query(`select rubric_id from competitions where id=$1`, [cid])).rows[0].rubric_id;
await expectFail('評分表總分不是 100 被拒', `select save_rubric($1, $2::jsonb)`, [rid, JSON.stringify([{ title: 'A', max_score: 60 }, { title: 'B', max_score: 30 }])], /總分必須是 100/);
await expectOk('儲存評分表（3 項 50／30／20）', `select save_rubric($1, $2::jsonb)`, [rid, JSON.stringify([{ title: '應用', max_score: 50 }, { title: '課程', max_score: 30, description: '判準' }, { title: '創意', max_score: 20 }])]);
const ri = (await db.query(`select title, max_score, sort from rubric_items where rubric_id=$1 order by sort`, [rid])).rows;
ri.length === 3 && ri[0].title === '應用' && ri[2].sort === 3 ? ok('評分表項目與順序正確') : bad('評分表項目', JSON.stringify(ri));

await expectFail('setup 階段不能開始評分', `select lock_for_judging($1, $2)`, [cid, good], /收件審查/);
await db.query(`update competitions set phase='collecting' where id=$1`, [cid]);
await expectFail('評審席位沒排滿不能開始評分', `select lock_for_judging($1, $2)`, [cid, good], /席位還沒排滿（1 \/ 5）/);
for (let i = 2; i <= 5; i++) await db.query(`insert into judge_slots(competition_id, slot_no, account_id) values($1,$2,$3)`, [cid, i, j[i - 1]]);
await db.query(`insert into team_current(team_id, version_id) values($1,$2)`, [tid, vid]);   // team01 最新審查是 fail
const tid2 = (await db.query(`insert into teams(competition_id, code) values($1,'team02') returning id`, [cid])).rows[0].id;
const vid2 = (await db.query(`insert into video_versions(competition_id, team_id, version_no, source_filename, source_sha256, source_size, check_ok, playback_path)
  values($1,$2,1,'team02_v1.mp4',$3,100,true,'videos/team02_v1.mp4') returning id`, [cid, tid2, 'd'.repeat(64)])).rows[0].id;
await db.query(`insert into team_current(team_id, version_id) values($1,$2)`, [tid2, vid2]);   // team02 還沒審查
const st = (await db.query(`select current_review_status($1) a, current_review_status($2) b`, [vid, vid2])).rows[0];
st.a === 'fail' && st.b === 'pending' ? ok('current_review_status 取最新一筆，沒審查為 pending') : bad('審查狀態', JSON.stringify(st));
await expectFail('有未完成的審查不能開始評分', `select lock_for_judging($1, $2)`, [cid, good], /還有 1 組/);
await db.query(`insert into reviews(version_id, status, reason) values($1,'resubmit','畫面中斷')`, [vid2]);
await expectFail('沒有任何通過的作品不能開始評分', `select lock_for_judging($1, $2)`, [cid, good], /沒有任何資格通過/);
const locks0 = (await db.query(`select count(*)::int n from judging_locks`)).rows[0].n;
const phase0 = (await db.query(`select phase from competitions where id=$1`, [cid])).rows[0].phase;
locks0 === 0 && phase0 === 'collecting' ? ok('失敗時什麼都沒寫入（沒有鎖版、階段不變）') : bad('原子性', locks0 + ' ' + phase0);

await db.query(`insert into reviews(version_id, status) values($1,'pass')`, [vid]);
const lr = (await db.query(`select lock_for_judging($1, $2) r`, [cid, good])).rows[0].r;
lr.locked === 1 && JSON.stringify(lr.excluded) === '["team02"]' ? ok('開始評分：鎖定 1 組，列出未進入評分的 team02') : bad('鎖版結果', JSON.stringify(lr));
const after = (await db.query(`select c.phase, rb.locked from competitions c join rubrics rb on rb.id=c.rubric_id where c.id=$1`, [cid])).rows[0];
after.phase === 'judging' && after.locked ? ok('階段改為 judging，評分表鎖定') : bad('鎖版後狀態', JSON.stringify(after));
await expectFail('評分表鎖定後不能修改', `select save_rubric($1, $2::jsonb)`, [rid, JSON.stringify([{ title: 'X', max_score: 100 }])], /已鎖定/);
await expectFail('評分階段不能重複鎖版', `select lock_for_judging($1, $2)`, [cid, good], /收件審查/);
const lg = (await db.query(`select count(*)::int n from admin_logs where action='lock_for_judging'`)).rows[0].n;
lg === 1 ? ok('鎖版寫入操作紀錄') : bad('鎖版紀錄', lg);
const fp = (await db.query(`select has_function_privilege('anon','lock_for_judging(uuid,uuid)','execute') a, has_function_privilege('anon','save_rubric(uuid,jsonb)','execute') b`)).rows[0];
!fp.a && !fp.b ? ok('anon 不能執行鎖版與評分表函式') : bad('函式權限', JSON.stringify(fp));

console.log(`\n通過 ${pass}，失敗 ${failN}`);
process.exit(failN ? 1 : 0);
