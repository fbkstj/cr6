// Gemini API 的最小用戶端（REST，不用 SDK）：上傳影片到 Files API、查檔案狀態、請模型評分、刪除檔案。
// 純 JS，Deno（Edge Function）與 Node 都能跑；測試時 core.js 會換成假的用戶端，不會真的呼叫 Google。
// 金鑰只從環境變數（Supabase secrets）讀進來，不寫進任何檔案或紀錄。

const BASE = 'https://generativelanguage.googleapis.com';

// 模型忙碌（503）、次數暫時用完（429）、伺服器錯誤（500）時自動重試；整個評分請求要在 Edge Function 的時間內結束
const RETRY_STATUS = [429, 500, 503];
const RETRY_DELAYS = [4000, 10000];          // 第 2、3 次之前各等多久
const GENERATE_BUDGET_MS = 140000;            // 一次評分請求（含重試）最多花多久
const MIN_ATTEMPT_MS = 25000;                 // 剩下的時間不夠一次嘗試就不再重試

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

    /** 影片＋文字提示，要求回傳 JSON；回傳 {text, usage, finishReason, attempts}。忙碌時自動重試（最多 3 次） */
    async generate(fileUri, prompt) {
      const start = clock();
      const body = JSON.stringify({
        contents: [{ role: 'user', parts: [{ file_data: { mime_type: 'video/mp4', file_uri: fileUri } }, { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      });
      for (let attempt = 1; ; attempt++) {
        const left = GENERATE_BUDGET_MS - (clock() - start);
        try {
          const r = await check(await fetchImpl(`${BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body, signal: AbortSignal.timeout(Math.max(5000, left)),
          }), 'AI 評分');
          const j = await r.json();
          const cand = (j.candidates || [])[0] || {};
          const text = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
          return { text, usage: j.usageMetadata || null, finishReason: cand.finishReason || '', attempts: attempt };
        } catch (e) {
          const delay = RETRY_DELAYS[attempt - 1];
          const retryable = RETRY_STATUS.includes(e.status);
          if (!retryable || delay === undefined || GENERATE_BUDGET_MS - (clock() - start) - delay < MIN_ATTEMPT_MS) {
            if (attempt > 1) e.message += `（已自動重試，共 ${attempt} 次）`;
            throw e;
          }
          await sleep(delay);
        }
      }
    },
  };
}
