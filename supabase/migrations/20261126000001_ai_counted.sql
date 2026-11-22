-- AI 分數照樣匯入保存，是否「計入平均」在結算頁決定（可隨時勾選或取消，公布後要先撤回）。
-- ai_counted＝true：AI 席位算進平均、要收齊；false：AI 席位的分數只留著當參考，不計入平均、不影響收齊與公布。
alter table competitions add column if not exists ai_counted boolean not null default true;

/** 計入平均的總份數：老師人數＋（有 AI 評審且勾選計入 ? 1 : 0）。排名、收齊、公布都用這個數字 */
create or replace function seat_count(c competitions) returns int
language sql immutable as $$ select c.judge_count + case when c.ai_judge and c.ai_counted then 1 else 0 end $$;
