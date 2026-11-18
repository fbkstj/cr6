// 主辦方後台（P3：總覽、作品與審查、評審與帳號、評分表、競賽設定、操作紀錄）
import { call, requireRole, logout, esc, fmtTime, fmtDur, fmtSec, fmtSize, toLocalInput, fromLocalInput,
  toast, dialog, dialogValues, confirmBox, busy, devBanner } from './app.js';

const $ = s => document.querySelector(s);
const main = $('#main');
const S = { me: null, board: null, accounts: [], tab: 'overview', teamId: null, versionId: null, draftTc: [] };

const PHASES = [['setup', '準備'], ['collecting', '收件審查'], ['judging', '評分'], ['settling', '結算'], ['published', '已公布']];
const STATUS_CHIP = { none: '', received: 'info', reviewing: 'warn', pass: 'ok', resubmit: 'warn', fail: 'bad', locked: 'accent', excluded: 'bad' };
const REVIEW = { pending: ['審查中', 'warn'], pass: ['通過', 'ok'], resubmit: ['退回補件', 'warn'], fail: ['不通過', 'bad'] };
const ACTION = {
  create_competition: '建立競賽', create_account: '新增帳號', update_account: '修改帳號', reset_password: '重設密碼',
  sync_videos: '同步影片清單', update_competition: '修改競賽設定', save_rubric: '修改評分表', assign_judge: '指派評審',
  replace_judge: '替補評審', clear_slot: '清空席位', create_team: '新增組別', update_team: '修改組別', delete_team: '刪除組別',
  set_received_at: '填寫收件時間', set_current_version: '設定正式版本', review: '資格審查', set_phase: '切換階段', lock_for_judging: '鎖定版本、開始評分',
};
const beforeJudging = () => ['setup', 'collecting'].includes(S.board.competition.phase);
const chip = (label, kind) => `<span class="chip ${kind || ''}">${esc(label)}</span>`;

/* ───────────── 載入 ───────────── */
async function load() {
  S.board = await call('adminGetBoard');
  S.accounts = await call('adminListAccounts');
  const c = S.board.competition;
  $('#compName').textContent = c.name;
  $('#phaseChip').textContent = c.phaseLabel;
  document.title = '主辦方後台｜' + c.name;
}
async function refresh() { await load(); render(); }

function setTab(tab) {
  S.tab = tab;
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  try { localStorage.setItem('contest.adminTab', tab); } catch (e) { /* 忽略 */ }
  render();
}

function render() {
  const views = { overview: viewOverview, works: viewWorks, judges: viewJudges, rubric: viewRubric, settings: viewSettings, logs: viewLogs };
  main.innerHTML = '';
  const out = views[S.tab]();
  if (typeof out === 'string') main.innerHTML = out;
}

