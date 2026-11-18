-- P3：資格審查、評分表、鎖版開始評分
-- 需要「全部一起成功或全部不做」的動作寫成資料庫函式（開發計畫書 3.1）。

-- 某個版本目前有效的審查狀態（最新一筆；沒有審查時為 pending）
create or replace function current_review_status(p_version uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select status from reviews where version_id = p_version order by id desc limit 1), 'pending');
$$;

-- 儲存評分表項目（整批取代）。只有 setup／collecting 階段、評分表未鎖定時可以改，總分必須是 100。
-- p_items：[{"title": "...", "max_score": 40, "description": "..."}, ...]，順序就是顯示順序。
create or replace function save_rubric(p_rubric uuid, p_items jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare r record; total int; n int;
begin
  select rb.locked, c.phase into r
    from rubrics rb join competitions c on c.id = rb.competition_id where rb.id = p_rubric for update of rb;
  if not found then raise exception '找不到評分表'; end if;
  if r.locked or r.phase not in ('setup', 'collecting') then raise exception '評分表已鎖定，不能修改'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception '評分表至少要有一個項目'; end if;
  select coalesce(sum((x ->> 'max_score')::int), 0), count(*) into total, n from jsonb_array_elements(p_items) x;
  if total <> 100 then raise exception '評分表總分必須是 100（目前 %）', total; end if;
  delete from rubric_items where rubric_id = p_rubric;
  insert into rubric_items (rubric_id, sort, title, max_score, description)
    select p_rubric, ord, trim(x ->> 'title'), (x ->> 'max_score')::int, coalesce(x ->> 'description', '')
    from jsonb_array_elements(p_items) with ordinality as t(x, ord);
  return n;
end $$;

-- 鎖定評分版本並進入評分階段（一次完成，任何一項不符就全部不做）
-- 條件：目前是 collecting；評審席位 1～N 都有啟用中的評審；評分表總分 100；
--       有正式版本的組別審查都不是 pending；至少一組通過。
-- 結果：通過的組別寫入 judging_locks、評分表鎖定、多出來的席位刪除、階段改為 judging、寫操作紀錄。
create or replace function lock_for_judging(p_competition uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c record; n int; pend int; locked int; excluded jsonb;
begin
  select * into c from competitions where id = p_competition for update;
  if not found then raise exception '找不到競賽'; end if;
  if c.phase <> 'collecting' then raise exception '只有「收件審查」階段可以開始評分'; end if;

  select count(*) into n from judge_slots s join accounts a on a.id = s.account_id
    where s.competition_id = p_competition and s.slot_no <= c.judge_count and a.active and a.role = 'judge';
  if n < c.judge_count then raise exception '評審席位還沒排滿（% / %）', n, c.judge_count; end if;

  if (select coalesce(sum(max_score), 0) from rubric_items where rubric_id = c.rubric_id) <> 100 then
    raise exception '評分表總分必須是 100';
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
  update rubrics set locked = true where id = c.rubric_id;
  update competitions set phase = 'judging' where id = p_competition;
  insert into admin_logs (competition_id, actor, action, target, detail)
    values (p_competition, p_actor, 'lock_for_judging', '', jsonb_build_object('locked', locked, 'excluded', excluded));
  return jsonb_build_object('locked', locked, 'excluded', excluded);
end $$;

revoke all on function current_review_status(uuid) from public, anon, authenticated;
revoke all on function save_rubric(uuid, jsonb) from public, anon, authenticated;
revoke all on function lock_for_judging(uuid, uuid) from public, anon, authenticated;
grant execute on function current_review_status(uuid) to service_role;
grant execute on function save_rubric(uuid, jsonb) to service_role;
grant execute on function lock_for_judging(uuid, uuid) to service_role;
