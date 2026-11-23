// 成績表轉成 Word（.docx），下載後可在 Word 自行修改。
// 直接讀 sheet.js 產生的成績表 HTML（標題、表格、註記），照同樣的版面寫成 WordprocessingML：
// A4 橫式、四邊 1.5cm、標楷體、標題 18pt 粗體置中、表格 12pt、資料列至少 90pt、表頭每頁重複。
// Word 檔不自動縮小：內容放不下時由 Word 自然換頁，要縮放或調整都在 Word 裡做。
const JSZIP_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

const TW = 20;                       // 1pt＝20 twips
const CM = 567;                      // 1cm 約 567 twips
const PAGE = { w: 16838, h: 11906, m: Math.round(1.5 * CM) };   // A4 橫式
const CONTENT_W = PAGE.w - PAGE.m * 2;
const FONT = '標楷體';

let zipLoading = null;
function loadZip() {
  if (window.JSZip) return Promise.resolve();
  if (!zipLoading) zipLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = JSZIP_LIB; s.onload = resolve; s.onerror = () => { zipLoading = null; reject(new Error('無法載入 Word 工具（需要連上網路）')); };
    document.head.appendChild(s);
  });
  return zipLoading;
}

// XML 不允許的控制字元要去掉
const xml = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const rPr = (pt, bold) => `<w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT}" w:cs="${FONT}"/>${bold ? '<w:b/><w:bCs/>' : ''}<w:sz w:val="${pt * 2}"/><w:szCs w:val="${pt * 2}"/></w:rPr>`;

/** 一個節點裡的文字 → runs（<br> 變換行） */
function runs(node, pt, bold) {
  let out = '';
  const walk = n => {
    if (n.nodeType === 3) { if (n.nodeValue) out += `<w:r>${rPr(pt, bold)}<w:t xml:space="preserve">${xml(n.nodeValue)}</w:t></w:r>`; return; }
    if (n.nodeType !== 1) return;
    if (n.tagName === 'BR') { out += `<w:r>${rPr(pt, bold)}<w:br/></w:r>`; return; }
    n.childNodes.forEach(walk);
  };
  walk(node);
  return out;
}

const para = (content, { align = 'left', pt = 12, extra = '' } = {}) =>
  `<w:p><w:pPr>${extra}<w:spacing w:before="0" w:after="0"/><w:jc w:val="${align === 'center' ? 'center' : 'left'}"/>${rPr(pt)}</w:pPr>${content}</w:p>`;

/** 儲存格內容：裡面的 <div>（每位評審一段評語）各成一個段落，其他照順序接在一起 */
function cellParas(cell, pt, align) {
  const ps = [];
  let inline = document.createElement('span');
  const flush = () => { if (inline.childNodes.length) { ps.push(para(runs(inline, pt), { align, pt })); inline = document.createElement('span'); } };
  [...cell.childNodes].forEach(n => {
    if (n.nodeType === 1 && n.tagName === 'DIV') { flush(); ps.push(para(runs(n, pt), { align, pt })); }
    else inline.appendChild(n.cloneNode(true));
  });
  flush();
  return ps.join('') || para('', { align, pt });   // 儲存格至少要有一個段落
}

/** 欄寬：colgroup 的 calc(27pt * …) 取 pt；沒寫寬度的欄平分剩下的寬度 */
function colWidths(table) {
  const cols = [...table.querySelectorAll('col')].map(c => { const m = /([\d.]+)pt/.exec(c.getAttribute('style') || ''); return m ? Math.round(Number(m[1]) * TW) : null; });
  const fixed = cols.reduce((a, w) => a + (w || 0), 0);
  const free = cols.filter(w => w === null).length;
  const each = free ? Math.max(600, Math.floor((CONTENT_W - fixed) / free)) : 0;
  return cols.map(w => w === null ? each : w);
}

function tableXml(table, pt) {
  const widths = colWidths(table);
  const total = widths.reduce((a, b) => a + b, 0);
  const border = t => `<w:${t} w:val="single" w:sz="6" w:space="0" w:color="000000"/>`;
  const row = (tr, head) => {
    const tall = tr.classList.contains('tall');
    const trPr = head ? '<w:trPr><w:tblHeader/></w:trPr>' : (tall ? `<w:trPr><w:trHeight w:val="${90 * TW}" w:hRule="atLeast"/></w:trPr>` : '');
    const cells = [...tr.children].map((c, i) => {
      const align = c.classList.contains('num') ? 'center' : 'left';
      return `<w:tc><w:tcPr><w:tcW w:w="${widths[i] || 0}" w:type="dxa"/><w:vAlign w:val="${head ? 'top' : 'center'}"/></w:tcPr>${cellParas(c, pt, align)}</w:tc>`;
    }).join('');
    return `<w:tr>${trPr}${cells}</w:tr>`;
  };
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:jc w:val="center"/>
    <w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>
    <w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="30" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="30" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar>
    <w:tblLook w:val="0000"/></w:tblPr>
    <w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>
    ${[...table.querySelectorAll('thead tr')].map(tr => row(tr, true)).join('')}
    ${[...table.querySelectorAll('tbody tr')].map(tr => row(tr, false)).join('')}</w:tbl>`;
}

/** 一張成績表（<section class="sheet">）→ 標題、表格、註記；第二張起從新的一頁開始 */
function sheetXml(section, first, pt) {
  const h1 = section.querySelector('.sheet-title');
  const note = section.querySelector('.sheet-note');
  const title = para(h1 ? runs(h1, 18, true) : '', { align: 'center', pt: 18, extra: (first ? '' : '<w:pageBreakBefore/>') });
  const gap = para('', { pt });                                  // 標題與表格之間空一行（範本約 30pt）
  const table = section.querySelector('table');
  const noteP = note && note.textContent.trim() ? para(runs(note, pt), { pt }) : '';
  return title + gap + (table ? tableXml(table, pt) : '') + noteP;
}

function documentXml(sheetsHtml, pt) {
  const host = document.createElement('div');
  host.innerHTML = sheetsHtml.join('');
  // 分頁標記（「第 1／2 頁」）是 PDF 用的，Word 由使用者自行排版，不放
  host.querySelectorAll('.sheet-page').forEach(n => n.remove());
  const body = [...host.querySelectorAll('section.sheet')].map((s, i) => sheetXml(s, i === 0, pt)).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${body}<w:sectPr><w:pgSz w:w="${PAGE.w}" w:h="${PAGE.h}" w:orient="landscape"/>
<w:pgMar w:top="${PAGE.m}" w:right="${PAGE.m}" w:bottom="${PAGE.m}" w:left="${PAGE.m}" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

const STYLES = pt => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault>${rPr(pt)}</w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

/** 成績表 HTML 陣列 → .docx 的 Blob。pt＝表格文字大小（預設 12pt＝範本） */
export async function makeDocx(sheetsHtml, pt = 12) {
  await loadZip();
  const zip = new window.JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/_rels/document.xml.rels', DOC_RELS);
  zip.file('word/styles.xml', STYLES(pt));
  zip.file('word/document.xml', documentXml(sheetsHtml, pt));
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

/** 產生並下載 .docx */
export async function downloadDocx(sheetsHtml, filename, pt = 12) {
  const blob = await makeDocx(sheetsHtml, pt);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
