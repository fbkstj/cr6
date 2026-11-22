// 成績表：復刻「桃園市立楊梅高中 115 年專題及創意製作競賽初賽評分表」的版面（A4 橫式、表格），
// 可以在網頁上看，也可以下載成 PDF。公開結果頁與後台「結算與公布」共用。
// 版面：標題「{競賽名稱}評分表(專題組)」；欄位 編號｜題目｜各評分項目(配分%)｜總分｜評語。
// 每一組別有一張「平均」成績表（含名次、各評審總分），以及每位評審各一張（和原 Word 檔一樣有評語欄）。
import { esc } from './app.js';

const PREFIX = { project: '專', creative: '創' };
const PDF_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';

/** 數字最多 2 位小數，去掉多餘的 0 */
const fmt = n => n === null || n === undefined || Number.isNaN(n) ? '' : String(Math.round(n * 100) / 100);

function judgeLabel(j) { return j.label || '評審' + j.slot; }

/** 後台排名資料（adminRanking）→ 共用格式 */
export function fromRanking(name, r) {
  return {
    name, judgeCount: r.judgeCount,
    categories: r.categories.filter(c => !c.empty && c.rows.length).map(c => ({
      category: c.category, label: c.categoryLabel, items: c.items,
      teams: c.rows.map(x => ({ code: x.code, name: x.name, workTitle: x.workTitle, rank: x.rank, tied: x.tied, average: x.average,
        judges: x.judges.map(j => ({ slot: j.slot, total: j.total, items: j.items, strengths: j.strengths, improvements: j.improvements })) })),
    })),
  };
}

/** 公開結果（publicResults）→ 共用格式 */
export function fromPublic(res) {
  return {
    name: res.competition.name, judgeCount: res.judgeCount,
    categories: res.categories.map(cat => ({
      category: cat.category, label: cat.label, items: cat.items,
      teams: res.teams.filter(t => t.category === cat.category).map(t => ({ code: t.code, name: t.name, workTitle: t.workTitle, rank: t.rank,
        tied: t.tied, average: t.average, judges: t.judges })),
    })).filter(c => c.teams.length),
  };
}

const th = (html, cls = '') => `<th class="${cls}">${html}</th>`;
const itemHead = it => `${esc(it.title)}<br>(${esc(it.max)}%)`;
const titleCell = t => esc(t.name && t.workTitle ? t.workTitle : (t.workTitle || t.name || t.code));

/** 編號依組別代碼排序：專1、專2…（和 Word 檔的「專1」「創1」一樣） */
function numbered(cat) {
  return cat.teams.slice().sort((a, b) => a.code.localeCompare(b.code)).map((t, i) => Object.assign({ no: (PREFIX[cat.category] || '') + (i + 1) }, t));
}

function sheetHtml(title, head, body, note) {
  return `<section class="sheet"><h1 class="sheet-title">${esc(title)}</h1>
    <table class="sheet-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    ${note ? `<p class="sheet-note">${note}</p>` : ''}</section>`;
}

/** 某一組別的「平均」成績表：名次、各項平均、總分（平均）、各評審總分 */
function averageSheet(data, cat) {
  const items = cat.items;
  const N = data.judgeCount || 0;
  const head = th('編號', 'c-no') + th('題目', 'c-title') + th('名次', 'c-rank')
    + (items ? items.map(i => th(itemHead(i), 'c-item')).join('') : '')
    + th('總分<br>(平均)', 'c-total') + Array.from({ length: N }, (_, k) => th('評審' + (k + 1), 'c-j')).join('');
  const body = numbered(cat).sort((a, b) => (a.rank || 999) - (b.rank || 999) || a.no.localeCompare(b.no, 'zh', { numeric: true })).map(t => {
    const itemCells = items ? items.map(i => {
      const v = t.judges.map(j => j.items && j.items[i.id]).filter(x => typeof x === 'number');
      return `<td class="num">${v.length ? fmt(v.reduce((a, b) => a + b, 0) / v.length) : ''}</td>`;
    }).join('') : '';
    return `<tr><td class="c-no">${esc(t.no)}</td><td>${titleCell(t)}</td><td class="num">${t.rank ? esc(t.rank) + (t.tied ? '<br><small>(並列)</small>' : '') : ''}</td>${itemCells}
      <td class="num"><b>${fmt(t.average)}</b></td>${Array.from({ length: N }, (_, k) => { const j = t.judges.find(x => x.slot === k + 1); return `<td class="num">${j ? esc(j.total) : ''}</td>`; }).join('')}</tr>`;
  }).join('');
  return { key: cat.category + '-avg', label: `${cat.label}｜平均`, html: sheetHtml(`${data.name}評分表(${cat.label})　成績總表`, head, body, '總分為各評審總分的平均；名次為本組別內的名次。') };
}

