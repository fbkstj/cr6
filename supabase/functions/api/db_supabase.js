// core.js 用的資料存取層（正式環境：Supabase Postgres，用 service role 存取）。
// 介面和 test/memdb.mjs 一致；密碼雜湊永遠不會回傳給 core.js。
import { createClient } from 'npm:@supabase/supabase-js@2';

const ACCOUNT_COLS = 'id, competition_id, login_id, display_name, role, active, created_at, password_hash';

export function createDb(url, serviceKey) {
  const sb = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  function must({ data, error }) {
    if (error) throw new Error('資料庫錯誤：' + error.message);
    return data;
  }
  const one = r => { const d = must(r); return Array.isArray(d) ? (d[0] || null) : d; };
  /** 把密碼雜湊換成 has_password，不讓雜湊離開資料層 */
  const strip = a => {
    if (!a) return null;
    const { password_hash, ...rest } = a;
    return Object.assign(rest, { has_password: !!password_hash });
  };

  return {
    /* 競賽 */
    getCompetition: async id => one(await sb.from('competitions').select('*').eq('id', id).limit(1)),
    getActiveCompetition: async () => one(await sb.from('competitions').select('*').eq('active', true).limit(1)),

    /* 帳號 */
    getAccount: async id => strip(one(await sb.from('accounts').select(ACCOUNT_COLS).eq('id', id).limit(1))),
    getAccountByLogin: async loginId => strip(one(await sb.from('accounts').select(ACCOUNT_COLS).eq('login_id', loginId).limit(1))),
    listAccounts: async cid => must(await sb.from('accounts').select(ACCOUNT_COLS).eq('competition_id', cid)).map(strip),
    insertAccount: async row => strip(one(await sb.from('accounts').insert(row).select(ACCOUNT_COLS))),
    updateAccount: async (id, patch) => { must(await sb.from('accounts').update(patch).eq('id', id)); },
    checkPassword: async (loginId, pw) => must(await sb.rpc('check_password', { p_login: loginId, p_pw: pw })) || null,
    setPassword: async (loginId, pw) => { must(await sb.rpc('set_password', { p_login: loginId, p_pw: pw })); },

    /* 評審席位 */
    listJudgeSlots: async cid => must(await sb.from('judge_slots').select('*').eq('competition_id', cid)),

    /* 登入失敗 */
    getLoginFail: async key => one(await sb.from('login_fails').select('*').eq('key', key).limit(1)),
    setLoginFail: async (key, count, until) => { must(await sb.from('login_fails').upsert({ key, count, until })); },
    clearLoginFail: async key => { must(await sb.from('login_fails').delete().eq('key', key)); },

    /* 紀錄 */
    insertAdminLog: async row => { must(await sb.from('admin_logs').insert(row)); },
    listAdminLogs: async (cid, n) => must(await sb.from('admin_logs').select('*').eq('competition_id', cid).order('id', { ascending: false }).limit(n)),

    /* 公布 */
    getLivePublication: async cid => one(await sb.from('publications').select('*').eq('competition_id', cid).is('revoked_at', null).limit(1)),
  };
}
