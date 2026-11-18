// 共用：API 呼叫、登入狀態、格式化、提示訊息
const CONFIG = window.CONTEST_CONFIG || {};
const TOKEN_KEY = 'contest.token';

export const isDev = !!CONFIG.dev;

export function getToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
}
export function setToken(t) {
  try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* 私密模式 */ }
}

/** 呼叫 API。需要登入的功能自動帶 token（第一個參數）。登入逾時就回到登入頁。 */
export async function api(fn, ...args) {
  if (!CONFIG.apiUrl) throw new Error('網站還沒有設定 API 網址（docs/config.js）');
  let r;
  try {
    r = await fetch(CONFIG.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ fn, args }) });
  } catch (e) {
    throw new Error('連不上伺服器，請檢查網路後再試');
  }
  let data;
  try { data = await r.json(); } catch (e) { throw new Error('伺服器回應格式錯誤（HTTP ' + r.status + '）'); }
  if (!data.ok) {
    if (String(data.error).startsWith('AUTH:')) {
      setToken('');
      if (!location.pathname.endsWith('/') && !location.pathname.endsWith('index.html')) location.href = './index.html?expired=1';
      throw new Error(String(data.error).slice(5));
    }
    throw new Error(data.error || '發生錯誤');
  }
  return data.result;
}
/** 帶 token 呼叫 */
export const call = (fn, ...args) => api(fn, getToken(), ...args);

/** 確認登入且角色正確，否則回登入頁 */
export async function requireRole(role) {
  if (!getToken()) { location.href = './index.html'; return new Promise(() => {}); }
  const me = await call('me');
  if (me.role !== role) { location.href = me.role === 'admin' ? './admin.html' : './judge.html'; return new Promise(() => {}); }
  return me;
}

export function logout() { setToken(''); location.href = './index.html'; }

/* ───── 格式化 ───── */
export const esc = s => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const TW = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export const fmtTime = iso => (iso ? TW.format(new Date(iso)) : '—');

/** ISO 時間 → datetime-local 輸入框用的台北時間字串 */
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 16);
}
/** datetime-local（台北時間）→ ISO */
export const fromLocalInput = v => (v ? new Date(v + ':00+08:00').toISOString() : '');

export function fmtDur(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return '—';
  const s = Math.floor(Number(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function fmtSec(sec) {
  const s = Number(sec) || 0;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}
export const fmtSize = b => (b === null || b === undefined ? '—' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');

/* ───── 提示 ───── */
export function toast(msg, kind = '') {
  let box = document.getElementById('toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
  const d = document.createElement('div');
  d.className = kind;
  d.textContent = msg;
  box.appendChild(d);
  setTimeout(() => d.remove(), kind === 'bad' ? 6000 : 3000);
}

/** 最後一個對話框裡輸入框的值（依 id），對話框關閉後仍可讀取 */
export const dialogValues = {};

/** 對話框：html 內容＋按鈕，回傳按下的按鈕值 */
export function dialog(html, buttons = [{ label: '確定', value: true, primary: true }]) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.innerHTML = `<div class="stack">${html}</div><div class="row" style="justify-content:flex-end;margin-top:16px">${
      buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`;
    document.body.appendChild(d);
    d.addEventListener('click', e => {
      const i = e.target.closest('button[data-i]');
      if (!i) return;
      Object.keys(dialogValues).forEach(k => delete dialogValues[k]);
      d.querySelectorAll('input[id], textarea[id], select[id]').forEach(x => { dialogValues[x.id] = x.value; });
      d.close();
      d.remove();   // 直接移除，不依賴 close 事件（背景分頁可能延後觸發）
      resolve(buttons[Number(i.dataset.i)].value);
    });
    d.addEventListener('close', () => { d.remove(); resolve(undefined); });   // 按 Esc 關閉
    d.showModal();
  });
}
export const confirmBox = (html, okLabel = '確定', danger = false) =>
  dialog(html, [{ label: '取消', value: false }, { label: okLabel, value: true, primary: !danger, danger }]);

/** 按鈕執行中鎖住，錯誤顯示提示 */
export async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, 'bad'); return undefined; } finally { if (btn) btn.disabled = false; }
}

export function devBanner() {
  if (!isDev) return;
  const b = document.createElement('div');
  b.className = 'dev-banner';
  b.textContent = '本機開發模式：資料是合成的測試資料，重開伺服器就還原';
  document.body.prepend(b);
}
