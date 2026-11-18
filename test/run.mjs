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

console.log(`\n全部通過：${passed} 項`);
