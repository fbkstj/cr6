#!/usr/bin/env python3
"""把 data/digest.md（台股新聞彙整）轉成單一 HTML 儀表板 index.html。

用法：python3 stock-news/build.py
只用標準函式庫，不需安裝套件。
"""
import html
import json
import re
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / "data" / "digest.md"
OUT = HERE / "index.html"
PRICES = HERE / "data" / "prices"
NAMES = {"6213": "聯茂"}  # 下拉選單顯示用，找不到就只顯示代號


def load_prices():
    data = {}
    for f in sorted(PRICES.glob("*.json")):
        data[f.stem] = json.loads(f.read_text(encoding="utf-8"))
    return data


KLINE_HTML = """
<div id="kline">
  <div class="kbar">
    <select id="kcode" aria-label="股票"></select>
    <select id="kdays" aria-label="區間"><option value="60">近 60 日</option><option value="120" selected>近 120 日</option><option value="9999">全部</option></select>
    <span id="kinfo" class="muted">滑鼠移到圖上看當日數字</span>
  </div>
  <div class="klegend"><i style="background:#f59e0b"></i>MA5 <i style="background:#3b82f6"></i>MA20 <i style="background:#a855f7"></i>MA60 <span class="muted">紅 K 收高於開、綠 K 收低於開；下方為成交量（張）</span></div>
  <div id="kchart"></div>
  <details><summary>看最近 20 個交易日數據</summary><div class="tablewrap" id="ktable"></div></details>
  <p class="note" id="knote"></p>
</div>
"""


def inline(text):
    """處理行內語法：跳脫、**粗體**、反斜線跳脫。"""
    text = text.replace("\\~", "~").replace("\\|", "|")
    text = html.escape(text, quote=False)
    return re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)


def num_key(cell):
    """表格排序用：取出第一個數字（含逗號、小數、負號）。"""
    m = re.search(r"-?\d[\d,]*\.?\d*", cell.replace("−", "-"))
    return m.group(0).replace(",", "") if m else ""


def split_row(line):
    cells = re.split(r"(?<!\\)\|", line.strip().strip("|"))
    return [c.strip() for c in cells]


def render_table(rows):
    head, body = rows[0], rows[2:]
    if not body:
        return '<p class="muted">（原稿此表沒有附資料列）</p>'
    out = ['<div class="tablewrap"><table class="sortable"><thead><tr>']
    for h in head:
        out.append(f"<th>{inline(h)}</th>")
    out.append("</tr></thead><tbody>")
    for r in body:
        out.append("<tr>")
        for c in r:
            out.append(f'<td data-k="{html.escape(num_key(c))}">{inline(c)}</td>')
        out.append("</tr>")
    out.append("</tbody></table></div>")
    return "".join(out)


def item_html(text):
    """清單項目：去掉 **1** 這種序號徽章，**新** 轉成標籤。"""
    m = re.match(r"\*\*(新|\d+)\*\*", text)
    badge = ""
    if m:
        if m.group(1) == "新":
            badge = '<span class="tag">新</span>'
        text = text[m.end():]
    return f"<li>{badge}{inline(text)}</li>"


def convert(md):
    lines = md.splitlines()
    blocks = []  # (kind, payload)
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
        elif line.startswith("## "):
            blocks.append(("h2", line[3:].strip()))
            i += 1
        elif line.startswith("# "):
            blocks.append(("h1", line[2:].strip()))
            i += 1
        elif line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append(split_row(lines[i]))
                i += 1
            blocks.append(("table", rows))
        elif re.match(r"\d+\. ", line):
            items = []
            while i < len(lines) and re.match(r"\d+\. ", lines[i]):
                items.append(re.sub(r"^\d+\. ", "", lines[i]))
                i += 1
            blocks.append(("ol", items))
        elif line.startswith("- "):
            items = []
            while i < len(lines) and lines[i].startswith("- "):
                items.append(lines[i][2:])
                i += 1
            blocks.append(("ul", items))
        else:
            blocks.append(("p", line.strip()))
            i += 1
    if len(blocks) > 1 and blocks[0][0] == "p" and blocks[1][0] == "h1":
        blocks[0], blocks[1] = blocks[1], blocks[0]
        blocks[1] = ("sub", blocks[1][1])
    return blocks


