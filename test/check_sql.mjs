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
const dflt = (await db.query(`select ai_judge from competitions where id=$1`, [cid])).rows[0];
dflt.ai_judge === true ? ok('新競賽預設開啟 AI 評審') : bad('ai_judge 預設', JSON.stringify(dflt));
await db.query(`update competitions set ai_judge=false where id=$1`, [cid]);   // P1～P5 的測試照原本（沒有 AI）的規則跑；AI 在最後一段測
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
await expectFail('席位編號 1～6（5 位老師＋AI）', `insert into judge_slots(competition_id, slot_no, account_id) values($1,7,$2)`, [cid, j[1]]);

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

/* ───── P4：評分 ───── */
// 目前狀態：競賽在 judging、評分表 3 項（應用 50／課程 30／創意 20）、team01 鎖定、team02 未進入評分、評審席位 1～5 = j[0..4]
const rItems = (await db.query(`select id, title from rubric_items where rubric_id=$1 order by sort`, [rid])).rows;
const sc = (a, b, c2) => JSON.stringify({ [rItems[0].id]: a, [rItems[1].id]: b, [rItems[2].id]: c2 });
const save = (acct, team, it, s1, s2, submit) => db.query(`select judge_save($1,$2,$3::jsonb,$4,$5,$6) r`, [team, acct, it, s1, s2, submit]);
const okText = '作品完整，操作展示清楚';
await expectFail('未進入評分的作品不能評', `select judge_save($1,$2,'{}'::jsonb,'','',false)`, [tid2, j[0]], /不在評分名單/);
const outsider = (await db.query(`insert into accounts(competition_id, login_id, display_name, role) values($1,'judge99','x','judge') returning id`, [cid])).rows[0].id;
await expectFail('沒有席位的評審不能評', `select judge_save($1,$2,'{}'::jsonb,'','',false)`, [tid, outsider], /沒有被指派/);
await expectFail('分數超過該項滿分被拒', `select judge_save($1,$2,$3::jsonb,'','',false)`, [tid, j[0], sc(51, 0, 0)], /0～50/);
await expectFail('分數不是整數被拒', `select judge_save($1,$2,$3::jsonb,'','',false)`, [tid, j[0], sc(10.5, 0, 0)], /整數/);
await expectFail('不在評分表上的項目被拒', `select judge_save($1,$2,$3::jsonb,'','',false)`, [tid, j[0], JSON.stringify({ [crypto.randomUUID()]: 1 })], /不在評分表上/);
let r1 = (await save(j[0], tid, JSON.stringify({ [rItems[0].id]: 40 }), '', '', false)).rows[0].r;
r1.status === 'draft' && r1.total === null ? ok('暫存可以只填一部分，不計總分') : bad('暫存', JSON.stringify(r1));
await expectFail('正式送出要每項都給分', `select judge_save($1,$2,$3::jsonb,$4,$4,true)`, [tid, j[0], JSON.stringify({ [rItems[0].id]: 40 }), okText], /還有 2 個項目/);
await expectFail('正式送出評語要達最少字數', `select judge_save($1,$2,$3::jsonb,'好','很好',true)`, [tid, j[0], sc(40, 20, 10)], /至少要 10 個字/);
r1 = (await save(j[0], tid, sc(40, 25, 15), okText, '可以補充測試數據與對照組', true)).rows[0].r;
r1.status === 'submitted' && r1.total === 80 ? ok('正式送出：總分由資料庫計算 = 80') : bad('送出', JSON.stringify(r1));
await expectFail('送出後不能再改', `select judge_save($1,$2,$3::jsonb,$4,$4,false)`, [tid, j[0], sc(1, 1, 1), okText], /需要主辦方退回/);
const sid = (await db.query(`select id from scores where team_id=$1 and slot_no=1`, [tid])).rows[0].id;
await expectFail('退回必須填原因', `select return_score($1,$2,'  ')`, [sid, good], /必須填寫原因/);
await expectOk('主辦方退回評分', `select return_score($1,$2,'第二項分數請再確認')`, [sid, good]);
const rs = (await db.query(`select status, total, items from scores where id=$1`, [sid])).rows[0];
rs.status === 'returned' && rs.total === null && Object.keys(rs.items).length === 3 ? ok('退回後狀態 returned、總分清空、分數保留供修改') : bad('退回', JSON.stringify(rs));
await expectFail('已退回的不能再退回', `select return_score($1,$2,'x')`, [sid, good], /只有已正式送出/);
r1 = (await save(j[0], tid, sc(40, 20, 15), okText, '可以補充測試數據與對照組', false)).rows[0].r;
r1.status === 'returned' ? ok('退回後暫存仍維持「已退回」狀態') : bad('退回後暫存', JSON.stringify(r1));
r1 = (await save(j[0], tid, sc(40, 20, 15), okText, '可以補充測試數據與對照組', true)).rows[0].r;
r1.status === 'submitted' && r1.total === 75 ? ok('修改後重新送出 = 75') : bad('重送', JSON.stringify(r1));
const hist = (await db.query(`select action, reason from score_history where score_id=$1 order by id`, [sid])).rows.map(h => h.action + (h.reason ? ':' + h.reason : ''));
JSON.stringify(hist) === JSON.stringify(['submit', 'return:第二項分數請再確認', 'resubmit']) ? ok('更正歷程：submit → return（原因）→ resubmit') : bad('歷程', JSON.stringify(hist));
await db.query(`insert into scores(competition_id, team_id, version_id, slot_no, account_id) values($1,$2,$3,9,$4)`, [cid, tid, vid, j[1]]).then(() => bad('席位 9', '應該失敗'), () => ok('席位編號超過 6 被資料庫拒絕'));
const fp4 = (await db.query(`select has_function_privilege('anon','judge_save(uuid,uuid,jsonb,text,text,boolean)','execute') a, has_function_privilege('anon','return_score(uuid,uuid,text)','execute') b`)).rows[0];
!fp4.a && !fp4.b ? ok('anon 不能執行評分與退回函式') : bad('函式權限', JSON.stringify(fp4));

