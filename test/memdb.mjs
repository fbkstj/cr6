// 本機測試用的記憶體資料庫：介面和 supabase/functions/api/db_supabase.js 一樣。
// 資料庫函式（save_rubric、lock_for_judging）照 SQL 版的規則用 JS 實作；SQL 版本身由 test/check_sql.mjs 驗證。
// 密碼用 scrypt 雜湊（正式環境是資料庫裡的 bcrypt），同樣不會把雜湊回傳給 core.js。
import crypto from 'node:crypto';

const hashPw = pw => { const salt = crypto.randomBytes(8).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); };
const verifyPw = (pw, h) => { if (!h) return false; const [salt, hex] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(hex, 'hex'), crypto.scryptSync(pw, salt, 32)); };

/** 模擬資料庫函式 raise exception（core.js 會把 userMessage 顯示給使用者） */
const raise = msg => { const e = new Error(msg); e.userMessage = msg; throw e; };

export function createMemDb() {
  const t = {
    competitions: [], accounts: [], rubrics: [], rubric_items: [], judge_slots: [], teams: [], video_versions: [],
    team_current: [], reviews: [], judging_locks: [], scores: [], score_history: [], tie_decisions: [], login_fails: [], admin_logs: [], publications: [],
    ai_runs: [],
  };
  const seats = c => c.judge_count + (c.ai_judge && c.ai_counted !== false ? 1 : 0);   // 同 SQL seat_count
  const clone = v => (v === undefined ? undefined : structuredClone(v));
  const strip = a => { if (!a) return null; const { password_hash, ...rest } = a; return Object.assign(clone(rest), { has_password: !!password_hash }); };
  const nowIso = () => new Date().toISOString();
  let seq = 0;
  const teamIdsOf = cid => new Set(t.teams.filter(x => x.competition_id === cid).map(x => x.id));
  const latestStatus = vid => {
    const rs = t.reviews.filter(r => r.version_id === vid).sort((a, b) => b.id - a.id);
    return rs.length ? rs[0].status : 'pending';
  };

  const db = {
    _tables: t,

    /* 競賽 */
    getCompetition: async id => clone(t.competitions.find(c => c.id === id) || null),
    getActiveCompetition: async () => clone(t.competitions.find(c => c.active) || null),
    updateCompetition: async (id, patch) => { Object.assign(t.competitions.find(c => c.id === id), clone(patch)); },

    /* 帳號 */
    getAccount: async id => strip(t.accounts.find(a => a.id === id)),
    getAccountByLogin: async loginId => strip(t.accounts.find(a => a.login_id === loginId)),
    listAccounts: async cid => t.accounts.filter(a => a.competition_id === cid).map(strip),
    insertAccount: async row => {
      if (t.accounts.some(a => a.login_id === row.login_id)) throw new Error('duplicate login_id');
      const r = Object.assign({ id: crypto.randomUUID(), password_hash: null, created_at: nowIso() }, row);
      t.accounts.push(r);
      return strip(r);
    },
    updateAccount: async (id, patch) => { Object.assign(t.accounts.find(a => a.id === id), clone(patch)); },
    checkPassword: async (loginId, pw) => {
      const a = t.accounts.find(x => x.login_id === loginId);
      return a && a.active && a.role !== 'ai' && verifyPw(String(pw), a.password_hash) ? a.id : null;
    },
    setPassword: async (loginId, pw) => {
      if (String(pw).length < 8) raise('密碼至少 8 個字');
      const a = t.accounts.find(x => x.login_id === loginId);
      if (a && a.role === 'ai') raise('AI 帳號不能設定密碼');
      if (!a) raise('找不到帳號');
      a.password_hash = hashPw(String(pw));
    },

    /* 評審席位 */
    listJudgeSlots: async cid => clone(t.judge_slots.filter(s => s.competition_id === cid)),
    upsertSlot: async row => {
      if (t.judge_slots.some(s => s.competition_id === row.competition_id && s.account_id === row.account_id && s.slot_no !== row.slot_no)) throw new Error('duplicate judge');
      const i = t.judge_slots.findIndex(s => s.competition_id === row.competition_id && s.slot_no === row.slot_no);
      if (i >= 0) t.judge_slots[i] = clone(row); else t.judge_slots.push(clone(row));
    },
    deleteSlot: async (cid, n) => { t.judge_slots = t.judge_slots.filter(s => !(s.competition_id === cid && s.slot_no === n)); },
    deleteSlotsAbove: async (cid, n) => { t.judge_slots = t.judge_slots.filter(s => !(s.competition_id === cid && s.slot_no > n)); },

    /* 評分表 */
    getRubric: async id => {
      const r = t.rubrics.find(x => x.id === id);
      return r ? Object.assign(clone(r), { items: clone(t.rubric_items.filter(i => i.rubric_id === id)) }) : null;
    },
    saveRubric: async (rid, items) => {   // 同 SQL save_rubric
      const r = t.rubrics.find(x => x.id === rid);
      if (!r) raise('找不到評分表');
      const c = t.competitions.find(x => x.id === r.competition_id);
      if (r.locked || !['setup', 'collecting'].includes(c.phase)) raise('評分表已鎖定，不能修改');
      const total = items.reduce((s, i) => s + i.max_score, 0);
      if (total !== 100) raise(`評分表總分必須是 100（目前 ${total}）`);
      t.rubric_items = t.rubric_items.filter(i => i.rubric_id !== rid)
        .concat(items.map((i, k) => ({ id: crypto.randomUUID(), rubric_id: rid, sort: k + 1, title: i.title, max_score: i.max_score, description: i.description || '' })));
      return items.length;
    },

    /* 小組與影片版本 */
    listTeams: async cid => clone(t.teams.filter(x => x.competition_id === cid)),
    getTeam: async id => clone(t.teams.find(x => x.id === id) || null),
    insertTeam: async row => {
      if (t.teams.some(x => x.competition_id === row.competition_id && x.code === row.code)) throw new Error('duplicate team');
      const r = Object.assign({ id: crypto.randomUUID(), name: '', members: '', work_title: '', work_desc: '', category: 'project', created_at: nowIso() }, clone(row));
      if (!['project', 'creative'].includes(r.category)) throw new Error('bad category');
      t.teams.push(r);
      return clone(r);
    },
    updateTeam: async (id, patch) => {
      if (patch.category !== undefined && !['project', 'creative'].includes(patch.category)) throw new Error('bad category');
      Object.assign(t.teams.find(x => x.id === id), clone(patch));
    },
    deleteTeam: async id => { t.teams = t.teams.filter(x => x.id !== id); },
    listVersions: async cid => clone(t.video_versions.filter(v => v.competition_id === cid)),
    getVersion: async id => clone(t.video_versions.find(v => v.id === id) || null),
    insertVersion: async row => {
      // 和資料庫相同的唯一約束
      if (t.video_versions.some(v => v.competition_id === row.competition_id && v.source_sha256 === row.source_sha256)) throw new Error('duplicate sha256');
      if (t.video_versions.some(v => v.team_id === row.team_id && v.version_no === row.version_no)) throw new Error('duplicate version');
      if (row.check_ok && !row.playback_path) throw new Error('check_ok without playback');
      const r = Object.assign({ id: crypto.randomUUID(), received_at: null, created_at: nowIso() }, clone(row));
      t.video_versions.push(r);
      return clone(r);
    },
    updateVersion: async (id, patch) => { Object.assign(t.video_versions.find(v => v.id === id), clone(patch)); },
    setTeamCurrent: async row => {
      const i = t.team_current.findIndex(x => x.team_id === row.team_id);
      if (i >= 0) t.team_current[i] = clone(row); else t.team_current.push(clone(row));
    },
    listTeamCurrent: async cid => { const ids = teamIdsOf(cid); return clone(t.team_current.filter(x => ids.has(x.team_id))); },
    listLocks: async cid => { const ids = teamIdsOf(cid); return clone(t.judging_locks.filter(x => ids.has(x.team_id))); },

    /* 資格審查 */
    listReviews: async ids => clone(t.reviews.filter(r => ids.includes(r.version_id))),
    insertReview: async row => {
      if ((row.status === 'resubmit' || row.status === 'fail') && !String(row.reason || '').trim()) throw new Error('reason required');
      t.reviews.push(Object.assign({ id: ++seq }, clone(row)));
    },

    /** 同 SQL lock_for_judging：先全部檢查，全部通過才一次寫入 */
    lockForJudging: async (cid, actor) => {
      const c = t.competitions.find(x => x.id === cid);
      if (c.phase !== 'collecting') raise('只有「收件審查」階段可以開始評分');
      const n = t.judge_slots.filter(s => s.competition_id === cid && s.slot_no <= c.judge_count
        && t.accounts.some(a => a.id === s.account_id && a.active && a.role === 'judge')).length;
      if (n < c.judge_count) raise(`評審席位還沒排滿（${n} / ${c.judge_count}）`);
      if (t.rubric_items.filter(i => i.rubric_id === c.rubric_id).reduce((s, i) => s + i.max_score, 0) !== 100) raise('專題組評分表總分必須是 100');
      if (t.rubric_items.filter(i => i.rubric_id === c.rubric_id_creative).reduce((s, i) => s + i.max_score, 0) !== 100) raise('創意組評分表總分必須是 100');
      const ids = teamIdsOf(cid);
      const cur = t.team_current.filter(x => ids.has(x.team_id));
      const pend = cur.filter(x => latestStatus(x.version_id) === 'pending').length;
      if (pend) raise(`還有 ${pend} 組的資格審查未完成`);
      const pass = cur.filter(x => latestStatus(x.version_id) === 'pass');
      if (!pass.length) raise('沒有任何資格通過的作品');
      t.judging_locks = t.judging_locks.filter(x => !ids.has(x.team_id))
        .concat(pass.map(x => ({ team_id: x.team_id, version_id: x.version_id, locked_at: nowIso(), locked_by: actor })));
      const lockedIds = new Set(pass.map(x => x.team_id));
      const excluded = t.teams.filter(x => ids.has(x.id) && !lockedIds.has(x.id)).map(x => x.code).sort();
      t.judge_slots = t.judge_slots.filter(s => !(s.competition_id === cid && s.slot_no > c.judge_count));
      if (c.ai_judge) {   // AI 評審：建立系統帳號（沒有密碼）並坐席位 N＋1
        let ai = t.accounts.find(a => a.competition_id === cid && a.role === 'ai');
        if (!ai) {
          ai = { id: crypto.randomUUID(), competition_id: cid, login_id: 'ai-' + cid.replace(/-/g, '').slice(0, 8), display_name: 'AI 評審', role: 'ai', active: true, password_hash: null, created_at: nowIso() };
          t.accounts.push(ai);
        }
        ai.active = true;
        t.judge_slots.push({ competition_id: cid, slot_no: c.judge_count + 1, account_id: ai.id, assigned_at: nowIso(), replaced_reason: null });
      }
      t.rubrics.filter(r => r.id === c.rubric_id || r.id === c.rubric_id_creative).forEach(r => { r.locked = true; });
      c.phase = 'judging';
      t.admin_logs.push({ id: ++seq, competition_id: cid, actor, action: 'lock_for_judging', target: '', detail: { locked: pass.length, excluded, judges: c.judge_count, ai: !!c.ai_judge }, at: nowIso() });
      return { locked: pass.length, excluded };
    },

    /* 評分 */
    listScores: async cid => clone(t.scores.filter(s => s.competition_id === cid)),
    getScore: async id => clone(t.scores.find(s => s.id === id) || null),
    listScoreHistory: async ids => clone(t.score_history.filter(h => ids.includes(h.score_id))),

    /** 同 SQL judge_save：檢查全部通過才寫入 */
    judgeSave: async (teamId, accountId, items, strengths, improvements, submit) => {
      const acc = t.accounts.find(a => a.id === accountId);
      if (!acc) raise('找不到帳號');
      const c = t.competitions.find(x => x.id === acc.competition_id);
      if (!['judging', 'settling'].includes(c.phase)) raise('目前不是評分階段');
      const slotRow = t.judge_slots.find(s => s.competition_id === c.id && s.account_id === accountId);
      if (!slotRow) raise('你目前沒有被指派評審席位');
      const team = t.teams.find(x => x.id === teamId && x.competition_id === c.id);
      const lock = team && t.judging_locks.find(l => l.team_id === teamId);
      if (!lock) raise('這件作品不在評分名單中');
      const rid = team.category === 'creative' ? c.rubric_id_creative : c.rubric_id;   // 依作品所屬組別的評分表
      const ritems = t.rubric_items.filter(i => i.rubric_id === rid).sort((a, b) => a.sort - b.sort);
      if (Object.keys(items || {}).some(k => !ritems.some(i => i.id === k))) raise('分數裡有不在評分表上的項目');
      const clean = {};
      let tot = 0;
      for (const it of ritems) {
        const v = (items || {})[it.id];
        if (v === null || v === undefined) continue;
        if (typeof v !== 'number' || !Number.isInteger(v)) raise(`「${it.title}」的分數要是整數`);
        if (v < 0 || v > it.max_score) raise(`「${it.title}」的分數要在 0～${it.max_score} 之間`);
        clean[it.id] = v;
        tot += v;
      }
      strengths = String(strengths || '').trim();
      improvements = String(improvements || '').trim();
      if (strengths.length > 2000 || improvements.length > 2000) raise('評語最多 2000 字');
      let s = t.scores.find(x => x.team_id === teamId && x.slot_no === slotRow.slot_no);
      if (s && s.status === 'submitted') raise('已經正式送出，需要主辦方退回才能修改');
      if (submit) {
        const missing = ritems.length - Object.keys(clean).length;
        if (missing) raise(`還有 ${missing} 個項目沒有給分`);
        if ([...strengths].length < c.min_comment_chars) raise(`「作品優點」至少要 ${c.min_comment_chars} 個字`);
        if ([...improvements].length < c.min_comment_chars) raise(`「改進建議」至少要 ${c.min_comment_chars} 個字`);
      }
      const prevReturned = !!s && s.status === 'returned';
      const now = nowIso();
      if (!s) {
        s = { id: crypto.randomUUID(), competition_id: c.id, team_id: teamId, slot_no: slotRow.slot_no };
        t.scores.push(s);
      }
      Object.assign(s, {
        version_id: lock.version_id, account_id: accountId, items: clean,
        status: submit ? 'submitted' : (prevReturned ? 'returned' : 'draft'),
        total: submit ? tot : null, strengths, improvements, submitted_at: submit ? now : null, updated_at: now,
      });
      if (submit) t.score_history.push({ id: ++seq, score_id: s.id, action: prevReturned ? 'resubmit' : 'submit', snapshot: { items: clean, total: tot, strengths, improvements, account: accountId }, actor: accountId, reason: '', at: now });
      return { status: s.status, total: s.total };
    },

    /** 同 SQL return_score */
    returnScore: async (scoreId, actor, reason) => {
      const s = t.scores.find(x => x.id === scoreId);
      if (!s) raise('找不到這份評分');
      const c = t.competitions.find(x => x.id === s.competition_id);
      if (!['judging', 'settling'].includes(c.phase)) raise('目前階段不能退回評分');
      if (s.status !== 'submitted') raise('只有已正式送出的評分可以退回');
      if (!String(reason || '').trim()) raise('退回必須填寫原因');
      const now = nowIso();
      t.score_history.push({ id: ++seq, score_id: s.id, action: 'return', snapshot: { items: s.items, total: s.total, strengths: s.strengths, improvements: s.improvements, account: s.account_id }, actor, reason: String(reason).trim(), at: now });
      Object.assign(s, { status: 'returned', submitted_at: null, total: null, updated_at: now });
      t.admin_logs.push({ id: ++seq, competition_id: s.competition_id, actor, action: 'return_score', target: s.id, detail: { slot: s.slot_no, reason: String(reason).trim() }, at: now });
    },

    /* 登入失敗 */
    getLoginFail: async key => clone(t.login_fails.find(f => f.key === key) || null),
    setLoginFail: async (key, count, until) => {
      const f = t.login_fails.find(x => x.key === key);
      if (f) Object.assign(f, { count, until }); else t.login_fails.push({ key, count, until });
    },
    clearLoginFail: async key => { t.login_fails = t.login_fails.filter(f => f.key !== key); },

    /* 紀錄 */
    insertAdminLog: async row => { t.admin_logs.push(Object.assign({ id: ++seq }, clone(row))); },
    listAdminLogs: async (cid, n) => clone(t.admin_logs.filter(l => l.competition_id === cid).sort((a, b) => b.id - a.id).slice(0, n)),

    /* 同分處理與公布 */
    listTieDecisions: async cid => clone(t.tie_decisions.filter(d => d.competition_id === cid)),
    insertTieDecision: async row => {
      if (!String(row.reason || '').trim()) throw new Error('reason required');
      t.tie_decisions.push(Object.assign({ id: crypto.randomUUID(), seq: ++seq }, clone(row)));
    },
    /** 同 SQL publish_results */
    publishResults: async (cid, actor, snapshot) => {
      const c = t.competitions.find(x => x.id === cid);
      if (c.phase !== 'settling') raise('只有「結算」階段可以公布');
      if (!snapshot || !Array.isArray(snapshot.teams)) raise('結果快照格式錯誤');
      const ids = teamIdsOf(cid);
      const missing = t.judging_locks.filter(l => ids.has(l.team_id)
        && t.scores.filter(s => s.team_id === l.team_id && s.status === 'submitted' && s.slot_no <= seats(c)).length < seats(c)).length;
      if (missing) raise(`還有 ${missing} 件作品的評分沒有收齊`);
      if (t.publications.some(p => p.competition_id === cid && !p.revoked_at)) raise('已經公布過了，請先撤回');
      const p = { id: crypto.randomUUID(), competition_id: cid, published_at: nowIso(), published_by: actor, snapshot: clone(snapshot), revoked_at: null };
      t.publications.push(p);
      c.phase = 'published';
      t.admin_logs.push({ id: ++seq, competition_id: cid, actor, action: 'publish', target: p.id, detail: { teams: snapshot.teams.length }, at: nowIso() });
      return p.id;
    },
    /** 同 SQL revoke_publication */
    revokePublication: async (cid, actor, reason) => {
      const c = t.competitions.find(x => x.id === cid);
      if (c.phase !== 'published') raise('目前沒有公布中的結果');
      if (!String(reason || '').trim()) raise('撤回必須填寫原因');
      const p = t.publications.find(x => x.competition_id === cid && !x.revoked_at);
      if (p) Object.assign(p, { revoked_at: nowIso(), revoked_by: actor, revoke_reason: String(reason).trim() });
      c.phase = 'settling';
      t.admin_logs.push({ id: ++seq, competition_id: cid, actor, action: 'revoke', target: p ? p.id : '', detail: { reason: String(reason).trim() }, at: nowIso() });
    },
    getLivePublication: async cid => clone(t.publications.find(p => p.competition_id === cid && !p.revoked_at) || null),

    /* AI 評分紀錄 */
    listAiRuns: async cid => clone(t.ai_runs.filter(r => r.competition_id === cid)),
    getAiRun: async id => clone(t.ai_runs.find(r => r.id === id) || null),
    insertAiRun: async row => {
      const r = Object.assign({ id: crypto.randomUUID(), problems: [], gemini_file: null, gemini_uri: null, raw_output: null, result: null,
        manual: null, usage: null, error: null, finished_at: null }, clone(row));
      t.ai_runs.push(r);
      return clone(r);
    },
    /** expectStatus：只有目前狀態相符才更新（同一步驟不會被執行兩次）；回傳是否有更新 */
    updateAiRun: async (id, patch, expectStatus) => {
      const r = t.ai_runs.find(x => x.id === id);
      if (!r || (expectStatus && r.status !== expectStatus)) return false;
      Object.assign(r, clone(patch));
      return true;
    },
  };

  /** 測試資料：等同 SQL 的 create_competition＋5 位評審＋3 個組別（全部是合成資料） */
  db.seedDemo = async ({ judgeCount = 5, teams = 3, aiJudge = false, creative = [] } = {}) => {   // creative：屬於創意組的組別代碼，例如 ['team03']
    const cid = crypto.randomUUID(), rid = crypto.randomUUID(), rid2 = crypto.randomUUID();
    t.competitions.push({ id: cid, name: '測試競賽（合成資料）', active: true, phase: 'setup', judge_count: judgeCount, ai_judge: aiJudge, ai_counted: true, rubric_id: rid, rubric_id_creative: rid2,
      show_status_page: true, show_item_scores: false, min_comment_chars: 10 });
    t.rubrics.push({ id: rid, competition_id: cid, name: '預設評分表', category: 'project', version: 1, locked: false });
    t.rubrics.push({ id: rid2, competition_id: cid, name: '創意組評分表', category: 'creative', version: 1, locked: false });
    [['專題作品的應用及整合性', 40], ['專題作品與課程相關', 25], ['創意性與實用性', 25], ['作品說明的組織與表達', 10]]
      .forEach(([title, max], k) => t.rubric_items.push({ id: crypto.randomUUID(), rubric_id: rid, sort: k + 1, title, max_score: max, description: '' }));
    [['獨創性', 40], ['實用性', 25], ['商品化程度', 25], ['內文組織及架構格式', 10]]
      .forEach(([title, max], k) => t.rubric_items.push({ id: crypto.randomUUID(), rubric_id: rid2, sort: k + 1, title, max_score: max, description: '' }));
    await db.insertAccount({ competition_id: cid, login_id: 'admin01', display_name: '主辦人員', role: 'admin', active: true });
    await db.setPassword('admin01', 'admin-pass-01');
    for (let i = 1; i <= 5; i++) {
      const a = await db.insertAccount({ competition_id: cid, login_id: 'judge0' + i, display_name: '測試評審' + i, role: 'judge', active: true });
      await db.setPassword('judge0' + i, 'judge-pass-0' + i);
      if (i <= judgeCount) t.judge_slots.push({ competition_id: cid, slot_no: i, account_id: a.id, assigned_at: nowIso(), replaced_reason: null });
    }
    for (let i = 1; i <= teams; i++) {
      t.teams.push({ id: crypto.randomUUID(), competition_id: cid, code: 'team' + String(i).padStart(2, '0'), name: '測試第' + i + '組', members: '', work_title: '測試作品' + i, work_desc: '', category: creative.includes('team' + String(i).padStart(2, '0')) ? 'creative' : 'project', created_at: nowIso() });
    }
    return cid;
  };

  return db;
}