def render(blocks):
    out, nav = [], []
    sec = 0
    new_group = True  # 第一組日期重點是「這一輪新增」
    i = 0
    open_section = False

    def close():
        nonlocal open_section
        if open_section:
            out.append("</section>")
            open_section = False

    def start(title):
        nonlocal sec, open_section
        close()
        sec += 1
        sid = f"s{sec}"
        nav.append((sid, title))
        out.append(f'<section id="{sid}"><h2>{inline(title)}</h2>')
        open_section = True

    while i < len(blocks):
        kind, p = blocks[i]
        nxt = blocks[i + 1][0] if i + 1 < len(blocks) else None
        if kind == "h1":
            out.append(f'<h1 class="title">{inline(p)}</h1>')
        elif kind == "sub":
            out.append(f'<p class="note">{inline(p)}</p>')
        elif kind == "h2" and p.startswith("最新重點") and nxt == "ol":
            start("近期重點")
            body = "".join(item_html(t) for t in blocks[i + 1][1])
            out.append(f'<details class="grp new" open><summary>{inline(p)}</summary><ol>{body}</ol></details>')
            new_group = False
            i += 1
        elif kind == "h2":
            start(p)
        elif kind == "p" and p.startswith("K 線圖"):
            start("K 線圖")
            out.append(KLINE_HTML)
            while i + 1 < len(blocks) and not (blocks[i + 1][0] == "p" and blocks[i + 1][1].startswith("總覽表")):
                i += 1  # 略過原稿裡沒有資料的 K 線區塊
        elif kind == "p":
            short = len(p) <= 40 and not p.endswith(("。", ";"))
            if short and nxt == "ol":
                # 日期重點群組 → 可摺疊
                items = blocks[i + 1][1]
                if not open_section:
                    start("近期重點")
                cls = "new" if new_group else ""
                new_group = False
                body = "".join(item_html(t) for t in items)
                out.append(
                    f'<details class="grp {cls}" {"open" if cls or not out else ""}>'
                    f"<summary>{inline(p)}</summary><ol>{body}</ol></details>"
                )
                i += 1
            elif short and nxt in ("table", "ul", "p"):
                if p.startswith(("總覽表", "焦點股", "個股索引", "未能存取", "K 線圖")):
                    start(p)
                else:
                    out.append(f"<h3>{inline(p)}</h3>")
            else:
                cls = "note" if p.startswith(("紫色", "資料來源", "單位", "自結數", "注意股", "數字引自")) else ""
                if not open_section:
                    start("總覽")
                out.append(f'<p class="{cls}">{inline(p)}</p>')
        elif kind == "ol":
            out.append("<ol>" + "".join(item_html(t) for t in p) + "</ol>")
        elif kind == "ul":
            out.append("<ul>" + "".join(f"<li>{inline(t)}</li>" for t in p) + "</ul>")
        elif kind == "table":
            out.append(render_table(p))
        i += 1
    close()
    return "\n".join(out), nav


