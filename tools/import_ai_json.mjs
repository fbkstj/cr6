// 匯入 AI 評分 JSON：node tools/import_ai_json.mjs [team01 team02 …｜--all] [選項]
//
// 用途：AI 評分不是由程式呼叫 Gemini 得到，而是人工（或別的工具）產出後存成檔案，
// 例如 AI評分結果/team01.json。這支程式把檔案送進評分系統，伺服器用和後台一樣的規則
// 驗證（分數整數、不超過滿分、時間點在影片長度內、評語字數），通過就送出到 AI 評審席位。
//
// 檔案格式（和 AI 評分的規定格式相同）：
//   {"items":[{"no":1,"score":整數,"reason":"理由","evidence":[{"time":"分:秒","note":"說明"}]}, …],
//    "strengths":"作品優點","improvements":"改進建議"}
// 檔案裡以底線開頭的欄位（例如 _source）只是備註，會被忽略。
//
// 執行時會詢問主辦人員帳號與密碼（輸入時不會顯示，也不會存進任何檔案），並先列出要匯入的內容、
// 等你輸入 y 才會寫入。
//
// 選項：
//   --all             匯入資料夾裡所有 teamXX.json
//   --dir 資料夾      預設 AI評分結果
//   --rerun           已經有 AI 評分的作品也重新匯入（新結果驗證通過才取代舊的，舊的留在更正歷程）
//   --label 名稱      記在 AI 評分紀錄的「模型」欄位，預設「人工匯入」
//   --draft           只暫存（不計入平均），到後台「AI 評分」分頁看過再按「採用」
//   --yes             不再詢問，直接寫入（演練時用）
//   --api 網址        評分系統 API，預設讀 docs/config.js
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───── 參數 ───── */
const argv = process.argv.slice(2);
const opt = { all: false, rerun: false, draft: false, yes: false, dir: 'AI評分結果', label: '人工匯入', api: '', teams: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--all') opt.all = true;
  else if (a === '--rerun') opt.rerun = true;
  else if (a === '--draft') opt.draft = true;
  else if (a === '--yes') opt.yes = true;
  else if (a === '--dir') opt.dir = argv[++i];
  else if (a === '--label') opt.label = argv[++i];
  else if (a === '--api') opt.api = argv[++i];
  else if (/^team\d{2}$/i.test(a)) opt.teams.push(a.toLowerCase());
  else { console.error('看不懂的參數：' + a + '\n用法：node tools/import_ai_json.mjs team01 team02 … 或 --all（見檔案開頭說明）'); process.exit(2); }
}
if (!opt.all && !opt.teams.length) { console.error('請指定組別（例如 team01）或 --all'); process.exit(2); }
if (!opt.api) {
  const cfg = fs.readFileSync(path.join(ROOT, 'docs', 'config.js'), 'utf8');
  const m = /apiUrl\s*:\s*['"]([^'"]+)['"]/.exec(cfg);
  if (!m) { console.error('docs/config.js 裡找不到 apiUrl，請用 --api 指定'); process.exit(2); }
  opt.api = m[1];
}
const dir = path.isAbsolute(opt.dir) ? opt.dir : path.join(ROOT, opt.dir);

/* ───── 讀檔（先在本機檢查格式，伺服器還會再驗證一次） ───── */
const codes = opt.all
  ? (fs.existsSync(dir) ? fs.readdirSync(dir).map(f => /^(team\d{2})\.json$/i.exec(f)).filter(Boolean).map(m => m[1].toLowerCase()).sort() : [])
  : opt.teams;
if (!codes.length) { console.error(`在 ${dir} 找不到 teamXX.json`); process.exit(1); }

const files = [];   // { code, text, items:[分數], total, problems:[] }
for (const code of codes) {
  const p = path.join(dir, code + '.json');
  const f = { code, problems: [] };
  if (!fs.existsSync(p)) { f.problems.push('找不到檔案 ' + p); files.push(f); continue; }
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (e) { f.problems.push('不是正確的 JSON：' + e.message); files.push(f); continue; }
  if (!j || !Array.isArray(j.items)) { f.problems.push('缺少 items 陣列'); files.push(f); continue; }
  for (const k of Object.keys(j)) if (k.startsWith('_')) delete j[k];
  f.scores = j.items.map(x => (x && Number.isInteger(x.score)) ? x.score : null);
  if (f.scores.some(s => s === null)) f.problems.push('有項目的分數不是整數');
  f.total = f.scores.reduce((a, b) => a + (b || 0), 0);
  f.strengths = String(j.strengths || '');
  f.improvements = String(j.improvements || '');
  f.text = JSON.stringify(j);
  files.push(f);
}

