-- 評語最多字數可設定（優點、改進建議各自）；預設 300，範圍 30～2000，且不能少於最少字數
alter table competitions add column if not exists max_comment_chars int not null default 300;
alter table competitions drop constraint if exists competitions_max_comment_chars_check;
alter table competitions add constraint competitions_max_comment_chars_check
  check (max_comment_chars between 30 and 2000 and max_comment_chars >= min_comment_chars);

create or replace function judge_save(p_team uuid, p_account uuid, p_items jsonb, p_strengths text,
                                      p_improvements text, p_submit boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  rub uuid; c record; slot int; lock_ver uuid; s record; it record;
  clean jsonb := '{}'::jsonb; v jsonb; n_items int; n_filled int := 0; tot int := 0; prev_returned boolean;
begin
  select co.* into c from competitions co join accounts a on a.competition_id = co.id where a.id = p_account for update of co;
  if not found then raise exception '找不到帳號'; end if;
  if c.phase not in ('judging', 'settling') then raise exception '目前不是評分階段'; end if;
  select slot_no into slot from judge_slots where competition_id = c.id and account_id = p_account;
  if slot is null then raise exception '你目前沒有被指派評審席位'; end if;
  select jl.version_id into lock_ver from judging_locks jl join teams t on t.id = jl.team_id
    where jl.team_id = p_team and t.competition_id = c.id;
  if lock_ver is null then raise exception '這件作品不在評分名單中'; end if;
  rub := team_rubric(p_team);
  if jsonb_typeof(coalesce(p_items, '{}'::jsonb)) <> 'object' then raise exception '分數格式錯誤'; end if;

  -- 只接受評分表上的項目，每項是 0～滿分的整數
  if exists (select 1 from jsonb_object_keys(coalesce(p_items, '{}'::jsonb)) k
             where k not in (select id::text from rubric_items where rubric_id = rub)) then
    raise exception '分數裡有不在評分表上的項目';
  end if;
  select count(*) into n_items from rubric_items where rubric_id = rub;
  for it in select id, title, max_score from rubric_items where rubric_id = rub order by sort loop
    v := p_items -> it.id::text;
    if v is null or v = 'null'::jsonb then continue; end if;
    if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) then
      raise exception '「%」的分數要是整數', it.title;
    end if;
    if (v #>> '{}')::int < 0 or (v #>> '{}')::int > it.max_score then
      raise exception '「%」的分數要在 0～% 之間', it.title, it.max_score;
    end if;
    clean := clean || jsonb_build_object(it.id::text, (v #>> '{}')::int);
    tot := tot + (v #>> '{}')::int;
    n_filled := n_filled + 1;
  end loop;

  p_strengths := trim(coalesce(p_strengths, ''));
  p_improvements := trim(coalesce(p_improvements, ''));
  if char_length(p_strengths) > c.max_comment_chars or char_length(p_improvements) > c.max_comment_chars then
    raise exception '評語最多 % 字', c.max_comment_chars;
  end if;

  select * into s from scores where team_id = p_team and slot_no = slot for update;
  -- 已送出的分數評審自己可以持續修改（評分、結算階段內）：按「修改」回到暫存中，按「送出」重新送出

  if p_submit then
    if n_filled < n_items then raise exception '還有 % 個項目沒有給分', n_items - n_filled; end if;
    if char_length(p_strengths) < c.min_comment_chars then raise exception '「作品優點」至少要 % 個字', c.min_comment_chars; end if;
    if char_length(p_improvements) < c.min_comment_chars then raise exception '「改進建議」至少要 % 個字', c.min_comment_chars; end if;
  end if;

  if not found then
    insert into scores (competition_id, team_id, version_id, slot_no, account_id, status, items, total, strengths, improvements, submitted_at, updated_at)
    values (c.id, p_team, lock_ver, slot, p_account, case when p_submit then 'submitted' else 'draft' end, clean,
            case when p_submit then tot end, p_strengths, p_improvements, case when p_submit then now() end, now())
    returning * into s;
    prev_returned := false;
  else
    prev_returned := s.status in ('returned', 'submitted');
    update scores set account_id = p_account, version_id = lock_ver, items = clean,
      status = case when p_submit then 'submitted' else (case when s.status = 'returned' then 'returned' else 'draft' end) end,
      total = case when p_submit then tot end, strengths = p_strengths, improvements = p_improvements,
      submitted_at = case when p_submit then now() end, updated_at = now()
    where id = s.id returning * into s;
  end if;

  if p_submit then
    insert into score_history (score_id, action, snapshot, actor)
    values (s.id, case when prev_returned then 'resubmit' else 'submit' end,
            jsonb_build_object('items', clean, 'total', tot, 'strengths', p_strengths, 'improvements', p_improvements, 'account', p_account),
            p_account);
  end if;
  return jsonb_build_object('status', s.status, 'total', s.total);
end $$;

revoke all on function judge_save(uuid, uuid, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function judge_save(uuid, uuid, jsonb, text, text, boolean) to service_role;