/** 某一組別、某一位評審的成績表（和 Word 檔一樣：編號、題目、各項分數、總分、評語；另有建議欄） */
function judgeSheet(data, cat, slot) {
  const items = cat.items;
  const head = th('編號', 'c-no') + th('題目', 'c-title') + (items ? items.map(i => th(itemHead(i), 'c-item')).join('') : '') + th('總分', 'c-total') + th('評語<br>(優點)', 'c-comment') + th('建議<br>(改進)', 'c-comment');
  const body = numbered(cat).map(t => {
    const j = t.judges.find(x => x.slot === slot);
    const cells = items ? items.map(i => `<td class="num">${j && j.items && j.items[i.id] !== undefined && j.items[i.id] !== null ? esc(j.items[i.id]) : ''}</td>`).join('') : '';
    const nl = x => esc(x).replace(/\n/g, '<br>');
    return `<tr class="tall"><td class="c-no">${esc(t.no)}</td><td>${titleCell(t)}</td>${cells}<td class="num"><b>${j ? esc(j.total) : ''}</b></td><td class="c-comment">${j ? nl(j.strengths || '') : ''}</td><td class="c-comment">${j ? nl(j.improvements || '') : ''}</td></tr>`;
  }).join('');
  return { key: `${cat.category}-j${slot}`, label: `${cat.label}｜評審${slot}`, html: sheetHtml(`${data.name}評分表(${cat.label})　評審${slot}`, head, body, '') };
}

/** 全部成績表：每個組別先「平均」，再每位評審一張 */
export function buildSheets(data) {
  const out = [];
  for (const cat of data.categories) {
    out.push(averageSheet(data, cat));
    for (let n = 1; n <= (data.judgeCount || 0); n++) out.push(judgeSheet(data, cat, n));
  }
  return out;
}

let pdfLoading = null;
function loadPdfLib() {
  if (window.html2pdf) return Promise.resolve();
  if (!pdfLoading) pdfLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PDF_LIB; s.onload = resolve; s.onerror = () => { pdfLoading = null; reject(new Error('無法載入 PDF 工具（需要連上網路）')); };
    document.head.appendChild(s);
  });
  return pdfLoading;
}

/** 把一批成績表轉成 PDF 下載（A4 橫式，一張一頁；太長的表自動接到下一頁） */
export async function downloadPdf(sheets, filename) {
  await loadPdfLib();
  // 要排在頁面最上方、而且是看得到的（不是 fixed、也不是負 z-index），否則 html2canvas 會轉出空白；
  // 所以先用白色遮罩蓋住整個畫面，轉完再移除
  const cover = document.createElement('div');
  cover.className = 'sheet-pdf-cover';
  cover.textContent = '產生 PDF 中…';
  // 外層 host 負責擺在畫面最上方；交給 html2pdf 的 box 本身不能是 absolute/fixed（高度會變 0，轉出空白頁）
  const host = document.createElement('div');
  host.className = 'sheet-pdf-root';
  const box = document.createElement('div');
  box.className = 'sheet-pdf-box';
  box.innerHTML = sheets.map((s, i) => i ? s.html.replace('<section class="sheet"', '<section class="sheet sheet-brk"') : s.html).join('');
  const oldY = window.scrollY;
  host.appendChild(box);
  document.body.appendChild(host);
  document.body.appendChild(cover);
  window.scrollTo(0, 0);
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await window.html2pdf().set({
      margin: [8, 10, 8, 10], filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', windowWidth: 1080, scrollX: 0, scrollY: 0 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
      pagebreak: { mode: ['css'], before: '.sheet-brk', avoid: 'tr' },
    }).from(box).save();
  } finally { host.remove(); cover.remove(); window.scrollTo(0, oldY); }
}

/** 在 container 放上「成績表」面板：選擇要看的表、網頁預覽、下載 PDF */
export function mountSheetPanel(container, data, { onError = () => {} } = {}) {
  const sheets = buildSheets(data);
  if (!sheets.length) { container.innerHTML = ''; return; }
  let cur = 0;
  const safe = s => s.replace(/[\\/:*?"<>|]/g, '');
  const draw = () => {
    container.innerHTML = `<div class="card stack">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">成績表（評分表格式）</h2>
        <div class="row"><button class="btn" data-sheet="one">下載這一張 PDF</button><button class="btn primary" data-sheet="all">下載全部 PDF（${sheets.length} 張）</button></div></div>
      <p class="muted small" style="margin:0">版面比照初賽評分表：A4 橫式，編號、題目、各項分數、總分、評語。每個組別一張「平均」總表，另有每位評審各一張。評審只顯示編號，不顯示姓名。</p>
      <div class="row sheet-tabs">${sheets.map((s, i) => `<button class="chip ${i === cur ? 'accent' : ''}" data-sheet-i="${i}" type="button">${esc(s.label)}</button>`).join('')}</div>
      <div class="sheet-scroll">${sheets[cur].html}</div>
    </div>`;
  };
  draw();
  container.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.sheetI !== undefined) { cur = Number(b.dataset.sheetI); draw(); return; }
    if (!b.dataset.sheet) return;
    const all = b.dataset.sheet === 'all';
    const old = b.textContent; b.disabled = true; b.textContent = '產生 PDF 中…';
    try { await downloadPdf(all ? sheets : [sheets[cur]], safe(`${data.name}_成績表${all ? '' : '_' + sheets[cur].label.replace('｜', '_')}`) + '.pdf'); }
    catch (err) { onError(err); }
    finally { b.disabled = false; b.textContent = old; }
  };
}
