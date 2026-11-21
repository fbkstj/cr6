// 本機自動測試：node test/run.mjs
// 用記憶體資料庫跑 core.js。每個開發階段的驗收項目都加在這裡（開發計畫書第 12 節）。
import assert from 'node:assert/strict';
import { createApi } from '../supabase/functions/api/core.js';
import { createMemDb } from './memdb.mjs';

let clock = Date.parse('2026-12-01T01:00:00Z');
const tick = sec => { clock += sec * 1000; };
const SECRET = 'test-secret-0123456789abcdef-0123456789';

let passed = 0;
async function step(name, f) { await f(); passed++; console.log('  ✓', name); }

async function setup(opts, apiOpts) {
  const db = createMemDb();
  const cid = await db.seedDemo(opts);
  const api = createApi(Object.assign({ db, secret: SECRET, now: () => clock }, apiOpts));
  const call = async (fn, ...args) => {
    const r = await api.handle({ fn, args });
    if (!r.ok) throw new Error(fn + '：' + r.error);
    return r.result;
  };
  const expectErr = async (re, fn, ...args) => {
    const r = await api.handle({ fn, args });
    assert.equal(r.ok, false, fn + ' 應該失敗');
    assert.match(r.error, re);
  };
  return { db, cid, api, call, expectErr };
}

/* ═════════════ P1 資料庫與登入 ═════════════ */
console.log('P1 登入與 token');
{
  const { db, cid, api, call, expectErr } = await setup();

  await step('密鑰太短拒絕啟動', async () => {
    assert.throws(() => createApi({ db, secret: 'short' }), /TOKEN_SECRET/);
  });

  await step('評審登入成功，回傳角色與競賽（不含密碼雜湊）', async () => {
    const r = await call('login', 'judge01', 'judge-pass-01');
    assert.equal(r.role, 'judge');
    assert.equal(r.me.loginId, 'judge01');
    assert.equal(r.competition.judgeCount, 5);
    assert.ok(!JSON.stringify(r).includes('password_hash'));
    assert.ok(!JSON.stringify(r).includes('judge-pass-01'));
  });

  await step('帳號不分大小寫、會去掉前後空白', async () => {
    const r = await call('login', '  ADMIN01 ', 'admin-pass-01');
    assert.equal(r.role, 'admin');
  });

  await step('密碼錯誤與帳號不存在顯示相同訊息（不洩漏帳號是否存在）', async () => {
    await expectErr(/^帳號或密碼不正確$/, 'login', 'judge02', 'wrong-password');
    await expectErr(/^帳號或密碼不正確$/, 'login', 'nobody99', 'wrong-password');
    await expectErr(/^帳號或密碼不正確$/, 'login', '<script>', 'x');
  });

  await step('連錯 5 次鎖 10 分鐘，期間正確密碼也進不去；時間到就解鎖', async () => {
    for (let i = 0; i < 4; i++) await expectErr(/不正確/, 'login', 'judge03', 'bad');
    await expectErr(/不正確/, 'login', 'judge03', 'bad');
    await expectErr(/嘗試次數過多/, 'login', 'judge03', 'judge-pass-03');
    tick(10 * 60 + 1);
    const r = await call('login', 'judge03', 'judge-pass-03');
    assert.equal(r.role, 'judge');
  });

  await step('鎖定只影響該帳號，其他評審照常登入', async () => {
    for (let i = 0; i < 5; i++) await expectErr(/不正確/, 'login', 'judge04', 'bad');
    await call('login', 'judge05', 'judge-pass-05');
  });

  await step('竄改 token 內容被拒（例如把 judge 改成 admin）', async () => {
    const { token } = await call('login', 'judge01', 'judge-pass-01');
    const [body, sig] = token.split('.');
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    data.role = 'admin';
    const forged = Buffer.from(JSON.stringify(data)).toString('base64url') + '.' + sig;
    await expectErr(/^AUTH:/, 'adminListAccounts', forged);
    await expectErr(/^AUTH:/, 'me', 'garbage');
    await expectErr(/^AUTH:/, 'me', '');
  });

  await step('token 12 小時後過期', async () => {
    const { token } = await call('login', 'judge01', 'judge-pass-01');
    tick(11 * 3600);
    await call('me', token);
    tick(3600 + 1);
    await expectErr(/逾時/, 'me', token);
  });

  await step('評審呼叫主辦方功能一律被拒', async () => {
    const { token } = await call('login', 'judge01', 'judge-pass-01');
    for (const fn of ['adminListAccounts', 'adminUpsertAccount', 'adminResetPassword', 'adminLogs']) {
      await expectErr(/不能使用此功能/, fn, token, {});
    }
  });

  await step('不存在的功能名稱被拒（包含原型鏈上的名稱）', async () => {
    for (const fn of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const r = await api.handle({ fn, args: [] });
      assert.equal(r.ok, false);
      assert.equal(r.error, '不支援的操作');
    }
    assert.equal((await api.handle(null)).ok, false);
  });

  let adminToken, newJudge;
  await step('主辦方新增評審帳號，取得一次性臨時密碼，可以登入', async () => {
    adminToken = (await call('login', 'admin01', 'admin-pass-01')).token;
    const r = await call('adminUpsertAccount', adminToken, { loginId: 'Judge06', name: '替補評審', role: 'judge' });
    assert.equal(r.account.loginId, 'judge06');
    assert.equal(r.tempPassword.length, 10);
    assert.doesNotMatch(r.tempPassword, /[0O1lI]/);
    newJudge = r;
    assert.equal((await call('login', 'judge06', r.tempPassword)).role, 'judge');
  });

  await step('新增帳號的格式檢查', async () => {
    await expectErr(/帳號只能用/, 'adminUpsertAccount', adminToken, { loginId: 'ab', name: 'x', role: 'judge' });
    await expectErr(/帳號只能用/, 'adminUpsertAccount', adminToken, { loginId: '評審七', name: 'x', role: 'judge' });
    await expectErr(/角色只能是/, 'adminUpsertAccount', adminToken, { loginId: 'judge07', name: 'x', role: 'student' });
    await expectErr(/已經有人使用/, 'adminUpsertAccount', adminToken, { loginId: 'judge01', name: 'x', role: 'judge' });
    await expectErr(/請填寫姓名/, 'adminUpsertAccount', adminToken, { loginId: 'judge07', name: '  ', role: 'judge' });
  });

  await step('帳號清單：看得到席位，看不到密碼雜湊', async () => {
    const list = await call('adminListAccounts', adminToken);
    assert.equal(list.length, 7);
    assert.equal(list.find(a => a.loginId === 'judge01').slot, 1);
    assert.equal(list.find(a => a.loginId === 'judge06').slot, null);
    assert.ok(list.every(a => a.hasPassword));
    assert.ok(!JSON.stringify(list).includes('password_hash'));
  });

  await step('重設密碼：舊密碼失效、新臨時密碼可登入，並解除鎖定', async () => {
    const j4 = (await call('adminListAccounts', adminToken)).find(a => a.loginId === 'judge04');
    for (let i = 0; i < 5; i++) await expectErr(/不正確|嘗試次數過多/, 'login', 'judge04', 'bad');
    await expectErr(/嘗試次數過多/, 'login', 'judge04', 'judge-pass-04');   // 先確認被鎖住
    const r = await call('adminResetPassword', adminToken, j4.id);
    await expectErr(/不正確/, 'login', 'judge04', 'judge-pass-04');
    assert.equal((await call('login', 'judge04', r.tempPassword)).role, 'judge');
  });

  await step('停用帳號後，已登入的 token 立刻失效，也無法再登入', async () => {
    const { token } = await call('login', 'judge06', newJudge.tempPassword);
    await call('adminUpsertAccount', adminToken, { id: newJudge.account.id, name: '替補評審', active: false });
    await expectErr(/已停用/, 'me', token);
    await expectErr(/不正確/, 'login', 'judge06', newJudge.tempPassword);
  });

  await step('主辦方不能停用自己', async () => {
    const meAcc = (await call('me', adminToken)).me;
    await expectErr(/不能停用自己/, 'adminUpsertAccount', adminToken, { id: meAcc.id, name: '主辦人員', active: false });
  });

  await step('修改密碼：原密碼要正確、新密碼至少 8 字', async () => {
    const { token } = await call('login', 'judge02', 'judge-pass-02');
    await expectErr(/原密碼不正確/, 'changePassword', token, 'wrong', 'new-password-02');
    await expectErr(/至少 8 個字/, 'changePassword', token, 'judge-pass-02', 'short');
    await call('changePassword', token, 'judge-pass-02', 'new-password-02');
    await expectErr(/不正確/, 'login', 'judge02', 'judge-pass-02');
    await call('login', 'judge02', 'new-password-02');
  });

  await step('其他競賽的帳號不能被這個主辦方查看或重設', async () => {
    const other = await db.insertAccount({ competition_id: 'other-competition', login_id: 'outsider', display_name: '別人', role: 'judge', active: true });
    await expectErr(/找不到這個帳號/, 'adminResetPassword', adminToken, other.id);
    await expectErr(/找不到這個帳號/, 'adminUpsertAccount', adminToken, { id: other.id, name: '改名' });
    assert.ok(!(await call('adminListAccounts', adminToken)).some(a => a.loginId === 'outsider'));
  });

  await step('操作紀錄：新增帳號、重設密碼、停用都有記錄操作人', async () => {
    const logs = await call('adminLogs', adminToken);
    const actions = logs.map(l => l.action);
    assert.ok(actions.includes('create_account'));
    assert.ok(actions.includes('reset_password'));
    assert.ok(actions.includes('update_account'));
    assert.ok(logs.every(l => l.actor === '主辦人員'));
  });

  console.log('P1 公開結果的權限');

  await step('公布前：訪客拿不到任何分數', async () => {
    const r = await call('publicResults');
    assert.equal(r.published, false);
    assert.deepEqual(Object.keys(r).sort(), ['competition', 'published']);
  });

  await step('公布後：只輸出白名單欄位，快照裡的評審姓名、帳號不會流出', async () => {
    db._tables.publications.push({
      id: 'p1', competition_id: cid, published_at: '2026-12-20T08:00:00Z', revoked_at: null,
      snapshot: {
        judgeCount: 3, showItemScores: false,
        items: [{ id: 'i1', title: '應用', max: 40 }],
        teams: [{
          rank: 1, code: 'team01', name: '第一組', workTitle: '智慧澆花', average: 88.33, secretNote: '內部備註',
          judges: [
            { slot: 2, total: 90, strengths: '完整', improvements: '加測試', judgeName: '王老師', accountId: 'x', items: { i1: 36 } },
            { slot: 1, total: 85, strengths: '創意', improvements: '說明', judgeName: '李老師' },
          ],
        }],
      },
    });
    const r = await call('publicResults');
    const text = JSON.stringify(r);
    assert.equal(r.published, true);
    assert.equal(r.teams[0].average, 88.33);
    assert.deepEqual(r.teams[0].judges.map(j => j.label), ['評審1', '評審2']);
    for (const leak of ['王老師', '李老師', 'judgeName', 'accountId', 'secretNote', '內部備註']) assert.ok(!text.includes(leak), '不應出現 ' + leak);
    assert.equal(r.items, null, '設定不顯示分項時不輸出分項');
    assert.equal(r.teams[0].judges[1].items, undefined);
  });

  await step('撤回公布後，公開頁又看不到結果', async () => {
    db._tables.publications[0].revoked_at = '2026-12-20T09:00:00Z';
    assert.equal((await call('publicResults')).published, false);
  });
}

