// 成績表：復刻「桃園市立楊梅高中 115 年專題及創意製作競賽初賽評分表」的版面（A4 橫式、表格），
// 可以在網頁上看，也可以下載成 PDF。公開結果頁與後台「結算與公布」共用。
// 版面：標題「{競賽名稱}評分表(專題組)」；欄位 編號｜題目｜各評分項目(配分%)｜總分｜評語。
// 每一組別有一張「平均」成績表（含名次、各評審總分），以及每位評審各一張（和原 Word 檔一樣有評語欄）。
import { esc } from './app.js';
import { downloadDocx } from './word.js?v=20261123i';

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

const th = html => `<th>${html}</th>`;
// 和範本一樣寫成「應用及整合性（40%）」，欄寬不夠時自然換行
const itemText = it => `${it.title}（${it.max}%）`;
const titleCell = t => esc(t.name && t.workTitle ? t.workTitle : (t.workTitle || t.name || t.code));
const nl = x => esc(x).replace(/\n/g, '<br>');

// 欄寬（pt，照範本實測）：編號 27、題目 86、總分 50；評分項目依標題長度 57～96（範本：創意性 57、內文組織及架構格式 96）
const W_NO = 27, W_TITLE = 86, W_TOTAL = 50, W_RANK = 38;
const itemWidth = it => Math.max(57, Math.min(96, Math.ceil([...itemText(it)].length / 2) * 12 + 11));
const colgroup = widths => `<colgroup>${widths.map(w => w ? `<col style="width:calc(${w}pt * var(--k, 1))">` : '<col>').join('')}</colgroup>`;

/** 編號依組別代碼排序：專1、專2…（和 Word 檔的「專1」「創1」一樣） */
function numbered(cat) {
  return cat.teams.slice().sort((a, b) => a.code.localeCompare(b.code)).map((t, i) => Object.assign({ no: (PREFIX[cat.category] || '') + (i + 1) }, t));
}

function sheetHtml(title, widths, head, body, note, fit, pageTag = '') {
  return `<section class="sheet"${fit ? ' data-fit="1"' : ''}><h1 class="sheet-title">${esc(title)}</h1>
    <table class="sheet-table">${colgroup(widths)}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    ${note || pageTag ? `<p class="sheet-note">${note ? `※${note}※` : ''}${pageTag ? `<span class="sheet-page">${esc(pageTag)}</span>` : ''}</p>` : ''}</section>`;
}

/** 成績總表的列順序：依名次，再依編號 */
const summaryRows = cat => numbered(cat).sort((a, b) => (a.rank || 999) - (b.rank || 999) || a.no.localeCompare(b.no, 'zh', { numeric: true }));
const SUMMARY_NOTE = '總分為各評審總分的平均；名次為本組別內的名次';

/** 某一組別的「成績總表」：各項平均、總分（平均）、名次、各評審的總分與評語、建議。rows 可只給一部分（分頁用） */
function averageSheet(data, cat, rows = summaryRows(cat), pageTag = '') {
  const items = cat.items || [];
  const widths = [W_NO, W_TITLE, ...items.map(itemWidth), W_TOTAL, W_RANK, null];
  const head = th('編號') + th('題目') + items.map(i => th(esc(itemText(i)))).join('') + th('總分（平均）') + th('名次') + th('評語及建議');
  const body = rows.map(t => {
    const itemCells = items.map(i => {
      const v = t.judges.map(j => j.items && j.items[i.id]).filter(x => typeof x === 'number');
      return `<td class="num">${v.length ? fmt(v.reduce((a, b) => a + b, 0) / v.length) : ''}</td>`;
    }).join('');
    const comments = t.judges.slice().sort((a, b) => a.slot - b.slot).map(j =>
      `<div class="cm">評審${esc(j.slot)}（${esc(j.total ?? '')}分）${j.strengths ? `優點：${nl(j.strengths)}` : ''}${j.improvements ? `${j.strengths ? '　' : ''}建議：${nl(j.improvements)}` : ''}</div>`).join('');
    return `<tr class="tall"><td>${esc(t.no)}</td><td>${titleCell(t)}</td>${itemCells}
      <td class="num">${fmt(t.average)}</td><td class="num">${t.rank ? esc(t.rank) + (t.tied ? '<br>(並列)' : '') : ''}</td><td>${comments}</td></tr>`;
  }).join('');
  return { key: cat.category + '-avg', label: `${cat.label}｜成績總表`, summary: true,
    html: sheetHtml(`${data.name}評分表(${cat.label})`, widths, head, body, SUMMARY_NOTE, true, pageTag) };
}