CSS = """
:root{--bg:#f6f6f3;--fg:#1f2328;--mut:#6b7280;--card:#fff;--bd:#e3e3de;--ac:#6d28d9;--acbg:#f1ebfd;--up:#c62828;--dn:#2e7d32}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#14151a;--fg:#e6e6e9;--mut:#9aa0aa;--card:#1d1f26;--bd:#2f323b;--ac:#b794f6;--acbg:#2a2140;--up:#ff6b6b;--dn:#6fcf8a}}
:root[data-theme=dark]{--bg:#14151a;--fg:#e6e6e9;--mut:#9aa0aa;--card:#1d1f26;--bd:#2f323b;--ac:#b794f6;--acbg:#2a2140;--up:#ff6b6b;--dn:#6fcf8a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 "PingFang TC","Microsoft JhengHei",system-ui,sans-serif}
header.top{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--bd);padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header.top h1{font-size:17px;margin:0;margin-right:auto}
input[type=search]{padding:7px 10px;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--fg);min-width:220px;font:inherit}
button{border:1px solid var(--bd);background:var(--bg);color:var(--fg);border-radius:8px;padding:6px 10px;cursor:pointer;font:inherit}
.layout{max-width:1180px;margin:0 auto;padding:16px;display:grid;grid-template-columns:200px 1fr;gap:24px}
nav.toc{position:sticky;top:64px;align-self:start;max-height:calc(100vh - 80px);overflow:auto;font-size:13px}
nav.toc a{display:block;padding:4px 8px;color:var(--mut);text-decoration:none;border-left:2px solid var(--bd)}
nav.toc a:hover{color:var(--ac);border-color:var(--ac)}
section{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:8px 20px 16px;margin-bottom:18px}
h2{font-size:18px;margin:14px 0 8px}h3{font-size:15px;margin:16px 0 6px}
.title{font-size:22px}
.note,.muted{color:var(--mut);font-size:13px}
details.grp{border:1px solid var(--bd);border-radius:10px;margin:8px 0;background:var(--bg)}
details.grp.new{border-color:var(--ac);background:var(--acbg)}
details.grp summary{cursor:pointer;padding:8px 14px;font-weight:600}
details.grp ol{margin:0;padding:0 18px 10px 36px}
li{margin:5px 0}
.tag{background:var(--ac);color:#fff;border-radius:4px;padding:0 6px;margin-right:6px;font-size:12px}
.tablewrap{overflow:auto;margin:8px 0}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{border-bottom:1px solid var(--bd);padding:7px 10px;text-align:left;vertical-align:top}
th{position:sticky;top:0;background:var(--card);cursor:pointer;white-space:nowrap;user-select:none}
th.asc::after{content:" ▲"}th.desc::after{content:" ▼"}
tr:hover td{background:var(--acbg)}
mark{background:#ffe08a;color:#000;border-radius:3px}
.hide{display:none!important}
.kbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0}
.kbar select{padding:6px 8px;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
#kinfo{font-variant-numeric:tabular-nums}
.klegend{font-size:12.5px;margin:4px 0}.klegend i{display:inline-block;width:14px;height:3px;margin:0 4px 3px 10px;vertical-align:middle}
#kchart svg{width:100%;height:auto;display:block;touch-action:pan-y}
#kchart .empty{padding:28px 8px;color:var(--mut);text-align:center;border:1px dashed var(--bd);border-radius:10px}
@media (max-width:820px){.layout{grid-template-columns:1fr}nav.toc{display:none}section{padding:6px 12px 12px}}
"""