/* ───── 輸入（密碼不顯示、不存檔） ───── */
let pipedLines = null;
async function ask(question, hidden) {
  if (!process.stdin.isTTY) {   // 測試時可以用管線輸入
    if (!pipedLines) pipedLines = (async function* () { for await (const l of readline.createInterface({ input: process.stdin })) yield l; })();
    process.stdout.write(question + (hidden ? '（已輸入）\n' : ''));
    const { value } = await pipedLines.next();
    if (!hidden) process.stdout.write((value || '') + '\n');
    return String(value || '').trim();
  }
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = s => { if (!muted) process.stdout.write(s); };
    rl.question(question, answer => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
    muted = !!hidden;
  });
}

/* ───── 評分系統 API ───── */
let token = '';
async function api(fn, ...args) {
  const r = await fetch(opt.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ fn, args: token ? [token, ...args] : args }) });
  const j = await r.json();
  if (!j.ok) throw new Error(String(j.error || '發生錯誤').replace(/^AUTH:/, ''));
  return j.result;
}

/* ───── 主程式 ───── */
console.log(`評分系統：${opt.api}`);
const loginId = (await ask('主辦人員帳號（直接按 Enter＝admin01）：')) || 'admin01';
const password = await ask('密碼（輸入時不會顯示）：', true);
token = (await api('login', loginId, password)).token;
if (!token) { console.error('登入失敗'); process.exit(1); }
const me = await api('me');
if (me.role !== 'admin') { console.error('這個帳號不是主辦人員'); process.exit(1); }

const ov = await api('adminAiOverview');
if (!ov.enabled) { console.error('這個競賽沒有開啟 AI 評審'); process.exit(1); }
if (!['judging', 'settling'].includes(ov.phase)) { console.error(`目前是「${ov.phaseLabel}」階段，只有評分或結算階段可以匯入 AI 評分`); process.exit(1); }

console.log('\n要匯入的內容：');
const todo = [];
for (const f of files) {
  const row = ov.rows.find(r => r.code === f.code);
  let note = f.problems.join('；');
  if (!note && !row) note = '不在評分名單中';
  if (!note && row.score.status === 'submitted' && !opt.rerun) note = '已經有 AI 評分（要取代請加 --rerun）';
  if (!note && row.run && ['uploading', 'processing', 'generating', 'finishing'].includes(row.run.status)) note = 'AI 評分進行中';
  if (note) console.log(`  ✗ ${f.code}　略過：${note}`);
  else { console.log(`  ✓ ${f.code}　${row.name}（${row.workTitle}）　${f.scores.join('／')}　合計 ${f.total}`); todo.push({ f, row }); }
}
if (!todo.length) { console.log('\n沒有可以匯入的檔案。'); process.exit(0); }
if (!opt.yes) {
  const yn = await ask(`\n確定${opt.draft ? '暫存' : '匯入'}以上 ${todo.length} 件${opt.draft ? '（不計入平均，之後在後台按「採用」）' : '到 AI 評審席位'}嗎？（輸入 y 確定，其他任何輸入都取消）：`);
  if (yn.toLowerCase() !== 'y') { console.log('已取消，沒有寫入任何資料。'); process.exit(0); }
}

const summary = [];
for (const { f, row } of todo) {
  let line;
  try {
    const b = await api('adminAiLocalBegin', row.teamId, opt.rerun, opt.label);
    const res = await api('adminAiLocalFinish', b.runId, { text: f.text, usage: {}, draft: opt.draft });
    if (res.status === 'draft') line = `✓ 已暫存，合計 ${Object.values(res.result.items).reduce((s, x) => s + x, 0)}（尚未計入平均，到後台按「採用」）`;
    else if (res.status === 'done') line = `✓ 完成，總分 ${Object.values(res.result.items).reduce((s, x) => s + x, 0)}`;
    else if (res.status === 'needs_review') line = `△ 需要處理：${(res.problems || []).join('；')}`;
    else line = `✗ 失敗：${res.error || res.status}`;
  } catch (e) { line = `✗ 失敗：${e.message}`; }
  console.log(`${f.code}　${line}`);
  summary.push(`${f.code}　${line}`);
}
console.log('\n──────── 結果 ────────\n' + summary.join('\n'));
console.log('\n到後台「AI 評分」分頁可以看詳情；「需要處理」的作品可以修改檔案後用 --rerun 重新匯入，或在後台補分。');
