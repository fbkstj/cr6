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

/** 總評分份數 M ＝ 老師評審人數 N ＋（AI 評審開啟 ? 1 : 0）；AI 坐席位 N＋1（開發計畫書第 14 節） */
const aiCounted = c => !!c.ai_judge && c.ai_counted !== false;                 // AI 分數是否計入平均（結算頁可勾選）
const seatCount = c => c.judge_count + (aiCounted(c) ? 1 : 0);                 // 計入平均的總份數（排名、收齊、公布用）
const allSeats = c => c.judge_count + (c.ai_judge ? 1 : 0);                    // 全部席位（含不計入的 AI；評分進度表用）
const aiSlotOf = c => (c.ai_judge ? c.judge_count + 1 : null);

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
    return { id: c.id, name: c.name, phase: c.phase, judgeCount: c.judge_count, aiJudge: !!c.ai_judge };
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
    const list = (await db.listAccounts(acc.competition_id)).filter(a => a.role !== 'ai');   // AI 帳號不能登入，不列在帳號管理
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
      if (target.role === 'ai') fail('AI 評審帳號不能修改');
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
    if (target.role === 'ai') fail('AI 評審帳號不能設定密碼');
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
  const PHASE_LABEL = { setup: '準備', collecting: '收件', judging: '評分', settling: '結算', published: '已公布' };
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
      aiJudge: !!c.ai_judge, aiCounted: aiCounted(c), seats: seatCount(c), aiSlot: aiSlotOf(c),
      showStatusPage: !!c.show_status_page, showItemScores: !!c.show_item_scores, minCommentChars: c.min_comment_chars,
    };
  }

  /** 兩大類：專題組（project）、創意組（creative）；每件作品屬於其中一組，各有自己的評分表與排名 */
  const CATEGORIES = ['project', 'creative'];
  const CATEGORY_LABEL = { project: '專題組', creative: '創意組' };
  const catOf = t => (t && t.category === 'creative' ? 'creative' : 'project');
  const rubricIdOf = (c, category) => (category === 'creative' ? c.rubric_id_creative : c.rubric_id);
  const needCategory = category => { if (!CATEGORIES.includes(category)) fail('組別只能是「專題組」或「創意組」'); return category; };

  async function rubricView(c, category) {
    const r = await db.getRubric(rubricIdOf(c, category || 'project'));
    if (!r) return { id: null, locked: false, items: [], total: 0 };
    const items = r.items.slice().sort((a, b) => a.sort - b.sort)
      .map(i => ({ id: i.id, title: i.title, max: i.max_score, description: i.description || '' }));
    return { id: r.id, category: category || 'project', categoryLabel: CATEGORY_LABEL[category || 'project'], locked: !!r.locked, items, total: items.reduce((s, i) => s + i.max, 0) };
  }

  /** 結算時決定 AI 分數要不要計入平均（AI 分數照樣匯入保存）。公布後要先撤回才能改 */
  async function adminSetAiCounted(token, counted) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    if (!c.ai_judge) fail('這個競賽沒有開啟 AI 評審');
    if (c.phase === 'published') fail('已經公布，要修改請先撤回公布');
    counted = !!counted;
    if (counted !== aiCounted(c)) {
      await db.updateCompetition(c.id, { ai_counted: counted });
      await log(acc, 'set_ai_counted', counted ? '計入平均' : '不計入平均', { counted });
    }
    return { aiCounted: counted };
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
      if (![1, 3, 5].includes(Number(input.judgeCount))) fail('評審人數只能是 1、3 或 5');
      patch.judge_count = Number(input.judgeCount);
    }
    if (input.aiJudge !== undefined && !!input.aiJudge !== !!c.ai_judge) {
      needBeforeJudging(c, (input.aiJudge ? '加入' : '取消') + ' AI 評審');
      patch.ai_judge = !!input.aiJudge;
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

  async function adminGetRubric(token, category) {
    const acc = await auth(token, 'admin');
    return rubricView(await compOf(acc), needCategory(category || 'project'));
  }

  async function adminSaveRubric(token, items, category) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    category = needCategory(category || 'project');
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
    await db.saveRubric(rubricIdOf(c, category), clean);
    await log(acc, 'save_rubric', CATEGORY_LABEL[category], { category, items: clean.map(i => `${i.title} ${i.max_score}`) });
    return rubricView(c, category);
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
      if (input.category !== undefined && input.category !== t.category) {
        needBeforeJudging(c, '改作品組別');
        fields.category = needCategory(input.category);
      }
      await db.updateTeam(t.id, fields);
      await log(acc, 'update_team', t.code, { name: fields.name, workTitle: fields.work_title });
      return { id: t.id };
    }
    needBeforeJudging(c, '新增組別');
    fields.category = needCategory(input.category || 'project');
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

  /** 狀態文字（後台與公開頁共用；公開頁不帶原因） */
  function teamStatus(c, versions, currentId, lockedVersionId) {
    if (lockedVersionId) return { key: 'locked', label: c.phase === 'published' ? '已公布' : '評分中' };
    if (!versions.length) return { key: 'none', label: '未收件' };
    if (!currentId) return { key: 'received', label: '已收件' };
    if (c.phase !== 'setup' && c.phase !== 'collecting') return { key: 'excluded', label: '未進入評分' };
    return { key: 'pass', label: '可評分' };   // 沒有資格審查：已設定正式版本就能進入評分
  }

  async function loadBoard(c) {
    const [teams, versions, current, locks] = await Promise.all([
      db.listTeams(c.id), db.listVersions(c.id), db.listTeamCurrent(c.id), db.listLocks(c.id),
    ]);
    const curBy = {}, lockBy = {};
    current.forEach(x => { curBy[x.team_id] = x.version_id; });
    locks.forEach(x => { lockBy[x.team_id] = x.version_id; });
    teams.sort((a, b) => a.code.localeCompare(b.code));
    return { teams, versions, curBy, lockBy };
  }

  async function adminGetBoard(token) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    const b = await loadBoard(c);
    const names = {};
    (await db.listAccounts(c.id)).forEach(a => { names[a.id] = a.display_name; });
    const slots = (await db.listJudgeSlots(c.id)).sort((a, b2) => a.slot_no - b2.slot_no)
      .map(s => ({ slot: s.slot_no, accountId: s.account_id, name: names[s.account_id] || '', replacedReason: s.replaced_reason || '', isAi: s.slot_no > c.judge_count }));
    const teams = b.teams.map(t => {
      const vs = b.versions.filter(v => v.team_id === t.id).sort((x, y) => y.version_no - x.version_no);
      return {
        id: t.id, code: t.code, name: t.name, members: t.members, workTitle: t.work_title, workDesc: t.work_desc,
        category: catOf(t), categoryLabel: CATEGORY_LABEL[catOf(t)],
        currentVersionId: b.curBy[t.id] || null, lockedVersionId: b.lockBy[t.id] || null,
        status: teamStatus(c, vs, b.curBy[t.id], b.lockBy[t.id]),
        versions: vs.map(v => ({
          id: v.id, no: v.version_no, filename: v.source_filename, sha256: v.source_sha256, size: v.source_size,
          duration: v.duration_sec === null ? null : Number(v.duration_sec), container: v.container, vcodec: v.vcodec, acodec: v.acodec,
          width: v.width, height: v.height, checkOk: v.check_ok, checkNotes: v.check_notes, playbackPath: v.playback_path,
          playbackSize: v.playback_size, receivedAt: v.received_at, processedAt: v.processed_at,
        })),
      };
    });
    const rubrics = { project: await rubricView(c, 'project'), creative: await rubricView(c, 'creative') };
    return { competition: competitionFull(c), rubric: rubrics.project, rubrics, slots, teams };
  }

  /** 開始評分前的預覽：會鎖定哪些、哪些不進入評分、還有什麼沒完成 */
  async function judgingCheck(c) {
    const b = await loadBoard(c);
    const problems = [];
    const slots = (await db.listJudgeSlots(c.id)).filter(s => s.slot_no <= c.judge_count);
    const accs = await db.listAccounts(c.id);
    const okSlots = slots.filter(s => accs.some(a => a.id === s.account_id && a.active && a.role === 'judge'));
    if (okSlots.length < c.judge_count) problems.push(`評審席位還沒排滿（${okSlots.length} / ${c.judge_count}）`);
    for (const cat of CATEGORIES) {
      const rb = await rubricView(c, cat);
      if (rb.total !== 100) problems.push(`${CATEGORY_LABEL[cat]}評分表總分必須是 100`);
    }
    const willLock = [], excluded = [];
    b.teams.forEach(t => {
      if (b.curBy[t.id]) willLock.push(t.code);
      else excluded.push({ code: t.code, reason: b.versions.some(v => v.team_id === t.id) ? '沒有設定正式版本' : '未收件' });
    });
    if (!willLock.length) problems.push('沒有任何可以評分的作品（還沒有設定正式版本）');
    return { problems, willLock, excluded };
  }

  async function adminJudgingPreview(token) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    if (c.phase !== 'collecting') fail('只有「收件」階段可以開始評分');
    return judgingCheck(c);
  }

  async function adminSetPhase(token, phase) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    const allowed = { setup: ['collecting'], collecting: ['setup', 'judging'], judging: ['settling'], settling: ['judging'] }[c.phase] || [];
    if (!allowed.includes(phase)) fail(`目前是「${PHASE_LABEL[c.phase]}」，不能切換到「${PHASE_LABEL[phase] || phase}」`);
    if (phase === 'judging' && c.phase === 'collecting') {
      const chk = await judgingCheck(c);
      if (chk.problems.length) fail(chk.problems.join('；'));
      const r = await db.lockForJudging(c.id, acc.id);   // 資料庫函式：再檢查一次並一次完成（失敗就全部不做）
      return { phase: 'judging', locked: r.locked, excluded: r.excluded };
    }
    // settling → judging：回到評分階段（例如發現要再請評審修改），版本鎖定不變
    if (phase === 'settling') {
      const r = await rankAll(c);
      if (r.incomplete.length) fail(`還有 ${r.incomplete.length} 件作品的評分沒有收齊：${r.incomplete.map(x => `${x.code}（${x.submitted}/${seatCount(c)}）`).join('、')}`);
    }
    await db.updateCompetition(c.id, { phase });
    await log(acc, 'set_phase', PHASE_LABEL[phase], { from: c.phase, to: phase });
    return { phase };
  }

  /* ───────────── 評審評分（P4） ───────────── */

  const SCORING_PHASES = ['judging', 'settling'];
  const SCORE_LABEL = { none: '未評', draft: '暫存中', submitted: '已送出', returned: '被退回', others: '前任評審已完成' };

  /** 從評審的角度看某一份評分：別人（前任評審）的內容一律不給看 */
  function myView(score, acc) {
    if (!score) return { status: 'none', mine: false };
    if (score.account_id !== acc.id) {
      return score.status === 'submitted' ? { status: 'others', mine: false } : { status: 'none', mine: false, inherited: score.status };
    }
    return { status: score.status, mine: true };
  }

  async function judgeSlot(acc, c) {
    const s = (await db.listJudgeSlots(c.id)).find(x => x.account_id === acc.id);
    return s ? s.slot_no : null;
  }

  async function judgeListWorks(token) {
    const acc = await auth(token, 'judge');
    const c = await compOf(acc);
    const slot = await judgeSlot(acc, c);
    const base = { phase: c.phase, phaseLabel: PHASE_LABEL[c.phase], slot, judgeCount: c.judge_count, works: [] };
    if (!slot) return Object.assign(base, { message: '你目前沒有被指派評審席位，請聯絡主辦單位' });
    if (!['judging', 'settling', 'published'].includes(c.phase)) return Object.assign(base, { message: '還沒有開始評分，請等候主辦單位通知' });
    const [teams, locks, versions, scores] = await Promise.all([db.listTeams(c.id), db.listLocks(c.id), db.listVersions(c.id), db.listScores(c.id)]);
    const works = locks.map(l => {
      const t = teams.find(x => x.id === l.team_id);
      const v = versions.find(x => x.id === l.version_id) || {};
      const sv = myView(scores.find(s => s.team_id === l.team_id && s.slot_no === slot), acc);
      const sc = sv.mine ? scores.find(s => s.team_id === l.team_id && s.slot_no === slot) : null;
      return { teamId: t.id, code: t.code, name: t.name, workTitle: t.work_title, duration: v.duration_sec === null ? null : Number(v.duration_sec),
        category: catOf(t), categoryLabel: CATEGORY_LABEL[catOf(t)],
        status: sv.status, statusLabel: SCORE_LABEL[sv.status], total: sc && sc.status === 'submitted' ? sc.total : null };
    }).sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.code.localeCompare(b.code));
    const done = works.filter(w => w.status === 'submitted' || w.status === 'others').length;
    return Object.assign(base, { works, done, canEdit: SCORING_PHASES.includes(c.phase) });
  }

  async function judgeGetWork(token, teamId) {
    const acc = await auth(token, 'judge');
    const c = await compOf(acc);
    const slot = await judgeSlot(acc, c);
    if (!slot) fail('你目前沒有被指派評審席位');
    if (!['judging', 'settling', 'published'].includes(c.phase)) fail('還沒有開始評分');
    const lock = (await db.listLocks(c.id)).find(l => l.team_id === teamId);
    if (!lock) fail('這件作品不在評分名單中');
    const t = await db.getTeam(teamId);
    const v = await db.getVersion(lock.version_id);
    const score = (await db.listScores(c.id)).find(s => s.team_id === teamId && s.slot_no === slot) || null;
    const sv = myView(score, acc);
    let returnReason = '';
    if (score && score.status === 'returned') {
      const h = (await db.listScoreHistory([score.id])).filter(x => x.action === 'return').sort((a, b) => b.id - a.id)[0];
      returnReason = h ? h.reason : '';
    }
    const mine = sv.mine ? score : null;
    return {
      team: { id: t.id, code: t.code, name: t.name, workTitle: t.work_title, workDesc: t.work_desc, category: catOf(t), categoryLabel: CATEGORY_LABEL[catOf(t)] },
      video: { path: v.playback_path, duration: v.duration_sec === null ? null : Number(v.duration_sec), versionNo: v.version_no },
      rubric: await rubricView(c, catOf(t)),
      minCommentChars: c.min_comment_chars,
      slot,
      score: {
        status: sv.status, statusLabel: SCORE_LABEL[sv.status],
        items: mine ? mine.items || {} : {}, total: mine && mine.status === 'submitted' ? mine.total : null,
        strengths: mine ? mine.strengths : '', improvements: mine ? mine.improvements : '',
        submittedAt: mine ? mine.submitted_at : null,
        returnReason: sv.mine || sv.inherited === 'returned' ? returnReason : '',
        note: sv.status === 'others' ? '這件作品已由前任評審完成評分，你不需要再評。'
          : sv.inherited ? '這個席位原本由其他評審負責，請重新完整評分。' : '',
      },
      canEdit: SCORING_PHASES.includes(c.phase) && sv.status !== 'others',
    };
  }

  async function judgeSaveScore(token, teamId, data, submit) {
    const acc = await auth(token, 'judge');
    data = data || {};
    const items = data.items && typeof data.items === 'object' && !Array.isArray(data.items) ? data.items : {};
    const clean = {};
    Object.entries(items).forEach(([k, v]) => {
      if (v === '' || v === null || v === undefined) return;
      const n = Number(v);
      if (!Number.isFinite(n)) fail('分數要是數字');
      clean[k] = n;
    });
    // 先在這裡去掉頭尾空白（含全形空白）；Postgres 的 trim() 不會去掉全形空白
    const r = await db.judgeSave(teamId, acc.id, clean, String(data.strengths || '').trim(), String(data.improvements || '').trim(), !!submit);
    if (submit) {
      const t = await db.getTeam(teamId);
      await log(acc, 'judge_submit', t ? t.code : teamId, { total: r.total });
    }
    return { status: r.status, statusLabel: SCORE_LABEL[r.status], total: r.total };
  }
  const judgeSaveDraft = (token, teamId, data) => judgeSaveScore(token, teamId, data, false);
  const judgeSubmit = (token, teamId, data) => judgeSaveScore(token, teamId, data, true);

  /* ───────────── 主辦方：評分進度與退回（P4） ───────────── */

  async function adminListScores(token) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    const [teams, locks, scores, slots, accounts, runs] = await Promise.all([
      db.listTeams(c.id), db.listLocks(c.id), db.listScores(c.id), db.listJudgeSlots(c.id), db.listAccounts(c.id), c.ai_judge ? db.listAiRuns(c.id) : []]);
    const name = id => (accounts.find(a => a.id === id) || {}).display_name || '';
    const M = allSeats(c), need = seatCount(c);
    // AI 的「暫存」分數：只給後台先看，不計入平均、不算收齊
    const draftOf = teamId => {
      const latest = runs.filter(r => r.team_id === teamId).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
      return latest && latest.status === 'draft' && latest.result ? { runId: latest.id, total: Object.values(latest.result.items).reduce((x, y) => x + (y || 0), 0) } : null;
    };
    const rows = locks.map(l => {
      const t = teams.find(x => x.id === l.team_id);
      const cells = [];
      for (let n = 1; n <= M; n++) {
        const s = scores.find(x => x.team_id === t.id && x.slot_no === n);
        cells.push(s ? { slot: n, scoreId: s.id, status: s.status, label: SCORE_LABEL[s.status], total: s.status === 'submitted' ? s.total : null, judge: name(s.account_id) }
          : { slot: n, scoreId: null, status: 'none', label: SCORE_LABEL.none, total: null, judge: '' });
      }
      const ai = aiSlotOf(c);
      if (ai && ai <= M) cells[ai - 1].draft = draftOf(t.id);
      const submitted = cells.filter(x => x.status === 'submitted' && x.slot <= need).length;   // 不計入的 AI 不算收齊
      return { teamId: t.id, code: t.code, name: t.name, workTitle: t.work_title, category: catOf(t), categoryLabel: CATEGORY_LABEL[catOf(t)], cells, submitted, complete: submitted === need };
    }).sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.code.localeCompare(b.code));
    const judges = Array.from({ length: M }, (_, i) => {
      const s = slots.find(x => x.slot_no === i + 1);
      return { slot: i + 1, name: s ? name(s.account_id) : '', isAi: i + 1 === aiSlotOf(c), done: rows.filter(r => r.cells[i].status === 'submitted').length };
    });
    return { phase: c.phase, judgeCount: M, needed: need, aiCounted: aiCounted(c), aiSlot: aiSlotOf(c), rows, judges, completeWorks: rows.filter(r => r.complete).length, totalWorks: rows.length };
  }

  async function adminGetScore(token, scoreId) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    const s = await db.getScore(scoreId);
    if (!s || s.competition_id !== c.id) fail('找不到這份評分');
    const accounts = await db.listAccounts(c.id);
    const name = id => (accounts.find(a => a.id === id) || {}).display_name || '';
    const t = await db.getTeam(s.team_id);
    const hist = (await db.listScoreHistory([s.id])).sort((a, b) => a.id - b.id);
    return {
      id: s.id, team: { code: t.code, name: t.name }, slot: s.slot_no, judge: name(s.account_id), status: s.status, statusLabel: SCORE_LABEL[s.status],
      items: s.items || {}, total: s.total, strengths: s.strengths, improvements: s.improvements, submittedAt: s.submitted_at,
      rubric: await rubricView(c, catOf(t)),
      history: hist.map(h => ({ action: h.action, at: h.at, actor: name(h.actor), reason: h.reason, total: h.snapshot ? h.snapshot.total : null })),
      canReturn: s.status === 'submitted' && SCORING_PHASES.includes(c.phase),
    };
  }

  async function adminReturnScore(token, scoreId, reason) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    const s = await db.getScore(scoreId);
    if (!s || s.competition_id !== c.id) fail('找不到這份評分');
    if (!String(reason || '').trim()) fail('退回必須填寫原因');
    await db.returnScore(s.id, acc.id, String(reason).trim().slice(0, 500));
    return { ok: true };
  }

  /* ───────────── 結算、同分、匯出、公布（P5） ───────────── */

  const sameSet = (a, b) => a.length === b.length && a.slice().sort().join(',') === b.slice().sort().join(',');

  /**
   * 排名規則（開發計畫書第 7 節）：
   * - 每件作品收齊 N 份正式評分才算完成；平均 = 總分和 ÷ N。
   * - 所有作品的 N 相同，所以直接比「總分和」（整數），等同比較未四捨五入的平均，沒有小數誤差。
   * - 名次「1、2、2、4」；同分群組要主辦方決定先後（或並列）並填理由，才算可以公布。
   */
  async function computeRanking(c, category) {
    category = category || 'project';
    const N = seatCount(c);   // 老師 N 人＋AI（開啟且勾選計入時）
    const refAi = !!c.ai_judge && !aiCounted(c);
    const [teams, allLocks, scores, accounts, decisions, versions] = await Promise.all([
      db.listTeams(c.id), db.listLocks(c.id), db.listScores(c.id), db.listAccounts(c.id), db.listTieDecisions(c.id), db.listVersions(c.id)]);
    const locks = allLocks.filter(l => catOf(teams.find(x => x.id === l.team_id)) === category);   // 只排這一組的作品
    const name = id => (accounts.find(a => a.id === id) || {}).display_name || '';
    const rows = locks.map(l => {
      const t = teams.find(x => x.id === l.team_id);
      const v = versions.find(x => x.id === l.version_id) || {};
      const subs = scores.filter(s => s.team_id === t.id && s.status === 'submitted' && s.slot_no <= N).sort((a, b) => a.slot_no - b.slot_no);
      const sum = subs.reduce((s, x) => s + x.total, 0);
      return {
        teamId: t.id, code: t.code, name: t.name, workTitle: t.work_title, versionNo: v.version_no, category,
        complete: subs.length === N, submitted: subs.length, sum: subs.length === N ? sum : null,
        average: subs.length === N ? sum / N : null,
        judges: subs.map(s => ({ slot: s.slot_no, judge: name(s.account_id), total: s.total, items: s.items || {}, strengths: s.strengths, improvements: s.improvements })),
        aiTotal: refAi ? ((scores.find(s => s.team_id === t.id && s.slot_no === aiSlotOf(c) && s.status === 'submitted') || {}).total ?? null) : null,   // AI 不計入平均時，只當參考顯示
        rank: null, tied: false,
      };
    });
    const done = rows.filter(r => r.complete).sort((a, b) => b.sum - a.sum || a.code.localeCompare(b.code));
    const incomplete = rows.filter(r => !r.complete).sort((a, b) => a.code.localeCompare(b.code));
    const ties = [];
    let i = 0;
    while (i < done.length) {
      let k = i;
      while (k + 1 < done.length && done[k + 1].sum === done[i].sum) k++;
      const group = done.slice(i, k + 1);
      const start = i + 1;
      if (group.length === 1) {
        group[0].rank = start;
      } else {
        const ids = group.map(g => g.teamId);
        const d = decisions.filter(x => sameSet(x.team_ids, ids)).sort((a, b) => Number(b.seq) - Number(a.seq))[0] || null;   // 最後一筆為準
        const order = d && Array.isArray(d.ordering) && sameSet(d.ordering, ids) ? d.ordering : null;
        if (order) {
          order.forEach((id, n) => { const g = group.find(x => x.teamId === id); g.rank = start + n; g.tieBroken = true; });
          group.sort((a, b) => a.rank - b.rank);
          done.splice(i, group.length, ...group);
        } else {
          group.forEach(g => { g.rank = start; g.tied = true; });
        }
        ties.push({
          teamIds: ids, codes: group.map(g => g.code), sum: group[0].sum, average: group[0].average, rank: start,
          decision: d ? { type: order ? 'order' : 'tied', order: order ? order.map(id => rows.find(r => r.teamId === id).code) : null,
            reason: d.reason, by: name(d.decided_by), at: d.decided_at } : null,
        });
      }
      i = k + 1;
    }
    const pendingTies = ties.filter(t => !t.decision).length;
    return { category, categoryLabel: CATEGORY_LABEL[category], judgeCount: N, aiSlot: aiSlotOf(c), aiEnabled: !!c.ai_judge, aiCounted: aiCounted(c), rows: done, incomplete, ties, pendingTies,
      ready: !incomplete.length && !pendingTies && done.length > 0 };
  }

  /** 兩組各自排名；沒有作品的組別不影響整體是否可以公布 */
  async function rankAll(c) {
    const cats = [];
    for (const cat of CATEGORIES) {
      const r = await computeRanking(c, cat);
      r.items = (await rubricView(c, cat)).items.map(i => ({ id: i.id, title: i.title, max: i.max }));
      r.empty = !r.rows.length && !r.incomplete.length;
      cats.push(r);
    }
    const used = cats.filter(x => !x.empty);
    return {
      judgeCount: seatCount(c), aiSlot: aiSlotOf(c), aiEnabled: !!c.ai_judge, aiCounted: aiCounted(c), categories: cats,
      rows: used.flatMap(x => x.rows), items: cats[0].items,   // 兩組合在一起的清單（名次是各組自己的），相容用；畫面請用 categories
      incomplete: used.flatMap(x => x.incomplete), pendingTies: used.reduce((n, x) => n + x.pendingTies, 0),
      ties: used.flatMap(x => x.ties.map(t => Object.assign({ category: x.category }, t))),
      ready: used.length > 0 && used.every(x => x.ready),
    };
  }

  async function adminRanking(token) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    if (beforeJudging(c)) fail('還沒有開始評分');
    const r = await rankAll(c);
    const pub = await db.getLivePublication(c.id);
    return Object.assign(r, { phase: c.phase, phaseLabel: PHASE_LABEL[c.phase], publishedAt: pub ? pub.published_at : null });
  }

  async function adminDecideTie(token, teamIds, ordering, reason) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    if (c.phase !== 'settling') fail('只有「結算」階段可以處理同分');
    reason = String(reason || '').trim();
    if (!reason) fail('同分處理必須填寫理由');
    if (reason.length > 500) fail('理由最多 500 字');
    const r = await rankAll(c);
    const tie = r.ties.find(t => Array.isArray(teamIds) && sameSet(t.teamIds, teamIds));
    if (!tie) fail('找不到這個同分群組（可能評分有變動，請重新整理）');
    const catRows = r.categories.find(x => x.category === tie.category).rows;
    let value;
    if (ordering === 'tied') value = { tied: true };
    else if (Array.isArray(ordering) && sameSet(ordering, tie.teamIds) && new Set(ordering).size === ordering.length) value = ordering;
    else fail('先後順序要包含這個同分群組的每一組，而且不能重複');
    await db.insertTieDecision({ competition_id: c.id, team_ids: tie.teamIds, ordering: value, reason, decided_by: acc.id, decided_at: iso(now()) });
    await log(acc, 'decide_tie', tie.codes.join('、'), { ordering: value === 'tied' || value.tied ? '並列' : ordering.map(id => catRows.find(x => x.teamId === id).code), reason });
    return { ok: true };
  }

  const csvCell = v => {
    const s = v === null || v === undefined ? '' : String(v);
    // 防止 Excel 把 =、+、-、@ 開頭的內容當成公式
    const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
    return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
  };

  async function adminExportCsv(token) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    if (beforeJudging(c)) fail('還沒有開始評分');
    const R = await rankAll(c);
    const head = ['類別', '名次', '並列', '組別代碼', '組別名稱', '作品名稱', '評分版本'];
    const M = seatCount(c);
    for (let n = 1; n <= M; n++) head.push(`評審${n}總分`, `評審${n}姓名`);
    head.push('總分合計', '平均', '同分處理');
    const refAi = !!c.ai_judge && !aiCounted(c);
    if (refAi) head.push('AI總分（參考，未計入平均）');
    const tieNote = row => {
      const t = R.ties.find(x => x.teamIds.includes(row.teamId));
      if (!t) return '';
      if (!t.decision) return `與 ${t.codes.filter(x => x !== row.code).join('、')} 同分，尚未處理`;
      return `${t.decision.type === 'tied' ? '並列' : '順序 ' + t.decision.order.join(' > ')}；理由：${t.decision.reason}（${t.decision.by}）`;
    };
    const lines = [head];
    R.categories.forEach(cat => cat.rows.concat(cat.incomplete).forEach(row => {
      const line = [cat.categoryLabel, row.rank ?? '未完成', row.tied ? '是' : '', row.code, row.name, row.workTitle, row.versionNo ? 'v' + row.versionNo : ''];
      for (let n = 1; n <= M; n++) {
        const j = row.judges.find(x => x.slot === n);
        line.push(j ? j.total : '', j ? j.judge : '');
      }
      line.push(row.sum ?? '', row.average === null ? '' : row.average.toFixed(2), tieNote(row));
      if (refAi) line.push(row.aiTotal ?? '');
      lines.push(line);
    }));
    await log(acc, 'export_csv', '', { rows: lines.length - 1 });
    const date = new Date(now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    return { filename: `${c.name}_成績_${date}.csv`, csv: lines.map(l => l.map(csvCell).join(',')).join('\r\n') + '\r\n' };
  }

  async function adminPublish(token) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    if (c.phase !== 'settling') fail('只有「結算」階段可以公布');
    const r = await rankAll(c);
    if (r.incomplete.length) fail(`還有 ${r.incomplete.length} 件作品的評分沒有收齊：${r.incomplete.map(x => x.code).join('、')}`);
    if (r.pendingTies) fail(`還有 ${r.pendingTies} 組同分沒有處理`);
    if (!r.ready) fail('沒有可以公布的作品');
    // 公開快照不標示哪一席是 AI（老師決定：和老師一樣只顯示編號）。teams 是兩組合在一起的清單，名次是各組自己的名次
    const used = r.categories.filter(x => !x.empty);
    const snapshot = {
      judgeCount: seatCount(c), showItemScores: !!c.show_item_scores,
      categories: used.map(x => ({ category: x.category, label: x.categoryLabel, items: x.items })),
      teams: used.flatMap(cat => cat.rows.map(row => ({
        category: cat.category,
        rank: row.rank, tied: row.tied, tieBroken: !!row.tieBroken, code: row.code, name: row.name, workTitle: row.workTitle,
        average: Math.round(row.average * 10000) / 10000,
        judges: row.judges.map(j => ({ slot: j.slot, total: j.total, strengths: j.strengths, improvements: j.improvements, items: j.items })),
      }))),
    };
    await db.publishResults(c.id, acc.id, snapshot);   // 資料庫函式：再檢查一次收齊，並一次完成公布與切換階段
    return { ok: true, teams: snapshot.teams.length };
  }

  async function adminRevoke(token, reason) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    if (c.phase !== 'published') fail('目前沒有公布中的結果');
    if (!String(reason || '').trim()) fail('撤回必須填寫原因');
    await db.revokePublication(c.id, acc.id, String(reason).trim().slice(0, 500));
    return { ok: true };
  }

  /* ───────────── AI 評審（P7，開發計畫書第 14 節） ───────────── */

  const AI_PROMPT_VERSION = 'v1';
  const AI_STATUS = { uploading: '上傳影片中', processing: '處理中', generating: 'AI 評分中', finishing: '寫入評分中', done: '已完成',
    needs_review: '需要處理', finalized: '已補分完成', failed: '失敗', draft: '暫存（未計入）' };
  const AI_ACTIVE = ['uploading', 'processing', 'generating', 'finishing'];
  // 匯入檔案的紀錄超過這個時間還沒寫完就當作中斷（可以重新匯入）
  const AI_STALE_MS = 5 * 60 * 1000;
  const LOCAL_JOB = 'local';   // gemini_job＝local：從外部 AI 匯入的評分檔（欄位名稱沿用舊的）

  const mmss = sec => { sec = Math.max(0, Math.round(Number(sec) || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  /** "3:15"、"1:02:03"、"75"、"75s" → 秒；看不懂回傳 null */
  function parseTime(s) {
    s = String(s === null || s === undefined ? '' : s).trim().replace(/s$/i, '');
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.\d+)?$/.exec(s);
    return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
  }

  function runView(r) {
    if (!r) return null;
    return {
      id: r.id, teamId: r.team_id, status: r.status, statusLabel: AI_STATUS[r.status] || r.status, model: r.model,
      startedAt: r.started_at, finishedAt: r.finished_at, error: r.error || '', problems: r.problems || [],
      result: r.result || null, manual: r.manual || null, usage: r.usage || null, local: r.gemini_job === 'local',
    };
  }

  async function aiComp(acc) {
    const c = await compOf(acc);
    if (!c.ai_judge) fail('這個競賽沒有開啟 AI 評審');
    return c;
  }
  const needScoringPhase = c => { if (!SCORING_PHASES.includes(c.phase)) fail('只有「評分」或「結算」階段可以匯入 AI 評分'); };

  /** 解析並驗證模型回應；回傳 {result, problems}（problems 不是空的就要主辦人員處理） */
  function aiParse(text, c, v, rb) {
    const problems = [];
    let j = null;
    const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { j = JSON.parse(s); } catch (e) {
      const a = s.indexOf('{'), b = s.lastIndexOf('}');
      if (a >= 0 && b > a) { try { j = JSON.parse(s.slice(a, b + 1)); } catch (e2) { j = null; } }
    }
    const result = { items: {}, reasons: {}, evidence: {}, strengths: '', improvements: '', droppedEvidence: 0 };
    if (!j || typeof j !== 'object' || !Array.isArray(j.items)) {
      problems.push('AI 的回應不是規定的 JSON 格式');
      rb.items.forEach(it => { result.items[it.id] = null; });
      return { result, problems };
    }
    const dur = Number(v.duration_sec) || 0;
    rb.items.forEach((it, i) => {
      const x = j.items.find(y => y && Number(y.no) === i + 1) || j.items[i] || null;
      let sc = x ? x.score : undefined;
      if (typeof sc === 'string' && /^\d+$/.test(sc.trim())) sc = Number(sc);
      if (sc === null || sc === undefined) { problems.push(`「${it.title}」AI 無法判定`); sc = null; }
      else if (typeof sc !== 'number' || !Number.isInteger(sc)) { problems.push(`「${it.title}」的分數不是整數（${String(sc).slice(0, 20)}）`); sc = null; }
      else if (sc < 0 || sc > it.max) { problems.push(`「${it.title}」的分數 ${sc} 超出 0～${it.max}`); sc = null; }
      result.items[it.id] = sc;
      result.reasons[it.id] = x ? str(x.reason, 1000) : '';
      const ev = x && Array.isArray(x.evidence) ? x.evidence.slice(0, 5) : [];
      result.evidence[it.id] = [];
      ev.forEach(e => {
        const sec = parseTime(e && e.time);
        if (sec === null || (dur && sec > dur + 1)) { result.droppedEvidence++; return; }
        result.evidence[it.id].push({ sec, note: str(e.note, 200) });
      });
    });
    result.strengths = str(j.strengths, 2000).trim();
    result.improvements = str(j.improvements, 2000).trim();
    const min = c.min_comment_chars || 0;
    if ([...result.strengths].length < min) problems.push(`「作品優點」少於 ${min} 個字`);
    if ([...result.improvements].length < min) problems.push(`「改進建議」少於 ${min} 個字`);
    return { result, problems };
  }

  /** 把 AI 評分寫進席位 N＋1；已經有送出的 AI 評分時先退回（舊內容留在更正歷程） */
  async function applyAiScore(c, run, items, strengths, improvements, actor, reason) {
    const aiAcc = (await db.listAccounts(c.id)).find(a => a.role === 'ai');
    const slot = aiSlotOf(c);
    const seat = (await db.listJudgeSlots(c.id)).find(s => s.slot_no === slot);
    if (!aiAcc || !seat || seat.account_id !== aiAcc.id) fail('找不到 AI 評審席位（開始評分時要開啟 AI 評審）');
    const cur = (await db.listScores(c.id)).find(s => s.team_id === run.team_id && s.slot_no === slot);
    if (cur && cur.status === 'submitted') await db.returnScore(cur.id, actor.id, reason || '重新執行 AI 評分');
    const r = await db.judgeSave(run.team_id, aiAcc.id, items, strengths, improvements, true);
    const t = await db.getTeam(run.team_id);
    await log(actor, 'ai_score', t ? t.code : run.team_id, { run: run.id, total: r.total, manual: String(reason || '').startsWith('主辦人員補分') });
    return r;
  }

  async function adminAiOverview(token) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    const slot = aiSlotOf(c);
    const [teams, locks, scores, runs, versions] = await Promise.all([
      db.listTeams(c.id), db.listLocks(c.id), db.listScores(c.id), c.ai_judge ? db.listAiRuns(c.id) : [], db.listVersions(c.id)]);
    for (const r of runs) {   // 匯入到一半中斷（網路斷線、關掉頁面）的紀錄標成失敗，才不會一直顯示進行中
      if (AI_ACTIVE.includes(r.status) && now() - Date.parse(r.updated_at) > AI_STALE_MS
        && await db.updateAiRun(r.id, { status: 'failed', error: '匯入中斷（超過 5 分鐘沒有送回結果），請重新匯入', updated_at: iso(now()), finished_at: iso(now()) }, r.status)) {
        r.status = 'failed'; r.error = '匯入中斷（超過 5 分鐘沒有送回結果），請重新匯入';
      }
    }
    const rows = locks.map(l => {
      const t = teams.find(x => x.id === l.team_id);
      const v = versions.find(x => x.id === l.version_id) || {};
      const sc = slot ? scores.find(s => s.team_id === t.id && s.slot_no === slot) : null;
      const mine = runs.filter(r => r.team_id === t.id).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
      return {
        teamId: t.id, code: t.code, name: t.name, workTitle: t.work_title, duration: v.duration_sec === null ? null : Number(v.duration_sec),
        category: catOf(t), categoryLabel: CATEGORY_LABEL[catOf(t)],
        score: sc ? { id: sc.id, status: sc.status, label: SCORE_LABEL[sc.status], total: sc.status === 'submitted' ? sc.total : null } : { id: null, status: 'none', label: SCORE_LABEL.none, total: null },
        run: runView(mine[0] || null), runCount: mine.length,
      };
    }).sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.code.localeCompare(b.code));
    return {
      enabled: !!c.ai_judge, phase: c.phase, phaseLabel: PHASE_LABEL[c.phase],
      canImport: !!c.ai_judge && SCORING_PHASES.includes(c.phase), aiSlot: slot, minCommentChars: c.min_comment_chars,
      items: (await rubricView(c, 'project')).items,   // 專題組（舊欄位，相容用）
      itemsByCategory: { project: (await rubricView(c, 'project')).items, creative: (await rubricView(c, 'creative')).items }, rows,
    };
  }

  async function adminAiGetRun(token, runId) {
    const acc = await auth(token, 'admin');
    const c = await compOf(acc);
    const r = await db.getAiRun(runId);
    if (!r || r.competition_id !== c.id) fail('找不到這次 AI 評分');
    return Object.assign(runView(r), { rawOutput: r.raw_output || '' });
  }

  /** 開始一次 AI 評分前的共同檢查：作品在評分名單、已有 AI 評分時要 rerun、沒有進行中的評分 */
  async function aiPreflight(c, teamId, rerun) {
    needScoringPhase(c);
    const lock = (await db.listLocks(c.id)).find(l => l.team_id === teamId);
    if (!lock) fail('這件作品不在評分名單中');
    const cur = (await db.listScores(c.id)).find(s => s.team_id === teamId && s.slot_no === aiSlotOf(c));
    if (cur && cur.status === 'submitted' && !rerun) fail('這件作品已經有 AI 評分；要重新評分請按「重新評分」');
    const busyRun = (await db.listAiRuns(c.id)).find(r => r.team_id === teamId && AI_ACTIVE.includes(r.status)
      && now() - Date.parse(r.updated_at) < AI_STALE_MS);
    if (busyRun) fail('這件作品的 AI 評分正在進行中');
    const t = await db.getTeam(teamId);
    const v = await db.getVersion(lock.version_id);
    if (!v || !v.playback_path) fail('找不到這件作品的播放檔');
    return { t, v };
  }

  /**
   * 匯入外部 AI 評分檔第 1 步（匯入只需幾秒；超過 5 分鐘沒送回就當作中斷）：建立紀錄（狀態 generating）。外部 AI 在系統之外評分，
   * 結果存成 JSON 檔，匯入時（後台或 tools/import_ai_json.mjs）再呼叫 adminAiLocalFinish 送回。
   */
  async function adminAiLocalBegin(token, teamId, rerun, model) {
    const acc = await auth(token, 'admin');
    const c = await aiComp(acc);
    const { t, v } = await aiPreflight(c, teamId, rerun);
    model = str(model, 60).trim() || '外部 AI';
    const at = iso(now());
    const run = await db.insertAiRun({
      competition_id: c.id, team_id: t.id, version_id: v.id, rubric_id: rubricIdOf(c, catOf(t)), model, prompt_version: AI_PROMPT_VERSION,
      status: 'generating', gemini_job: LOCAL_JOB, started_by: acc.id, started_at: at, updated_at: at, problems: [],
    });
    await log(acc, 'ai_start', `${t.code}_v${v.version_no}`, { run: run.id, model, rerun: !!rerun, local: true });
    return {
      runId: run.id, team: { id: t.id, code: t.code, name: t.name },
      video: { path: v.playback_path, versionNo: v.version_no, duration: v.duration_sec === null ? null : Number(v.duration_sec) },
    };
  }

  /** 第 2 步：送回 AI 的回應（或失敗原因）。伺服器照同樣規則驗證、送出到 AI 席位 */
  async function adminAiLocalFinish(token, runId, input) {
    const acc = await auth(token, 'admin');
    const c = await aiComp(acc);
    const r = await db.getAiRun(runId);
    if (!r || r.competition_id !== c.id || r.gemini_job !== LOCAL_JOB) fail('找不到這次本機 AI 評分');
    if (r.status !== 'generating') fail(`這次 AI 評分已經結束（${AI_STATUS[r.status] || r.status}），請重新匯入`);
    if (now() - Date.parse(r.updated_at) > AI_STALE_MS) {
      await db.updateAiRun(r.id, { status: 'failed', error: '匯入逾時（超過 5 分鐘才送回），請重新匯入', updated_at: iso(now()), finished_at: iso(now()) }, 'generating');
      fail('這次匯入已逾時，請重新匯入');
    }
    input = input || {};
    const usage = {};   // 只留數字欄位（token 數、嘗試次數、耗時秒數）
    if (input.usage && typeof input.usage === 'object') Object.entries(input.usage).slice(0, 20).forEach(([k, val]) => { if (Number.isFinite(val)) usage[str(k, 40)] = val; });
    if (input.error) {
      await db.updateAiRun(r.id, { status: 'failed', error: str(input.error, 500), raw_output: str(input.raw, 4000) || null, usage,
        updated_at: iso(now()), finished_at: iso(now()) });
      return runView(await db.getAiRun(r.id));
    }
    needScoringPhase(c);
    if (!(await db.updateAiRun(r.id, { status: 'finishing', updated_at: iso(now()) }, 'generating'))) fail('這次 AI 評分正在寫入，請重新整理');
    return completeRun(c, acc, r, str(input.text, 20000), usage, !!input.draft);
  }

  /** 拿到 AI 的回應後（狀態已經是 finishing）：解析、驗證；全部通過就送出到 AI 席位，否則標成「需要處理」 */
  /** draft＝只驗證並存成「暫存」，不寫進評審席位、不計入平均；之後由主辦人員按「採用」才算數 */
  async function completeRun(c, acc, r, text, usage, draft) {
    const t = await db.getTeam(r.team_id);
    const v = await db.getVersion(r.version_id);
    const rb = await rubricView(c, catOf(t));
    const { result, problems } = aiParse(text, c, v, rb);
    if (!text) problems.unshift('AI 沒有回傳內容');
    await db.updateAiRun(r.id, { raw_output: String(text || '').slice(0, 20000), result, problems, usage, updated_at: iso(now()) });
    r = await db.getAiRun(r.id);
    if (problems.length) {
      await db.updateAiRun(r.id, { status: 'needs_review', finished_at: iso(now()), updated_at: iso(now()) });
      await log(acc, 'ai_needs_review', t.code, { run: r.id, problems });
      return runView(await db.getAiRun(r.id));
    }
    if (draft) {
      await db.updateAiRun(r.id, { status: 'draft', finished_at: iso(now()), updated_at: iso(now()) });
      await log(acc, 'ai_draft', t.code, { run: r.id, total: Object.values(result.items).reduce((a, b) => a + b, 0) });
      return runView(await db.getAiRun(r.id));
    }
    try {
      await applyAiScore(c, r, result.items, result.strengths, result.improvements, acc, '重新執行 AI 評分');
      await db.updateAiRun(r.id, { status: 'done', finished_at: iso(now()), updated_at: iso(now()) });
    } catch (e) {
      const msg = e instanceof UserError || (e && e.userMessage) ? e.message : '寫入評分失敗';
      await db.updateAiRun(r.id, { status: 'needs_review', problems: [msg], finished_at: iso(now()), updated_at: iso(now()) });
    }
    return runView(await db.getAiRun(r.id));
  }

  /** 採用「暫存」的 AI 評分：寫進 AI 評審席位，從這一刻起才計入平均（已有送出的 AI 評分會被取代，舊的留在更正歷程） */
  async function adminAiAdopt(token, runId) {
    const acc = await auth(token, 'admin');
    const c = await aiComp(acc);
    needScoringPhase(c);
    const r = await db.getAiRun(runId);
    if (!r || r.competition_id !== c.id) fail('找不到這次 AI 評分');
    if (r.status !== 'draft') fail('只有「暫存」的 AI 評分可以採用');
    const latest = (await db.listAiRuns(c.id)).filter(x => x.team_id === r.team_id).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
    if (latest && latest.id !== r.id) fail('這件作品已經有更新的 AI 評分紀錄，請重新整理');
    if (!(await db.updateAiRun(r.id, { status: 'finishing', updated_at: iso(now()) }, 'draft'))) fail('這次 AI 評分正在寫入，請重新整理');
    const res = r.result || { items: {} };
    try {
      await applyAiScore(c, r, res.items, res.strengths || '', res.improvements || '', acc, '採用暫存的 AI 評分');
    } catch (e) {
      await db.updateAiRun(r.id, { status: 'draft', updated_at: iso(now()) });
      throw e;
    }
    await db.updateAiRun(r.id, { status: 'done', finished_at: iso(now()), updated_at: iso(now()) });
    const t = await db.getTeam(r.team_id);
    await log(acc, 'ai_adopt', t.code, { run: r.id, total: Object.values(res.items).reduce((a, b) => a + b, 0) });
    return runView(await db.getAiRun(r.id));
  }

  /** 修改「暫存」的 AI 評分（分數與評語）；仍是暫存，不計入平均，要按「送出」（採用）才算數。修改內容留在這次紀錄與操作紀錄裡 */
  async function adminAiEditDraft(token, runId, input) {
    const acc = await auth(token, 'admin');
    const c = await aiComp(acc);
    needScoringPhase(c);
    const r = await db.getAiRun(runId);
    if (!r || r.competition_id !== c.id) fail('找不到這次 AI 評分');
    if (r.status !== 'draft') fail('只有「暫存」的 AI 評分可以修改');
    const latest = (await db.listAiRuns(c.id)).filter(x => x.team_id === r.team_id).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
    if (latest && latest.id !== r.id) fail('這件作品已經有更新的 AI 評分紀錄，請重新整理');
    input = input || {};
    const rb = await rubricView(c, catOf(await db.getTeam(r.team_id)));
    const base = r.result || { items: {} };
    const given = input.items && typeof input.items === 'object' ? input.items : {};
    const items = {}, changed = {};
    for (const it of rb.items) {
      const g = given[it.id];
      const n = g === undefined || g === null || g === '' ? base.items[it.id] : Number(g);
      if (!Number.isInteger(n) || n < 0 || n > it.max) fail(`「${it.title}」的分數要是 0～${it.max} 的整數`);
      if (n !== base.items[it.id]) changed[it.id] = { from: base.items[it.id] ?? null, to: n };
      items[it.id] = n;
    }
    const strengths = str(input.strengths ?? base.strengths ?? '', 2000).trim();
    const improvements = str(input.improvements ?? base.improvements ?? '', 2000).trim();
    const min = c.min_comment_chars || 0;
    if ([...strengths].length < min) fail(`「作品優點」至少要 ${min} 個字`);
    if ([...improvements].length < min) fail(`「改進建議」至少要 ${min} 個字`);
    const commentsEdited = strengths !== (base.strengths || '') || improvements !== (base.improvements || '');
    if (!Object.keys(changed).length && !commentsEdited) return runView(r);
    const prev = r.manual && r.manual.items ? r.manual.items : {};
    const merged = Object.assign({}, prev);
    Object.entries(changed).forEach(([k, v]) => { merged[k] = { from: prev[k] ? prev[k].from : v.from, to: v.to }; });
    await db.updateAiRun(r.id, { result: Object.assign({}, base, { items, strengths, improvements }),
      manual: { items: merged, reason: '送出前修改暫存', by: acc.id, at: iso(now()), commentsEdited: commentsEdited || !!(r.manual && r.manual.commentsEdited) },
      updated_at: iso(now()) });
    const t = await db.getTeam(r.team_id);
    await log(acc, 'ai_edit_draft', t.code, { run: r.id, changed, commentsEdited });
    return runView(await db.getAiRun(r.id));
  }

  /** 需要處理的 AI 評分：主辦人員補上（或修改）分數與評語並寫理由後送出 */
  async function adminAiFinalize(token, runId, input) {
    const acc = await auth(token, 'admin');
    const c = await aiComp(acc);
    needScoringPhase(c);
    const r = await db.getAiRun(runId);
    if (!r || r.competition_id !== c.id) fail('找不到這次 AI 評分');
    if (r.status !== 'needs_review') fail('只有「需要處理」的 AI 評分可以補分');
    const latest = (await db.listAiRuns(c.id)).filter(x => x.team_id === r.team_id).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
    if (latest && latest.id !== r.id) fail('這件作品已經有更新的 AI 評分紀錄，請重新整理');
    input = input || {};
    const reason = String(input.reason || '').trim();
    if (!reason) fail('補分必須填寫理由');
    if (reason.length > 500) fail('理由最多 500 字');
    const rb = await rubricView(c, catOf(await db.getTeam(r.team_id)));
    const base = (r.result && r.result.items) || {};
    const given = input.items && typeof input.items === 'object' ? input.items : {};
    const items = {}, changed = {};
    for (const it of rb.items) {
      const g = given[it.id];
      if (g !== undefined && g !== null && g !== '') {
        const n = Number(g);
        if (!Number.isInteger(n) || n < 0 || n > it.max) fail(`「${it.title}」的分數要是 0～${it.max} 的整數`);
        if (n !== base[it.id]) changed[it.id] = { from: base[it.id] ?? null, to: n };
        items[it.id] = n;
      } else if (Number.isInteger(base[it.id])) items[it.id] = base[it.id];
      else fail(`「${it.title}」還沒有分數`);
    }
    const strengths = String(input.strengths ?? (r.result && r.result.strengths) ?? '').trim();
    const improvements = String(input.improvements ?? (r.result && r.result.improvements) ?? '').trim();
    const sc = await applyAiScore(c, r, items, strengths, improvements, acc, '主辦人員補分：' + reason);
    const manual = { items: changed, reason, by: acc.id, at: iso(now()),
      commentsEdited: strengths !== ((r.result && r.result.strengths) || '') || improvements !== ((r.result && r.result.improvements) || '') };
    await db.updateAiRun(r.id, { status: 'finalized', manual, updated_at: iso(now()) });
    const t = await db.getTeam(r.team_id);
    await log(acc, 'ai_finalize', t.code, { run: r.id, changed, reason, total: sc.total });
    return runView(await db.getAiRun(r.id));
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
        const s = teamStatus(c, vs, b.curBy[t.id], b.lockBy[t.id]);
        return { code: t.code, name: t.name, workTitle: t.work_title, category: catOf(t), categoryLabel: CATEGORY_LABEL[catOf(t)], status: s.label };
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
    // 舊快照（沒有分組）當作只有專題組
    const cats = (Array.isArray(s.categories) ? s.categories : [{ category: 'project', items: s.items }]).map(x => ({
      category: x.category === 'creative' ? 'creative' : 'project',
      label: CATEGORY_LABEL[x.category === 'creative' ? 'creative' : 'project'],
      items: showItems && Array.isArray(x.items) ? x.items.map(i => ({ id: String(i.id), title: String(i.title), max: Number(i.max) })) : null,
    }));
    return {
      published: true,
      competition: { name: c.name },
      publishedAt: pub.published_at,
      judgeCount: Number(s.judgeCount) || null,
      categories: cats,
      items: cats.length ? cats[0].items : null,   // 舊欄位（第一組的分項），相容用
      teams: (Array.isArray(s.teams) ? s.teams : []).map(t => ({
        category: t.category === 'creative' ? 'creative' : 'project',
        rank: Number(t.rank) || null,
        tied: !!t.tied,
        tieBroken: !!t.tieBroken,
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
    adminGetBoard, adminUpdateCompetition, adminSetAiCounted, adminGetRubric, adminSaveRubric, adminAssignSlot,
    adminUpsertTeam, adminDeleteTeam, adminSetReceivedAt, adminSetCurrentVersion,
    adminJudgingPreview, adminSetPhase,
    judgeListWorks, judgeGetWork, judgeSaveDraft, judgeSubmit,
    adminListScores, adminGetScore, adminReturnScore,
    adminRanking, adminDecideTie, adminExportCsv, adminPublish, adminRevoke,
    adminAiOverview, adminAiGetRun, adminAiFinalize, adminAiAdopt, adminAiEditDraft, adminAiLocalBegin, adminAiLocalFinish,
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
