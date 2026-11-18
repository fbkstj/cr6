// 專題競賽評分系統的伺服器邏輯（純 JS）。
// 資料存取全部透過 db（正式：db_supabase.js；本機測試：test/memdb.mjs），這個檔案不碰任何雲端服務，
// 所以同一份程式碼可以在 Supabase Edge Function（Deno）跑，也可以在本機用 Node 測試。
// 設計依據：開發計畫書.md 第 4、8 節。

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;     // 登入有效 12 小時
const LOCK_TRIES = 5, LOCK_MS = 10 * 60 * 1000; // 同一帳號連錯 5 次鎖 10 分鐘
const LOGIN_RE = /^[a-z0-9_-]{3,32}$/;
const ROLES = ['judge', 'admin'];
// 臨時密碼：去掉容易看錯的 0/O、1/l/I
const PW_CHARS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class UserError extends Error {}
const fail = msg => { throw new UserError(msg); };
const iso = t => new Date(t).toISOString();

/* ───────────── 登入 token（HMAC 簽章，不存資料庫） ───────────── */

const enc = new TextEncoder();
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const hmacKey = secret => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

function randomPassword(len = 10) {
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, x => PW_CHARS[x % PW_CHARS.length]).join('');
}

/** 讀網站上的 JSON（影片清單）。測試時可以換成假的 */
async function defaultFetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'Cache-Control': 'no-cache' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