/* ═════════════ P2 影片清單同步 ═════════════ */
console.log('P2 影片清單同步');
{
  const sha = c => c.repeat(64);
  // 格式和 tools/process_videos.py 產生的 manifest.json 相同
  const entry = (team, version, c, okFlag = true, extra = {}) => Object.assign({
    team, version, source_filename: `${team}_v${version}.mov`, source_sha256: sha(c), source_size: 123456789,
    duration_sec: 598.4, container: 'mov,mp4,m4a,3gp,3g2,mj2', vcodec: 'hevc', acodec: 'aac', width: 1080, height: 1920, rotation: 90,
    check_ok: okFlag, check_notes: okFlag ? '' : '長度 10:01，超過 10:00',
    playback_path: okFlag ? `videos/${team}_v${version}.mp4` : null, playback_size: okFlag ? 80000000 : null,
    processed_at: '2026-12-02T03:00:00+00:00',
  }, extra);
  let manifest = { format: 1, versions: [entry('team01', 1, 'a'), entry('team02', 1, 'b', false)] };
  const fetched = [];
  const fetchJson = async url => { fetched.push(url); if (manifest === 'down') throw new Error('HTTP 404'); return structuredClone(manifest); };
  const { db, call, expectErr } = await setup({}, { siteBaseUrl: 'https://fbkstj.github.io/cr6', fetchJson });
  const admin = (await call('login', 'admin01', 'admin-pass-01')).token;
  const judge = (await call('login', 'judge01', 'judge-pass-01')).token;

  await step('評審不能同步影片清單', async () => {
    await expectErr(/不能使用此功能/, 'adminSyncVideos', judge);
  });

  await step('第一次同步：新增合格與不合格的版本，讀的是網站上的 videos/manifest.json', async () => {
    const r = await call('adminSyncVideos', admin);
    assert.deepEqual(r.added.map(a => a.label), ['team01_v1', 'team02_v1']);
    assert.equal(r.added[1].checkOk, false);
    assert.equal(r.warnings.length, 0);
    assert.match(fetched[0], /^https:\/\/fbkstj\.github\.io\/cr6\/videos\/manifest\.json\?t=\d+$/);
    const v = db._tables.video_versions.find(x => x.source_sha256 === sha('a'));
    assert.equal(v.playback_path, 'videos/team01_v1.mp4');
    assert.equal(v.duration_sec, 598.4);
    assert.equal(db._tables.video_versions.find(x => x.source_sha256 === sha('b')).playback_path, null);
  });

  await step('重複同步不會重複建立版本', async () => {
    const r = await call('adminSyncVideos', admin);
    assert.equal(r.added.length, 0);
    assert.equal(r.skipped, 2);
    assert.equal(db._tables.video_versions.length, 2);
  });

  await step('補件版本（_v2）新增為新版本，舊版本保留', async () => {
    manifest.versions.push(entry('team01', 2, 'c'));
    const r = await call('adminSyncVideos', admin);
    assert.deepEqual(r.added.map(a => a.label), ['team01_v2']);
    assert.equal(db._tables.video_versions.filter(x => x.version_no && db._tables.teams.find(t => t.id === x.team_id).code === 'team01').length, 2);
  });

  await step('還沒建立的組別、格式錯誤、檔案衝突都列為警告，不寫入', async () => {
    manifest.versions.push(
      entry('team09', 1, 'd'),                                    // 沒有這個組別
      entry('team03', 1, 'e', true, { playback_path: '../../etc/passwd' }),   // 路徑不對
      entry('team03', 1, 'f', true, { source_sha256: 'xyz' }),    // sha 格式錯
      entry('team03', 2, 'a'),                                    // 和 team01_v1 同一支檔案
      entry('team02', 1, '9'),                                    // 版本號相同但檔案不同
      'not-an-object',
    );
    const before = db._tables.video_versions.length;
    const r = await call('adminSyncVideos', admin);
    assert.equal(r.added.length, 0);
    assert.equal(db._tables.video_versions.length, before);
    const w = r.warnings.join('\n');
    assert.match(w, /還沒有建立 team09/);
    assert.match(w, /播放檔路徑應為 videos\/team03_v1\.mp4/);
    assert.match(w, /sha256 格式錯誤/);
    assert.match(w, /和 team01_v1 是同一支檔案/);
    assert.match(w, /已經有這個版本，但檔案不同/);
    assert.match(w, /不是物件/);
  });

  await step('網站讀不到清單時顯示明確訊息', async () => {
    const saved = manifest;
    manifest = 'down';
    await expectErr(/讀不到影片清單（HTTP 404）/, 'adminSyncVideos', admin);
    manifest = { nope: true };
    await expectErr(/影片清單格式錯誤/, 'adminSyncVideos', admin);
    manifest = saved;
  });

  await step('沒有設定 SITE_BASE_URL 時提示部署說明', async () => {
    const s2 = await setup();
    const t = (await s2.call('login', 'admin01', 'admin-pass-01')).token;
    await s2.expectErr(/SITE_BASE_URL/, 'adminSyncVideos', t);
  });

  await step('同步動作寫入操作紀錄', async () => {
    const logs = await call('adminLogs', admin);
    assert.ok(logs.some(l => l.action === 'sync_videos' && l.detail.added.includes('team01_v2')));
  });
}

