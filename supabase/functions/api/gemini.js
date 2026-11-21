// Gemini API 的最小用戶端（REST，不用 SDK）：上傳影片到 Files API、查檔案狀態、送出背景評分、查結果、刪除。
// 純 JS，Deno（Edge Function）與 Node 都能跑；測試時 core.js 會換成假的用戶端，不會真的呼叫 Google。
// 金鑰只從環境變數（Supabase secrets）讀進來，不寫進任何檔案或紀錄。

const BASE = 'https://generativelanguage.googleapis.com';

// 評分用 Interactions API 的背景執行（非同步）：送出後立刻回應，之後再查結果，不受 Edge Function 時間上限影響。
// 送出時遇到模型忙碌（503）、次數暫時用完（429）、伺服器錯誤（500）會自動重試。
const API_REVISION = '2026-05-20';
const RETRY_STATUS = [429, 500, 503];
const RETRY_DELAYS = [3000, 8000];           // 第 2、3 次之前各等多久
const START_BUDGET_MS = 60000;                // 送出（含重試）最多花多久

export function createGemini({ apiKey, model, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), clock = () => Date.now() }) {
  if (!apiKey) throw new Error('沒有設定 GEMINI_API_KEY');
  const headers = extra => Object.assign({ 'x-goog-api-key': apiKey }, extra || {});

  async function check(r, what) {
    if (r.ok) return r;
    let msg = '';
    try { const j = await r.json(); msg = (j && j.error && j.error.message) || ''; } catch (e) { /* 忽略 */ }
    const err = new Error(`${what}失敗（HTTP ${r.status}）${msg ? '：' + msg.slice(0, 300) : ''}`);
    err.status = r.status;
    throw err;
  }

  return {
    model,

    /** 從網址下載影片並上傳到 Gemini Files API（resumable：start → upload, finalize） */
    async uploadFromUrl(videoUrl, displayName) {
      const v = await check(await fetchImpl(videoUrl, { signal: AbortSignal.timeout(60000) }), '下載影片');
      const bytes = new Uint8Array(await v.arrayBuffer());
      const start = await check(await fetchImpl(`${BASE}/upload/v1beta/files`, {
        method: 'POST',
        headers: headers({
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(bytes.length),
          'X-Goog-Upload-Header-Content-Type': 'video/mp4',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ file: { display_name: displayName } }),
        signal: AbortSignal.timeout(30000),
      }), '開始上傳');
      const uploadUrl = start.headers.get('x-goog-upload-url');
      if (!uploadUrl) throw new Error('Gemini 沒有回傳上傳網址');
      const up = await check(await fetchImpl(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Length': String(bytes.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
        body: bytes,
        signal: AbortSignal.timeout(110000),
      }), '上傳影片');
      const j = await up.json();
      const f = j.file || j;
      return { name: f.name, uri: f.uri, state: f.state || 'PROCESSING', size: bytes.length };
    },

    /** 查檔案狀態：PROCESSING／ACTIVE／FAILED */
    async getFile(name) {
      const r = await check(await fetchImpl(`${BASE}/v1beta/${name}`, { headers: headers(), signal: AbortSignal.timeout(20000) }), '查詢影片狀態');
      const f = await r.json();
      return { name: f.name, uri: f.uri, state: f.state, error: f.error ? f.error.message : '' };
    },

    async deleteFile(name) {
      try { await fetchImpl(`${BASE}/v1beta/${name}`, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(20000) }); } catch (e) { /* 48 小時後也會自動刪除 */ }
    },

    /**
     * 送出背景評分（Interactions API，background: true），立刻回傳 {id, status, attempts}；
     * 之後用 getJob(id) 查結果。忙碌（429／500／503）時自動重試，整個呼叫控制在 START_BUDGET_MS 內。
     */
    async startJob(fileUri, prompt) {
      const start = clock();
      const body = JSON.stringify({
        model,
        input: [{ type: 'video', uri: fileUri, mime_type: 'video/mp4' }, { type: 'text', text: prompt }],   // 文字要放在影片後面
        background: true,
        store: true,
      });
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await check(await fetchImpl(`${BASE}/v1beta/interactions`, {
            method: 'POST', headers: headers({ 'Content-Type': 'application/json', 'Api-Revision': API_REVISION }), body, signal: AbortSignal.timeout(30000),
          }), '送出 AI 評分');
          const j = await r.json();
          if (!j.id) throw new Error('Gemini 沒有回傳評分工作編號');
          return { id: j.id, status: j.status || 'in_progress', attempts: attempt };
        } catch (e) {
          const delay = RETRY_DELAYS[attempt - 1];
          if (!RETRY_STATUS.includes(e.status) || delay === undefined || START_BUDGET_MS - (clock() - start) - delay < 30000) {
            if (attempt > 1) e.message += `（已自動重試，共 ${attempt} 次）`;
            throw e;
          }
          await sleep(delay);
        }
      }
    },

    /** 查背景評分：{status: in_progress／completed／failed／cancelled／requires_action, text, usage, error} */
    async getJob(id) {
      const r = await check(await fetchImpl(`${BASE}/v1beta/interactions/${encodeURIComponent(id)}`, {
        headers: headers({ 'Api-Revision': API_REVISION }), signal: AbortSignal.timeout(20000),
      }), '查詢 AI 評分');
      const j = await r.json();
      const done = j.status && j.status !== 'in_progress';
      return { status: j.status || '', text: interactionText(j), usage: j.usage || j.usageMetadata || j.usage_metadata || null,
        error: interactionError(j),
        raw: done && j.status !== 'completed' ? JSON.stringify(j).slice(0, 4000) : '' };   // 失敗時保留原始回應，方便找原因
    },

    async deleteJob(id) {
      try { await fetchImpl(`${BASE}/v1beta/interactions/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers({ 'Api-Revision': API_REVISION }), signal: AbortSignal.timeout(20000) }); } catch (e) { /* 免費方案 1 天後也會自動刪除 */ }
    },
  };
}

/** 錯誤原因：實測（2026-11-22）Google 放在 errors: [{code, message}]，也接受 error: {message} */
const ERROR_HINT = { RESOURCE_EXHAUSTED: '額度不足（免費方案沒有這個模型的額度，或今天的額度用完了；開通付費或換模型）' };
export function interactionError(j) {
  const list = Array.isArray(j && j.errors) ? j.errors : j && j.error ? [j.error] : [];
  return list.map(e => {
    if (!e || typeof e !== 'object') return String(e || '');
    const code = e.code ? String(e.code) : '';
    return [ERROR_HINT[code] || code, e.message ? String(e.message) : ''].filter(Boolean).join('：');
  }).filter(Boolean).join('；').slice(0, 400);
}

/** 從 interaction 取出模型輸出的文字（文件的範例有 output_text、steps[].content[].text、outputs[].text 幾種寫法，都接受；略過 thought） */
export function interactionText(j) {
  if (!j || typeof j !== 'object') return '';
  if (typeof j.output_text === 'string') return j.output_text;
  if (typeof j.outputText === 'string') return j.outputText;
  const texts = [];
  for (const s of Array.isArray(j.steps) ? j.steps : []) {
    if (!s || (s.type && !/output/i.test(s.type))) continue;
    for (const c of Array.isArray(s.content) ? s.content : []) if (c && typeof c.text === 'string' && (!c.type || c.type === 'text')) texts.push(c.text);
  }
  if (!texts.length) for (const o of Array.isArray(j.outputs) ? j.outputs : []) if (o && o.type === 'text' && typeof o.text === 'string') texts.push(o.text);
  return texts.join('');
}
