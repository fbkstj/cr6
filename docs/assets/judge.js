// 評審頁（P4）：作品清單、看片評分、暫存、正式送出
import { call, requireRole, logout, esc, fmtTime, fmtDur, toast, dialogValues, confirmBox, busy, devBanner } from './app.js';

const main = document.getElementById('main');
const S = { me: null, list: null, work: null, dirty: false };
const CHIP = { none: '', draft: 'info', submitted: 'ok', returned: 'warn', others: 'accent' };

/* ───────────── 作品清單 ───────────── */
async function showList() {
  S.work = null;
  S.dirty = false;
  main.innerHTML = '<p class="muted">載入中…</p>';
  const r = S.list = await call('judgeListWorks');
  const chip = document.getElementById('slotChip');
  if (r.slot) { chip.textContent = '評審' + r.slot; chip.classList.remove('hidden'); } else chip.classList.add('hidden');
  if (r.message) { main.innerHTML = `<div class="card notice">${esc(r.message)}</div>`; return; }
  const pct = r.works.length ? Math.round(r.done / r.works.length * 100) : 0;
  main.innerHTML = `
  <div class="card stack">
    <div class="row" style="justify-content:space-between">
      <h1 style="margin:0">作品清單</h1>
      <span><b>已完成 ${r.done} / ${r.works.length}</b></span>
    </div>
    <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
    ${r.canEdit ? '<p class="muted small" style="margin:0">點作品開始評分。可以先暫存，全部確認後再正式送出；送出後要由主辦單位退回才能修改。</p>'
      : '<p class="muted small" style="margin:0">評分已經結束，只能查看。</p>'}
  </div>
  <div class="works" style="margin-top:16px">
    ${r.works.map(w => `<button class="card work" data-team="${w.teamId}">
      <div class="row" style="justify-content:space-between;width:100%"><b>${esc(w.code)}</b><span class="chip ${CHIP[w.status]}">${esc(w.statusLabel)}</span></div>
      <div style="font-size:1.05rem">${esc(w.workTitle || '（未填作品名稱）')}</div>
      <div class="muted small">${esc(w.name)}・影片 ${fmtDur(w.duration)}${w.total !== null ? `・<b>${w.total} 分</b>` : ''}</div>
    </button>`).join('')}
  </div>`;
}