/* ═════════════ P3 主辦方後台：作品、審查、補件、鎖版 ═════════════ */
console.log('P3 作品與資格審查');
{
  const sha = c => c.repeat(64);
  const entry = (team, version, c, okFlag = true) => ({
    team, version, source_filename: `${team}_v${version}.mov`, source_sha256: sha(c), source_size: 1000, duration_sec: 300,
    check_ok: okFlag, check_notes: okFlag ? '' : '沒有聲音（音軌）', playback_path: okFlag ? `videos/${team}_v${version}.mp4` : null, playback_size: okFlag ? 500 : null,
  });
  const manifest = { versions: [entry('team01', 1, 'a'), entry('team02', 1, 'b', false), entry('team02', 2, 'c'), entry('team03', 1, 'd')] };
  const { db, call, expectErr } = await setup({}, { siteBaseUrl: 'https://example.test/', fetchJson: async () => structuredClone(manifest) });
  const admin = (await call('login', 'admin01', 'admin-pass-01')).token;
  const judge = (await call('login', 'judge01', 'judge-pass-01')).token;
  const board = async () => call('adminGetBoard', admin);
  const teamBy = async code => (await board()).teams.find(t => t.code === code);

  await step('評審不能使用任何後台功能', async () => {
    for (const fn of ['adminGetBoard', 'adminUpsertTeam', 'adminReview', 'adminSetPhase', 'adminSaveRubric', 'adminAssignSlot', 'adminSetCurrentVersion']) {
      await expectErr(/不能使用此功能/, fn, judge, {});
    }
  });

  await step('後台總覽：3 組未收件、評分表 100 分、5 個席位', async () => {
    const b = await board();
    assert.equal(b.competition.phase, 'setup');
    assert.deepEqual(b.teams.map(t => t.status.label), ['未收件', '未收件', '未收件']);
    assert.equal(b.rubric.total, 100);
    assert.equal(b.slots.length, 5);
  });

  await step('新增、修改、刪除組別（含格式與重複檢查）', async () => {
    const { id } = await call('adminUpsertTeam', admin, { code: 'TEAM04', name: '第四組', workTitle: '智慧門鎖' });
    await expectErr(/格式為 team/, 'adminUpsertTeam', admin, { code: 't5' });
    await expectErr(/已經存在/, 'adminUpsertTeam', admin, { code: 'team04' });
    await call('adminUpsertTeam', admin, { id, name: '第四組（改名）', members: '王小明、李小華' });
    assert.equal((await teamBy('team04')).members, '王小明、李小華');
    await call('adminDeleteTeam', admin, id);
    assert.equal((await board()).teams.length, 3);
  });

  await step('同步影片後：有版本但未設正式版本顯示「已收件」，不合格版本帶原因', async () => {
    await call('adminSyncVideos', admin);
    const t2 = await teamBy('team02');
    assert.equal(t2.status.label, '已收件');
    assert.deepEqual(t2.versions.map(v => v.no), [2, 1], '新版本排在前面');
    assert.equal(t2.versions[1].checkOk, false);
    assert.match(t2.versions[1].checkNotes, /沒有聲音/);
  });

  await step('有版本的組別不能刪除', async () => {
    await expectErr(/不能刪除/, 'adminDeleteTeam', admin, (await teamBy('team01')).id);
  });

  await step('設定正式版本：檢查沒過的版本、別組的版本都不行', async () => {
    const t1 = await teamBy('team01'), t2 = await teamBy('team02');
    await expectErr(/檢查沒有通過/, 'adminSetCurrentVersion', admin, t2.id, t2.versions[1].id);
    await expectErr(/不屬於這一組/, 'adminSetCurrentVersion', admin, t2.id, t1.versions[0].id);
    await call('adminSetCurrentVersion', admin, t2.id, t2.versions[0].id);
    await call('adminSetCurrentVersion', admin, t1.id, t1.versions[0].id);
    assert.equal((await teamBy('team02')).status.label, '審查中');
  });

  await step('收件時間：可以填寫與清除，不能晚於現在', async () => {
    const v = (await teamBy('team01')).versions[0];
    await expectErr(/不能晚於現在/, 'adminSetReceivedAt', admin, v.id, '2030-01-01T00:00:00Z');
    await call('adminSetReceivedAt', admin, v.id, '2026-11-30T08:30:00+08:00');
    assert.equal((await teamBy('team01')).versions[0].receivedAt, '2026-11-30T00:30:00.000Z');
    await call('adminSetReceivedAt', admin, v.id, '');
    assert.equal((await teamBy('team01')).versions[0].receivedAt, null);
  });

  await step('資格審查：退回與不通過必填原因、時間點要在片長內、檢查沒過不能通過', async () => {
    const t2 = await teamBy('team02');
    await expectErr(/必須填寫原因/, 'adminReview', admin, t2.versions[0].id, 'resubmit', '  ');
    await expectErr(/必須填寫原因/, 'adminReview', admin, t2.versions[0].id, 'fail', '');
    await expectErr(/不能審查通過/, 'adminReview', admin, t2.versions[1].id, 'pass');
    await expectErr(/影片長度內/, 'adminReview', admin, t2.versions[0].id, 'resubmit', '中間有剪接', [{ sec: 999, note: 'x' }]);
    await expectErr(/審查結果不正確/, 'adminReview', admin, t2.versions[0].id, 'ok');
    await call('adminReview', admin, t2.versions[0].id, 'resubmit', '04:10 畫面中斷，疑似剪接', [{ sec: 250.04, note: '畫面跳接' }, { sec: 12, note: '開頭' }]);
    const v = (await teamBy('team02')).versions[0];
    assert.equal(v.reviewStatus, 'resubmit');
    assert.deepEqual(v.reviews[0].timecodes.map(x => x.sec), [12, 250], '時間點排序並取到 0.1 秒');
    assert.equal(v.reviews[0].reviewer, '主辦人員');
    assert.equal((await teamBy('team02')).status.label, '補件中');
  });

  await step('改判：新增一筆審查，舊紀錄保留，以最新一筆為準', async () => {
    const v1 = (await teamBy('team01')).versions[0];
    await call('adminReview', admin, v1.id, 'fail', '有後製字幕');
    await call('adminReview', admin, v1.id, 'pass', '');
    const v = (await teamBy('team01')).versions[0];
    assert.equal(v.reviewStatus, 'pass');
    assert.deepEqual(v.reviews.map(r => r.status), ['pass', 'fail']);
  });

  await step('公開狀態頁：只顯示狀態，不帶退回原因', async () => {
    const r = await call('publicStatus');
    assert.equal(r.enabled, true);
    assert.deepEqual(r.teams.map(t => [t.code, t.status]), [['team01', '資格通過'], ['team02', '補件中'], ['team03', '已收件']]);
    const text = JSON.stringify(r);
    for (const leak of ['剪接', '後製字幕', '畫面跳接', 'sha', 'reason']) assert.ok(!text.includes(leak), '不應出現 ' + leak);
  });

  await step('主辦方可以關閉公開狀態頁', async () => {
    await call('adminUpdateCompetition', admin, { showStatusPage: false });
    assert.equal((await call('publicStatus')).enabled, false);
    await call('adminUpdateCompetition', admin, { showStatusPage: true });
  });

  await step('評分表：總分要 100、項目名稱與滿分檢查，可以改成任意項目', async () => {
    await expectErr(/必須是 100（目前 90）/, 'adminSaveRubric', admin, [{ title: 'A', max: 50 }, { title: 'B', max: 40 }]);
    await expectErr(/名稱 1～60/, 'adminSaveRubric', admin, [{ title: '', max: 100 }]);
    await expectErr(/1～100 的整數/, 'adminSaveRubric', admin, [{ title: 'A', max: 99.5 }, { title: 'B', max: 0.5 }]);
    const r = await call('adminSaveRubric', admin, [
      { title: '專題作品的應用及整合性', max: 40 }, { title: '專題作品與課程相關', max: 25 },
      { title: '創意性與實用性', max: 25 }, { title: '口頭表達', max: 10, description: '校方定案名稱' }]);
    assert.equal(r.total, 100);
    assert.equal(r.items[3].title, '口頭表達');
  });

  await step('評審人數改成 3：多出來的席位 4、5 自動移除', async () => {
    await call('adminUpdateCompetition', admin, { judgeCount: 3 });
    const b = await board();
    assert.equal(b.competition.judgeCount, 3);
    assert.deepEqual(b.slots.map(s => s.slot), [1, 2, 3]);
    await expectErr(/只能是 3 或 5/, 'adminUpdateCompetition', admin, { judgeCount: 4 });
  });

  await step('評審席位：只能指派啟用中的評審、同一人不能坐兩席、可以清空', async () => {
    const accs = await call('adminListAccounts', admin);
    const id = login => accs.find(a => a.loginId === login).id;
    await expectErr(/啟用中的評審/, 'adminAssignSlot', admin, 2, id('admin01'));
    await expectErr(/已經是評審1/, 'adminAssignSlot', admin, 2, id('judge01'));
    await expectErr(/席位編號要是 1～3/, 'adminAssignSlot', admin, 4, id('judge04'));
    await call('adminAssignSlot', admin, 3, null);
    assert.deepEqual((await board()).slots.map(s => s.slot), [1, 2]);
  });

  await step('階段：準備不能直接跳到評分；切到收件審查', async () => {
    await expectErr(/不能切換到「評分」/, 'adminSetPhase', admin, 'judging');
    await call('adminSetPhase', admin, 'collecting');
    assert.equal((await board()).competition.phase, 'collecting');
  });

  await step('開始評分前的檢查：列出缺席位、未完成審查的組別', async () => {
    const p = await call('adminJudgingPreview', admin);
    assert.ok(p.problems.some(x => /席位還沒排滿（2 \/ 3）/.test(x)));
    assert.ok(p.problems.some(x => /team03/.test(x)) === false, 'team03 沒有正式版本，不算未完成審查');
    assert.deepEqual(p.willLock, ['team01']);
    assert.deepEqual(p.excluded.map(e => e.code + ':' + e.reason), ['team02:退回補件中', 'team03:沒有設定正式版本']);
    await expectErr(/席位還沒排滿/, 'adminSetPhase', admin, 'judging');
  });

  await step('補件：新版本獨立重審，舊版本與舊審查仍可查', async () => {
    manifest.versions.push(entry('team02', 3, 'e'));
    await call('adminSyncVideos', admin);
    const t2 = await teamBy('team02');
    await call('adminSetCurrentVersion', admin, t2.id, t2.versions[0].id);
    assert.equal((await teamBy('team02')).status.label, '審查中');
    const p = await call('adminJudgingPreview', admin);
    assert.ok(p.problems.some(x => /還有 1 組.*team02/.test(x)));
    await call('adminReview', admin, t2.versions[0].id, 'pass');
    const after = await teamBy('team02');
    assert.equal(after.versions.find(v => v.no === 2).reviewStatus, 'resubmit');
    assert.equal(after.versions.find(v => v.no === 2).reviews[0].reason, '04:10 畫面中斷，疑似剪接');
  });

  await step('審查不通過的作品不進入評分；開始評分後鎖定版本', async () => {
    const t3 = await teamBy('team03');
    await call('adminSetCurrentVersion', admin, t3.id, t3.versions[0].id);
    await call('adminReview', admin, t3.versions[0].id, 'fail', '不是一鏡到底');
    const accs = await call('adminListAccounts', admin);
    await call('adminAssignSlot', admin, 3, accs.find(a => a.loginId === 'judge03').id);
    const r = await call('adminSetPhase', admin, 'judging');
    assert.equal(r.locked, 2);
    assert.deepEqual(r.excluded, ['team03']);
    const b = await board();
    assert.equal(b.competition.phase, 'judging');
    assert.equal(b.rubric.locked, true);
    const t2 = b.teams.find(t => t.code === 'team02');
    assert.equal(t2.lockedVersionId, t2.versions.find(v => v.no === 3).id, '鎖定的是補件後的第 3 版');
    assert.deepEqual(b.teams.map(t => t.status.label), ['評分中', '評分中', '未通過']);
  });

  await step('開始評分後：不能換正式版本、改審查、改評分表、改評審人數', async () => {
    const t1 = await teamBy('team01');
    await expectErr(/已經開始評分/, 'adminSetCurrentVersion', admin, t1.id, t1.versions[0].id);
    await expectErr(/已經開始評分/, 'adminReview', admin, t1.versions[0].id, 'fail', 'x');
    await expectErr(/已經開始評分/, 'adminSaveRubric', admin, [{ title: 'A', max: 100 }]);
    await expectErr(/已經開始評分/, 'adminUpdateCompetition', admin, { judgeCount: 5 });
    await expectErr(/已經開始評分/, 'adminUpsertTeam', admin, { code: 'team09' });
    await expectErr(/不能切換/, 'adminSetPhase', admin, 'collecting');
  });

  await step('開始評分後更換評審（替補）必須填寫原因，並記錄', async () => {
    const accs = await call('adminListAccounts', admin);
    await expectErr(/必須填寫原因/, 'adminAssignSlot', admin, 2, accs.find(a => a.loginId === 'judge05').id);
    await call('adminAssignSlot', admin, 2, accs.find(a => a.loginId === 'judge05').id, '原評審請病假');
    const s2 = (await board()).slots.find(s => s.slot === 2);
    assert.equal(s2.name, '測試評審5');
    assert.equal(s2.replacedReason, '原評審請病假');
  });

  await step('操作紀錄包含審查、正式版本、鎖版、替補', async () => {
    const actions = (await call('adminLogs', admin)).map(l => l.action);
    for (const a of ['review', 'set_current_version', 'lock_for_judging', 'replace_judge', 'save_rubric', 'set_phase']) assert.ok(actions.includes(a), a);
  });

  await step('其他競賽的組別、版本不能被操作', async () => {
    db._tables.teams.push({ id: 'other-team', competition_id: 'other', code: 'team01' });
    await expectErr(/找不到這個組別/, 'adminUpsertTeam', admin, { id: 'other-team', name: 'x' });
  });
}

