// AI 評分（在主辦方電腦上執行）：node tools/ai_score.mjs [team01 team02 …｜--all] [選項]
//
// 為什麼要在電腦上跑：Supabase Edge Function 一次請求最多約 150 秒，Gemini 看完影片寫評分常常超過；
// 背景執行在免費方案又不穩。這支程式在你的電腦上直接等 Gemini 寫完（沒有時間限制），
// 結果送回評分系統，由伺服器用和後台一樣的規則驗證、送出到 AI 評審席位（評審 N＋1）。
//
// 執行時會詢問：主辦人員帳號密碼、Gemini API 金鑰（輸入時不會顯示，也不會存進任何檔案）。
//
// 選項：
//   --all             評所有「還沒有 AI 評分」的作品（不含需要處理、進行中的）
//   --rerun           已經有 AI 評分的作品也重新評（新結果驗證通過才取代舊的）
//   --model 名稱      Gemini 模型，預設 gemini-3.8-flash
//   --api 網址        評分系統 API，預設讀 docs/config.js
//   --site 網址       影片網站，本機找不到影片檔時從這裡下載，預設 https://fbkstj.github.io/cr6/docs/
//   --fake            不呼叫 Gemini，用模擬結果（測試用，搭配 node test/devserver.mjs）
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createGemini } from '../supabase/functions/api/gemini.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

/* ───── 參數 ───── */
const argv = process.argv.slice(2);
const opt = { all: false, rerun: false, fake: false, model: 'gemini-3.8-flash', api: '', site: 'https://fbkstj.github.io/cr6/docs/', teams: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--all') opt.all = true;
  else if (a === '--rerun') opt.rerun = true;
  else if (a === '--fake') opt.fake = true;
  else if (a === '--model') opt.model = argv[++i];
  else if (a === '--api') opt.api = argv[++i];
  else if (a === '--site') opt.site = argv[++i];
  else if (/^team\d{2}$/i.test(a)) opt.teams.push(a.toLowerCase());
  else { console.error('看不懂的參數：' + a + '\n用法：node tools/ai_score.mjs team01 team02 … 或 --all（見檔案開頭說明）'); process.exit(2); }
}
if (!opt.all && !opt.teams.length) { console.error('請指定組別（例如 team01）或 --all'); process.exit(2); }
if (!opt.api) {
  const cfg = fs.readFileSync(path.join(DOCS, 'config.js'), 'utf8');
  const m = /apiUrl\s*:\s*['"]([^'"]+)['"]/.exec(cfg);
  if (!m) { console.error('docs/config.js 裡找不到 apiUrl，請用 --api 指定'); process.exit(2); }
  opt.api = m[1];
}

/* ───── 輸入（密碼與金鑰不顯示、不存檔） ───── */
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

