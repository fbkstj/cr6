-- AI 評分「暫存」：外部 AI 評好的分數先存起來給主辦人員看，不計入平均，按「採用」後才寫進 AI 評審席位。
alter table ai_runs drop constraint if exists ai_runs_status_check;
alter table ai_runs add constraint ai_runs_status_check
  check (status in ('uploading', 'processing', 'generating', 'finishing', 'done', 'needs_review', 'finalized', 'failed', 'draft'));
