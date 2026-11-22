-- 兩大類：專題組（project）與創意組（creative）。
-- 每件作品屬於其中一組；兩組各有自己的評分表、各自排名；同一批評審評兩組。
-- competitions.rubric_id 仍是專題組的評分表，新增 rubric_id_creative 是創意組的評分表。

alter table teams add column if not exists category text not null default 'project';
alter table teams drop constraint if exists teams_category_check;
alter table teams add constraint teams_category_check check (category in ('project', 'creative'));

alter table competitions add column if not exists rubric_id_creative uuid references rubrics (id);

-- 評分表也標示所屬組別；同一競賽同一組別的版本不能重複
alter table rubrics add column if not exists category text not null default 'project';
alter table rubrics drop constraint if exists rubrics_category_check;
alter table rubrics add constraint rubrics_category_check check (category in ('project', 'creative'));
alter table rubrics drop constraint if exists rubrics_competition_id_version_key;
alter table rubrics drop constraint if exists rubrics_competition_category_version_key;
alter table rubrics add constraint rubrics_competition_category_version_key unique (competition_id, category, version);

-- 已存在的競賽補一份創意組評分表（複製專題組目前的項目，之後在後台修改）
do $$
declare c record; rid uuid;
begin
  for c in select id, rubric_id from competitions where rubric_id_creative is null and rubric_id is not null loop
    insert into rubrics (competition_id, name, category, locked) values (c.id, '創意組評分表', 'creative', (select locked from rubrics where id = c.rubric_id)) returning id into rid;
    insert into rubric_items (rubric_id, sort, title, max_score, description)
      select rid, sort, title, max_score, description from rubric_items where rubric_id = c.rubric_id;
    update competitions set rubric_id_creative = rid where id = c.id;
  end loop;
end $$;

/** 作品所屬組別對應的評分表 */
create or replace function team_rubric(p_team uuid) returns uuid
language sql stable as $$
  select case t.category when 'creative' then c.rubric_id_creative else c.rubric_id end
  from teams t join competitions c on c.id = t.competition_id where t.id = p_team
$$;

/* ───────────── 建立競賽：同時建立兩份評分表 ───────────── */

create or replace function create_competition(p_name text, p_admin_login text, p_admin_name text,
                                              p_admin_pw text, p_judge_count int default 3) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare cid uuid; rid uuid; rid2 uuid;
begin
  update competitions set active = false where active;
  insert into competitions (name, active, judge_count) values (p_name, true, p_judge_count) returning id into cid;
  insert into rubrics (competition_id, name) values (cid, '預設評分表') returning id into rid;
  insert into rubric_items (rubric_id, sort, title, max_score, description) values
    (rid, 1, '應用及整合性', 40, ''),
    (rid, 2, '主題與課程相關性', 25, ''),
    (rid, 3, '創意性', 25, ''),
    (rid, 4, '內文組織及架構格式', 10, '依 115 年初賽評分表');
  insert into rubrics (competition_id, name, category) values (cid, '創意組評分表', 'creative') returning id into rid2;
  insert into rubric_items (rubric_id, sort, title, max_score, description) values
    (rid2, 1, '獨創性', 40, '依 115 年初賽評分表'),
    (rid2, 2, '實用性', 25, '依 115 年初賽評分表'),
    (rid2, 3, '商品化程度', 25, '依 115 年初賽評分表'),
    (rid2, 4, '內文組織及架構格式', 10, '依 115 年初賽評分表');
  update competitions set rubric_id = rid, rubric_id_creative = rid2 where id = cid;
  insert into accounts (competition_id, login_id, display_name, role) values (cid, p_admin_login, p_admin_name, 'admin');
  perform set_password(p_admin_login, p_admin_pw);
  insert into admin_logs (competition_id, action, target, detail)
    values (cid, 'create_competition', p_name, jsonb_build_object('admin', p_admin_login, 'judge_count', p_judge_count));
  return cid;
end $$;

/* ───────────── 開始評分：兩份評分表都要 100 分並一起鎖定 ───────────── */

create or replace function lock_for_judging(p_competition uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c record; n int; pend int; locked int; excluded jsonb; ai uuid;
begin
  select * into c from competitions where id = p_competition for update;
  if not found then raise exception '找不到競賽'; end if;
  if c.phase <> 'collecting' then raise exception '只有「收件審查」階段可以開始評分'; end if;

  select count(*) into n from judge_slots s join accounts a on a.id = s.account_id
    where s.competition_id = p_competition and s.slot_no <= c.judge_count and a.active and a.role = 'judge';
  if n < c.judge_count then raise exception '評審席位還沒排滿（% / %）', n, c.judge_count; end if;

  if (select coalesce(sum(max_score), 0) from rubric_items where rubric_id = c.rubric_id) <> 100 then
    raise exception '專題組評分表總分必須是 100';
  end if;
  if (select coalesce(sum(max_score), 0) from rubric_items where rubric_id = c.rubric_id_creative) <> 100 then
    raise exception '創意組評分表總分必須是 100';
  end if;

  select count(*) into pend from teams t join team_current tc on tc.team_id = t.id
    where t.competition_id = p_competition and current_review_status(tc.version_id) = 'pending';
  if pend > 0 then raise exception '還有 % 組的資格審查未完成', pend; end if;

  delete from judging_locks where team_id in (select id from teams where competition_id = p_competition);
  insert into judging_locks (team_id, version_id, locked_by)
    select t.id, tc.version_id, p_actor from teams t join team_current tc on tc.team_id = t.id
    where t.competition_id = p_competition and current_review_status(tc.version_id) = 'pass';
  get diagnostics locked = row_count;
  if locked = 0 then raise exception '沒有任何資格通過的作品'; end if;

  select coalesce(jsonb_agg(t.code order by t.code), '[]'::jsonb) into excluded from teams t
    where t.competition_id = p_competition and t.id not in (select team_id from judging_locks);

  delete from judge_slots where competition_id = p_competition and slot_no > c.judge_count;
  if c.ai_judge then
    select id into ai from accounts where competition_id = p_competition and role = 'ai' limit 1;
    if ai is null then
      insert into accounts (competition_id, login_id, display_name, role)
        values (p_competition, 'ai-' || substr(replace(p_competition::text, '-', ''), 1, 8), 'AI 評審', 'ai')
        returning id into ai;
    end if;
    update accounts set active = true where id = ai;
    insert into judge_slots (competition_id, slot_no, account_id) values (p_competition, c.judge_count + 1, ai);
  end if;
  update rubrics set locked = true where id in (c.rubric_id, c.rubric_id_creative);
  update competitions set phase = 'judging' where id = p_competition;
  insert into admin_logs (competition_id, actor, action, target, detail)
    values (p_competition, p_actor, 'lock_for_judging', '',
            jsonb_build_object('locked', locked, 'excluded', excluded, 'judges', c.judge_count, 'ai', c.ai_judge));
  return jsonb_build_object('locked', locked, 'excluded', excluded);
end $$;

/* ───────────── 評審評分：依作品所屬組別的評分表檢查與計分 ───────────── */

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

revoke all on function team_rubric(uuid) from public, anon, authenticated;
grant execute on function team_rubric(uuid) to service_role;
revoke all on function create_competition(text, text, text, text, int) from public, anon, authenticated;
revoke all on function lock_for_judging(uuid, uuid) from public, anon, authenticated;
revoke all on function judge_save(uuid, uuid, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function lock_for_judging(uuid, uuid) to service_role;
grant execute on function judge_save(uuid, uuid, jsonb, text, text, boolean) to service_role;