/* ───── 模擬 Gemini（--fake） ───── */
function fakeGemini() {
  return {
    model: 'fake（模擬）',
    async uploadBytes(bytes) { return { name: 'files/fake', uri: 'fake://video', state: 'ACTIVE', size: bytes.length }; },
    async getFile(name) { return { name, uri: 'fake://video', state: 'ACTIVE' }; },
    async deleteFile() {},
    async generate(uri, prompt) {
      const maxes = [...prompt.matchAll(/（滿分 (\d+)）/g)].map(m => Number(m[1]));
      const items = maxes.map((max, i) => ({ no: i + 1, score: Math.round(max * 0.8), reason: '（模擬）依影片內容評分', evidence: [{ time: '0:0' + (i + 1), note: '（模擬）' }] }));
      return { text: JSON.stringify({ items, strengths: '（模擬）作品完整，操作展示清楚，說明有條理。', improvements: '（模擬）可以補充測試數據與對照組，並說明限制。' }),
        usage: { totalTokens: 0 }, finishReason: 'STOP', attempts: 1 };
    },
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = () => Date.now();
const secs = since => Math.round((Date.now() - since) / 1000);

async function loadVideo(p) {
  const local = path.join(DOCS, p);
  if (fs.existsSync(local)) return new Uint8Array(fs.readFileSync(local));
  const url = opt.site.replace(/\/?$/, '/') + p;
  console.log(`   本機沒有 ${p}，從網站下載…`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下載影片失敗（HTTP ${r.status}）：${url}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** 評一件：建立紀錄 → 上傳影片 → 等處理 → 請 AI 評分（等它寫完）→ 送回伺服器驗證 */
async function scoreOne(g, teamId, code) {
  const started = t0();
  let b;
  try { b = await api('adminAiLocalBegin', teamId, opt.rerun, g.model); } catch (e) { return { status: 'failed', error: e.message }; }
  let file = null;
  try {
    const bytes = await loadVideo(b.video.path);
    console.log(`   上傳影片 ${b.video.path}（${(bytes.length / 1048576).toFixed(1)} MB）…`);
    file = await g.uploadBytes(bytes, `${code}_v${b.video.versionNo}`, 10 * 60 * 1000);
    for (let i = 0; file.state !== 'ACTIVE'; i++) {
      if (file.state === 'FAILED') throw new Error('Gemini 無法處理這支影片' + (file.error ? '：' + file.error : ''));
      if (i > 120) throw new Error('Gemini 處理影片超過 10 分鐘');
      await sleep(5000);
      file = Object.assign(file, await g.getFile(file.name));
    }
    console.log(`   影片處理好了，請 AI 評分（可能要幾分鐘）…`);
    const genStart = t0();
    const out = await g.generate(file.uri, b.prompt);
    const usage = Object.assign({}, out.usage, { attempts: out.attempts, seconds: secs(genStart), totalSeconds: secs(started) });
    if (!out.text) {
      const why = out.blocked ? `內容被 Gemini 擋下（${out.blocked}）` : `AI 沒有回傳內容（${out.finishReason || '原因不明'}）`;
      return await api('adminAiLocalFinish', b.runId, { error: why, usage });
    }
    return await api('adminAiLocalFinish', b.runId, { text: out.text, usage });
  } catch (e) {
    const msg = String(e && e.message || e);
    try { return await api('adminAiLocalFinish', b.runId, { error: msg.slice(0, 500), usage: { totalSeconds: secs(started) } }); }
    catch (e2) { return { status: 'failed', error: msg }; }
  } finally {
    if (file && file.name) await g.deleteFile(file.name);
  }
}

/* ───── 主程式 ───── */
console.log(`評分系統：${opt.api}`);
const loginId = (await ask('主辦人員帳號（直接按 Enter＝admin01）：')) || 'admin01';
const password = await ask('密碼（輸入時不會顯示）：', true);
token = (await api('login', loginId, password)).token;
if (!token) { console.error('登入失敗'); process.exit(1); }
const me = await api('me');
if (me.role !== 'admin') { console.error('這個帳號不是主辦人員'); process.exit(1); }

let g;
if (opt.fake) g = fakeGemini();
else {
  const key = process.env.GEMINI_API_KEY || await ask('Gemini API 金鑰（輸入時不會顯示，不會存檔）：', true);
  if (!key) { console.error('沒有輸入金鑰'); process.exit(1); }
  g = createGemini({ apiKey: key, model: opt.model });
}

const ov = await api('adminAiOverview');
if (!ov.enabled) { console.error('這個競賽沒有開啟 AI 評審'); process.exit(1); }
if (!['judging', 'settling'].includes(ov.phase)) { console.error(`目前是「${ov.phaseLabel}」階段，只有評分或結算階段可以執行 AI 評分`); process.exit(1); }
const active = r => r.run && ['uploading', 'processing', 'generating', 'finishing'].includes(r.run.status);
let rows;
if (opt.all) rows = ov.rows.filter(r => (opt.rerun || r.score.status !== 'submitted') && !active(r) && !(r.run && r.run.status === 'needs_review'));
else {
  rows = opt.teams.map(code => ov.rows.find(r => r.code === code) || code);
  const missing = rows.filter(r => typeof r === 'string');
  if (missing.length) { console.error('不在評分名單中：' + missing.join('、')); process.exit(1); }
}
console.log(`模型：${g.model}；要評 ${rows.length} 件：${rows.map(r => r.code).join('、') || '（沒有）'}\n`);

const summary = [];
for (const r of rows) {
  console.log(`▶ ${r.code} ${r.name}（${r.workTitle}）`);
  const res = await scoreOne(g, r.teamId, r.code);
  const total = res && res.result && res.status === 'done' ? Object.values(res.result.items).reduce((s, x) => s + x, 0) : null;
  const line = res.status === 'done' ? `✓ 完成，總分 ${total}`
    : res.status === 'needs_review' ? `△ 需要處理：${(res.problems || []).join('；')}`
    : `✗ 失敗：${res.error || res.status}`;
  console.log('   ' + line + (res.usage && res.usage.seconds ? `（AI 花了 ${res.usage.seconds} 秒）` : '') + '\n');
  summary.push(`${r.code}　${line}`);
}
console.log('──────── 結果 ────────\n' + (summary.join('\n') || '沒有要評的作品'));
console.log('\n到後台「AI 評分」分頁可以看詳情；「需要處理」的作品可以重新執行或補分。');