/* ───── P5：公布與撤回 ───── */
// 目前：team01 鎖定、評審1 已送出，評審2～5 還沒評；階段 judging
const snap = JSON.stringify({ teams: [{ code: 'team01', rank: 1 }] });
await db.query(`update publications set revoked_at = now() where competition_id=$1 and revoked_at is null`, [cid]);   // 清掉前面測約束時建的公布
await expectFail('評分階段不能公布', `select publish_results($1,$2,$3::jsonb)`, [cid, good, snap], /只有「結算」階段/);
await db.query(`update competitions set phase='settling' where id=$1`, [cid]);
await expectFail('評分沒收齊不能公布', `select publish_results($1,$2,$3::jsonb)`, [cid, good, snap], /還有 1 件作品的評分沒有收齊/);
for (let i = 2; i <= 5; i++) {
  await db.query(`update competitions set phase='judging' where id=$1`, [cid]);
  await save(j[i - 1], tid, sc(40, 20, 15), okText, '可以補充測試數據與對照組', true);
}
await db.query(`update competitions set phase='settling' where id=$1`, [cid]);
await expectFail('快照格式錯誤被拒', `select publish_results($1,$2,'{"teams":1}'::jsonb)`, [cid, good], /格式錯誤/);
const pid = (await db.query(`select publish_results($1,$2,$3::jsonb) id`, [cid, good, snap])).rows[0].id;
const ph = (await db.query(`select phase from competitions where id=$1`, [cid])).rows[0].phase;
pid && ph === 'published' ? ok('收齊後可以公布，階段改為已公布') : bad('公布', ph);
await expectFail('已公布不能重複公布', `select publish_results($1,$2,$3::jsonb)`, [cid, good, snap], /只有「結算」階段/);
await expectFail('公布後不能再退回評分', `select return_score((select id from scores where team_id=$1 and slot_no=1), $2, 'x')`, [tid, good], /目前階段不能退回/);
await expectFail('撤回必須填原因', `select revoke_publication($1,$2,' ')`, [cid, good], /必須填寫原因/);
await expectOk('撤回公布', `select revoke_publication($1,$2,'名次有誤')`, [cid, good]);
const rv = (await db.query(`select (select phase from competitions where id=$1) phase, (select count(*)::int from publications where competition_id=$1 and revoked_at is null) live, (select revoke_reason from publications where id=$2) reason`, [cid, pid])).rows[0];
rv.phase === 'settling' && rv.live === 0 && rv.reason === '名次有誤' ? ok('撤回後回到結算、沒有公布中的結果、保留撤回原因') : bad('撤回', JSON.stringify(rv));
await expectOk('撤回後可以重新公布', `select publish_results($1,$2,$3::jsonb)`, [cid, good, snap]);
const pl = (await db.query(`select array_agg(action order by id) a from admin_logs where action in ('publish','revoke')`)).rows[0].a;
JSON.stringify(pl) === '["publish","revoke","publish"]' ? ok('公布與撤回都有操作紀錄') : bad('紀錄', JSON.stringify(pl));
const fp5 = (await db.query(`select has_function_privilege('anon','publish_results(uuid,uuid,jsonb)','execute') a, has_function_privilege('anon','revoke_publication(uuid,uuid,text)','execute') b`)).rows[0];
!fp5.a && !fp5.b ? ok('anon 不能執行公布與撤回函式') : bad('函式權限', JSON.stringify(fp5));

