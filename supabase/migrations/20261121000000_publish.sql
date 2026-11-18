-- P5：公布與撤回（開發計畫書 6.1、7）
-- 公布時把結果存成快照，公開頁只讀快照；之後就算有人改了資料庫，公開的結果也不會跟著變。

-- 同分處理可能改判多次，以最後一筆為準。決定時間可能相同（同一毫秒），所以用遞增序號判斷先後。
alter table tie_decisions add column if not exists seq bigint generated always as identity;

-- 公布：只有 settling 階段、每件評分作品都收齊 N 份正式評分時才可以。快照由 core.js 依排名規則產生。
create or replace function publish_results(p_competition uuid, p_actor uuid, p_snapshot jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare c record; missing int; pid uuid;
begin
  select * into c from competitions where id = p_competition for update;
  if not found then raise exception '找不到競賽'; end if;
  if c.phase <> 'settling' then raise exception '只有「結算」階段可以公布'; end if;
  if jsonb_typeof(p_snapshot -> 'teams') <> 'array' then raise exception '結果快照格式錯誤'; end if;
  select count(*) into missing from judging_locks jl join teams t on t.id = jl.team_id
    where t.competition_id = p_competition
      and (select count(*) from scores s where s.team_id = jl.team_id and s.status = 'submitted' and s.slot_no <= c.judge_count) < c.judge_count;
  if missing > 0 then raise exception '還有 % 件作品的評分沒有收齊', missing; end if;
  if exists (select 1 from publications where competition_id = p_competition and revoked_at is null) then
    raise exception '已經公布過了，請先撤回';
  end if;
  insert into publications (competition_id, published_by, snapshot) values (p_competition, p_actor, p_snapshot) returning id into pid;
  update competitions set phase = 'published' where id = p_competition;
  insert into admin_logs (competition_id, actor, action, target, detail)
    values (p_competition, p_actor, 'publish', pid::text, jsonb_build_object('teams', jsonb_array_length(p_snapshot -> 'teams')));
  return pid;
end $$;

-- 撤回公布：公開頁立刻看不到結果，階段回到 settling，可以修正後重新公布。必填原因。
create or replace function revoke_publication(p_competition uuid, p_actor uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare c record; pid uuid;
begin
  select * into c from competitions where id = p_competition for update;
  if not found then raise exception '找不到競賽'; end if;
  if c.phase <> 'published' then raise exception '目前沒有公布中的結果'; end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception '撤回必須填寫原因'; end if;
  update publications set revoked_at = now(), revoked_by = p_actor, revoke_reason = trim(p_reason)
    where competition_id = p_competition and revoked_at is null returning id into pid;
  update competitions set phase = 'settling' where id = p_competition;
  insert into admin_logs (competition_id, actor, action, target, detail)
    values (p_competition, p_actor, 'revoke', coalesce(pid::text, ''), jsonb_build_object('reason', trim(p_reason)));
end $$;

revoke all on function publish_results(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function revoke_publication(uuid, uuid, text) from public, anon, authenticated;
grant execute on function publish_results(uuid, uuid, jsonb) to service_role;
grant execute on function revoke_publication(uuid, uuid, text) to service_role;
