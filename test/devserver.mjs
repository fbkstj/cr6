// 本機開發伺服器：node test/devserver.mjs [port]
// 不連任何雲端服務：API 用記憶體資料庫（重開就清空），網頁來自 docs/，
// 示範影片來自 test/out/demo_videos/（先執行 python test/make_demo_videos.py 產生）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../supabase/functions/api/core.js';
import { createMemDb } from './memdb.mjs';
import { createGemini } from '../supabase/functions/api/gemini.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const DEMO = path.join(ROOT, 'test', 'out', 'demo_videos');
const PORT = Number(process.argv[2]) || 8790;

const db = createMemDb();
await db.seedDemo({ judgeCount: 3, teams: 3, aiJudge: true });

// AI 評審：有 GEMINI_API_KEY 環境變數就用真的 Gemini（會花用額度），否則用模擬（隨機分數，標明是模擬）
const gemini = process.env.GEMINI_API_KEY
  ? createGemini({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || 'gemini-3.8-flash' })
  : mockGemini();
function mockGemini() {
  let n = 0;
  const ready = {};
  return {
    model: 'mock（模擬，不是真的 AI）',
    async uploadFromUrl() { const name = 'files/mock' + (++n); ready[name] = Date.now() + 3000; return { name, uri: 'mock://' + name, state: 'PROCESSING' }; },
    async getFile(name) { return { name, uri: 'mock://' + name, state: Date.now() >= ready[name] ? 'ACTIVE' : 'PROCESSING' }; },
    async deleteFile() {},
    // 背景評分：送出後約 6 秒完成
    jobs: {},
    async startJob(uri, prompt) {
      const maxes = [...prompt.matchAll(/（滿分 (\d+)）/g)].map(m => Number(m[1]));
      const items = maxes.map((max, i) => ({ no: i + 1, score: (n % 3 === 0 && i === 3) ? null : Math.round(max * (0.6 + Math.random() * 0.35)),
        reason: '（模擬）依影片內容評分', evidence: [{ time: '0:0' + (i + 1), note: '（模擬）示範片段' }] }));
      const id = 'mockjob' + n;
      this.jobs[id] = { at: Date.now() + 6000, text: JSON.stringify({ items, strengths: '（模擬）作品完整，操作展示清楚，說明有條理。', improvements: '（模擬）可以補充測試數據與對照組，並說明限制。' }) };
      return { id, status: 'in_progress', attempts: 1 };
    },
    async getJob(id) {
      const j = this.jobs[id];
      if (!j) { const e = new Error('查詢 AI 評分失敗（HTTP 404）'); e.status = 404; throw e; }
      return Date.now() < j.at ? { status: 'in_progress', text: '', usage: null, error: '' } : { status: 'completed', text: j.text, usage: { total_tokens: 0 }, error: '' };
    },
    async deleteJob(id) { delete this.jobs[id]; },
  };
}

const api = createApi({
  db,
  gemini,
  secret: 'devserver-secret-not-for-production-0123456789',
  siteBaseUrl: `http://localhost:${PORT}/`,
  fetchJson: async () => {
    for (const dir of [DEMO, path.join(DOCS, 'videos')]) {
      const f = path.join(dir, 'manifest.json');
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    }
    throw new Error('找不到 manifest.json，請先執行 python test/make_demo_videos.py');
  },
});

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

/** 靜態檔案，支援 Range（影片拖曳進度條需要） */
function sendFile(req, res, file) {
  const stat = fs.statSync(file);
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    let start = range[1] === '' ? stat.size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : stat.size - 1;
    end = Math.min(end, stat.size - 1);
    if (start > end || start < 0) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function resolveStatic(urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
  const candidates = rel.startsWith('videos/') ? [path.join(DEMO, rel.slice(7)), path.join(DOCS, rel)] : [path.join(DOCS, rel)];
  for (const f of candidates) {
    const full = path.resolve(f);
    if (!full.startsWith(DOCS) && !full.startsWith(DEMO)) continue;   // 不允許 ../ 跳出資料夾
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    if (fs.existsSync(full) && fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'index.html'))) return path.join(full, 'index.html');
  }
  return null;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/api' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      let out;
      try { out = await api.handle(JSON.parse(body)); } catch (e) { out = { ok: false, error: '請求格式錯誤' }; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end("window.CONTEST_CONFIG = { apiUrl: '/api', dev: true };\n");
  }
  const file = resolveStatic(url.pathname);
  if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('找不到 ' + url.pathname); }
  sendFile(req, res, file);
}).listen(PORT, () => {
  console.log(`本機開發伺服器：http://localhost:${PORT}/`);
  console.log('測試帳號（合成資料，重開伺服器就還原）：admin01 / admin-pass-01；judge01～judge05 / judge-pass-01～05（評審 3 人＋AI）');
  console.log('AI 評審：' + (process.env.GEMINI_API_KEY ? '真的 Gemini（' + gemini.model + '）' : '模擬（設定 GEMINI_API_KEY 環境變數才會呼叫真的 Gemini）'));
  if (!fs.existsSync(path.join(DEMO, 'manifest.json'))) console.log('尚未產生示範影片：python test/make_demo_videos.py');
});