/* ───── P7：AI 評審 ───── */
// 新競賽（AI 開啟、3 位老師）：開始評分時自動建立 AI 帳號坐席位 4；公布要收齊 4 份
const cidA = (await db.query(`select create_competition('AI 測試','admin02','主辦2','password123') as id`)).rows[0].id;
const ca = (await db.query(`select judge_count, ai_judge from competitions where id=$1`, [cidA])).rows[0];
ca.judge_count === 3 && ca.ai_judge ? ok('create_competition 預設 3 位評審＋AI') : bad('預設', JSON.stringify(ca));
const adminA = (await db.query(`select id from accounts where login_id='admin02'`)).rows[0].id;
const ja = [];
for (let i = 1; i <= 3; i++) {
  ja.push((await db.query(`insert into accounts(competition_id, login_id, display_name, role) values($1,$2,$3,'judge') returning id`, [cidA, 'aj0' + i, 'A評審' + i])).rows[0].id);
  await db.query(`insert into judge_slots(competition_id, slot_no, account_id) values($1,$2,$3)`, [cidA, i, ja[i - 1]]);
}
const tA = (await db.query(`insert into teams(competition_id, code) values($1,'team01') returning id`, [cidA])).rows[0].id;
const vA = (await db.query(`insert into video_versions(competition_id, team_id, version_no, source_filename, source_sha256, source_size, check_ok, playback_path, duration_sec)
  values($1,$2,1,'team01_v1.mov',$3,100,true,'videos/team01_v1.mp4',300) returning id`, [cidA, tA, 'f'.repeat(64)])).rows[0].id;
