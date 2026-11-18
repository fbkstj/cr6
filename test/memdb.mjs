// 本機測試用的記憶體資料庫：介面和 supabase/functions/api/db_supabase.js 一樣。
// 密碼用 scrypt 雜湊（正式環境是資料庫裡的 bcrypt），同樣不會把雜湊回傳給 core.js。
import crypto from 'node:crypto';

const hashPw = pw => { const salt = crypto.randomBytes(8).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); };
const verifyPw = (pw, h) => { if (!h) return false; const [salt, hex] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(hex, 'hex'), crypto.scryptSync(pw, salt, 32)); };

export function createMemDb() {
  const t = { competitions: [], accounts: [], judge_slots: [], teams: [], video_versions: [], login_fails: [], admin_logs: [], publications: [] };
  const clone = v => (v === undefined ? undefined : structuredClone(v));
  const strip = a => { if (!a) return null; const { password_hash, ...rest } = a; return Object.assign(clone(rest), { has_password: !!password_hash }); };
  let logId = 0;

  const db = {
    _tables: t,

    getCompetition: async id => clone(t.competitions.find(c => c.id === id) || null),
    getActiveCompetition: async () => clone(t.competitions.find(c => c.active) || null),

    getAccount: async id => strip(t.accounts.find(a => a.id === id)),
    getAccountByLogin: async loginId => strip(t.accounts.find(a => a.login_id === loginId)),
    listAccounts: async cid => t.accounts.filter(a => a.competition_id === cid).map(strip),
    insertAccount: async row => {
      if (t.accounts.some(a => a.login_id === row.login_id)) throw new Error('duplicate login_id');
      const r = Object.assign({ id: crypto.randomUUID(), password_hash: null, created_at: new Date().toISOString() }, row);
      t.accounts.push(r);
      return strip(r);
    },
    updateAccount: async (id, patch) => { Object.assign(t.accounts.find(a => a.id === id), clone(patch)); },
    checkPassword: async (loginId, pw) => {
      const a = t.accounts.find(x => x.login_id === loginId);
      return a && a.active && verifyPw(String(pw), a.password_hash) ? a.id : null;
    },
    setPassword: async (loginId, pw) => {
      if (String(pw).length < 8) throw new Error('密碼至少 8 個字');
      const a = t.accounts.find(x => x.login_id === loginId);
      if (!a) throw new Error('找不到帳號');
      a.password_hash = hashPw(String(pw));
    },

    listJudgeSlots: async cid => clone(t.judge_slots.filter(s => s.competition_id === cid)),

    listTeams: async cid => clone(t.teams.filter(x => x.competition_id === cid)),
    listVersions: async cid => clone(t.video_versions.filter(v => v.competition_id === cid)),
    insertVersion: async row => {
      // 和資料庫相同的唯一約束
      if (t.video_versions.some(v => v.competition_id === row.competition_id && v.source_sha256 === row.source_sha256)) throw new Error('duplicate sha256');
      if (t.video_versions.some(v => v.team_id === row.team_id && v.version_no === row.version_no)) throw new Error('duplicate version');
      if (row.check_ok && !row.playback_path) throw new Error('check_ok without playback');
      const r = Object.assign({ id: crypto.randomUUID(), created_at: new Date().toISOString() }, clone(row));
      t.video_versions.push(r);
      return clone(r);
    },

    getLoginFail: async key => clone(t.login_fails.find(f => f.key === key) || null),
    setLoginFail: async (key, count, until) => {
      const f = t.login_fails.find(x => x.key === key);
      if (f) Object.assign(f, { count, until }); else t.login_fails.push({ key, count, until });
    },
    clearLoginFail: async key => { t.login_fails = t.login_fails.filter(f => f.key !== key); },

    insertAdminLog: async row => { t.admin_logs.push(Object.assign({ id: ++logId }, clone(row))); },
    listAdminLogs: async (cid, n) => clone(t.admin_logs.filter(l => l.competition_id === cid).sort((a, b) => b.id - a.id).slice(0, n)),

    getLivePublication: async cid => clone(t.publications.find(p => p.competition_id === cid && !p.revoked_at) || null),
  };

  /** 測試資料：等同 SQL 的 create_competition＋5 位評審 */
  db.seedDemo = async ({ judgeCount = 5 } = {}) => {
    const cid = crypto.randomUUID();
    t.competitions.push({ id: cid, name: '測試競賽（合成資料）', active: true, phase: 'setup', judge_count: judgeCount, show_status_page: true, show_item_scores: false, min_comment_chars: 10 });
    await db.insertAccount({ competition_id: cid, login_id: 'admin01', display_name: '主辦人員', role: 'admin', active: true });
    await db.setPassword('admin01', 'admin-pass-01');
    for (let i = 1; i <= 5; i++) {
      const a = await db.insertAccount({ competition_id: cid, login_id: 'judge0' + i, display_name: '測試評審' + i, role: 'judge', active: true });
      await db.setPassword('judge0' + i, 'judge-pass-0' + i);
      if (i <= judgeCount) t.judge_slots.push({ competition_id: cid, slot_no: i, account_id: a.id });
    }
    for (let i = 1; i <= 3; i++) {
      t.teams.push({ id: crypto.randomUUID(), competition_id: cid, code: 'team0' + i, name: '測試第' + i + '組', members: '', work_title: '測試作品' + i, work_desc: '' });
    }
    return cid;
  };

  return db;
}