/** 某一組別、某一位評審的成績表（和 Word 檔一樣：編號、題目、各項分數、總分、評語；另有建議欄） */
function judgeSheet(data, cat, slot) {
  const items = cat.items || [];
  const widths = [W_NO, W_TITLE, ...items.map(itemWidth), W_TOTAL, null, null];
  const head = th('編號') + th('題目') + items.map(i => th(esc(itemText(i)))).join('') + th('總分') + th('評語（優點）') + th('建議（改進）');
  const body = numbered(cat).map(t => {
    const j = t.judges.find(x => x.slot === slot);
    const cells = items.map(i => `<td class="num">${j && j.items && j.items[i.id] !== undefined && j.items[i.id] !== null ? esc(j.items[i.id]) : ''}</td>`).join('');
    return `<tr class="tall"><td>${esc(t.no)}</td><td>${titleCell(t)}</td>${cells}<td class="num">${j ? esc(j.total) : ''}</td><td>${j ? nl(j.strengths || '') : ''}</td><td>${j ? nl(j.improvements || '') : ''}</td></tr>`;
  }).join('');
  return { key: `${cat.category}-j${slot}`, label: `${cat.label}｜評審${slot}`, html: sheetHtml(`${data.name}評分表(${cat.label})　評審${slot}`, widths, head, body, '') };
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

// ── 成績總表的 PDF 版面：A4 橫式、四邊留白 1.5cm → 內容區 267×180mm（1px＝0.75pt） ──
const MM = 96 / 25.4;                       // 1mm 的 px 數
const PAGE_W = Math.floor(267 * MM);
const FIT_H = Math.floor(180 * MM) - 4;     // 內容區高 180mm，留一點餘裕給四捨五入
const BASE_PT = 12;                         // 範本表格字體
export const SIZE_CHOICES = [12, 11, 10, 9, 8];
export const PAGE_CHOICES = [
  { v: '1', label: '每組 1 頁（放不下就縮小文字）' },
  { v: '2', label: '每組 2 頁（放不下就縮小文字）' },
  { v: 'auto', label: '依文字大小自動分頁' },
];

/** 量版面用的隱藏容器（寬度和 PDF 內容區一樣） */
function measureHost() {
  const host = document.createElement('div');
  host.className = 'sheet-pdf-box';
  host.style.cssText = 'position:absolute;left:-20000px;top:0;visibility:hidden';
  document.body.appendChild(host);
  return host;
}

/** 放一頁的列，文字比例最大 kMax：①列高照範本 90pt，放不下就降到依內容 ②再一起縮小所有尺寸（二分搜尋最大的 k） */
function fitPage(host, data, cat, rows, pageTag, kMax) {
  host.innerHTML = averageSheet(data, cat, rows, pageTag).html;
  const sh = host.firstElementChild;
  const cells = sh.querySelectorAll('tr.tall td');
  sh.style.setProperty('--k', kMax);
  for (let rh = 90; rh >= 0; rh -= 10) {
    cells.forEach(c => { c.style.height = (rh * kMax) + 'pt'; });
    if (sh.offsetHeight <= FIT_H) break;
  }
  let k = kMax;
  if (sh.offsetHeight > FIT_H) {
    const fits = x => { sh.style.setProperty('--k', x); return sh.offsetHeight <= FIT_H; };
    let lo = 0.2, hi = kMax;
    for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
    k = lo; fits(k);
  }
  return { html: sh.outerHTML, k, pt: Math.round(BASE_PT * k * 10) / 10 };
}

/** 不設列高、文字比例 k 時這些列的總高度 */
function naturalHeight(host, data, cat, rows, k) {
  host.innerHTML = averageSheet(data, cat, rows, '第 1／9 頁').html;
  const sh = host.firstElementChild;
  sh.querySelectorAll('tr.tall td').forEach(c => { c.style.height = '0'; });
  sh.style.setProperty('--k', k);
  return sh.offsetHeight;
}

/** 把一個組別的列分成幾頁：固定頁數時找最平均的切法；auto＝照文字大小一頁放到滿再換頁 */
function splitRows(host, data, cat, rows, pages, kMax) {
  if (pages === 'auto') {
    const out = [];
    let cur = [];
    for (const r of rows) {
      if (cur.length && naturalHeight(host, data, cat, [...cur, r], kMax) > FIT_H) { out.push(cur); cur = []; }
      cur.push(r);
    }
    if (cur.length) out.push(cur);
    return out;
  }
  const P = Math.min(Number(pages) || 1, rows.length);
  if (P <= 1) return [rows];
  // P＝2：試每一個切點，取兩頁中較高的那頁最矮的切法（內容多的組會少放幾組）
  let best = null;
  for (let i = 1; i < rows.length; i++) {
    const h = Math.max(naturalHeight(host, data, cat, rows.slice(0, i), kMax), naturalHeight(host, data, cat, rows.slice(i), kMax));
    if (!best || h < best.h) best = { h, i };
  }
  return [rows.slice(0, best.i), rows.slice(best.i)];
}

/**
 * 依選項排好成績總表的每一頁。opts.pages：'1'｜'2'｜'auto'；opts.size：0＝自動（最大 12pt），或指定 pt。
 * 回傳 [{ label, pages: [{ html, k, pt }] }]（每個組別一筆）
 */
export async function layoutSummary(data, { pages = '1', size = 0 } = {}) {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const kMax = (Number(size) || BASE_PT) / BASE_PT;
  const host = measureHost();
  try {
    return data.categories.map(cat => {
      const chunks = splitRows(host, data, cat, summaryRows(cat), pages, kMax);
      return {
        label: cat.label,
        pages: chunks.map((rows, i) => fitPage(host, data, cat, rows, chunks.length > 1 ? `第 ${i + 1}／${chunks.length} 頁` : '', kMax)),
      };
    });
  } finally { host.remove(); }
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

/** 把一批成績表（html）轉成 PDF 下載：A4 橫式、四邊留白 1.5cm，一張一頁；太長的表自動接到下一頁 */
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
      margin: 15, filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', windowWidth: PAGE_W, scrollX: 0, scrollY: 0 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
      pagebreak: { mode: ['css'], before: '.sheet-brk', avoid: 'tr' },
    }).from(box).toContainer().then(function () {
      // html2pdf 的容器預設在整個視窗置中（margin:auto），但 html2canvas 用 windowWidth（內容區寬）排版，
      // 視窗比內容區寬時兩邊的位置對不上，內容會往左偏「(視窗寬−內容寬)/2」、左邊被裁掉。改成貼齊左邊就與視窗寬度無關。
      const c = this.prop.container;
      c.style.left = '0'; c.style.right = 'auto'; c.style.margin = '0';
    }).save();
  } finally { host.remove(); cover.remove(); window.scrollTo(0, oldY); }
}