/* ═════════════ P4 評審評分 ═════════════ */

/** 建立一個已經進入評分階段的競賽：team01、team02 通過，team03 不通過 */
async function judgingSetup(judgeCount, { teams = 3, fail = ['team03'], aiJudge = false, gemini = null } = {}) {
  const sha = c => c.repeat(64);
  const e = (team, c) => ({ team, version: 1, source_filename: team + '_v1.mov', source_sha256: sha(c), source_size: 1, duration_sec: 300,
    check_ok: true, check_notes: '', playback_path: `videos/${team}_v1.mp4`, playback_size: 1 });
  const codes = Array.from({ length: teams }, (_, i) => 'team' + String(i + 1).padStart(2, '0'));
  const ctx = await setup({ judgeCount, teams, aiJudge }, { siteBaseUrl: 'https://example.test/', gemini, fetchJson: async () => ({ versions: codes.map((c, i) => e(c, 'abcdef'[i])) }) });
  const admin = (await ctx.call('login', 'admin01', 'admin-pass-01')).token;
  await ctx.call('adminSyncVideos', admin);
  for (const t of (await ctx.call('adminGetBoard', admin)).teams) {
    await ctx.call('adminSetCurrentVersion', admin, t.id, t.versions[0].id);
    await ctx.call('adminReview', admin, t.versions[0].id, fail.includes(t.code) ? 'fail' : 'pass', fail.includes(t.code) ? '有剪接' : '');
  }
  await ctx.call('adminSetPhase', admin, 'collecting');
  await ctx.call('adminSetPhase', admin, 'judging');
  const judges = {};
  for (let i = 1; i <= 5; i++) judges['j' + i] = (await ctx.call('login', 'judge0' + i, 'judge-pass-0' + i)).token;
  const board = await ctx.call('adminGetBoard', admin);
  const team = code => board.teams.find(t => t.code === code).id;
  const ids = board.rubric.items.map(i => i.id);
  const items = (...v) => Object.fromEntries(ids.map((id, i) => [id, v[i]]));
  return Object.assign(ctx, { admin, judges, team, ids, items, board });
}
const GOOD = { strengths: '作品完整，操作展示清楚', improvements: '可以補充測試數據與對照組' };

