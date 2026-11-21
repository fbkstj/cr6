-- P7 修正：AI 評分改成非同步（Gemini Interactions API 的背景執行）
-- 原因：同步呼叫 generateContent 會超過 Edge Function 的時間上限（免費方案約 150 秒，2026-11-22 實測 HTTP 546）。
-- 做法：送出評分後立刻回應，記下 Gemini 的 interaction id，後台每幾秒查一次結果。

alter table ai_runs add column if not exists gemini_job text;   -- Gemini interaction id（背景執行）

-- 新狀態 finishing：拿到結果、正在寫入評分（避免兩個查詢同時寫兩次）
alter table ai_runs drop constraint if exists ai_runs_status_check;
alter table ai_runs add constraint ai_runs_status_check
  check (status in ('uploading', 'processing', 'generating', 'finishing', 'done', 'needs_review', 'finalized', 'failed'));