JS = """
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
// 表格排序：點表頭，數字欄依數值、其餘依文字
$$('table.sortable').forEach(t=>{
  $$('th',t).forEach((th,ci)=>th.addEventListener('click',()=>{
    const dir=th.classList.contains('asc')?'desc':'asc';
    $$('th',t).forEach(x=>x.classList.remove('asc','desc'));th.classList.add(dir);
    const rows=$$('tbody tr',t),num=rows.every(r=>r.cells[ci].dataset.k!==''||!r.cells[ci].textContent.trim());
    const val=r=>num?parseFloat(r.cells[ci].dataset.k)||-Infinity:r.cells[ci].textContent;
    rows.sort((a,b)=>{const x=val(a),y=val(b);return(x>y?1:x<y?-1:0)*(dir==='asc'?1:-1)});
    rows.forEach(r=>t.tBodies[0].appendChild(r));
  }));
});
// 全頁搜尋：代號、公司名、關鍵字
const q=$('#q');
function clearMarks(){$$('mark').forEach(m=>m.replaceWith(document.createTextNode(m.textContent)))}
function mark(el,re){const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);const hit=[];
  while(w.nextNode())if(re.test(w.currentNode.nodeValue))hit.push(w.currentNode);
  hit.forEach(n=>{const f=document.createDocumentFragment();
    n.nodeValue.split(re).forEach((s,i)=>{if(i%2){const m=document.createElement('mark');m.textContent=s;f.append(m)}else f.append(s)});
    n.replaceWith(f)})}
q.addEventListener('input',()=>{
  clearMarks();const v=q.value.trim();
  $$('.hide').forEach(e=>e.classList.remove('hide'));
  if(!v)return;
  const re=new RegExp('('+v.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')+')','i');
  $$('tbody tr, li').forEach(e=>{if(re.test(e.textContent))mark(e,re);else e.classList.add('hide')});
  $$('details.grp').forEach(d=>{const any=$$('li:not(.hide)',d).length>0;d.classList.toggle('hide',!any);d.open=any});
  $$('section').forEach(sc=>sc.classList.toggle('hide',!$('mark',sc)&&!re.test($('h2',sc).textContent)));
});
// K 線圖：SVG 自繪，紅漲綠跌（台股慣例），MA5/20/60 與成交量
const PRICES=__PRICES__,NAMES=__NAMES__;
(function(){
  const box=$('#kchart');if(!box)return;
  const codes=Object.keys(PRICES),sel=$('#kcode'),dsel=$('#kdays');
  if(!codes.length){box.innerHTML='<div class="empty">尚未載入股價資料。請在自己的電腦執行 <code>python3 stock-news/fetch_prices.py 6213</code>，再重新執行 <code>build.py</code>。</div>';sel.hidden=dsel.hidden=true;return}
  sel.innerHTML=codes.map(c=>`<option value="${c}">${c} ${NAMES[c]||''}</option>`).join('');
  const ma=(a,n)=>a.map((_,i)=>i<n-1?null:a.slice(i-n+1,i+1).reduce((s,x)=>s+x.c,0)/n);
  const f=(x,d=2)=>x==null?'—':x.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
  const fv=x=>x.toLocaleString('en-US');
  function draw(){
    const all=PRICES[sel.value],m5=ma(all,5),m20=ma(all,20),m60=ma(all,60);
    const n=Math.min(+dsel.value,all.length),off=all.length-n,rows=all.slice(off);
    const W=900,H=420,L=52,R=10,T=10,PH=290,VT=T+PH+14,VH=H-VT-18,cw=(W-L-R)/n,bw=Math.max(1,cw*0.65);
    const hi=Math.max(...rows.map(r=>r.h)),lo=Math.min(...rows.map(r=>r.l)),pad=(hi-lo)*0.05||1;
    const y=p=>T+PH*(1-(p-(lo-pad))/((hi+pad)-(lo-pad))),vmax=Math.max(...rows.map(r=>r.v))||1;
    const x=i=>L+cw*(i+0.5),up=getComputedStyle(document.documentElement).getPropertyValue("--up").trim(),dn=getComputedStyle(document.documentElement).getPropertyValue("--dn").trim();
    let s=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${sel.value} K 線圖">`;
    for(let k=0;k<=4;k++){const p=lo-pad+((hi+pad)-(lo-pad))*k/4,yy=y(p);
      s+=`<line x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}" stroke="currentColor" opacity=".12"/><text x="${L-6}" y="${yy+4}" text-anchor="end" font-size="11" fill="currentColor" opacity=".6">${f(p,p>=100?0:1)}</text>`}
    const step=Math.ceil(n/8);
    rows.forEach((r,i)=>{
      if(i%step===0)s+=`<text x="${x(i)}" y="${H-4}" text-anchor="middle" font-size="11" fill="currentColor" opacity=".6">${r.d.slice(5)}</text>`;
      const c=r.c>=r.o?up:dn;
      s+=`<line x1="${x(i)}" x2="${x(i)}" y1="${y(r.h)}" y2="${y(r.l)}" stroke="${c}"/><rect x="${x(i)-bw/2}" y="${Math.min(y(r.o),y(r.c))}" width="${bw}" height="${Math.max(1,Math.abs(y(r.o)-y(r.c)))}" fill="${c}"/>`;
      s+=`<rect x="${x(i)-bw/2}" y="${VT+VH*(1-r.v/vmax)}" width="${bw}" height="${VH*r.v/vmax}" fill="${c}" opacity=".55"/>`});
    [[m5,'#f59e0b'],[m20,'#3b82f6'],[m60,'#a855f7']].forEach(([a,col])=>{
      const d=rows.map((_,i)=>a[off+i]==null?null:`${x(i)},${y(a[off+i])}`).filter(Boolean).join(' ');
      if(d)s+=`<polyline points="${d}" fill="none" stroke="${col}" stroke-width="1.4"/>`});
    s+=`<line id="kx" y1="${T}" y2="${VT+VH}" stroke="currentColor" opacity=".4" visibility="hidden"/><rect id="khit" x="${L}" y="${T}" width="${W-L-R}" height="${H-T}" fill="transparent"/></svg>`;
    box.innerHTML=s;
    const svg=$('svg',box),line=$('#kx',box),info=$('#kinfo');
    const show=e=>{const b=svg.getBoundingClientRect(),px=((e.touches?e.touches[0].clientX:e.clientX)-b.left)/b.width*W;
      const i=Math.max(0,Math.min(n-1,Math.floor((px-L)/cw))),r=rows[i],pr=all[off+i-1];
      line.setAttribute('x1',x(i));line.setAttribute('x2',x(i));line.setAttribute('visibility','visible');
      const chg=pr?r.c-pr.c:null;
      info.textContent=`${r.d}　開 ${f(r.o)}　高 ${f(r.h)}　低 ${f(r.l)}　收 ${f(r.c)}${chg==null?'':`（${chg>=0?'+':''}${f(chg)}）`}　量 ${fv(r.v)} 張`};
    svg.addEventListener('mousemove',show);svg.addEventListener('touchmove',show,{passive:true});
    // 近 20 日表格
    const last=all.slice(-20).map((r,k,a)=>({r,pr:all[all.length-20+k-1],m:m20[all.length-20+k]})).reverse();
    $('#ktable').innerHTML='<table><thead><tr><th>日期</th><th>開</th><th>高</th><th>低</th><th>收</th><th>漲跌</th><th>量(張)</th><th>MA20</th></tr></thead><tbody>'+
      last.map(({r,pr,m})=>{const ch=pr?r.c-pr.c:null;return `<tr><td>${r.d}</td><td>${f(r.o)}</td><td>${f(r.h)}</td><td>${f(r.l)}</td><td>${f(r.c)}</td><td style="color:${ch>=0?up:dn}">${ch==null?'—':(ch>=0?'+':'')+f(ch)}</td><td>${fv(r.v)}</td><td>${f(m)}</td></tr>`}).join('')+'</tbody></table>';
    $('#knote').textContent=`資料來源：臺灣證券交易所個股日成交資訊，統計到 ${all[all.length-1].d}。均線用收盤價計算，沒有做除權息還原。`;
  }
  sel.onchange=dsel.onchange=draw;draw();
})();
// 深色模式切換
const root=document.documentElement;
$('#theme').addEventListener('click',()=>{
  const dark=getComputedStyle(root).getPropertyValue('--bg').trim()==='#14151a';
  root.dataset.theme=dark?'light':'dark';
});
$('#toggle').addEventListener('click',e=>{
  const ds=$$('details.grp'),open=!ds.every(d=>d.open);ds.forEach(d=>d.open=open);
});
"""


def main():
    md = SRC.read_text(encoding="utf-8")
    body, nav = render(convert(md))
    prices = load_prices()
    toc = "".join(f'<a href="#{sid}">{inline(t)[:22]}</a>' for sid, t in nav)
    page = f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>台股新聞彙整</title>
<style>{CSS}</style>
</head>
<body>
<header class="top">
  <h1>台股新聞彙整</h1>
  <input id="q" type="search" placeholder="搜尋代號、公司、關鍵字…">
  <button id="toggle" type="button">展開／收合重點</button>
  <button id="theme" type="button">深色／淺色</button>
</header>
<div class="layout">
<nav class="toc">{toc}</nav>
<main>
{body}
</main>
</div>
<script>{JS.replace("__PRICES__", json.dumps(prices, ensure_ascii=False, separators=(",", ":"))).replace("__NAMES__", json.dumps(NAMES, ensure_ascii=False))}</script>
</body>
</html>
"""
    OUT.write_text(page, encoding="utf-8")
    print(f"wrote {OUT} ({len(page):,} bytes, {len(nav)} sections)")


if __name__ == "__main__":
    main()