console.log('P4 評審評分');
{
  // 評分開始前
  const pre = await setup();
  await step('評分開始前：評審清單是空的並顯示提示', async () => {
    const t = (await pre.call('login', 'judge01', 'judge-pass-01')).token;
    const r = await pre.call('judgeListWorks', t);
    assert.equal(r.works.length, 0);
    assert.match(r.message, /還沒有開始評分/);
  });

  const { db, call, expectErr, admin, judges, team, ids, items } = await judgingSetup(5);
  const [j1, j2] = [judges.j1, judges.j2];

  await step('評審只看到進入評分的作品（不通過的 team03 不在清單）', async () => {
    const r = await call('judgeListWorks', j1);
    assert.deepEqual(r.works.map(w => w.code), ['team01', 'team02']);
    assert.equal(r.slot, 1);
    assert.equal(r.done, 0);
    assert.ok(r.works.every(w => w.status === 'none'));
  });

  await step('評分頁：影片是鎖定版本，評分表帶判準', async () => {
    const w = await call('judgeGetWork', j1, team('team01'));
    assert.equal(w.video.path, 'videos/team01_v1.mp4');
    assert.equal(w.rubric.items.length, 4);
    assert.equal(w.rubric.total, 100);
    assert.equal(w.canEdit, true);
    await expectErr(/不在評分名單/, 'judgeGetWork', j1, team('team03'));
  });

  await step('主辦方不能呼叫評審的評分功能、評審不能看評分進度', async () => {
    await expectErr(/不能使用此功能/, 'judgeSubmit', admin, team('team01'), {});
    await expectErr(/不能使用此功能/, 'adminListScores', j1);
    await expectErr(/不能使用此功能/, 'adminReturnScore', j1, 'x', 'y');
  });

  await step('暫存：可以只填一部分；超過滿分、不是整數被拒', async () => {
    const r = await call('judgeSaveDraft', j1, team('team01'), { items: { [ids[0]]: 35 }, strengths: '草稿' });
    assert.equal(r.status, 'draft');
    await expectErr(/0～40 之間/, 'judgeSaveDraft', j1, team('team01'), { items: { [ids[0]]: 41 } });
    await expectErr(/整數/, 'judgeSaveDraft', j1, team('team01'), { items: { [ids[0]]: 3.5 } });
    await expectErr(/分數要是數字/, 'judgeSaveDraft', j1, team('team01'), { items: { [ids[0]]: 'abc' } });
    const w = await call('judgeGetWork', j1, team('team01'));
    assert.equal(w.score.items[ids[0]], 35);
    assert.equal(w.score.strengths, '草稿');
  });

  await step('正式送出：每項都要給分、評語要達最少字數', async () => {
    await expectErr(/還有 3 個項目/, 'judgeSubmit', j1, team('team01'), { items: { [ids[0]]: 35 }, ...GOOD });
    await expectErr(/作品優點」至少要 10 個字/, 'judgeSubmit', j1, team('team01'), { items: items(35, 20, 20, 8), strengths: '很好', improvements: GOOD.improvements });
    await expectErr(/改進建議」至少要 10 個字/, 'judgeSubmit', j1, team('team01'), { items: items(35, 20, 20, 8), strengths: GOOD.strengths, improvements: '　'.repeat(12) });
  });

  await step('正式送出成功：總分由伺服器計算（不採用前端傳的總分）', async () => {
    const r = await call('judgeSubmit', j1, team('team01'), { items: items(35, 20, 20, 8), total: 100, ...GOOD });
    assert.equal(r.status, 'submitted');
    assert.equal(r.total, 83);
    const l = await call('judgeListWorks', j1);
    assert.equal(l.done, 1);
    assert.equal(l.works.find(w => w.code === 'team01').total, 83);
  });

  await step('送出後評審不能再改（暫存、送出都被擋）', async () => {
    await expectErr(/需要主辦方退回/, 'judgeSaveDraft', j1, team('team01'), { items: items(1, 1, 1, 1) });
    await expectErr(/需要主辦方退回/, 'judgeSubmit', j1, team('team01'), { items: items(1, 1, 1, 1), ...GOOD });
    assert.equal((await call('judgeGetWork', j1, team('team01'))).canEdit, false);
  });

  await step('評審讀不到別人的評分（P1 延後的驗收項目）', async () => {
    const w = await call('judgeGetWork', j2, team('team01'));
    assert.equal(w.score.status, 'none');
    assert.deepEqual(w.score.items, {});
    const text = JSON.stringify(w) + JSON.stringify(await call('judgeListWorks', j2));
    for (const leak of ['作品完整', '對照組', '"total":83', '測試評審1']) assert.ok(!text.includes(leak), '不應出現 ' + leak);
  });

  await step('主辦方評分進度：矩陣顯示每位評審的狀態與總分', async () => {
    const r = await call('adminListScores', admin);
    assert.equal(r.totalWorks, 2);
    assert.equal(r.completeWorks, 0);
    const row = r.rows.find(x => x.code === 'team01');
    assert.deepEqual(row.cells.map(c => c.label), ['已送出', '未評', '未評', '未評', '未評']);
    assert.equal(row.cells[0].total, 83);
    assert.equal(row.cells[0].judge, '測試評審1');
    assert.equal(r.judges[0].done, 1);
  });

  let sid;
  await step('主辦方退回：必填原因、只有已送出的可以退回', async () => {
    sid = (await call('adminListScores', admin)).rows.find(x => x.code === 'team01').cells[0].scoreId;
    await expectErr(/必須填寫原因/, 'adminReturnScore', admin, sid, ' ');
    await call('adminReturnScore', admin, sid, '「課程相關」分數與評語不一致，請再確認');
    await expectErr(/只有已正式送出/, 'adminReturnScore', admin, sid, '再退一次');
    const d = await call('adminGetScore', admin, sid);
    assert.equal(d.status, 'returned');
    assert.equal(d.canReturn, false);
  });

  await step('被退回：評審看到原因與原本的分數，可以修改後重新送出', async () => {
    const w = await call('judgeGetWork', j1, team('team01'));
    assert.equal(w.score.status, 'returned');
    assert.match(w.score.returnReason, /課程相關/);
    assert.equal(w.score.items[ids[1]], 20);
    assert.equal(w.canEdit, true);
    assert.equal((await call('judgeListWorks', j1)).done, 0, '被退回的不算完成');
    await call('judgeSaveDraft', j1, team('team01'), { items: items(35, 15, 20, 8), ...GOOD });
    assert.equal((await call('judgeGetWork', j1, team('team01'))).score.status, 'returned', '暫存後仍標示被退回');
    const r = await call('judgeSubmit', j1, team('team01'), { items: items(35, 15, 20, 8), ...GOOD });
    assert.equal(r.total, 78);
  });

  await step('更正歷程保留：送出 → 退回（原因、操作人）→ 重新送出', async () => {
    const d = await call('adminGetScore', admin, sid);
    assert.deepEqual(d.history.map(h => h.action), ['submit', 'return', 'resubmit']);
    assert.equal(d.history[1].actor, '主辦人員');
    assert.match(d.history[1].reason, /課程相關/);
    assert.equal(d.history[0].total, 83);
    assert.equal(d.history[2].total, 78);
  });

  await step('替補評審：前任已送出的不用再評、前任的暫存不會帶給替補者', async () => {
    await call('judgeSubmit', j2, team('team01'), { items: items(30, 20, 20, 9), ...GOOD });
    await call('judgeSaveDraft', j2, team('team02'), { items: { [ids[0]]: 30 }, strengths: '前任的草稿內容' });
    const accs = await call('adminListAccounts', admin);
    const sub = await call('adminUpsertAccount', admin, { loginId: 'judge06', name: '替補評審', role: 'judge' });
    await call('adminAssignSlot', admin, 2, accs.find(a => a.loginId === 'judge05').id, '先移走 judge05')
      .then(() => assert.fail('judge05 已經坐評審5，應該失敗'), () => {});
    await call('adminAssignSlot', admin, 2, sub.account.id, '原評審請病假');
    const j6 = (await call('login', 'judge06', sub.tempPassword)).token;
    const l = await call('judgeListWorks', j6);
    assert.deepEqual(l.works.map(w => w.status), ['others', 'none']);
    const w1 = await call('judgeGetWork', j6, team('team01'));
    assert.equal(w1.canEdit, false);
    assert.match(w1.score.note, /前任評審完成/);
    assert.ok(!JSON.stringify(w1).includes('作品完整'), '看不到前任的評語');
    const w2 = await call('judgeGetWork', j6, team('team02'));
    assert.deepEqual(w2.score.items, {});
    assert.equal(w2.score.strengths, '');
    assert.match(w2.score.note, /重新完整評分/);
    await call('judgeSubmit', j6, team('team02'), { items: items(33, 22, 22, 9), ...GOOD });
    const cell = (await call('adminListScores', admin)).rows.find(x => x.code === 'team02').cells[1];
    assert.equal(cell.judge, '替補評審');
    assert.equal(cell.total, 86);
  });

  await step('被換下的評審沒有席位，不能再評分', async () => {
    await expectErr(/沒有被指派評審席位/, 'judgeSubmit', j2, team('team02'), { items: items(1, 1, 1, 1), ...GOOD });
    assert.match((await call('judgeListWorks', j2)).message, /沒有被指派/);
  });

  await step('前任評審的評分被退回：由席位目前的評審重新評分', async () => {
    const s = (await call('adminListScores', admin)).rows.find(x => x.code === 'team01').cells[1];
    await call('adminReturnScore', admin, s.scoreId, '分數有誤');
    const j6 = (await call('login', 'judge06', (await call('adminResetPassword', admin, (await call('adminListAccounts', admin)).find(a => a.loginId === 'judge06').id)).tempPassword)).token;
    const w = await call('judgeGetWork', j6, team('team01'));
    assert.equal(w.canEdit, true);
    assert.deepEqual(w.score.items, {}, '看不到前任的分數');
    assert.match(w.score.returnReason, /分數有誤/);
    await call('judgeSubmit', j6, team('team01'), { items: items(30, 20, 20, 10), ...GOOD });
    const d = await call('adminGetScore', admin, s.scoreId);
    assert.equal(d.judge, '替補評審');
    assert.deepEqual(d.history.map(h => h.action), ['submit', 'return', 'resubmit']);
  });

  await step('收齊 5 份才算完成；評分進度正確', async () => {
    for (const k of ['j3', 'j4', 'j5']) {
      await call('judgeSubmit', judges[k], team('team01'), { items: items(30, 20, 20, 8), ...GOOD });
    }
    const r = await call('adminListScores', admin);
    assert.equal(r.rows.find(x => x.code === 'team01').complete, true);
    assert.equal(r.rows.find(x => x.code === 'team02').complete, false);
    assert.equal(r.completeWorks, 1);
  });

  await step('評審送出寫入操作紀錄', async () => {
    const logs = await call('adminLogs', admin);
    assert.ok(logs.some(l => l.action === 'judge_submit' && l.target === 'team01'));
    assert.ok(logs.some(l => l.action === 'return_score'));
  });

  await step('3 位評審模式：只有評審1～3，收齊 3 份就完成', async () => {
    const s3 = await judgingSetup(3);
    const r0 = await s3.call('judgeListWorks', s3.judges.j4);
    assert.match(r0.message, /沒有被指派/, '評審4 在 3 人模式沒有席位');
    for (const k of ['j1', 'j2', 'j3']) await s3.call('judgeSubmit', s3.judges[k], s3.team('team01'), { items: s3.items(40, 25, 25, 10), ...GOOD });
    const r = await s3.call('adminListScores', s3.admin);
    assert.equal(r.judgeCount, 3);
    assert.equal(r.rows[0].cells.length, 3);
    assert.equal(r.completeWorks, 1);
  });
}