const TEAM_RE = /^team\d{2}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const str = (v, max) => String(v === null || v === undefined ? '' : v).slice(0, max);
const numOrNull = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function createApi({ db, secret, now = () => Date.now(), siteBaseUrl = '', fetchJson = defaultFetchJson }) {
  if (!secret || secret.length < 32) throw new Error('TOKEN_SECRET 沒有設定或太短（至少 32 個字元）');
  const keyP = hmacKey(secret);

  async function sign(data) {
    const body = b64u(enc.encode(JSON.stringify(Object.assign({}, data, { exp: now() + TOKEN_TTL_MS }))));
    const sig = b64u(await crypto.subtle.sign('HMAC', await keyP, enc.encode(body)));
    return body + '.' + sig;
  }

  /** 驗證 token，並重新查帳號：停用、改角色、換競賽都會立刻失效 */
  async function auth(token, role) {
    const [body, sig] = String(token || '').split('.');
    let data = null;
    if (body && sig) {
      try {
        if (await crypto.subtle.verify('HMAC', await keyP, unb64u(sig), enc.encode(body))) {
          data = JSON.parse(new TextDecoder().decode(unb64u(body)));
        }
      } catch (e) { data = null; }
    }
    if (!data || !data.exp || data.exp < now()) fail('AUTH:登入已逾時，請重新登入');
    const acc = await db.getAccount(data.aid);
    if (!acc || !acc.active || acc.role !== data.role || acc.competition_id !== data.cid) fail('AUTH:帳號已停用或權限已變更，請重新登入');
    if (role && acc.role !== role) fail('AUTH:這個帳號不能使用此功能');
    return acc;
  }

  /* ───── 防猜測 ───── */
  async function checkLock(key) {
    const r = await db.getLoginFail(key);
    if (r && r.count >= LOCK_TRIES && new Date(r.until).getTime() > now()) fail('嘗試次數過多，請 10 分鐘後再試');
  }
  async function addFail(key) {
    const r = await db.getLoginFail(key);
    const alive = r && new Date(r.until).getTime() > now();
    await db.setLoginFail(key, (alive ? r.count : 0) + 1, iso(now() + LOCK_MS));
  }

  const log = (acc, action, target, detail) =>
    db.insertAdminLog({ competition_id: acc.competition_id, actor: acc.id, action, target: String(target || ''), detail: detail || {}, at: iso(now()) });

  const accountView = a => ({ id: a.id, loginId: a.login_id, name: a.display_name, role: a.role, active: a.active, hasPassword: !!a.has_password });

  async function competitionView(cid) {
    const c = await db.getCompetition(cid);
    if (!c) fail('找不到競賽');
    return { id: c.id, name: c.name, phase: c.phase, judgeCount: c.judge_count };
  }

  /* ───────────── 登入 ───────────── */

  async function login(loginId, password) {
    loginId = String(loginId || '').trim().toLowerCase();
    if (!LOGIN_RE.test(loginId)) fail('帳號或密碼不正確');
    const key = 'fail:' + loginId;
    await checkLock(key);
    const aid = await db.checkPassword(loginId, String(password || ''));
    if (!aid) { await addFail(key); fail('帳號或密碼不正確'); }
    await db.clearLoginFail(key);
    const acc = await db.getAccount(aid);
    const token = await sign({ aid: acc.id, role: acc.role, cid: acc.competition_id });
    return { token, role: acc.role, me: accountView(acc), competition: await competitionView(acc.competition_id) };
  }

  async function me(token) {
    const acc = await auth(token);
    return { role: acc.role, me: accountView(acc), competition: await competitionView(acc.competition_id) };
  }

  async function changePassword(token, oldPw, newPw) {
    const acc = await auth(token);
    const key = 'fail:' + acc.login_id;
    await checkLock(key);
    if (!(await db.checkPassword(acc.login_id, String(oldPw || '')))) { await addFail(key); fail('原密碼不正確'); }
    newPw = String(newPw || '');
    if (newPw.length < 8) fail('新密碼至少 8 個字');
    if (newPw === oldPw) fail('新密碼不能和原密碼相同');
    await db.setPassword(acc.login_id, newPw);
    return { ok: true };
  }

  /* ───────────── 主辦方：帳號管理 ───────────── */

  async function adminListAccounts(token) {
    const acc = await auth(token, 'admin');
    const list = await db.listAccounts(acc.competition_id);
    const slots = await db.listJudgeSlots(acc.competition_id);
    const slotOf = {};
    slots.forEach(s => { slotOf[s.account_id] = s.slot_no; });
    return list.sort((a, b) => a.login_id.localeCompare(b.login_id))
      .map(a => Object.assign(accountView(a), { slot: slotOf[a.id] || null }));
  }

  /** 新增或修改帳號。新增時回傳一次性的臨時密碼（只顯示這一次） */
  async function adminUpsertAccount(token, input) {
    const acc = await auth(token, 'admin');
    input = input || {};
    const name = String(input.name || '').trim();
    if (!name) fail('請填寫姓名');
    if (input.id) {
      const target = await db.getAccount(input.id);
      if (!target || target.competition_id !== acc.competition_id) fail('找不到這個帳號');
      const patch = { display_name: name };
      if (input.active !== undefined) {
        if (target.id === acc.id && !input.active) fail('不能停用自己的帳號');
        patch.active = !!input.active;
      }
      await db.updateAccount(target.id, patch);
      await log(acc, 'update_account', target.login_id, patch);
      return { account: accountView(Object.assign({}, target, patch)) };
    }
    const loginId = String(input.loginId || '').trim().toLowerCase();
    if (!LOGIN_RE.test(loginId)) fail('帳號只能用小寫英文、數字、底線或減號，3～32 個字');
    if (!ROLES.includes(input.role)) fail('角色只能是評審或主辦人員');
    if (await db.getAccountByLogin(loginId)) fail('這個帳號已經有人使用');
    const created = await db.insertAccount({ competition_id: acc.competition_id, login_id: loginId, display_name: name, role: input.role, active: true });
    const tempPassword = randomPassword();
    await db.setPassword(loginId, tempPassword);
    await log(acc, 'create_account', loginId, { role: input.role });
    return { account: accountView(Object.assign({}, created, { has_password: true })), tempPassword };
  }

  async function adminResetPassword(token, accountId) {
    const acc = await auth(token, 'admin');
    const target = await db.getAccount(accountId);
    if (!target || target.competition_id !== acc.competition_id) fail('找不到這個帳號');
    const tempPassword = randomPassword();
    await db.setPassword(target.login_id, tempPassword);
    await db.clearLoginFail('fail:' + target.login_id);
    await log(acc, 'reset_password', target.login_id);
    return { loginId: target.login_id, tempPassword };
  }

  async function adminLogs(token, limit) {
    const acc = await auth(token, 'admin');
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    const names = {};
    (await db.listAccounts(acc.competition_id)).forEach(a => { names[a.id] = a.display_name; });
    return (await db.listAdminLogs(acc.competition_id, n)).map(l => ({
      at: l.at, actor: names[l.actor] || '（系統）', action: l.action, target: l.target, detail: l.detail,
    }));
  }

  /* ───────────── 主辦方：影片清單同步（P2） ───────────── */

  /** 驗證清單裡的一筆，回傳要寫入的資料；格式不對回傳錯誤訊息字串 */
  function parseManifestEntry(e) {
    if (!e || typeof e !== 'object') return '不是物件';
    const team = String(e.team || '');
    const version = Number(e.version);
    if (!TEAM_RE.test(team)) return '組別代碼格式錯誤';
    if (!Number.isInteger(version) || version < 1 || version > 99) return '版本號錯誤';
    if (!SHA_RE.test(String(e.source_sha256 || ''))) return 'sha256 格式錯誤';
    if (typeof e.check_ok !== 'boolean') return 'check_ok 必須是 true／false';
    const expectPath = `videos/${team}_v${version}.mp4`;
    if (e.check_ok && e.playback_path !== expectPath) return '播放檔路徑應為 ' + expectPath;
    if (!e.check_ok && e.playback_path) return '不合格的版本不應有播放檔';
    return {
      team, version_no: version,
      source_filename: str(e.source_filename, 200) || `${team}_v${version}`,
      source_sha256: e.source_sha256,
      source_size: Math.max(0, Math.floor(numOrNull(e.source_size) || 0)),
      duration_sec: numOrNull(e.duration_sec),
      container: str(e.container, 100) || null, vcodec: str(e.vcodec, 50) || null, acodec: str(e.acodec, 50) || null,
      width: numOrNull(e.width), height: numOrNull(e.height),
      check_ok: e.check_ok, check_notes: str(e.check_notes, 1000),
      playback_path: e.check_ok ? expectPath : null,
      playback_size: e.check_ok ? numOrNull(e.playback_size) : null,
      processed_at: e.processed_at && !isNaN(Date.parse(e.processed_at)) ? iso(e.processed_at) : null,
    };
  }

  /** 讀 Pages 上的 videos/manifest.json，把新版本登錄進資料庫（重複按不會重複建立） */
  async function adminSyncVideos(token) {
    const acc = await auth(token, 'admin');
    if (!siteBaseUrl) fail('伺服器沒有設定 SITE_BASE_URL，請見部署說明');
    const url = siteBaseUrl.replace(/\/?$/, '/') + 'videos/manifest.json?t=' + now();
    let m;
    try { m = await fetchJson(url); } catch (e) { fail('讀不到影片清單（' + (e && e.message || e) + '），請確認已經推送並等 1～2 分鐘網站更新'); }
    if (!m || !Array.isArray(m.versions)) fail('影片清單格式錯誤');

    const teams = await db.listTeams(acc.competition_id);
    const teamByCode = {}, codeById = {};
    teams.forEach(t => { teamByCode[t.code] = t; codeById[t.id] = t.code; });
    const existing = await db.listVersions(acc.competition_id);
    const bySha = {}, byKey = {};
    existing.forEach(v => { bySha[v.source_sha256] = v; byKey[codeById[v.team_id] + '|' + v.version_no] = v; });

    const added = [], warnings = [];
    let skipped = 0;
    for (let i = 0; i < m.versions.length; i++) {
      const row = parseManifestEntry(m.versions[i]);
      if (typeof row === 'string') { warnings.push(`清單第 ${i + 1} 筆：${row}`); continue; }
      const label = `${row.team}_v${row.version_no}`;
      const team = teamByCode[row.team];
      if (!team) { warnings.push(`${label}：還沒有建立 ${row.team} 這個組別，建立後再同步一次`); continue; }
      const same = bySha[row.source_sha256];
      if (same) {
        if (same.team_id === team.id && same.version_no === row.version_no) skipped++;
        else warnings.push(`${label}：和 ${codeById[same.team_id]}_v${same.version_no} 是同一支檔案，略過`);
        continue;
      }
      if (byKey[row.team + '|' + row.version_no]) { warnings.push(`${label}：資料庫已經有這個版本，但檔案不同，請檢查原檔`); continue; }
      const { team: _t, ...data } = row;
      const saved = await db.insertVersion(Object.assign(data, { competition_id: acc.competition_id, team_id: team.id }));
      bySha[row.source_sha256] = saved;
      byKey[row.team + '|' + row.version_no] = saved;
      added.push({ label, checkOk: row.check_ok, notes: row.check_notes });
    }
    await log(acc, 'sync_videos', 'manifest.json', { added: added.map(a => a.label), skipped, warnings: warnings.length });
    return { added, skipped, warnings };
  }

  /* ───────────── 主辦方：競賽、評分表、評審席位（P3） ───────────── */

  const PHASES = ['setup', 'collecting', 'judging', 'settling', 'published'];
  const PHASE_LABEL = { setup: '準備', collecting: '收件審查', judging: '評分', settling: '結算', published: '已公布' };
  const REVIEW_STATUS = ['pending', 'pass', 'resubmit', 'fail'];
  const beforeJudging = c => c.phase === 'setup' || c.phase === 'collecting';
  const needBeforeJudging = (c, what) => { if (!beforeJudging(c)) fail(`已經開始評分，不能再${what}`); };

  async function compOf(acc) {
    const c = await db.getCompetition(acc.competition_id);
    if (!c) fail('找不到競賽');
    return c;
  }

  function competitionFull(c) {
    return {
      id: c.id, name: c.name, phase: c.phase, phaseLabel: PHASE_LABEL[c.phase], judgeCount: c.judge_count,
      showStatusPage: !!c.show_status_page, showItemScores: !!c.show_item_scores, minCommentChars: c.min_comment_chars,
    };
  }

  async function rubricView(c) {
    const r = await db.getRubric(c.rubric_id);
    if (!r) return { id: null, locked: false, items: [], total: 0 };
    const items = r.items.slice().sort((a, b) => a.sort - b.sort)
      .map(i => ({ id: i.id, title: i.title, max: i.max_score, description: i.description || '' }));
    return { id: r.id, locked: !!r.locked, items, total: items.reduce((s, i) => s + i.max, 0) };
  }

  async function adminUpdateCompetition(token, input) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    input = input || {};
    const patch = {};
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name || name.length > 100) fail('競賽名稱 1～100 個字');
      patch.name = name;
    }
    if (input.judgeCount !== undefined && Number(input.judgeCount) !== c.judge_count) {
      needBeforeJudging(c, '改評審人數');
      if (![3, 5].includes(Number(input.judgeCount))) fail('評審人數只能是 3 或 5');
      patch.judge_count = Number(input.judgeCount);
    }
    if (input.showStatusPage !== undefined) patch.show_status_page = !!input.showStatusPage;
    if (input.showItemScores !== undefined) patch.show_item_scores = !!input.showItemScores;
    if (input.minCommentChars !== undefined) {
      const n = Number(input.minCommentChars);
      if (!Number.isInteger(n) || n < 0 || n > 200) fail('評語最少字數 0～200');
      if (n !== c.min_comment_chars) { needBeforeJudging(c, '改評語最少字數'); patch.min_comment_chars = n; }
    }
    if (!Object.keys(patch).length) return { competition: competitionFull(c) };
    await db.updateCompetition(c.id, patch);
    if (patch.judge_count) await db.deleteSlotsAbove(c.id, patch.judge_count);
    await log(acc, 'update_competition', c.name, patch);
    return { competition: competitionFull(Object.assign({}, c, patch)) };
  }

  async function adminGetRubric(token) {
    const acc = await auth(token, 'admin');
    return rubricView(await compOf(acc));
  }

  async function adminSaveRubric(token, items) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    needBeforeJudging(c, '修改評分表');
    if (!Array.isArray(items) || !items.length || items.length > 10) fail('評分表要有 1～10 個項目');
    const clean = items.map((it, i) => {
      const title = String((it && it.title) || '').trim();
      const max = Number(it && it.max);
      if (!title || title.length > 60) fail(`第 ${i + 1} 項名稱 1～60 個字`);
      if (!Number.isInteger(max) || max < 1 || max > 100) fail(`第 ${i + 1} 項滿分要是 1～100 的整數`);
      return { title, max_score: max, description: String((it && it.description) || '').trim().slice(0, 500) };
    });
    const total = clean.reduce((s, i) => s + i.max_score, 0);
    if (total !== 100) fail(`各項滿分加起來必須是 100（目前 ${total}）`);
    await db.saveRubric(c.rubric_id, clean);
    await log(acc, 'save_rubric', '', { items: clean.map(i => `${i.title} ${i.max_score}`) });
    return rubricView(c);
  }

  async function adminAssignSlot(token, slotNo, accountId, reason) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    slotNo = Number(slotNo);
    if (!Number.isInteger(slotNo) || slotNo < 1 || slotNo > c.judge_count) fail(`席位編號要是 1～${c.judge_count}`);
    const slots = await db.listJudgeSlots(c.id);
    const cur = slots.find(s => s.slot_no === slotNo);
    if (!accountId) {
      needBeforeJudging(c, '清空評審席位');
      if (cur) await db.deleteSlot(c.id, slotNo);
      await log(acc, 'clear_slot', '評審' + slotNo);
      return { ok: true };
    }
    const target = await db.getAccount(accountId);
    if (!target || target.competition_id !== c.id || target.role !== 'judge' || !target.active) fail('只能指派啟用中的評審帳號');
    const other = slots.find(s => s.account_id === target.id && s.slot_no !== slotNo);
    if (other) fail(`${target.display_name} 已經是評審${other.slot_no}`);
    if (cur && cur.account_id === target.id) return { ok: true };
    reason = String(reason || '').trim().slice(0, 500);
    if (!beforeJudging(c) && !reason) fail('評分開始後更換評審（替補）必須填寫原因');
    await db.upsertSlot({ competition_id: c.id, slot_no: slotNo, account_id: target.id, assigned_at: iso(now()), replaced_reason: cur ? (reason || null) : null });
    await log(acc, cur ? 'replace_judge' : 'assign_judge', '評審' + slotNo, { account: target.login_id, reason });
    return { ok: true };
  }

  /* ───────────── 主辦方：小組、版本、資格審查（P3） ───────────── */

  async function teamOf(c, teamId) {
    const t = await db.getTeam(teamId);
    if (!t || t.competition_id !== c.id) fail('找不到這個組別');
    return t;
  }
  async function versionOf(c, versionId) {
    const v = await db.getVersion(versionId);
    if (!v || v.competition_id !== c.id) fail('找不到這個影片版本');
    return v;
  }

  async function adminUpsertTeam(token, input) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    input = input || {};
    const fields = {
      name: String(input.name || '').trim().slice(0, 60),
      members: String(input.members || '').trim().slice(0, 300),
      work_title: String(input.workTitle || '').trim().slice(0, 100),
      work_desc: String(input.workDesc || '').trim().slice(0, 2000),
    };
    if (input.id) {
      const t = await teamOf(c, input.id);
      await db.updateTeam(t.id, fields);
      await log(acc, 'update_team', t.code, { name: fields.name, workTitle: fields.work_title });
      return { id: t.id };
    }
    needBeforeJudging(c, '新增組別');
    const code = String(input.code || '').trim().toLowerCase();
    if (!TEAM_RE.test(code)) fail('組別代碼格式為 team 加兩位數字，例如 team01');
    if ((await db.listTeams(c.id)).some(t => t.code === code)) fail(code + ' 已經存在');
    const t = await db.insertTeam(Object.assign({ competition_id: c.id, code }, fields));
    await log(acc, 'create_team', code, { name: fields.name });
    return { id: t.id };
  }

  async function adminDeleteTeam(token, teamId) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    needBeforeJudging(c, '刪除組別');
    const t = await teamOf(c, teamId);
    if ((await db.listVersions(c.id)).some(v => v.team_id === t.id)) fail('這組已經有影片版本，不能刪除');
    await db.deleteTeam(t.id);
    await log(acc, 'delete_team', t.code);
    return { ok: true };
  }

  async function adminSetReceivedAt(token, versionId, at) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    const v = await versionOf(c, versionId);
    let value = null;
    if (at) {
      const ms = Date.parse(at);
      if (isNaN(ms)) fail('收件時間格式錯誤');
      if (ms > now() + 5 * 60 * 1000) fail('收件時間不能晚於現在');
      value = iso(ms);
    }
    await db.updateVersion(v.id, { received_at: value });
    await log(acc, 'set_received_at', v.source_filename, { at: value });
    return { receivedAt: value };
  }

  async function adminSetCurrentVersion(token, teamId, versionId) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    needBeforeJudging(c, '更換正式版本');
    const t = await teamOf(c, teamId);
    const v = await versionOf(c, versionId);
    if (v.team_id !== t.id) fail('這個版本不屬於這一組');
    if (!v.check_ok) fail('檢查沒有通過的版本不能設為正式版本');
    await db.setTeamCurrent({ team_id: t.id, version_id: v.id, set_by: acc.id, set_at: iso(now()) });
    await log(acc, 'set_current_version', `${t.code}_v${v.version_no}`);
    return { ok: true };
  }

  async function adminReview(token, versionId, status, reason, timecodes) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    needBeforeJudging(c, '修改資格審查');
    const v = await versionOf(c, versionId);
    if (!REVIEW_STATUS.includes(status)) fail('審查結果不正確');
    if (status === 'pass' && !v.check_ok) fail('檢查沒有通過的版本不能審查通過');
    reason = String(reason || '').trim();
    if ((status === 'resubmit' || status === 'fail') && !reason) fail('退回補件或不通過必須填寫原因');
    if (reason.length > 1000) fail('原因最多 1000 字');
    const tc = Array.isArray(timecodes) ? timecodes : [];
    if (tc.length > 50) fail('時間點最多 50 個');
    const dur = Number(v.duration_sec) || 0;
    const cleanTc = tc.map(x => {
      const sec = Math.round(Number(x && x.sec) * 10) / 10;
      if (!Number.isFinite(sec) || sec < 0 || (dur && sec > dur + 0.5)) fail('時間點要在影片長度內');
      return { sec, note: String((x && x.note) || '').trim().slice(0, 200) };
    }).sort((a, b) => a.sec - b.sec);
    const team = await db.getTeam(v.team_id);
    await db.insertReview({ version_id: v.id, status, reason, timecodes: cleanTc, reviewer: acc.id, reviewed_at: iso(now()) });
    await log(acc, 'review', `${team.code}_v${v.version_no}`, { status, reason });
    return { ok: true };
  }

  /** 狀態文字（後台與公開頁共用；公開頁不帶原因） */
  function teamStatus(c, versions, currentId, latestOf, lockedVersionId) {
    if (lockedVersionId) return { key: 'locked', label: c.phase === 'published' ? '已公布' : '評分中' };
    if (!versions.length) return { key: 'none', label: '未收件' };
    if (!currentId) return { key: 'received', label: '已收件' };
    const st = latestOf(currentId);
    if (c.phase !== 'setup' && c.phase !== 'collecting') return { key: 'excluded', label: st === 'fail' ? '未通過' : '未進入評分' };
    return { pending: { key: 'reviewing', label: '審查中' }, pass: { key: 'pass', label: '資格通過' },
      resubmit: { key: 'resubmit', label: '補件中' }, fail: { key: 'fail', label: '未通過' } }[st];
  }

  async function loadBoard(c) {
    const [teams, versions, current, locks] = await Promise.all([
      db.listTeams(c.id), db.listVersions(c.id), db.listTeamCurrent(c.id), db.listLocks(c.id),
    ]);
    const reviews = await db.listReviews(versions.map(v => v.id));
    const revBy = {};
    reviews.sort((a, b) => b.id - a.id).forEach(r => { (revBy[r.version_id] = revBy[r.version_id] || []).push(r); });
    const latestOf = vid => (revBy[vid] && revBy[vid][0] ? revBy[vid][0].status : 'pending');
    const curBy = {}, lockBy = {};
    current.forEach(x => { curBy[x.team_id] = x.version_id; });
    locks.forEach(x => { lockBy[x.team_id] = x.version_id; });
    teams.sort((a, b) => a.code.localeCompare(b.code));
    return { teams, versions, revBy, latestOf, curBy, lockBy };
  }

  async function adminGetBoard(token) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    const b = await loadBoard(c);
    const names = {};
    (await db.listAccounts(c.id)).forEach(a => { names[a.id] = a.display_name; });
    const slots = (await db.listJudgeSlots(c.id)).sort((a, b2) => a.slot_no - b2.slot_no)
      .map(s => ({ slot: s.slot_no, accountId: s.account_id, name: names[s.account_id] || '', replacedReason: s.replaced_reason || '' }));
    const teams = b.teams.map(t => {
      const vs = b.versions.filter(v => v.team_id === t.id).sort((x, y) => y.version_no - x.version_no);
      return {
        id: t.id, code: t.code, name: t.name, members: t.members, workTitle: t.work_title, workDesc: t.work_desc,
        currentVersionId: b.curBy[t.id] || null, lockedVersionId: b.lockBy[t.id] || null,
        status: teamStatus(c, vs, b.curBy[t.id], b.latestOf, b.lockBy[t.id]),
        versions: vs.map(v => ({
          id: v.id, no: v.version_no, filename: v.source_filename, sha256: v.source_sha256, size: v.source_size,
          duration: v.duration_sec === null ? null : Number(v.duration_sec), container: v.container, vcodec: v.vcodec, acodec: v.acodec,
          width: v.width, height: v.height, checkOk: v.check_ok, checkNotes: v.check_notes, playbackPath: v.playback_path,
          playbackSize: v.playback_size, receivedAt: v.received_at, processedAt: v.processed_at,
          reviewStatus: b.latestOf(v.id),
          reviews: (b.revBy[v.id] || []).map(r => ({ status: r.status, reason: r.reason, timecodes: r.timecodes || [], reviewer: names[r.reviewer] || '', at: r.reviewed_at })),
        })),
      };
    });
    return { competition: competitionFull(c), rubric: await rubricView(c), slots, teams };
  }

  /** 開始評分前的預覽：會鎖定哪些、哪些不進入評分、還有什麼沒完成 */
  async function judgingCheck(c) {
    const b = await loadBoard(c);
    const problems = [];
    const slots = (await db.listJudgeSlots(c.id)).filter(s => s.slot_no <= c.judge_count);
    const accs = await db.listAccounts(c.id);
    const okSlots = slots.filter(s => accs.some(a => a.id === s.account_id && a.active && a.role === 'judge'));
    if (okSlots.length < c.judge_count) problems.push(`評審席位還沒排滿（${okSlots.length} / ${c.judge_count}）`);
    const rb = await rubricView(c);
    if (rb.total !== 100) problems.push('評分表總分必須是 100');
    const willLock = [], excluded = [], pending = [];
    b.teams.forEach(t => {
      const cur = b.curBy[t.id];
      if (!cur) { excluded.push({ code: t.code, reason: b.versions.some(v => v.team_id === t.id) ? '沒有設定正式版本' : '未收件' }); return; }
      const st = b.latestOf(cur);
      if (st === 'pending') pending.push(t.code);
      else if (st === 'pass') willLock.push(t.code);
      else excluded.push({ code: t.code, reason: st === 'fail' ? '資格未通過' : '退回補件中' });
    });
    if (pending.length) problems.push(`還有 ${pending.length} 組的資格審查未完成：${pending.join('、')}`);
    if (!pending.length && !willLock.length) problems.push('沒有任何資格通過的作品');
    return { problems, willLock, excluded };
  }

  async function adminJudgingPreview(token) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    if (c.phase !== 'collecting') fail('只有「收件審查」階段可以開始評分');
    return judgingCheck(c);
  }

  async function adminSetPhase(token, phase) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    const allowed = { setup: ['collecting'], collecting: ['setup', 'judging'] }[c.phase] || [];
    if (!allowed.includes(phase)) fail(`目前是「${PHASE_LABEL[c.phase]}」，不能切換到「${PHASE_LABEL[phase] || phase}」`);
    if (phase === 'judging') {
      const chk = await judgingCheck(c);
      if (chk.problems.length) fail(chk.problems.join('；'));
      const r = await db.lockForJudging(c.id, acc.id);   // 資料庫函式：再檢查一次並一次完成（失敗就全部不做）
      return { phase: 'judging', locked: r.locked, excluded: r.excluded };
    }
    await db.updateCompetition(c.id, { phase });
    await log(acc, 'set_phase', PHASE_LABEL[phase], { from: c.phase, to: phase });
    return { phase };
  }

  /* ───────────── 公開（免登入） ───────────── */

  /** 公布前的收件與資格狀態：只有組別、作品名稱、狀態，不含原因與分數 */
  async function publicStatus() {
    const c = await db.getActiveCompetition();
    if (!c) return { enabled: false, competition: null };
    if (!c.show_status_page) return { enabled: false, competition: { name: c.name } };
    const b = await loadBoard(c);
    return {
      enabled: true,
      competition: { name: c.name, phaseLabel: PHASE_LABEL[c.phase] },
      teams: b.teams.map(t => {
        const vs = b.versions.filter(v => v.team_id === t.id);
        const s = teamStatus(c, vs, b.curBy[t.id], b.latestOf, b.lockBy[t.id]);
        return { code: t.code, name: t.name, workTitle: t.work_title, status: s.label };
      }),
    };
  }

  /** 公布後的結果。只輸出白名單欄位：快照裡就算有評審姓名也不會流出 */
  async function publicResults() {
    const c = await db.getActiveCompetition();
    if (!c) return { published: false, competition: null };
    const pub = await db.getLivePublication(c.id);
    if (!pub) return { published: false, competition: { name: c.name } };
    const s = pub.snapshot || {};
    const showItems = !!s.showItemScores;
    return {
      published: true,
      competition: { name: c.name },
      publishedAt: pub.published_at,
      judgeCount: Number(s.judgeCount) || null,
      items: showItems && Array.isArray(s.items) ? s.items.map(i => ({ id: String(i.id), title: String(i.title), max: Number(i.max) })) : null,
      teams: (Array.isArray(s.teams) ? s.teams : []).map(t => ({
        rank: Number(t.rank) || null,
        tied: !!t.tied,
        code: String(t.code || ''),
        name: String(t.name || ''),
        workTitle: String(t.workTitle || ''),
        average: t.average === null || t.average === undefined ? null : Number(t.average),
        judges: (Array.isArray(t.judges) ? t.judges : []).map(j => ({
          slot: Number(j.slot),
          label: '評審' + Number(j.slot),
          total: Number(j.total),
          strengths: String(j.strengths || ''),
          improvements: String(j.improvements || ''),
          items: showItems && j.items && typeof j.items === 'object' ? Object.fromEntries(Object.entries(j.items).map(([k, v]) => [k, Number(v)])) : undefined,
        })).sort((a, b) => a.slot - b.slot),
      })),
    };
  }

  const API = {
    login, me, changePassword,
    adminListAccounts, adminUpsertAccount, adminResetPassword, adminLogs,
    adminSyncVideos,
    adminGetBoard, adminUpdateCompetition, adminGetRubric, adminSaveRubric, adminAssignSlot,
    adminUpsertTeam, adminDeleteTeam, adminSetReceivedAt, adminSetCurrentVersion, adminReview,
    adminJudgingPreview, adminSetPhase,
    publicStatus, publicResults,
  };

  /** 處理一次 {fn, args} 請求；回傳 {ok, result} 或 {ok:false, error} */
  async function handle(req) {
    try {
      const fn = req && Object.prototype.hasOwnProperty.call(API, req.fn) ? API[req.fn] : null;
      if (!fn) fail('不支援的操作');
      const result = await fn(...(Array.isArray(req.args) ? req.args : []));
      return { ok: true, result: result === undefined ? null : result };
    } catch (e) {
      if (e instanceof UserError) return { ok: false, error: e.message };
      if (e && e.userMessage) return { ok: false, error: e.userMessage };   // 資料庫函式 raise exception 的中文訊息
      console.error(e);
      return { ok: false, error: '系統忙碌，請稍後再試' };
    }
  }

  return { handle, API };
}