await db.query(`insert into team_current(team_id, version_id) values($1,$2)`, [tA, vA]);
await db.query(`insert into reviews(version_id, status) values($1,'pass')`, [vA]);
await db.query(`update competitions set phase='collecting' where id=$1`, [cidA]);
await expectOk('AI 開啟時開始評分', `select lock_for_judging($1,$2)`, [cidA, adminA]);
const aiAcc = (await db.query(`select a.id, a.login_id, a.role, a.password_hash, s.slot_no from accounts a join judge_slots s on s.account_id=a.id where a.competition_id=$1 and a.role='ai'`, [cidA])).rows[0];
aiAcc && aiAcc.slot_no === 4 && /^ai-[0-9a-f]{8}$/.test(aiAcc.login_id) && aiAcc.password_hash === null ? ok('自動建立 AI 帳號（沒有密碼）並坐席位 4') : bad('AI 帳號', JSON.stringify(aiAcc));
await expectFail('AI 帳號不能設定密碼', `select set_password($1,'password123')`, [aiAcc.login_id], /AI 帳號不能設定密碼/);
await db.query(`update accounts set password_hash = extensions.crypt('password123', extensions.gen_salt('bf', 4)) where id=$1`, [aiAcc.id]);
(await db.query(`select check_password($1,'password123') id`, [aiAcc.login_id])).rows[0].id === null ? ok('就算 AI 帳號有密碼雜湊也不能登入') : bad('AI 登入', '可以登入');
await db.query(`update accounts set password_hash = null where id=$1`, [aiAcc.id]);
const riA = (await db.query(`select ri.id, ri.max_score from rubric_items ri join competitions c on c.rubric_id=ri.rubric_id where c.id=$1 order by sort`, [cidA])).rows;
const scA = (a, b, c2, d) => JSON.stringify({ [riA[0].id]: a, [riA[1].id]: b, [riA[2].id]: c2, [riA[3].id]: d });
for (const jid of ja) await db.query(`select judge_save($1,$2,$3::jsonb,$4,$4,true)`, [tA, jid, scA(30, 20, 20, 10), okText]);
await db.query(`update competitions set phase='settling' where id=$1`, [cidA]);
await expectFail('只有 3 位老師的評分（缺 AI）不能公布', `select publish_results($1,$2,$3::jsonb)`, [cidA, adminA, snap], /還有 1 件作品的評分沒有收齊/);
await db.query(`update competitions set phase='judging' where id=$1`, [cidA]);
const aiSave = (await db.query(`select judge_save($1,$2,$3::jsonb,$4,$4,true) r`, [tA, aiAcc.id, scA(31, 20, 18, 8), okText])).rows[0].r;
aiSave.status === 'submitted' && aiSave.total === 77 ? ok('AI 帳號用 judge_save 送出到席位 4') : bad('AI 送出', JSON.stringify(aiSave));
(await db.query(`select slot_no from scores where team_id=$1 and account_id=$2`, [tA, aiAcc.id])).rows[0].slot_no === 4 ? ok('AI 評分存在席位 4') : bad('AI 席位', '');
await db.query(`update competitions set phase='settling' where id=$1`, [cidA]);
await expectOk('收齊 3 位老師＋AI 後可以公布', `select publish_results($1,$2,$3::jsonb)`, [cidA, adminA, snap]);
const lgA = (await db.query(`select detail from admin_logs where competition_id=$1 and action='lock_for_judging'`, [cidA])).rows[0].detail;
lgA.ai === true && lgA.judges === 3 ? ok('鎖版紀錄寫明老師人數與 AI') : bad('鎖版紀錄', JSON.stringify(lgA));
await expectFail('ai_runs 狀態只能是規定的值', `insert into ai_runs(competition_id, team_id, version_id, model, prompt_version, status) values($1,$2,$3,'m','v1','weird')`, [cidA, tA, vA]);
await expectOk('建立 ai_runs 紀錄', `insert into ai_runs(competition_id, team_id, version_id, model, prompt_version, status) values($1,$2,$3,'m','v1','uploading')`, [cidA, tA, vA]);
await expectOk('非同步：ai_runs 可記錄 Gemini 評分編號與 finishing 狀態', `insert into ai_runs(competition_id, team_id, version_id, model, prompt_version, status, gemini_job) values($1,$2,$3,'m','v1','finishing','v1_abc')`, [cidA, tA, vA]);
const rlsA = (await db.query(`select relrowsecurity r from pg_class where relname='ai_runs'`)).rows[0].r;
const anonA = (await db.query(`select count(*)::int n from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_name='ai_runs'`)).rows[0].n;
rlsA && anonA === 0 ? ok('ai_runs 開啟 RLS、anon 沒有權限') : bad('ai_runs 權限', rlsA + ' ' + anonA);
const fpA = (await db.query(`select has_function_privilege('anon','seat_count(competitions)','execute') a`)).rows[0];
!fpA.a ? ok('anon 不能執行 seat_count') : bad('函式權限', JSON.stringify(fpA));
// AI 關閉時：不建立 AI 席位
const cidB = (await db.query(`select create_competition('AI 關閉','admin03','主辦3','password123',3) as id`)).rows[0].id;
await db.query(`update competitions set ai_judge=false, phase='collecting' where id=$1`, [cidB]);
const adminB = (await db.query(`select id from accounts where login_id='admin03'`)).rows[0].id;
for (let i = 1; i <= 3; i++) {
  const id = (await db.query(`insert into accounts(competition_id, login_id, display_name, role) values($1,$2,$3,'judge') returning id`, [cidB, 'bj0' + i, 'B評審' + i])).rows[0].id;
  await db.query(`insert into judge_slots(competition_id, slot_no, account_id) values($1,$2,$3)`, [cidB, i, id]);
}
const tB = (await db.query(`insert into teams(competition_id, code) values($1,'team01') returning id`, [cidB])).rows[0].id;
const vB = (await db.query(`insert into video_versions(competition_id, team_id, version_no, source_filename, source_sha256, source_size, check_ok, playback_path)
  values($1,$2,1,'x.mov',$3,100,true,'videos/team01_v1.mp4') returning id`, [cidB, tB, '9'.repeat(64)])).rows[0].id;
await db.query(`insert into team_current(team_id, version_id) values($1,$2)`, [tB, vB]);
await db.query(`insert into reviews(version_id, status) values($1,'pass')`, [vB]);
await db.query(`select lock_for_judging($1,$2)`, [cidB, adminB]);
const slB = (await db.query(`select array_agg(slot_no order by slot_no) s from judge_slots where competition_id=$1`, [cidB])).rows[0].s;
JSON.stringify(slB) === '[1,2,3]' ? ok('AI 關閉時不建立 AI 席位') : bad('AI 關閉', JSON.stringify(slB));

console.log(`\n通過 ${pass}，失敗 ${failN}`);
process.exit(failN ? 1 : 0);
