-- P7：AI 評審（開發計畫書第 14 節，2026-11-21 老師決定）
-- AI 算成一位評審：坐在席位 N＋1（N＝老師評審人數），用系統帳號（role＝ai，沒有密碼、不能登入）送出評分，
-- 所以平均、排名、同分、匯出、公布都沿用 scores 表；總份數 M ＝ N ＋（ai_judge ? 1 : 0）。

/* ───────────── 設定與約束 ───────────── */

alter table competitions add column if not exists ai_judge boolean not null default true;   -- 老師決定：預設開啟
alter table competitions alter column judge_count set default 3;                           -- 老師決定：預設 3 人

alter table accounts drop constraint if exists accounts_role_check;
alter table accounts add constraint accounts_role_check check (role in ('judge', 'admin', 'ai'));

-- 5 位老師＋AI＝席位 6
alter table judge_slots drop constraint if exists judge_slots_slot_no_check;
alter table judge_slots add constraint judge_slots_slot_no_check check (slot_no between 1 and 6);
alter table scores drop constraint if exists scores_slot_no_check;
alter table scores add constraint scores_slot_no_check check (slot_no between 1 and 6);

/** 這個競賽的總評分份數 */
create or replace function seat_count(c competitions) returns int
language sql immutable as $$ select c.judge_count + case when c.ai_judge then 1 else 0 end $$;

/* ───────────── AI 帳號不能登入、不能設密碼 ───────────── */

create or replace function set_password(p_login text, p_pw text) returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  if length(coalesce(p_pw, '')) < 8 then raise exception '密碼至少 8 個字'; end if;
  if exists (select 1 from accounts where login_id = p_login and role = 'ai') then raise exception 'AI 帳號不能設定密碼'; end if;
  update accounts set password_hash = crypt(p_pw, gen_salt('bf', 10)) where login_id = p_login;
  if not found then raise exception '找不到帳號 %', p_login; end if;
  return '已設定 ' || p_login || ' 的密碼';
end $$;

create or replace function check_password(p_login text, p_pw text) returns uuid
language sql stable security definer set search_path = public, extensions as $$
  select id from accounts
  where login_id = p_login and active and role <> 'ai' and password_hash is not null
    and password_hash = crypt(coalesce(p_pw, ''), password_hash);
$$;

/* ───────────── 建立競賽：評審人數預設 3 ───────────── */

create or replace function create_competition(p_name text, p_admin_login text, p_admin_name text,
                                              p_admin_pw text, p_judge_count int default 3) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare cid uuid; rid uuid;
begin
  update competitions set active = false where active;
  insert into competitions (name, active, judge_count) values (p_name, true, p_judge_count) returning id into cid;
  insert into rubrics (competition_id, name) values (cid, '預設評分表') returning id into rid;
  insert into rubric_items (rubric_id, sort, title, max_score, description) values
    (rid, 1, '專題作品的應用及整合性', 40, ''),
    (rid, 2, '專題作品與課程相關', 25, ''),
    (rid, 3, '創意性與實用性', 25, ''),
    (rid, 4, '作品說明的組織與表達', 10, '試辦項目，名稱與判準待校方定案');
  update competitions set rubric_id = rid where id = cid;
  insert into accounts (competition_id, login_id, display_name, role) values (cid, p_admin_login, p_admin_name, 'admin');
  perform set_password(p_admin_login, p_admin_pw);
  insert into admin_logs (competition_id, action, target, detail)
    values (cid, 'create_competition', p_name, jsonb_build_object('admin', p_admin_login, 'judge_count', p_judge_count));
  return cid;
end $$;

/* ───────────── 開始評分：AI 開啟時自動建立 AI 帳號並坐進席位 N＋1 ───────────── */

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
  if c.ai_judge then
    select id into ai from accounts where competition_id = p_competition and role = 'ai' limit 1;
    if ai is null then
      insert into accounts (competition_id, login_id, display_name, role)
        values (p_competition, 'ai-' || substr(replace(p_competition::text, '-', ''), 1, 8), 'AI 評審（Gemini）', 'ai')
        returning id into ai;
    end if;
    update accounts set active = true where id = ai;
    insert into judge_slots (competition_id, slot_no, account_id) values (p_competition, c.judge_count + 1, ai);
  end if;
  update rubrics set locked = true where id = c.rubric_id;
  update competitions set phase = 'judging' where id = p_competition;
  insert into admin_logs (competition_id, actor, action, target, detail)
    values (p_competition, p_actor, 'lock_for_judging', '',
            jsonb_build_object('locked', locked, 'excluded', excluded, 'judges', c.judge_count, 'ai', c.ai_judge));
  return jsonb_build_object('locked', locked, 'excluded', excluded);
end $$;

/* ───────────── 公布：收齊 M 份 ───────────── */

create or replace function publish_results(p_competition uuid, p_actor uuid, p_snapshot jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare c competitions; m int; missing int; pid uuid;
begin
  select * into c from competitions where id = p_competition for update;
  if not found then raise exception '找不到競賽'; end if;
  if c.phase <> 'settling' then raise exception '只有「結算」階段可以公布'; end if;
  if jsonb_typeof(p_snapshot -> 'teams') <> 'array' then raise exception '結果快照格式錯誤'; end if;
  m := seat_count(c);
  select count(*) into missing from judging_locks jl join teams t on t.id = jl.team_id
    where t.competition_id = p_competition
      and (select count(*) from scores s where s.team_id = jl.team_id and s.status = 'submitted' and s.slot_no <= m) < m;
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

/* ───────────── AI 評分紀錄 ───────────── */

-- 每次執行一筆，不刪除；狀態：uploading → processing → generating → done ／ needs_review → finalized；任何一步失敗 → failed
create table if not exists ai_runs (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions (id) on delete cascade,
  team_id        uuid not null references teams (id) on delete cascade,
  version_id     uuid not null references video_versions (id),
  rubric_id      uuid references rubrics (id),
  model          text not null,
  prompt_version text not null,
  status         text not null check (status in ('uploading', 'processing', 'generating', 'done', 'needs_review', 'finalized', 'failed')),
  gemini_file    text,                                       -- files/xxx（48 小時後 Gemini 自動刪除）
  gemini_uri     text,
  raw_output     text,                                       -- 模型原始回應（最多 20000 字）
  result         jsonb,                                      -- 解析後：{items:{item_id:分數或null}, reasons, evidence, strengths, improvements}
  problems       jsonb not null default '[]'::jsonb,         -- 需要主辦人員處理的原因
  manual         jsonb,                                      -- 主辦人員補分：{items, reason}
  usage          jsonb,                                      -- token 用量
  error          text,
  started_by     uuid references accounts (id),
  started_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create index if not exists ai_runs_team on ai_runs (team_id, started_at desc);

alter table ai_runs enable row level security;
revoke all on table ai_runs from anon, authenticated;

revoke all on function seat_count(competitions) from public, anon, authenticated;
revoke all on function set_password(text, text) from public, anon, authenticated;
revoke all on function check_password(text, text) from public, anon, authenticated;
revoke all on function create_competition(text, text, text, text, int) from public, anon, authenticated;
revoke all on function lock_for_judging(uuid, uuid) from public, anon, authenticated;
revoke all on function publish_results(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function seat_count(competitions) to service_role;
grant execute on function set_password(text, text) to service_role;
grant execute on function check_password(text, text) to service_role;
grant execute on function lock_for_judging(uuid, uuid) to service_role;
grant execute on function publish_results(uuid, uuid, jsonb) to service_role;
