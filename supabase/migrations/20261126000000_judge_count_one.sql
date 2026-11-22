-- 老師評審人數可以選 1、3、5 位（原本只有 3、5）；AI 評審仍是另外加一席，可勾選要不要加入。
alter table competitions drop constraint if exists competitions_judge_count_check;
alter table competitions add constraint competitions_judge_count_check check (judge_count in (1, 3, 5));