const OPT_KEY = 'cr6.summaryPdfOpts';
function loadOpts() {
  try { const o = JSON.parse(localStorage.getItem(OPT_KEY) || '{}'); return { pages: o.pages || '1', size: Number(o.size) || 0 }; }
  catch { return { pages: '1', size: 0 }; }
}
function saveOpts(o) { try { localStorage.setItem(OPT_KEY, JSON.stringify(o)); } catch { /* 無法儲存就算了 */ } }

/** 在 container 放上「成績表」面板：成績總表（可選頁數、文字大小，A4 預覽後下載）＋每位評審的單張表 */
export function mountSheetPanel(container, data, { onError = () => {} } = {}) {
  const all = buildSheets(data);
  const sheets = all.filter(s => !s.summary);                  // 評審單張表
  const summaries = all.filter(s => s.summary).map(s => s.html); // Word 版成績總表（不分頁、不縮小，由 Word 自然換頁）
  if (!data.categories.length) { container.innerHTML = ''; return; }
  const opts = loadOpts();
  let cur = -1;          // -1＝成績總表（輸出預覽）；其他＝評審單張表
  let layout = null;     // layoutSummary 的結果
  let seq = 0;
  const safe = s => s.replace(/[\\/:*?"<>|]/g, '');
  const pageCount = () => layout ? layout.reduce((n, c) => n + c.pages.length, 0) : 0;
  const status = () => layout ? layout.map(c => {
    const pts = c.pages.map(p => p.pt);
    const lo = Math.min(...pts), hi = Math.max(...pts);
    const shrunk = opts.size && lo < opts.size - 0.05 ? `（指定 ${opts.size}pt 放不下，已縮小）` : '';
    return `${esc(c.label)} ${c.pages.length} 頁，文字 ${lo === hi ? lo : `${lo}～${hi}`}pt${shrunk}`;
  }).join('；') : '排版中…';

  const previewHtml = () => layout
    ? layout.flatMap(c => c.pages.map(p => `<div class="a4-page"><div class="a4-inner">${p.html}</div></div>`)).join('')
    : '<p class="muted">排版中…</p>';

  const fitPreview = () => {
    const wrap = container.querySelector('.a4-preview'); if (!wrap) return;
    const page = wrap.querySelector('.a4-page'); if (!page) return;
    const z = Math.min(1, (wrap.clientWidth - 2) / (297 * MM));
    wrap.querySelectorAll('.a4-page').forEach(p => { p.style.zoom = z; });
  };

  const draw = () => {
    const onSummary = cur < 0;
    container.innerHTML = `<div class="card stack">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">成績表（評分表格式）</h2>
        <div class="row">${onSummary ? '' : '<button class="btn" data-sheet="one">下載這一張 PDF</button><button class="btn" data-word="one">下載這一張 Word</button>'}
          <button class="btn primary" data-sheet="all" ${layout ? '' : 'disabled'}>下載成績總表 PDF（共 ${pageCount() || '…'} 頁）</button>
          <button class="btn" data-word="all">下載成績總表 Word</button></div></div>
      <p class="muted small" style="margin:0">版面比照初賽評分表：A4 橫式、標楷體、四邊留白 1.5 公分。成績總表＝各組別的各項平均、總分、名次、各評審總分與評語及建議；另有每位評審各一張，可在下方選擇後單張下載。評審只顯示編號，不顯示姓名。Word 檔可自行修改：文字大小用上面選的（自動＝12pt），不自動縮小，放不下時由 Word 自然換頁、表頭每頁重複。</p>
      <div class="row sheet-opts">
        <label>每組頁數 <select data-opt="pages">${PAGE_CHOICES.map(c => `<option value="${c.v}" ${c.v === opts.pages ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>
        <label>文字大小 <select data-opt="size"><option value="0" ${!opts.size ? 'selected' : ''}>自動（盡量大，最大 12pt＝範本）</option>${SIZE_CHOICES.map(s => `<option value="${s}" ${s === opts.size ? 'selected' : ''}>${s}pt${s === 12 ? '（範本）' : ''}</option>`).join('')}</select></label>
      </div>
      <p class="small" style="margin:0" data-status>輸出結果：${status()}</p>
      <div class="row sheet-tabs"><button class="chip ${onSummary ? 'accent' : ''}" data-sheet-i="-1" type="button">成績總表（輸出預覽）</button>${sheets.map((s, i) => `<button class="chip ${i === cur ? 'accent' : ''}" data-sheet-i="${i}" type="button">${esc(s.label)}</button>`).join('')}</div>
      ${onSummary ? `<div class="a4-preview">${previewHtml()}</div>` : `<div class="sheet-scroll">${sheets[cur].html}</div>`}
    </div>`;
    if (onSummary) fitPreview();
  };

  const relayout = async () => {
    const my = ++seq;
    layout = null; draw();
    try {
      const r = await layoutSummary(data, opts);
      if (my !== seq) return;
      layout = r; draw();
    } catch (err) { onError(err); }
  };

  container.onchange = e => {
    const s = e.target.closest('select[data-opt]'); if (!s) return;
    opts[s.dataset.opt] = s.dataset.opt === 'size' ? Number(s.value) : s.value;
    saveOpts(opts);
    relayout();
  };
  container.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.sheetI !== undefined) { cur = Number(b.dataset.sheetI); draw(); return; }
    if (b.dataset.word) {
      const allW = b.dataset.word === 'all';
      const old = b.textContent; b.disabled = true; b.textContent = '產生 Word 中…';
      try { await downloadDocx(allW ? summaries : [sheets[cur].html], safe(`${data.name}_成績表${allW ? '' : '_' + sheets[cur].label.replace('｜', '_')}`) + '.docx', opts.size || 12); }
      catch (err) { onError(err); }
      finally { b.disabled = false; b.textContent = old; }
      return;
    }
    if (!b.dataset.sheet) return;
    const all = b.dataset.sheet === 'all';
    if (all && !layout) return;
    const list = all ? layout.flatMap(c => c.pages) : [sheets[cur]];
    const old = b.textContent; b.disabled = true; b.textContent = '產生 PDF 中…';
    try { await downloadPdf(list, safe(`${data.name}_成績表${all ? '' : '_' + sheets[cur].label.replace('｜', '_')}`) + '.pdf'); }
    catch (err) { onError(err); }
    finally { b.disabled = false; b.textContent = old; }
  };
  if (container._sheetRO) container._sheetRO.disconnect();   // 面板重畫時不要累積
  if (typeof ResizeObserver === 'function') {
    container._sheetRO = new ResizeObserver(() => fitPreview());
    container._sheetRO.observe(container);
  }
  relayout();
}