/* ═════════════ P5 結算、同分、匯出、公布 ═════════════ */
console.log('P5 結算與公布');
{
  const { db, call, expectErr, admin, judges, team, items } = await judgingSetup(5, { teams: 4, fail: [] });
  const S = { 80: [32, 20, 20, 8], 90: [36, 22, 23, 9], 85: [34, 21, 22, 8], 81: [32, 21, 20, 8], 79: [32, 19, 20, 8] };
  const give = async (code, totals) => {
    for (let i = 0; i < totals.length; i++) await call('judgeSubmit', judges['j' + (i + 1)], team(code), { items: items(...S[totals[i]]), ...GOOD });
  };
  await give('team01', [80, 80, 80, 80, 80]);        // 400，平均 80
  await give('team02', [90, 90, 90, 90]);            // 只有 4 份
  await give('team03', [80, 80, 80, 80, 80]);        // 400，和 team01 同分
  await give('team04', [81, 80, 80, 80, 79]);        // 81+80+80+80+79 = 400，也同分
  const T = c => team(c);

  await step('評分沒收齊不能進入結算，並列出缺幾份', async () => {
    await expectErr(/team02（4\/5）/, 'adminSetPhase', admin, 'settling');
  });

  await step('排名預覽：只收到 4 份的作品標示待完成，不算平均', async () => {
    const r = await call('adminRanking', admin);
    const t2 = r.incomplete.find(x => x.code === 'team02');
    assert.equal(t2.submitted, 4);
    assert.equal(t2.average, null);
    assert.equal(t2.rank, null);
    assert.equal(r.ready, false);
  });

  await step('第 5 份送出後正確計算平均，可以進入結算', async () => {
    await call('judgeSubmit', judges.j5, T('team02'), { items: items(...S[85]), ...GOOD });
    const t2 = (await call('adminRanking', admin)).rows.find(x => x.code === 'team02');
    assert.equal(t2.sum, 445);
    assert.equal(t2.average, 89);
    await call('adminSetPhase', admin, 'settling');
  });

  await step('同分：三組總分都是 400，名次 1、2、2、2，需要處理才能公布', async () => {
    const r = await call('adminRanking', admin);
    assert.deepEqual(r.rows.map(x => [x.code, x.rank, x.tied]), [['team02', 1, false], ['team01', 2, true], ['team03', 2, true], ['team04', 2, true]]);
    assert.equal(r.ties.length, 1);
    assert.deepEqual(r.ties[0].codes, ['team01', 'team03', 'team04']);
    assert.equal(r.pendingTies, 1);
    await expectErr(/還有 1 組同分沒有處理/, 'adminPublish', admin);
  });

  await step('同分處理：必填理由、群組要完全相同、順序不能重複', async () => {
    const g = [T('team01'), T('team03'), T('team04')];
    await expectErr(/必須填寫理由/, 'adminDecideTie', admin, g, 'tied', ' ');
    await expectErr(/找不到這個同分群組/, 'adminDecideTie', admin, [T('team01'), T('team03')], 'tied', '理由');
    await expectErr(/不能重複/, 'adminDecideTie', admin, g, [T('team01'), T('team01'), T('team03')], '理由');
    await expectErr(/每一組/, 'adminDecideTie', admin, g, [T('team01'), T('team03'), T('team02')], '理由');
  });

  await step('決定先後：名次依主辦方決定排列，並保留理由與決定人', async () => {
    await call('adminDecideTie', admin, [T('team04'), T('team01'), T('team03')], [T('team03'), T('team01'), T('team04')], '依「應用及整合性」分項總和較高者在前');
    const r = await call('adminRanking', admin);
    assert.deepEqual(r.rows.map(x => [x.code, x.rank, x.tied]), [['team02', 1, false], ['team03', 2, false], ['team01', 3, false], ['team04', 4, false]]);
    assert.equal(r.ties[0].decision.type, 'order');
    assert.equal(r.ties[0].decision.by, '主辦人員');
    assert.equal(r.ready, true);
  });

  await step('匯出 CSV：每位評審總分與姓名、平均、名次、同分處理紀錄；防止公式注入', async () => {
    await call('adminUpsertTeam', admin, { id: T('team04'), name: '=HYPERLINK("http://x")', workTitle: '作品, "四"' });
    const { filename, csv } = await call('adminExportCsv', admin);
    assert.match(filename, /成績_\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = csv.trim().split('\r\n');
    assert.match(lines[0], /^名次,並列,組別代碼,組別名稱,作品名稱,評分版本,評審1總分,評審1姓名/);
    assert.match(lines[0], /評審5總分,評審5姓名,總分合計,平均,同分處理$/);
    assert.match(lines[1], /^1,,team02,/);
    assert.match(lines[1], /,445,89\.00,$/);
    assert.match(lines[2], /^2,,team03,.*順序 team03 > team01 > team04；理由：依「應用及整合性」/);
    assert.ok(lines[4].includes(`"'=HYPERLINK(""http://x"")"`), '公式開頭要加單引號');
    assert.ok(lines[4].includes('"作品, ""四"""'), '逗號與引號要正確跳脫');
    assert.ok(lines[1].includes('測試評審1'), '主辦方匯出含評審姓名');
  });

  await step('公布前：公開頁看不到任何分數', async () => {
    const r = await call('publicResults');
    assert.equal(r.published, false);
    assert.ok(!JSON.stringify(r).includes('445'));
  });

  await step('公布：公開結果有名次、平均、評審1～5 的評語，沒有評審姓名、沒有分項', async () => {
    await call('adminPublish', admin);
    const r = await call('publicResults');
    assert.equal(r.published, true);
    assert.deepEqual(r.teams.map(x => [x.code, x.rank]), [['team02', 1], ['team03', 2], ['team01', 3], ['team04', 4]]);
    assert.deepEqual(r.teams.map(x => x.tieBroken), [false, true, true, true], '同分由主辦方決定先後的組別要標示');
    assert.equal(r.teams[0].average, 89);
    assert.deepEqual(r.teams[0].judges.map(j => j.label), ['評審1', '評審2', '評審3', '評審4', '評審5']);
    assert.equal(r.teams[0].judges[0].strengths, GOOD.strengths);
    assert.equal(r.items, null);
    const text = JSON.stringify(r);
    for (const leak of ['測試評審', 'judge0', '依「應用及整合性」', 'accountId']) assert.ok(!text.includes(leak), '不應出現 ' + leak);
    assert.equal((await call('adminGetBoard', admin)).competition.phase, 'published');
  });

  await step('公布後：評審不能再評分、主辦方不能退回評分或改同分處理', async () => {
    await expectErr(/目前不是評分階段/, 'judgeSubmit', judges.j1, T('team01'), { items: items(...S[80]), ...GOOD });
    const sid = (await call('adminListScores', admin)).rows[0].cells[0].scoreId;
    await expectErr(/目前階段不能退回/, 'adminReturnScore', admin, sid, '原因');
    await expectErr(/只有「結算」階段/, 'adminDecideTie', admin, [T('team01'), T('team03'), T('team04')], 'tied', '理由');
    await expectErr(/只有「結算」階段可以公布/, 'adminPublish', admin);
  });

  await step('公開結果是快照：之後資料庫的分數變動不會影響已公布的結果', async () => {
    const saved = db._tables.scores.map(s => s.total);
    db._tables.scores.forEach(s => { s.total = 0; });
    const r = await call('publicResults');
    assert.equal(r.teams[0].average, 89);
    assert.equal(r.teams[0].judges[0].total, 90);
    db._tables.scores.forEach((s, i) => { s.total = saved[i]; });
  });

  await step('撤回：必填原因；撤回後公開頁看不到結果，回到結算', async () => {
    await expectErr(/必須填寫原因/, 'adminRevoke', admin, '');
    await call('adminRevoke', admin, '同分處理方式需改為並列');
    assert.equal((await call('publicResults')).published, false);
    assert.equal((await call('adminGetBoard', admin)).competition.phase, 'settling');
  });

  await step('改成並列後重新公布：三組都是第 2 名並標示並列；設定顯示分項後公開結果帶分項', async () => {
    await call('adminDecideTie', admin, [T('team01'), T('team03'), T('team04')], 'tied', '校方決定同分並列');
    await call('adminUpdateCompetition', admin, { showItemScores: true });
    await call('adminPublish', admin);
    const r = await call('publicResults');
    assert.deepEqual(r.teams.map(x => [x.code, x.rank, x.tied]), [['team02', 1, false], ['team01', 2, true], ['team03', 2, true], ['team04', 2, true]]);
    assert.equal(r.items.length, 4);
    assert.equal(Object.keys(r.teams[0].judges[0].items).length, 4);
  });

  await step('回到評分、退回改分後，舊的同分處理不再適用', async () => {
    await call('adminRevoke', admin, '要請評審修改');
    await call('adminSetPhase', admin, 'judging');
    const row = (await call('adminListScores', admin)).rows.find(x => x.code === 'team04');
    await call('adminReturnScore', admin, row.cells[0].scoreId, '請再確認');
    await call('judgeSubmit', judges.j1, T('team04'), { items: items(...S[79]), ...GOOD });   // 81 → 79，總分 398
    await call('adminSetPhase', admin, 'settling');
    const r = await call('adminRanking', admin);
    assert.equal(r.rows.find(x => x.code === 'team04').rank, 4);
    assert.deepEqual(r.ties[0].codes, ['team01', 'team03']);
    assert.equal(r.ties[0].decision, null, '群組變了，要重新處理');
    assert.equal(r.ready, false);
  });

  await step('操作紀錄包含同分處理、匯出、公布、撤回', async () => {
    const actions = (await call('adminLogs', admin)).map(l => l.action);
    for (const a of ['decide_tie', 'export_csv', 'publish', 'revoke']) assert.ok(actions.includes(a), a);
  });

  await step('評審不能使用結算功能', async () => {
    for (const fn of ['adminRanking', 'adminDecideTie', 'adminExportCsv', 'adminPublish', 'adminRevoke']) await expectErr(/不能使用此功能/, fn, judges.j1);
  });
}

/* ═════════════ P7 AI 評審（用假的 Gemini，不會真的呼叫 Google） ═════════════ */
console.log('P7 AI 評審');
function fakeGemini() {
  const g = {
    model: 'fake-model', uploads: [], ticks: {}, deleted: [], replies: [], calls: 0, lastPrompt: '', uploadFail: false, fileFailed: false,
    async uploadFromUrl(url) {
      if (g.uploadFail) throw new Error('下載影片失敗（HTTP 404）');
      g.uploads.push(url);
      const name = 'files/f' + g.uploads.length;
      g.ticks[name] = 1;                       // 第一次查詢還在處理中
      return { name, uri: 'https://gemini.test/' + name, state: 'PROCESSING' };
    },
    async getFile(name) {
      if (g.ticks[name] > 0) { g.ticks[name]--; return { name, state: 'PROCESSING' }; }
      return { name, uri: 'https://gemini.test/' + name, state: g.fileFailed ? 'FAILED' : 'ACTIVE' };
    },
    async deleteFile(name) { g.deleted.push(name); },
    async generate(uri, prompt) {
      g.calls++;
      g.lastPrompt = prompt;
      await new Promise(r => setTimeout(r, 5));
      const r = g.replies.shift();
      if (r instanceof Error) throw r;
      return { text: typeof r === 'string' ? r : JSON.stringify(r), usage: { totalTokenCount: 1234 }, finishReason: 'STOP' };
    },
  };
  return g;
}
const AI_OK = { strengths: '作品完整，操作展示清楚，說明有條理', improvements: '可以補充測試數據與對照組，並說明限制' };
const aiReply = (scores, extra) => Object.assign({
  items: scores.map((s, i) => ({ no: i + 1, score: s, reason: '理由' + (i + 1), evidence: [{ time: '1:05', note: '示範' }, { time: '99:00', note: '超出片長' }] })),
}, AI_OK, extra || {});
{
  await step('設定：AI 評審開關、總份數 M＝N＋1；沒設定金鑰時不能開始評分', async () => {
    const pre = await setup({ judgeCount: 3, aiJudge: true });
    const admin = (await pre.call('login', 'admin01', 'admin-pass-01')).token;
    let c = (await pre.call('adminGetBoard', admin)).competition;
    assert.deepEqual([c.judgeCount, c.aiJudge, c.seats, c.aiSlot, c.aiConfigured], [3, true, 4, 4, false]);
    await pre.call('adminSetPhase', admin, 'collecting');
    const p = await pre.call('adminJudgingPreview', admin);
    assert.ok(p.problems.some(x => /GEMINI_API_KEY/.test(x)));
    c = (await pre.call('adminUpdateCompetition', admin, { aiJudge: false })).competition;
    assert.deepEqual([c.aiJudge, c.seats, c.aiSlot], [false, 3, null]);
    assert.ok(!(await pre.call('adminJudgingPreview', admin)).problems.some(x => /GEMINI/.test(x)));
    await expectErrOf(pre, /沒有開啟 AI 評審/, 'adminAiStart', admin, 'x');
  });

  const g = fakeGemini();
  const { db, call, expectErr, admin, judges, team, ids, items, board } = await judgingSetup(3, { aiJudge: true, gemini: g });
  const aiSeat = board.slots.find(s => s.slot === 4);
  const runTo = async (teamId, rerun) => {     // 模擬後台：開始 → 一直查到不是進行中
    let r = await call('adminAiStart', admin, teamId, rerun);
    for (let i = 0; i < 10 && ['uploading', 'processing', 'generating'].includes(r.status); i++) r = await call('adminAiStep', admin, r.id);
    return r;
  };
  const aiScore = async code => (await call('adminAiOverview', admin)).rows.find(x => x.code === code).score;

  await step('開始評分：AI 帳號自動坐進席位 4；不出現在帳號管理、不能登入、不能設密碼、不能修改', async () => {
    assert.ok(aiSeat && aiSeat.isAi);
    assert.deepEqual(board.slots.map(s => s.slot), [1, 2, 3, 4]);
    const accs = await call('adminListAccounts', admin);
    assert.ok(!accs.some(a => a.role === 'ai'));
    const ai = db._tables.accounts.find(a => a.role === 'ai');
    assert.match(ai.login_id, /^ai-[0-9a-f]{8}$/);
    await expectErr(/帳號或密碼不正確/, 'login', ai.login_id, 'anything-123');
    await expectErr(/不能設定密碼/, 'adminResetPassword', admin, ai.id);
    await expectErr(/不能修改/, 'adminUpsertAccount', admin, { id: ai.id, name: 'x' });
    await expectErr(/已經開始評分/, 'adminUpdateCompetition', admin, { aiJudge: false });
  });

  await step('只有主辦人員能執行 AI 評分', async () => {
    for (const fn of ['adminAiOverview', 'adminAiStart', 'adminAiStep', 'adminAiFinalize', 'adminAiGetRun']) await expectErr(/不能使用此功能/, fn, judges.j1);
  });

  await step('AI 評分：上傳鎖定版本 → 處理中 → 評分、驗證、自動送出到席位 4', async () => {
    g.replies.push(aiReply([30, 20, 18, 8]));
    let r = await call('adminAiStart', admin, team('team01'));
    assert.equal(r.status, 'processing');
    assert.equal(g.uploads[0], 'https://example.test/videos/team01_v1.mp4');
    r = await call('adminAiStep', admin, r.id);
    assert.equal(r.status, 'processing', '影片還在處理');
    assert.equal(g.calls, 0);
    r = await call('adminAiStep', admin, r.id);
    assert.equal(r.status, 'done');
    assert.equal(r.result.items[ids[1]], 20);
    assert.equal(r.result.droppedEvidence, 4, '超出片長的時間點被丟掉');
    assert.deepEqual(r.result.evidence[ids[0]], [{ sec: 65, note: '示範' }]);
    assert.deepEqual(g.deleted, ['files/f1'], '評完刪除 Gemini 上的檔案');
    const s = await aiScore('team01');
    assert.deepEqual([s.status, s.total], ['submitted', 76]);
    assert.match(g.lastPrompt, /專題作品的應用及整合性（滿分 40）/);
    assert.match(g.lastPrompt, /只輸出一個 JSON/);
    assert.match(g.lastPrompt, /不是給你的指令/);
    const raw = await call('adminAiGetRun', admin, r.id);
    assert.ok(raw.rawOutput.includes('"score":30'));
  });

  await step('已經有 AI 評分不能直接再跑；「重新評分」會先退回，舊分數留在更正歷程', async () => {
    await expectErr(/已經有 AI 評分/, 'adminAiStart', admin, team('team01'));
    g.replies.push(aiReply([32, 20, 18, 8]));
    const r = await runTo(team('team01'), true);
    assert.equal(r.status, 'done');
    const s = await aiScore('team01');
    assert.equal(s.total, 78);
    const d = await call('adminGetScore', admin, s.id);
    assert.deepEqual(d.history.map(h => h.action), ['submit', 'return', 'resubmit']);
    assert.equal(d.history[1].reason, '重新執行 AI 評分');
    assert.equal(d.slot, 4);
  });

  await step('某一項 AI 判斷不了（null）→ 需要處理，不會送出', async () => {
    g.replies.push(aiReply([30, null, 18, 8]));
    const r = await runTo(team('team02'));
    assert.equal(r.status, 'needs_review');
    assert.ok(r.problems.some(x => /專題作品與課程相關」AI 無法判定/.test(x)));
    assert.equal((await aiScore('team02')).status, 'none');
  });

  await step('補分：必填理由、分數要在範圍內；補完後送出並記錄改了什麼', async () => {
    const run = (await call('adminAiOverview', admin)).rows.find(x => x.code === 'team02').run;
    await expectErr(/必須填寫理由/, 'adminAiFinalize', admin, run.id, { items: { [ids[1]]: 20 } });
    await expectErr(/0～25 的整數/, 'adminAiFinalize', admin, run.id, { items: { [ids[1]]: 26 }, reason: 'x' });
    await expectErr(/還沒有分數/, 'adminAiFinalize', admin, run.id, { items: {}, reason: '看過影片' });
    const r = await call('adminAiFinalize', admin, run.id, { items: { [ids[1]]: 21 }, reason: '主辦人員看過影片，依判準補分' });
    assert.equal(r.status, 'finalized');
    assert.deepEqual(r.manual.items[ids[1]], { from: null, to: 21 });
    assert.equal((await aiScore('team02')).total, 30 + 21 + 18 + 8);
    await expectErr(/只有「需要處理」/, 'adminAiFinalize', admin, run.id, { items: {}, reason: 'x' });
    const actions = (await call('adminLogs', admin)).map(l => l.action);
    for (const a of ['ai_start', 'ai_score', 'ai_needs_review', 'ai_finalize']) assert.ok(actions.includes(a), a);
  });

  await step('回應格式錯誤、分數超出範圍、評語太短 → 需要處理；原本已送出的 AI 評分保持不變', async () => {
    g.replies.push('這不是 JSON');
    let r = await runTo(team('team02'), true);
    assert.equal(r.status, 'needs_review');
    assert.match(r.problems[0], /不是規定的 JSON/);
    assert.equal((await aiScore('team02')).total, 77, '舊的 AI 評分還在');
    g.replies.push(aiReply([45, 20, 18, 8], { strengths: '好' }));
    r = await runTo(team('team02'), true);
    assert.ok(r.problems.some(x => /45 超出 0～40/.test(x)));
    assert.ok(r.problems.some(x => /作品優點」少於 10 個字/.test(x)));
    g.replies.push('```json\n' + JSON.stringify(aiReply([31, 20, 18, 8])) + '\n```');
    r = await runTo(team('team02'), true);
    assert.equal(r.status, 'done', '包在 ```json 裡的回應也能解析');
    assert.equal((await aiScore('team02')).total, 77);
  });

  await step('失敗：下載影片失敗、Gemini 處理失敗、評分呼叫失敗 → failed 並顯示原因，可以再試', async () => {
    g.uploadFail = true;
    let r = await call('adminAiStart', admin, team('team01'), true);
    assert.equal(r.status, 'failed');
    assert.match(r.error, /HTTP 404/);
    g.uploadFail = false;
    g.fileFailed = true;
    r = await runTo(team('team01'), true);
    assert.equal(r.status, 'failed');
    assert.match(r.error, /無法處理這支影片/);
    g.fileFailed = false;
    g.replies.push(new Error('AI 評分失敗（HTTP 429）：Resource exhausted'));
    r = await runTo(team('team01'), true);
    assert.equal(r.status, 'failed');
    assert.match(r.error, /429/);
    assert.equal((await aiScore('team01')).total, 78, '失敗不影響已送出的 AI 評分');
  });

  await step('同一步驟同時按兩次，只會送出一次評分請求；進行中不能再開始', async () => {
    g.replies.push(aiReply([33, 20, 18, 8]));
    let r = await call('adminAiStart', admin, team('team01'), true);
    await expectErr(/正在進行中/, 'adminAiStart', admin, team('team01'), true);
    r = await call('adminAiStep', admin, r.id);      // 處理中
    const before = g.calls;
    const [a, b] = await Promise.all([call('adminAiStep', admin, r.id), call('adminAiStep', admin, r.id)]);
    assert.equal(g.calls - before, 1);
    assert.ok([a.status, b.status].includes('done'));
  });

  await step('評分中斷太久（例如關掉頁面）會被標成失敗，可以重新執行', async () => {
    g.replies.push(aiReply([33, 20, 18, 8]));
    const r = await call('adminAiStart', admin, team('team02'), true);
    db._tables.ai_runs.find(x => x.id === r.id).status = 'generating';
    tick(7 * 60);
    const r2 = await call('adminAiStep', admin, r.id);
    assert.equal(r2.status, 'failed');
    assert.match(r2.error, /逾時/);
    g.replies.length = 0;
  });

  await step('結算：每件作品要收齊 3 位老師＋AI＝4 份，平均 ÷ 4', async () => {
    for (const code of ['team01', 'team02']) {
      for (const j of ['j1', 'j2', 'j3']) await call('judgeSubmit', judges[j], team(code), { items: items(30, 20, 20, 10), ...GOOD });
    }
    const p = await call('adminListScores', admin);
    assert.equal(p.judgeCount, 4);
    assert.equal(p.judges[3].isAi, true);
    assert.equal(p.completeWorks, 2);
    const r = await call('adminRanking', admin);
    const t1 = r.rows.find(x => x.code === 'team01');
    assert.equal(r.judgeCount, 4);
    assert.equal(t1.sum, 80 * 3 + 79);
    assert.equal(t1.average, (80 * 3 + 79) / 4);
    await call('adminSetPhase', admin, 'settling');
  });

  await step('AI 評分沒有送出就不能結算', async () => {
    const x = await judgingSetup(3, { aiJudge: true, gemini: fakeGemini(), teams: 1, fail: [] });
    for (const j of ['j1', 'j2', 'j3']) await x.call('judgeSubmit', x.judges[j], x.team('team01'), { items: x.items(30, 20, 20, 10), ...GOOD });
    await expectErrOf(x, /team01（3\/4）/, 'adminSetPhase', x.admin, 'settling');
  });

  await step('匯出 CSV 標示 AI 與模型；公開結果只顯示評審1～4，看不出哪一位是 AI', async () => {
    const csv = (await call('adminExportCsv', admin)).csv;
    assert.match(csv.split('\r\n')[0], /評審4總分,評審4姓名/);
    assert.match(csv, /AI 評審（Gemini）（fake-model）/);
    await call('adminPublish', admin);
    const pub = await call('publicResults');
    assert.equal(pub.judgeCount, 4);
    assert.deepEqual(pub.teams[0].judges.map(j => j.label), ['評審1', '評審2', '評審3', '評審4']);
    const text = JSON.stringify(pub);
    for (const leak of ['AI', 'Gemini', 'fake-model', 'ai-']) assert.ok(!text.includes(leak), '不應出現 ' + leak);
  });

  await step('公布後不能再執行 AI 評分', async () => {
    await expectErr(/只有「評分」或「結算」/, 'adminAiStart', admin, team('team01'), true);
  });
}
console.log('P7 Gemini 用戶端（假的 HTTP，不會連到 Google）');
{
  const { createGemini } = await import('../supabase/functions/api/gemini.js');
  const okBody = { candidates: [{ content: { parts: [{ text: '{"items":[]}' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 9 } };
  const make = (statuses) => {
    const seen = [], waits = [];
    let t = 0;
    const g = createGemini({
      apiKey: 'test-key', model: 'm',
      fetchImpl: async (url, opt) => {
        seen.push({ url, key: opt.headers['x-goog-api-key'] });
        const st = statuses.shift();
        t += 2000;   // 每次請求花 2 秒
        return new Response(JSON.stringify(st === 200 ? okBody : { error: { message: 'This model is currently experiencing high demand.' } }), { status: st });
      },
      sleep: async ms => { waits.push(ms); t += ms; },
      clock: () => t,
    });
    return { g, seen, waits };
  };

  await step('評分請求遇到 503／429 自動重試，成功就回傳結果與嘗試次數', async () => {
    const { g, seen, waits } = make([503, 429, 200]);
    const r = await g.generate('https://gemini.test/files/a', 'prompt');
    assert.equal(r.attempts, 3);
    assert.equal(r.text, '{"items":[]}');
    assert.deepEqual(waits, [4000, 10000]);
    assert.ok(seen.every(s => /models\/m:generateContent$/.test(s.url) && s.key === 'test-key'));
  });

  await step('重試 3 次都忙碌 → 失敗並註明已自動重試；400 之類的錯誤不重試', async () => {
    let { g, waits } = make([503, 503, 503]);
    await assert.rejects(g.generate('u', 'p'), e => /HTTP 503/.test(e.message) && /已自動重試，共 3 次/.test(e.message));
    assert.equal(waits.length, 2);
    ({ g, waits } = make([400]));
    await assert.rejects(g.generate('u', 'p'), e => /HTTP 400/.test(e.message) && !/重試/.test(e.message));
    assert.equal(waits.length, 0);
  });
}

async function expectErrOf(ctx, re, fn, ...args) {
  const r = await ctx.api.handle({ fn, args });
  assert.equal(r.ok, false, fn + ' 應該失敗');
  assert.match(r.error, re);
}

console.log(`\n全部通過：${passed} 項`);
