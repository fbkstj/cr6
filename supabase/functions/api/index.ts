// Supabase Edge Function：專題競賽評分系統的 API
// 前端用 POST {fn, args} 呼叫，Content-Type 用 text/plain 避免 CORS 預檢（同重補修 supabase 版）。
// GET 只回 alive，給測試用。
import { createApi } from './core.js';
import { createDb } from './db_supabase.js';

const db = createDb(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const api = createApi({ db, secret: Deno.env.get('TOKEN_SECRET') || '', siteBaseUrl: Deno.env.get('SITE_BASE_URL') || '' });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: true, result: 'alive' });
  let body: unknown = null;
  try { body = JSON.parse(await req.text()); } catch (_e) { return json({ ok: false, error: '請求格式錯誤' }, 400); }
  return json(await api.handle(body as { fn: string; args: unknown[] }));
});
