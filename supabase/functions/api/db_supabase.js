// core.js 用的資料存取層（正式環境：Supabase Postgres，用 service role 存取）。
// 介面和 test/memdb.mjs 一致；密碼雜湊永遠不會回傳給 core.js。
import { createClient } from 'npm:@supabase/supabase-js@2';

const ACCOUNT_COLS = 'id, competition_id, login_id, display_name, role, active, created_at, password_hash';

export function createDb(url, serviceKey) {
  const sb = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  function must({ data, error }) {
    if (error) {
      const e = new Error('資料庫錯誤：' + error.message);
      // 資料庫函式用 raise exception 丟出的中文訊息（SQLSTATE P0001）可以直接顯示給使用者
      if (error.code === 'P0001') e.userMessage = error.message;
      throw e;
    }
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

    updateCompetition: async (id, patch) => { must(await sb.from('competitions').update(patch).eq('id', id)); },

    /* 評審席位 */
    listJudgeSlots: async cid => must(await sb.from('judge_slots').select('*').eq('competition_id', cid)),
    upsertSlot: async row => { must(await sb.from('judge_slots').upsert(row)); },
    deleteSlot: async (cid, slotNo) => { must(await sb.from('judge_slots').delete().eq('competition_id', cid).eq('slot_no', slotNo)); },
    deleteSlotsAbove: async (cid, n) => { must(await sb.from('judge_slots').delete().eq('competition_id', cid).gt('slot_no', n)); },

    /* 評分表 */
    async getRubric(id) {
      if (!id) return null;
      const r = one(await sb.from('rubrics').select('*').eq('id', id).limit(1));
      if (!r) return null;
      r.items = must(await sb.from('rubric_items').select('*').eq('rubric_id', id));
      return r;
    },
    saveRubric: async (rid, items) => must(await sb.rpc('save_rubric', { p_rubric: rid, p_items: items })),

    /* 小組與影片版本 */
    listTeams: async cid => must(await sb.from('teams').select('*').eq('competition_id', cid)),
    getTeam: async id => one(await sb.from('teams').select('*').eq('id', id).limit(1)),
    insertTeam: async row => one(await sb.from('teams').insert(row).select()),
    updateTeam: async (id, patch) => { must(await sb.from('teams').update(patch).eq('id', id)); },
    deleteTeam: async id => { must(await sb.from('teams').delete().eq('id', id)); },
    listVersions: async cid => must(await sb.from('video_versions').select('*').eq('competition_id', cid)),
    getVersion: async id => one(await sb.from('video_versions').select('*').eq('id', id).limit(1)),
    insertVersion: async row => one(await sb.from('video_versions').insert(row).select()),
    updateVersion: async (id, patch) => { must(await sb.from('video_versions').update(patch).eq('id', id)); },
    setTeamCurrent: async row => { must(await sb.from('team_current').upsert(row)); },
    listTeamCurrent: async cid => must(await sb.from('team_current').select('team_id, version_id, teams!inner(competition_id)').eq('teams.competition_id', cid))
      .map(({ teams, ...r }) => r),
    listLocks: async cid => must(await sb.from('judging_locks').select('team_id, version_id, locked_at, teams!inner(competition_id)').eq('teams.competition_id', cid))
      .map(({ teams, ...r }) => r),

    /* 資格審查 */
    listReviews: async ids => (ids.length ? must(await sb.from('reviews').select('*').in('version_id', ids)) : []),
    insertReview: async row => { must(await sb.from('reviews').insert(row)); },
    lockForJudging: async (cid, actor) => must(await sb.rpc('lock_for_judging', { p_competition: cid, p_actor: actor })),

    /* 評分 */
    listScores: async cid => must(await sb.from('scores').select('*').eq('competition_id', cid)),
    getScore: async id => one(await sb.from('scores').select('*').eq('id', id).limit(1)),
    listScoreHistory: async ids => (ids.length ? must(await sb.from('score_history').select('*').in('score_id', ids)) : []),
    judgeSave: async (teamId, accountId, items, strengths, improvements, submit) => must(await sb.rpc('judge_save', {
      p_team: teamId, p_account: accountId, p_items: items, p_strengths: strengths, p_improvements: improvements, p_submit: submit })),
    returnScore: async (scoreId, actor, reason) => { must(await sb.rpc('return_score', { p_score: scoreId, p_actor: actor, p_reason: reason })); },

    /* 登入失敗 */
    getLoginFail: async key => one(await sb.from('login_fails').select('*').eq('key', key).limit(1)),
    setLoginFail: async (key, count, until) => { must(await sb.from('login_fails').upsert({ key, count, until })); },
    clearLoginFail: async key => { must(await sb.from('login_fails').delete().eq('key', key)); },

    /* 紀錄 */
    insertAdminLog: async row => { must(await sb.from('admin_logs').insert(row)); },
    listAdminLogs: async (cid, n) => must(await sb.from('admin_logs').select('*').eq('competition_id', cid).order('id', { ascending: false }).limit(n)),

    /* 同分處理與公布 */
    listTieDecisions: async cid => must(await sb.from('tie_decisions').select('*').eq('competition_id', cid)),
    insertTieDecision: async row => { must(await sb.from('tie_decisions').insert(row)); },
    publishResults: async (cid, actor, snapshot) => must(await sb.rpc('publish_results', { p_competition: cid, p_actor: actor, p_snapshot: snapshot })),
    revokePublication: async (cid, actor, reason) => { must(await sb.rpc('revoke_publication', { p_competition: cid, p_actor: actor, p_reason: reason })); },
    getLivePublication: async cid => one(await sb.from('publications').select('*').eq('competition_id', cid).is('revoked_at', null).limit(1)),

    /* AI 評分紀錄 */
    listAiRuns: async cid => must(await sb.from('ai_runs').select('*').eq('competition_id', cid)),
    getAiRun: async id => one(await sb.from('ai_runs').select('*').eq('id', id).limit(1)),
    insertAiRun: async row => one(await sb.from('ai_runs').insert(row).select()),
    /** expectStatus：只有目前狀態相符才更新；回傳是否有更新 */
    async updateAiRun(id, patch, expectStatus) {
      let q = sb.from('ai_runs').update(patch).eq('id', id);
      if (expectStatus) q = q.eq('status', expectStatus);
      return must(await q.select('id')).length > 0;
    },
  };
}
