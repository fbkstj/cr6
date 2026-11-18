-- P4：評審評分（暫存、正式送出）與主辦方退回
-- 規則見開發計畫書 5.1、6.3、7。分數一律由資料庫依評分表重新計算，不相信前端傳來的總分。

-- 評審暫存或正式送出。
-- p_items：{"<rubric_item_id>": 分數, ...}；暫存可以只填一部分，正式送出必須每項都填。
-- 回傳 {"status": "draft" | "submitted", "total": 總分或 null}
create or replace function judge_save(p_team uuid, p_account uuid, p_items jsonb, p_strengths text,
                                      p_improvements text, p_submit boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c record; slot int; lock_ver uuid; s record; it record;
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
  if jsonb_typeof(coalesce(p_items, '{}'::jsonb)) <> 'object' then raise exception '分數格式錯誤'; end if;

  -- 只接受評分表上的項目，每項是 0～滿分的整數
  if exists (select 1 from jsonb_object_keys(coalesce(p_items, '{}'::jsonb)) k
             where k not in (select id::text from rubric_items where rubric_id = c.rubric_id)) then
    raise exception '分數裡有不在評分表上的項目';
  end if;
  select count(*) into n_items from rubric_items where rubric_id = c.rubric_id;
  for it in select id, title, max_score from rubric_items where rubric_id = c.rubric_id order by sort loop
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
  if length(p_strengths) > 2000 or length(p_improvements) > 2000 then raise exception '評語最多 2000 字'; end if;

  select * into s from scores where team_id = p_team and slot_no = slot for update;
  if found and s.status = 'submitted' then raise exception '已經正式送出，需要主辦方退回才能修改'; end if;

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
    prev_returned := s.status = 'returned';
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

-- 主辦方退回已送出的評分（必填原因）。舊內容存進 score_history，評分改成 returned。
create or replace function return_score(p_score uuid, p_actor uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare s record; c record;
begin
  select * into s from scores where id = p_score for update;
  if not found then raise exception '找不到這份評分'; end if;
  select * into c from competitions where id = s.competition_id;
  if c.phase not in ('judging', 'settling') then raise exception '目前階段不能退回評分'; end if;
  if s.status <> 'submitted' then raise exception '只有已正式送出的評分可以退回'; end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception '退回必須填寫原因'; end if;
  insert into score_history (score_id, action, snapshot, actor, reason)
  values (s.id, 'return', jsonb_build_object('items', s.items, 'total', s.total, 'strengths', s.strengths,
          'improvements', s.improvements, 'account', s.account_id), p_actor, trim(p_reason));
  update scores set status = 'returned', submitted_at = null, total = null, updated_at = now() where id = s.id;
  insert into admin_logs (competition_id, actor, action, target, detail)
  values (s.competition_id, p_actor, 'return_score', s.id::text, jsonb_build_object('slot', s.slot_no, 'reason', trim(p_reason)));
end $$;

revoke all on function judge_save(uuid, uuid, jsonb, text, text, boolean) from public, anon, authenticated;
revoke all on function return_score(uuid, uuid, text) from public, anon, authenticated;
grant execute on function judge_save(uuid, uuid, jsonb, text, text, boolean) to service_role;
grant execute on function return_score(uuid, uuid, text) to service_role;