/* ───────────── 評分頁 ───────────── */
async function showWork(teamId) {
  main.innerHTML = '<p class="muted">載入中…</p>';
  const w = S.work = await call('judgeGetWork', teamId);
  S.dirty = false;
  const sc = w.score, ro = !w.canEdit;
  const min = w.minCommentChars;
  main.innerHTML = `
  <div class="row" style="margin-bottom:12px"><a href="#" data-act="back">← 回作品清單</a></div>
  <div class="score-layout">
    <div class="video-col stack">
      <div class="card stack">
        <div class="row" style="justify-content:space-between">
          <h1 style="margin:0">${esc(w.team.code)}　${esc(w.team.workTitle || '')}</h1>
          <span class="chip ${CHIP[sc.status]}">${esc(sc.statusLabel)}</span>
        </div>
        <div class="muted small">${esc(w.team.name)}・第 ${w.video.versionNo} 版・${fmtDur(w.video.duration)}</div>
        ${w.video.path ? `<video id="player" controls preload="metadata" playsinline src="${esc(w.video.path)}"></video>` : '<div class="notice bad">找不到影片</div>'}
        <div class="row small muted">
          播放速度
          ${[0.75, 1, 1.25, 1.5, 2].map(r => `<button class="btn small" data-act="rate" data-rate="${r}">${r}×</button>`).join('')}
          <button class="btn small" data-act="skip" data-sec="-10">⟲ 10 秒</button>
          <button class="btn small" data-act="skip" data-sec="10">10 秒 ⟳</button>
        </div>
        ${w.team.workDesc ? `<details><summary>作品說明</summary><p style="white-space:pre-wrap">${esc(w.team.workDesc)}</p></details>` : ''}
      </div>
    </div>
    <form class="card stack" id="scoreForm" autocomplete="off">
      ${sc.returnReason ? `<div class="notice warn"><b>主辦單位退回：</b>${esc(sc.returnReason)}<br><span class="small">請修改後重新正式送出。</span></div>` : ''}
      ${sc.note ? `<div class="notice">${esc(sc.note)}</div>` : ''}
      ${sc.status === 'submitted' ? `<div class="notice ok">已於 ${fmtTime(sc.submittedAt)} 正式送出。如需修改，請聯絡主辦單位退回。</div>` : ''}
      <div class="row" style="justify-content:space-between;align-items:baseline">
        <h2 style="margin:0">評分</h2>
        <span><span class="total" id="total">—</span> <span class="muted">/ ${w.rubric.total}</span></span>
      </div>
      <div>
        ${w.rubric.items.map(it => `<div class="item">
          <div class="item-head">
            <label for="it-${it.id}" style="margin:0">${esc(it.title)}<span class="muted" style="font-weight:400">（滿分 ${it.max}）</span></label>
            <input id="it-${it.id}" data-item="${it.id}" type="number" inputmode="numeric" min="0" max="${it.max}" step="1"
              value="${sc.items[it.id] ?? ''}" ${ro ? 'disabled' : ''} aria-describedby="d-${it.id}">
          </div>
          ${it.description ? `<div class="small muted" id="d-${it.id}" style="white-space:pre-wrap">${esc(it.description)}</div>` : ''}
        </div>`).join('')}
      </div>
      <div class="field">
        <label for="strengths">作品優點${min ? `（至少 ${min} 字）` : ''}</label>
        <textarea id="strengths" maxlength="2000" ${ro ? 'disabled' : ''}>${esc(sc.strengths)}</textarea>
        <div class="counter" data-for="strengths"></div>
      </div>
      <div class="field">
        <label for="improvements">改進建議${min ? `（至少 ${min} 字）` : ''}</label>
        <textarea id="improvements" maxlength="2000" ${ro ? 'disabled' : ''}>${esc(sc.improvements)}</textarea>
        <div class="counter" data-for="improvements"></div>
      </div>
      <p class="muted small" style="margin:0">評語會公開給學生看，顯示為「評審${w.slot}」，不會顯示你的姓名。</p>
      ${ro ? '' : `<div class="row" style="justify-content:flex-end">
        <span class="muted small" id="saveState"></span>
        <button class="btn" type="button" data-act="draft">暫存</button>
        <button class="btn primary" type="submit">正式送出</button>
      </div>`}
    </form>
  </div>`;
  updateTotals();
}

function readForm() {
  const items = {};
  main.querySelectorAll('input[data-item]').forEach(i => { if (i.value !== '') items[i.dataset.item] = Number(i.value); });
  return { items, strengths: document.getElementById('strengths').value, improvements: document.getElementById('improvements').value };
}

/** 即時計算總分、檢查每一項的範圍、更新評語字數 */
function updateTotals() {
  const w = S.work;
  if (!w) return;
  let tot = 0, filled = 0, bad = false;
  w.rubric.items.forEach(it => {
    const el = document.getElementById('it-' + it.id);
    const v = el.value;
    const invalid = v !== '' && (!/^\d+$/.test(v) || Number(v) > it.max);
    el.setAttribute('aria-invalid', String(invalid));
    el.style.borderColor = invalid ? 'var(--bad)' : '';
    if (v !== '' && !invalid) { tot += Number(v); filled++; }
    if (invalid) bad = true;
  });
  document.getElementById('total').textContent = filled ? tot : '—';
  ['strengths', 'improvements'].forEach(id => {
    const n = [...document.getElementById(id).value.trim()].length;
    const c = main.querySelector(`.counter[data-for="${id}"]`);
    c.textContent = `${n} 字`;
    c.classList.toggle('short', n < w.minCommentChars);
  });
  return { tot, filled, bad };
}

