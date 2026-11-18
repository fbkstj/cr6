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

export function createApi({ db, secret, now = () => Date.now() }) {
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

  /* ───────────── 公開（免登入） ───────────── */

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
    publicResults,
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
      console.error(e);
      return { ok: false, error: '系統忙碌，請稍後再試' };
    }
  }

  return { handle, API };
}
