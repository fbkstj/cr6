-- 評審人數可以是 0＝只有 AI 評分（老師 2026-11-23）：老師評審 0、1、3、5 人；0 人時一定要開啟 AI 評審且 AI 計入平均，
-- AI 坐評審1（席位 judge_count＋1）。另外把 lock_for_judging 的錯誤訊息「收件」改成「檢核」（階段改名，C18）。
alter table competitions drop constraint if exists competitions_judge_count_check;
alter table competitions add constraint competitions_judge_count_check check (judge_count in (0, 1, 3, 5));
alter table competitions drop constraint if exists competitions_ai_only_check;
alter table competitions add constraint competitions_ai_only_check check (judge_count > 0 or (ai_judge and ai_counted));

create or replace function lock_for_judging(p_competition uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c record; n int; locked int; excluded jsonb; ai uuid;
begin
  select * into c from competitions where id = p_competition for update;
  if not found then raise exception '找不到競賽'; end if;
  if c.phase <> 'collecting' then raise exception '只有「檢核」階段可以開始評分'; end if;
  if c.judge_count = 0 and not c.ai_judge then raise exception '只有 AI 評分時，要開啟 AI 評審'; end if;

  select count(*) into n from judge_slots s join accounts a on a.id = s.account_id
    where s.competition_id = p_competition and s.slot_no <= c.judge_count and a.active and a.role = 'judge';
  if n < c.judge_count then raise exception '評審席位還沒排滿（% / %）', n, c.judge_count; end if;

  if (select coalesce(sum(max_score), 0) from rubric_items where rubric_id = c.rubric_id) <> 100 then
    raise exception '專題組評分表總分必須是 100';
  end if;
  if (select coalesce(sum(max_score), 0) from rubric_items where rubric_id = c.rubric_id_creative) <> 100 then
    raise exception '創意組評分表總分必須是 100';
  end if;

  delete from judging_locks where team_id in (select id from teams where competition_id = p_competition);
  insert into judging_locks (team_id, version_id, locked_by)
    select t.id, tc.version_id, p_actor from teams t join team_current tc on tc.team_id = t.id
    where t.competition_id = p_competition;   -- 不再有資格審查（老師決定：審查在系統外人工先做）；有設定正式版本的作品都進入評分
  get diagnostics locked = row_count;
  if locked = 0 then raise exception '沒有任何可以評分的作品（還沒有設定正式版本）'; end if;

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

revoke all on function lock_for_judging(uuid, uuid) from public, anon, authenticated;
grant execute on function lock_for_judging(uuid, uuid) to service_role;