/* ───────────── 總覽 ───────────── */
function viewOverview() {
  const c = S.board.competition, teams = S.board.teams;
  const idx = PHASES.findIndex(p => p[0] === c.phase);
  const count = k => teams.filter(t => t.status.key === k).length;
  const actions = {
    setup: `<button class="btn primary" data-act="phase" data-to="collecting">開始收件審查</button>`,
    collecting: `<button class="btn" data-act="phase" data-to="setup">回到準備</button>
                 <button class="btn primary" data-act="preview-judging">開始評分（鎖定版本）…</button>`,
    judging: `<span class="muted">評分進行中。評審評分與結算功能在下一階段（P4、P5）完成。</span>`,
  }[c.phase] || '';
  return `
  <div class="card stack">
    <h2>競賽階段</h2>
    <div class="steps">${PHASES.map((p, i) => `<span class="${i < idx ? 'done' : i === idx ? 'now' : ''}">${i < idx ? '✓ ' : ''}${p[1]}</span>`).join('')}</div>
    <div class="row">${actions}</div>
  </div>
  <div class="card stack">
    <h2>作品狀態</h2>
    <div class="stats">
      <div class="stat"><span class="muted small">組數</span><b>${teams.length}</b></div>
      <div class="stat"><span class="muted small">已收件</span><b>${teams.filter(t => t.versions.length).length}</b></div>
      <div class="stat"><span class="muted small">待設正式版本</span><b>${count('received')}</b></div>
      <div class="stat"><span class="muted small">審查中</span><b>${count('reviewing')}</b></div>
      <div class="stat"><span class="muted small">資格通過</span><b>${count('pass') + count('locked')}</b></div>
      <div class="stat"><span class="muted small">補件中</span><b>${count('resubmit')}</b></div>
      <div class="stat"><span class="muted small">未通過</span><b>${count('fail') + count('excluded')}</b></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>組別</th><th>作品</th><th>版本數</th><th>狀態</th></tr></thead>
      <tbody>${teams.map(t => `<tr><td><a href="#" data-act="open-team" data-id="${t.id}">${esc(t.code)}</a> ${esc(t.name)}</td>
        <td>${esc(t.workTitle) || '<span class="muted">—</span>'}</td><td>${t.versions.length}</td>
        <td>${chip(t.status.label, STATUS_CHIP[t.status.key])}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">還沒有組別</td></tr>'}</tbody>
    </table></div>
  </div>
  <div class="card stack">
    <h2>評審席位</h2>
    <p class="muted small" style="margin:0">評審人數：${c.judgeCount} 人。${S.board.slots.length < c.judgeCount ? `<span class="chip warn">還差 ${c.judgeCount - S.board.slots.length} 位</span>` : chip('已排滿', 'ok')}</p>
  </div>`;
}

async function previewJudging(btn) {
  const p = await busy(btn, () => call('adminJudgingPreview'));
  if (!p) return;
  const html = `<h2>開始評分（鎖定版本）</h2>
    ${p.problems.length ? `<div class="notice bad"><b>還不能開始：</b><ul style="margin:.4em 0 0 1.2em;padding:0">${p.problems.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    <div><b>會進入評分（${p.willLock.length} 組）：</b> ${p.willLock.map(esc).join('、') || '無'}</div>
    <div><b>不進入評分（${p.excluded.length} 組）：</b> ${p.excluded.map(e => `${esc(e.code)}（${esc(e.reason)}）`).join('、') || '無'}</div>
    ${p.problems.length ? '' : '<div class="notice warn">開始評分後，<b>不能再更換正式版本、修改資格審查、評分表與評審人數</b>。</div>'}`;
  if (p.problems.length) { await dialog(html, [{ label: '知道了', value: false, primary: true }]); return; }
  if (!(await confirmBox(html, '確定開始評分'))) return;
  const r = await busy(null, () => call('adminSetPhase', 'judging'));
  if (r) { toast(`已開始評分：鎖定 ${r.locked} 組作品`); await refresh(); }
}

/* ───────────── 作品與審查 ───────────── */
function viewWorks() {
  const teams = S.board.teams;
  if (!S.teamId && teams.length) S.teamId = teams[0].id;
  const t = teams.find(x => x.id === S.teamId);
  const list = `<div class="card" style="padding:0">
    <div class="row" style="padding:12px;justify-content:space-between">
      <b>組別</b>
      <span class="row">
        <button class="btn small" data-act="sync">同步影片清單</button>
        ${beforeJudging() ? '<button class="btn small" data-act="new-team">＋ 新增</button>' : ''}
      </span>
    </div>
    <ul class="list">${teams.map(x => `<li><button data-act="open-team" data-id="${x.id}" aria-current="${x.id === S.teamId}">
      <span><b>${esc(x.code)}</b> ${esc(x.name)}<br><span class="muted small">${esc(x.workTitle) || '（未填作品名稱）'}</span></span>
      ${chip(x.status.label, STATUS_CHIP[x.status.key])}</button></li>`).join('') || '<li class="muted" style="padding:12px">還沒有組別，請先新增</li>'}</ul>
  </div>`;
  return `<div class="split">${list}<div>${t ? teamDetail(t) : '<div class="card muted">請在左邊選擇組別</div>'}</div></div>`;
}

function teamDetail(t) {
  if (!t.versions.some(v => v.id === S.versionId)) S.versionId = (t.versions.find(v => v.id === t.currentVersionId) || t.versions[0] || {}).id || null;
  const v = t.versions.find(x => x.id === S.versionId);
  const locked = !beforeJudging();
  return `
  <div class="card stack">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(t.code)} ${esc(t.name)}</h2>${chip(t.status.label, STATUS_CHIP[t.status.key])}</div>
    <form data-form="team" class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
      <div><label>組別名稱</label><input type="text" name="name" value="${esc(t.name)}" maxlength="60"></div>
      <div><label>作品名稱</label><input type="text" name="workTitle" value="${esc(t.workTitle)}" maxlength="100"></div>
      <div style="grid-column:1/-1"><label>組員</label><input type="text" name="members" value="${esc(t.members)}" maxlength="300"></div>
      <div style="grid-column:1/-1"><label>作品說明</label><textarea name="workDesc" maxlength="2000">${esc(t.workDesc)}</textarea></div>
      <div class="row" style="grid-column:1/-1">
        <button class="btn primary" type="submit">儲存組別資料</button>
        ${!locked && !t.versions.length ? `<button class="btn danger" type="button" data-act="del-team" data-id="${t.id}">刪除組別</button>` : ''}
      </div>
    </form>
  </div>
  <div class="card stack">
    <h2>影片版本</h2>
    ${t.versions.length ? `<div class="table-wrap"><table>
      <thead><tr><th>版本</th><th>長度</th><th>檔案檢查</th><th>資格審查</th><th>收件時間</th><th></th></tr></thead>
      <tbody>${t.versions.map(x => `<tr ${x.id === S.versionId ? 'style="background:var(--accent-soft)"' : ''}>
        <td><b>v${x.no}</b> ${x.id === t.lockedVersionId ? chip('評分版本', 'accent') : x.id === t.currentVersionId ? chip('正式版本', 'info') : ''}<br><span class="muted small">${esc(x.filename)}</span></td>
        <td>${fmtDur(x.duration)}</td>
        <td>${x.checkOk ? chip('合格', 'ok') : chip('不合格', 'bad') + `<br><span class="small">${esc(x.checkNotes)}</span>`}</td>
        <td>${chip(...REVIEW[x.reviewStatus])}</td>
        <td class="small">${fmtTime(x.receivedAt)}</td>
        <td><div class="row">
          <button class="btn small" data-act="open-version" data-id="${x.id}">檢視</button>
          ${!locked && x.checkOk && x.id !== t.currentVersionId ? `<button class="btn small" data-act="set-current" data-id="${x.id}">設為正式版本</button>` : ''}
        </div></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">還沒有影片。把影片依規則命名放進「影片原檔」、執行處理腳本並推送後，按「同步影片清單」。</p>'}
  </div>
  ${v ? versionDetail(t, v) : ''}`;
}

function versionDetail(t, v) {
  const locked = !beforeJudging();
  const tc = S.draftTc;
  return `
  <div class="card stack">
    <h2>v${v.no} 檢視與資格審查</h2>
    ${v.playbackPath ? `<video id="player" controls preload="metadata" src="${esc(v.playbackPath)}"></video>`
      : '<div class="notice bad">這個版本檔案檢查不合格，沒有播放版。請在自己電腦上開原檔確認。</div>'}
    <div class="small muted">
      原檔 ${esc(v.filename)}（${fmtSize(v.size)}，${esc(v.container || '')}，${esc(v.vcodec || '?')}／${esc(v.acodec || '?')}，${v.width || '?'}×${v.height || '?'}）
      ・處理時間 ${fmtTime(v.processedAt)}・<span class="mono" title="${esc(v.sha256)}">sha256 ${esc((v.sha256 || '').slice(0, 12))}…</span>
    </div>
    <form data-form="received" class="row">
      <label for="recv" style="margin:0">收件時間</label>
      <input id="recv" type="datetime-local" name="at" value="${toLocalInput(v.receivedAt)}" style="width:auto">
      <button class="btn small" type="submit">儲存</button>
      <span class="muted small">（台灣時間）</span>
    </form>
    ${locked ? '<div class="notice">已經開始評分，資格審查不能再修改。</div>' : `
    <form data-form="review" class="stack">
      <div><label>審查結果</label>
        <div class="row">
          ${[['pass', '通過'], ['resubmit', '退回補件'], ['fail', '不通過']].map(([k, l]) =>
            `<label class="check"><input type="radio" name="status" value="${k}" ${!v.checkOk && k === 'pass' ? 'disabled' : ''}> ${l}</label>`).join('')}
        </div>
      </div>
      <div><label for="reason">原因（退回補件、不通過必填，例如剪接、後製、不是一鏡到底）</label><textarea id="reason" name="reason" maxlength="1000"></textarea></div>
      <div class="stack">
        <div class="row"><b>影片時間點</b>
          ${v.playbackPath ? '<button class="btn small" type="button" data-act="add-tc">＋ 加入目前播放時間</button>' : ''}
        </div>
        ${tc.length ? `<ul class="list">${tc.map((x, i) => `<li class="row" style="padding:6px 0">
          <a href="#" data-act="seek" data-sec="${x.sec}" class="mono">${fmtSec(x.sec)}</a>
          <input type="text" data-tc="${i}" value="${esc(x.note)}" placeholder="說明（例如：畫面跳接）" maxlength="200" style="flex:1;min-width:160px">
          <button class="btn small" type="button" data-act="del-tc" data-i="${i}">刪除</button></li>`).join('')}</ul>`
          : '<span class="muted small">播放到有問題的地方，按「加入目前播放時間」。</span>'}
      </div>
      <div><button class="btn primary" type="submit">送出審查</button></div>
    </form>`}
    <div>
      <h3>審查紀錄</h3>
      ${v.reviews.length ? `<ul class="list">${v.reviews.map(r => `<li style="padding:8px 0;border-bottom:1px solid var(--line)">
        ${chip(...REVIEW[r.status])} <span class="muted small">${fmtTime(r.at)}・${esc(r.reviewer)}</span>
        ${r.reason ? `<div>${esc(r.reason)}</div>` : ''}
        ${r.timecodes.length ? `<div class="small">${r.timecodes.map(x => `<a href="#" data-act="seek" data-sec="${x.sec}" class="mono">${fmtSec(x.sec)}</a> ${esc(x.note)}`).join('　')}</div>` : ''}
      </li>`).join('')}</ul>` : '<p class="muted small">還沒有審查紀錄</p>'}
    </div>
  </div>`;
}

async function newTeam() {
  const used = new Set(S.board.teams.map(t => t.code));
  let n = 1;
  while (used.has('team' + String(n).padStart(2, '0'))) n++;
  const ok = await confirmBox(`<h2>新增組別</h2>
    <div class="field"><label for="nt-code">組別代碼（team 加兩位數字）</label><input id="nt-code" type="text" value="team${String(n).padStart(2, '0')}"></div>
    <div class="field"><label for="nt-name">組別名稱</label><input id="nt-name" type="text" maxlength="60"></div>
    <div class="field"><label for="nt-title">作品名稱</label><input id="nt-title" type="text" maxlength="100"></div>`, '新增');
  if (!ok) return;
  const r = await busy(null, () => call('adminUpsertTeam', { code: dialogValues['nt-code'], name: dialogValues['nt-name'], workTitle: dialogValues['nt-title'] }));
  if (r) { S.teamId = r.id; toast('已新增組別'); await refresh(); }
}

/* ───────────── 評審與帳號 ───────────── */
function viewJudges() {
  const c = S.board.competition;
  const judges = S.accounts.filter(a => a.role === 'judge' && a.active);
  const slotRows = Array.from({ length: c.judgeCount }, (_, i) => {
    const s = S.board.slots.find(x => x.slot === i + 1);
    return `<tr><td><b>評審${i + 1}</b></td>
      <td><select data-slot="${i + 1}"><option value="">（未指派）</option>${judges.map(a =>
        `<option value="${a.id}" ${s && s.accountId === a.id ? 'selected' : ''}>${esc(a.name)}（${esc(a.loginId)}）</option>`).join('')}</select>
        ${s && s.replacedReason ? `<div class="small muted">替補原因：${esc(s.replacedReason)}</div>` : ''}</td>
      <td><button class="btn small" data-act="assign" data-slot="${i + 1}">儲存</button></td></tr>`;
  }).join('');
  return `
  <div class="card stack">
    <h2>評審席位（${c.judgeCount} 人）</h2>
    <p class="muted small" style="margin:0">公開結果只顯示「評審1～${c.judgeCount}」，不顯示姓名。${beforeJudging() ? '' : '評分已開始，更換評審（替補）需要填寫原因。'}</p>
    <div class="table-wrap"><table><thead><tr><th>席位</th><th>評審</th><th></th></tr></thead><tbody>${slotRows}</tbody></table></div>
  </div>
  <div class="card stack">
    <h2>帳號</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>帳號</th><th>姓名</th><th>角色</th><th>狀態</th><th></th></tr></thead>
      <tbody>${S.accounts.map(a => `<tr>
        <td class="mono">${esc(a.loginId)}</td><td>${esc(a.name)}</td>
        <td>${a.role === 'admin' ? '主辦人員' : '評審' + (a.slot ? `（評審${a.slot}）` : '')}</td>
        <td>${a.active ? chip('啟用', 'ok') : chip('停用', 'bad')}</td>
        <td><div class="row">
          <button class="btn small" data-act="rename" data-id="${a.id}">改名</button>
          <button class="btn small" data-act="reset-pw" data-id="${a.id}">重設密碼</button>
          ${a.id === S.me.me.id ? '' : `<button class="btn small ${a.active ? 'danger' : ''}" data-act="toggle-active" data-id="${a.id}">${a.active ? '停用' : '啟用'}</button>`}
        </div></td></tr>`).join('')}</tbody>
    </table></div>
    <form data-form="new-account" class="grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));align-items:end">
      <div><label>新帳號</label><input type="text" name="loginId" placeholder="judge06" autocapitalize="none" spellcheck="false" required></div>
      <div><label>姓名</label><input type="text" name="name" required maxlength="40"></div>
      <div><label>角色</label><select name="role"><option value="judge">評審</option><option value="admin">主辦人員</option></select></div>
      <div><button class="btn primary" type="submit">新增帳號</button></div>
    </form>
  </div>`;
}

async function showTempPassword(loginId, pw, title) {
  await dialog(`<h2>${esc(title)}</h2>
    <p>帳號 <b class="mono">${esc(loginId)}</b> 的臨時密碼（<b>只會顯示這一次</b>，請抄下或複製後交給本人，登入後可以自己修改）：</p>
    <p class="mono" style="font-size:1.4rem;letter-spacing:.08em;user-select:all">${esc(pw)}</p>
    <button class="btn small" type="button" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(pw)}').then(()=>this.textContent='已複製')">複製</button>`,
  [{ label: '我已記下', value: true, primary: true }]);
}

/* ───────────── 評分表 ───────────── */
let rubricDraft = null;
function viewRubric() {
  const rb = S.board.rubric;
  if (!rubricDraft) rubricDraft = rb.items.map(i => ({ title: i.title, max: i.max, description: i.description }));
  const total = rubricDraft.reduce((s, i) => s + (Number(i.max) || 0), 0);
  const ro = rb.locked || !beforeJudging();
  return `<div class="card stack">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">評分表</h2>
      ${ro ? chip('已鎖定', 'accent') : chip(`合計 ${total} / 100`, total === 100 ? 'ok' : 'bad')}</div>
    <p class="muted small" style="margin:0">評審依這些項目評分，各項滿分加起來必須是 100。開始評分時會鎖定，之後不能修改。</p>
    ${rubricDraft.map((it, i) => `<div class="card" style="box-shadow:none">
      <div class="grid" style="grid-template-columns:1fr 110px;gap:8px">
        <div><label>第 ${i + 1} 項名稱</label><input type="text" data-rb="${i}" data-k="title" value="${esc(it.title)}" maxlength="60" ${ro ? 'disabled' : ''}></div>
        <div><label>滿分</label><input type="number" data-rb="${i}" data-k="max" value="${esc(it.max)}" min="1" max="100" step="1" ${ro ? 'disabled' : ''}></div>
        <div style="grid-column:1/-1"><label>判準說明（評審評分時看得到）</label><textarea data-rb="${i}" data-k="description" maxlength="500" ${ro ? 'disabled' : ''} style="min-height:56px">${esc(it.description)}</textarea></div>
      </div>
      ${ro ? '' : `<div class="row" style="margin-top:8px">
        <button class="btn small" data-act="rb-up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>上移</button>
        <button class="btn small" data-act="rb-del" data-i="${i}" ${rubricDraft.length === 1 ? 'disabled' : ''}>刪除</button></div>`}
    </div>`).join('')}
    ${ro ? '' : `<div class="row">
      <button class="btn" data-act="rb-add" ${rubricDraft.length >= 10 ? 'disabled' : ''}>＋ 新增項目</button>
      <span class="spacer" style="flex:1"></span>
      <button class="btn" data-act="rb-reset">還原</button>
      <button class="btn primary" data-act="rb-save" ${total === 100 ? '' : 'disabled'}>儲存評分表</button></div>`}
  </div>`;
}

/* ───────────── 競賽設定 ───────────── */
function viewSettings() {
  const c = S.board.competition;
  const ro = !beforeJudging();
  return `<div class="card">
    <form data-form="settings" class="stack">
      <h2>競賽設定</h2>
      <div class="field"><label>競賽名稱</label><input type="text" name="name" value="${esc(c.name)}" maxlength="100" required></div>
      <div class="field"><label>評審人數</label>
        <div class="row">${[3, 5].map(n => `<label class="check"><input type="radio" name="judgeCount" value="${n}" ${c.judgeCount === n ? 'checked' : ''} ${ro ? 'disabled' : ''}> ${n} 人</label>`).join('')}</div>
        ${ro ? '<span class="muted small">已經開始評分，不能修改。</span>' : '<span class="muted small">改成 3 人時，評審4、評審5 的席位會被移除。</span>'}</div>
      <div class="field"><label>評語最少字數（優點、改進建議各自）</label><input type="number" name="minCommentChars" value="${c.minCommentChars}" min="0" max="200" ${ro ? 'disabled' : ''} style="width:120px"></div>
      <label class="check"><input type="checkbox" name="showStatusPage" ${c.showStatusPage ? 'checked' : ''}> 公布前，公開頁顯示各組收件與資格狀態（不顯示原因）</label>
      <label class="check"><input type="checkbox" name="showItemScores" ${c.showItemScores ? 'checked' : ''}> 公布結果時顯示每位評審的分項分數</label>
      <div><button class="btn primary" type="submit">儲存設定</button></div>
    </form>
  </div>
  <div class="card">
    <form data-form="password" class="stack" style="max-width:360px">
      <h2>修改我的密碼</h2>
      <div class="field"><label>原密碼</label><input type="password" name="old" autocomplete="current-password" required></div>
      <div class="field"><label>新密碼（至少 8 個字）</label><input type="password" name="new" autocomplete="new-password" minlength="8" required></div>
      <div><button class="btn" type="submit">修改密碼</button></div>
    </form>
  </div>`;
}

/* ───────────── 操作紀錄 ───────────── */
function viewLogs() {
  main.innerHTML = '<div class="card"><p class="muted">載入中…</p></div>';
  call('adminLogs', 200).then(logs => {
    main.innerHTML = `<div class="card"><h2>操作紀錄</h2><div class="table-wrap"><table>
      <thead><tr><th>時間</th><th>操作人</th><th>動作</th><th>對象</th><th>內容</th></tr></thead>
      <tbody>${logs.map(l => `<tr><td class="small">${fmtTime(l.at)}</td><td>${esc(l.actor)}</td><td>${esc(ACTION[l.action] || l.action)}</td>
        <td>${esc(l.target)}</td><td class="small mono" style="max-width:360px;word-break:break-all">${esc(JSON.stringify(l.detail))}</td></tr>`).join('')}</tbody>
    </table></div></div>`;
  }).catch(e => { main.innerHTML = `<div class="card notice bad">${esc(e.message)}</div>`; });
  return null;
}

/* ───────────── 事件 ───────────── */
document.getElementById('tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });
$('#logout').addEventListener('click', logout);

main.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  if (el.tagName === 'A') e.preventDefault();
  const player = document.getElementById('player');
  switch (act) {
    case 'phase': {
      const to = el.dataset.to;
      const label = to === 'collecting' ? '開始收件審查' : '回到準備階段';
      if (!(await confirmBox(`<p>確定要${label}？</p>`))) return;
      if (await busy(el, () => call('adminSetPhase', to))) { toast('已切換階段'); await refresh(); }
      break;
    }
    case 'preview-judging': await previewJudging(el); break;
    case 'open-team': S.teamId = id; S.versionId = null; S.draftTc = []; if (S.tab !== 'works') setTab('works'); else render(); break;
    case 'open-version': S.versionId = id; S.draftTc = []; render(); break;
    case 'new-team': await newTeam(); break;
    case 'del-team':
      if (!(await confirmBox('<p>確定刪除這個組別？</p>', '刪除', true))) return;
      if (await busy(el, () => call('adminDeleteTeam', id))) { S.teamId = null; toast('已刪除'); await refresh(); }
      break;
    case 'sync': {
      const r = await busy(el, () => call('adminSyncVideos'));
      if (!r) return;
      await refresh();
      await dialog(`<h2>同步影片清單</h2>
        <p>新增 ${r.added.length} 個版本，已存在 ${r.skipped} 個。</p>
        ${r.added.length ? `<ul>${r.added.map(a => `<li>${esc(a.label)} ${a.checkOk ? chip('合格', 'ok') : chip('不合格', 'bad') + ' ' + esc(a.notes)}</li>`).join('')}</ul>` : ''}
        ${r.warnings.length ? `<div class="notice warn"><b>需要處理：</b><ul style="margin:.4em 0 0 1.2em;padding:0">${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}`,
      [{ label: '關閉', value: true, primary: true }]);
      break;
    }
    case 'set-current': {
      const t = S.board.teams.find(x => x.id === S.teamId);
      if (await busy(el, () => call('adminSetCurrentVersion', t.id, id))) { S.versionId = id; toast('已設為正式版本，請進行資格審查'); await refresh(); }
      break;
    }
    case 'add-tc':
      if (player) { S.draftTc.push({ sec: Math.round(player.currentTime * 10) / 10, note: '' }); S.draftTc.sort((a, b) => a.sec - b.sec); keepForm(() => render()); }
      break;
    case 'del-tc': S.draftTc.splice(Number(el.dataset.i), 1); keepForm(() => render()); break;
    case 'seek': if (player) { player.currentTime = Number(el.dataset.sec); player.play().catch(() => {}); } break;
    case 'assign': {
      const slot = Number(el.dataset.slot);
      const sel = main.querySelector(`select[data-slot="${slot}"]`);
      let reason = '';
      const cur = S.board.slots.find(s => s.slot === slot);
      if (!beforeJudging() && cur && sel.value && cur.accountId !== sel.value) {
        const ok = await confirmBox(`<h2>替補評審${slot}</h2><div class="field"><label for="rp-reason">替補原因（必填）</label><textarea id="rp-reason"></textarea></div>`, '確定替補');
        if (!ok) return;
        reason = dialogValues['rp-reason'] || '';
      }
      if (await busy(el, () => call('adminAssignSlot', slot, sel.value || null, reason))) { toast('已儲存評審' + slot); await refresh(); }
      break;
    }
    case 'reset-pw': {
      const a = S.accounts.find(x => x.id === id);
      if (!(await confirmBox(`<p>重設 <b>${esc(a.name)}</b>（${esc(a.loginId)}）的密碼？原密碼會立刻失效。</p>`, '重設'))) return;
      const r = await busy(el, () => call('adminResetPassword', id));
      if (r) await showTempPassword(r.loginId, r.tempPassword, '已重設密碼');
      break;
    }
    case 'rename': {
      const a = S.accounts.find(x => x.id === id);
      const ok = await confirmBox(`<h2>修改姓名</h2><div class="field"><label for="rn">姓名</label><input id="rn" type="text" value="${esc(a.name)}" maxlength="40"></div>`, '儲存');
      if (!ok) return;
      if (await busy(el, () => call('adminUpsertAccount', { id, name: dialogValues.rn || a.name }))) { toast('已修改'); await refresh(); render(); }
      break;
    }
    case 'toggle-active': {
      const a = S.accounts.find(x => x.id === id);
      if (a.active && !(await confirmBox(`<p>停用 <b>${esc(a.name)}</b>？已登入的畫面會立刻失效。</p>`, '停用', true))) return;
      if (await busy(el, () => call('adminUpsertAccount', { id, name: a.name, active: !a.active }))) { await refresh(); }
      break;
    }
    case 'rb-add': rubricDraft.push({ title: '', max: 0, description: '' }); render(); break;
    case 'rb-del': rubricDraft.splice(Number(el.dataset.i), 1); render(); break;
    case 'rb-up': { const i = Number(el.dataset.i); [rubricDraft[i - 1], rubricDraft[i]] = [rubricDraft[i], rubricDraft[i - 1]]; render(); break; }
    case 'rb-reset': rubricDraft = null; render(); break;
    case 'rb-save': {
      const r = await busy(el, () => call('adminSaveRubric', rubricDraft.map(x => ({ title: x.title, max: Number(x.max), description: x.description }))));
      if (r) { rubricDraft = null; toast('評分表已儲存'); await refresh(); }
      break;
    }
    default: break;
  }
});

/** 重畫畫面時保留審查表單已經填的內容 */
function keepForm(fn) {
  const f = main.querySelector('form[data-form="review"]');
  const saved = f ? { status: (f.querySelector('input[name=status]:checked') || {}).value, reason: f.reason.value } : null;
  const player = document.getElementById('player');
  const t = player ? player.currentTime : 0;
  fn();
  const f2 = main.querySelector('form[data-form="review"]');
  if (f2 && saved) {
    if (saved.status) f2.querySelector(`input[name=status][value="${saved.status}"]`).checked = true;
    f2.reason.value = saved.reason;
  }
  const p2 = document.getElementById('player');
  if (p2 && t) p2.addEventListener('loadedmetadata', () => { p2.currentTime = t; }, { once: true });
}

main.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.tc !== undefined) S.draftTc[Number(el.dataset.tc)].note = el.value;
  if (el.dataset.rb !== undefined) {
    rubricDraft[Number(el.dataset.rb)][el.dataset.k] = el.value;
    if (el.dataset.k === 'max') {   // 只更新合計與儲存按鈕，不重畫（避免輸入框失去焦點）
      const total = rubricDraft.reduce((s, i) => s + (Number(i.max) || 0), 0);
      const c = main.querySelector('.chip'); if (c) { c.textContent = `合計 ${total} / 100`; c.className = 'chip ' + (total === 100 ? 'ok' : 'bad'); }
      const b = main.querySelector('[data-act="rb-save"]'); if (b) b.disabled = total !== 100;
    }
  }
});

main.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, kind = f.dataset.form, btn = e.submitter;
  const t = S.board.teams.find(x => x.id === S.teamId);
  if (kind === 'team') {
    if (await busy(btn, () => call('adminUpsertTeam', { id: t.id, name: f.name.value, members: f.members.value, workTitle: f.workTitle.value, workDesc: f.workDesc.value }))) { toast('已儲存組別資料'); await refresh(); }
  } else if (kind === 'received') {
    if (await busy(btn, () => call('adminSetReceivedAt', S.versionId, fromLocalInput(f.at.value)))) { toast('已儲存收件時間'); await refresh(); }
  } else if (kind === 'review') {
    const st = f.querySelector('input[name=status]:checked');
    if (!st) { toast('請選擇審查結果', 'bad'); return; }
    if (await busy(btn, () => call('adminReview', S.versionId, st.value, f.reason.value, S.draftTc))) { S.draftTc = []; toast('已送出審查'); await refresh(); }
  } else if (kind === 'new-account') {
    const r = await busy(btn, () => call('adminUpsertAccount', { loginId: f.loginId.value, name: f.name.value, role: f.role.value }));
    if (r) { await refresh(); await showTempPassword(r.account.loginId, r.tempPassword, '已新增帳號'); }
  } else if (kind === 'settings') {
    const jc = f.querySelector('input[name=judgeCount]:checked');
    const input = { name: f.name.value, showStatusPage: f.showStatusPage.checked, showItemScores: f.showItemScores.checked };
    if (beforeJudging()) Object.assign(input, { judgeCount: Number(jc.value), minCommentChars: Number(f.minCommentChars.value) });
    if (await busy(btn, () => call('adminUpdateCompetition', input))) { toast('已儲存設定'); await refresh(); }
  } else if (kind === 'password') {
    if (await busy(btn, () => call('changePassword', f.old.value, f.new.value))) { f.reset(); toast('密碼已修改'); }
  }
});

/* ───────────── 啟動 ───────────── */
devBanner();
try {
  S.me = await requireRole('admin');
  $('#who').textContent = S.me.me.name + '（' + S.me.me.loginId + '）';
  await load();
  let tab = 'overview';
  try { tab = localStorage.getItem('contest.adminTab') || 'overview'; } catch (e) { /* 忽略 */ }
  setTab(['overview', 'works', 'judges', 'rubric', 'settings', 'logs'].includes(tab) ? tab : 'overview');
} catch (e) {
  main.innerHTML = `<div class="card notice bad">${esc(e.message)}</div>`;
}