async function save(submit, btn) {
  const w = S.work, data = readForm(), t = updateTotals();
  if (t.bad) { toast('有分數超出範圍，請檢查紅框的欄位', 'bad'); return; }
  if (submit) {
    const ok = await confirmBox(`<h2>正式送出評分</h2>
      <p>${esc(w.team.code)}　${esc(w.team.workTitle || '')}</p>
      <table><tbody>${w.rubric.items.map(it => `<tr><td>${esc(it.title)}</td><td style="text-align:right">${data.items[it.id] ?? '<span style="color:var(--bad)">未填</span>'} / ${it.max}</td></tr>`).join('')}
      <tr><th>總分</th><th style="text-align:right">${t.tot} / ${w.rubric.total}</th></tr></tbody></table>
      <div class="notice warn">送出後就不能自己修改，需要由主辦單位退回。</div>`, '確定送出');
    if (!ok) return;
  }
  const r = await busy(btn, () => call(submit ? 'judgeSubmit' : 'judgeSaveDraft', w.team.id, data));
  if (!r) return;
  S.dirty = false;
  if (submit) {
    toast(`已正式送出：${r.total} 分`);
    // 回到清單時把網址也改回來，否則再點同一件作品網址不會變、打不開
    if (location.hash) { lastHash = ''; history.replaceState(null, '', location.pathname); }
    await showList();
  }
  else {
    toast('已暫存');
    const st = document.getElementById('saveState');
    if (st) st.textContent = '已暫存 ' + new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  }
}

async function leaveIfOk() {
  if (!S.dirty) return true;
  return confirmBox('<p>有還沒暫存的變更，確定要離開嗎？</p>', '離開', true);
}

/* ───────────── 事件 ───────────── */
main.addEventListener('click', async e => {
  const card = e.target.closest('[data-team]');
  if (card) { location.hash = 't=' + card.dataset.team; return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const player = document.getElementById('player');
  switch (el.dataset.act) {
    case 'back': e.preventDefault(); if (await leaveIfOk()) { S.dirty = false; location.hash = ''; } break;
    case 'rate': if (player) player.playbackRate = Number(el.dataset.rate); break;
    case 'skip': if (player) player.currentTime = Math.max(0, player.currentTime + Number(el.dataset.sec)); break;
    case 'draft': await save(false, el); break;
    default: break;
  }
});
main.addEventListener('input', e => {
  if (e.target.matches('input[data-item], textarea')) { S.dirty = true; updateTotals(); }
});
main.addEventListener('submit', async e => { e.preventDefault(); await save(true, e.submitter); });
window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

async function route() {
  const m = /^#t=([0-9a-f-]{36})$/i.exec(location.hash);
  try {
    if (m) await showWork(m[1]); else await showList();
  } catch (err) {
    main.innerHTML = `<div class="card notice bad">${esc(err.message)}</div><p><a href="#">← 回作品清單</a></p>`;
  }
}
let lastHash = location.hash;
window.addEventListener('hashchange', async () => {
  if (S.dirty && !(await leaveIfOk())) { history.replaceState(null, '', lastHash || '#'); return; }
  lastHash = location.hash;
  S.dirty = false;
  route();
});

document.getElementById('logout').addEventListener('click', async () => { if (await leaveIfOk()) { S.dirty = false; logout(); } });
document.getElementById('pwBtn').addEventListener('click', async () => {
  const ok = await confirmBox(`<h2>修改密碼</h2>
    <div class="field"><label for="pw-old">原密碼</label><input id="pw-old" type="password" autocomplete="current-password"></div>
    <div class="field"><label for="pw-new">新密碼（至少 8 個字）</label><input id="pw-new" type="password" autocomplete="new-password"></div>`, '修改');
  if (!ok) return;
  if (await busy(null, () => call('changePassword', dialogValues['pw-old'], dialogValues['pw-new']))) toast('密碼已修改');
});

/* ───────────── 啟動 ───────────── */
devBanner();
try {
  S.me = await requireRole('judge');
  document.getElementById('compName').textContent = S.me.competition.name;
  document.getElementById('who').textContent = S.me.me.name;
  await route();
} catch (err) {
  main.innerHTML = `<div class="card notice bad">${esc(err.message)}</div>`;
}
