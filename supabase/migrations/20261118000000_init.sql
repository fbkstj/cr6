-- 專題競賽評分系統：初始資料表（P1）
-- 設計依據：開發計畫書.md 第 5 節。
-- 所有資料表都開 RLS 而且不開任何 policy：瀏覽器（anon）完全讀寫不到，
-- 只有 Edge Function 用 service role 存取，權限在 core.js 檢查。

create extension if not exists pgcrypto with schema extensions;

/* ───────────── 競賽與帳號 ───────────── */

create table if not exists competitions (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(trim(name)) > 0),
  active            boolean not null default false,          -- 公開頁顯示的競賽（同時只能有一個）
  phase             text not null default 'setup'
                    check (phase in ('setup', 'collecting', 'judging', 'settling', 'published')),
  judge_count       int not null default 5 check (judge_count in (3, 5)),
  rubric_id         uuid,                                     -- 外鍵在 rubrics 建好後補上
  show_status_page  boolean not null default true,            -- 公布前公開頁是否顯示收件與資格狀態
  show_item_scores  boolean not null default false,           -- 公開結果是否顯示分項分數
  min_comment_chars int not null default 10 check (min_comment_chars between 0 and 200),
  created_at        timestamptz not null default now()
);
create unique index if not exists competitions_one_active on competitions (active) where active;

create table if not exists accounts (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions (id) on delete cascade,
  login_id       text not null unique check (login_id ~ '^[a-z0-9_-]{3,32}$'),   -- judge01、admin01；全系統唯一
  display_name   text not null check (length(trim(display_name)) > 0),
  role           text not null check (role in ('judge', 'admin')),
  password_hash  text,                                                           -- bcrypt；null＝還沒設定密碼
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create index if not exists accounts_competition on accounts (competition_id);

/* ───────────── 評分表 ───────────── */

create table if not exists rubrics (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions (id) on delete cascade,
  name           text not null,
  version        int not null default 1 check (version > 0),
  locked         boolean not null default false,              -- 進入 judging 時鎖定
  created_at     timestamptz not null default now(),
  unique (competition_id, version)
);
alter table competitions drop constraint if exists competitions_rubric_fk;
alter table competitions add constraint competitions_rubric_fk foreign key (rubric_id) references rubrics (id);

create table if not exists rubric_items (
  id          uuid primary key default gen_random_uuid(),
  rubric_id   uuid not null references rubrics (id) on delete cascade,
  sort        int not null,
  title       text not null check (length(trim(title)) > 0),
  max_score   int not null check (max_score between 1 and 100),
  description text not null default '',                       -- 判準
  unique (rubric_id, sort)
);

/* ───────────── 評審席位（評審1～N） ───────────── */

create table if not exists judge_slots (
  competition_id  uuid not null references competitions (id) on delete cascade,
  slot_no         int not null check (slot_no between 1 and 5),
  account_id      uuid not null references accounts (id),
  assigned_at     timestamptz not null default now(),
  replaced_reason text,                                       -- 替補時填寫
  primary key (competition_id, slot_no),
  unique (competition_id, account_id)                         -- 同一位評審只能坐一個席位
);

/* ───────────── 小組、影片版本、資格審查 ───────────── */

create table if not exists teams (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions (id) on delete cascade,
  code           text not null check (code ~ '^team[0-9]{2}$'),
  name           text not null default '',
  members        text not null default '',
  work_title     text not null default '',
  work_desc      text not null default '',
  created_at     timestamptz not null default now(),
  unique (competition_id, code),
  unique (id, competition_id)
);

create table if not exists video_versions (
  id              uuid primary key default gen_random_uuid(),
  competition_id  uuid not null references competitions (id) on delete cascade,
  team_id         uuid not null,
  version_no      int not null check (version_no > 0),
  source_filename text not null,
  source_sha256   text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_size     bigint not null check (source_size >= 0),
  duration_sec    numeric(8, 2),
  container       text,
  vcodec          text,
  acodec          text,
  width           int,
  height          int,
  check_ok        boolean not null,
  check_notes     text not null default '',
  playback_path   text,                                       -- docs/ 底下的相對路徑，例如 videos/team01_v1.mp4
  playback_size   bigint,
  received_at     timestamptz,                                -- 主辦方填寫的收件時間
  processed_at    timestamptz,
  created_at      timestamptz not null default now(),
  foreign key (team_id, competition_id) references teams (id, competition_id) on delete cascade,
  unique (team_id, version_no),
  unique (competition_id, source_sha256),                     -- 同一支原檔不會建立兩個版本
  check (not check_ok or playback_path is not null)
);

create table if not exists team_current (
  team_id    uuid primary key references teams (id) on delete cascade,
  version_id uuid not null references video_versions (id),
  set_by     uuid references accounts (id),
  set_at     timestamptz not null default now()
);

-- 只增不改：改判時新增一筆，最新一筆為有效審查
create table if not exists reviews (
  id          bigint generated always as identity primary key,
  version_id  uuid not null references video_versions (id) on delete cascade,
  status      text not null check (status in ('pending', 'pass', 'resubmit', 'fail')),
  reason      text not null default '',
  timecodes   jsonb not null default '[]'::jsonb,              -- [{sec, note}]
  reviewer    uuid references accounts (id),
  reviewed_at timestamptz not null default now(),
  check (status in ('pending', 'pass') or length(trim(reason)) > 0),
  check (jsonb_typeof(timecodes) = 'array')
);
create index if not exists reviews_version on reviews (version_id, id desc);

create table if not exists judging_locks (
  team_id    uuid primary key references teams (id) on delete cascade,
  version_id uuid not null references video_versions (id),
  locked_at  timestamptz not null default now(),
  locked_by  uuid references accounts (id)
);

/* ───────────── 評分 ───────────── */

create table if not exists scores (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions (id) on delete cascade,
  team_id        uuid not null references teams (id) on delete cascade,
  version_id     uuid not null references video_versions (id),
  slot_no        int not null check (slot_no between 1 and 5),
  account_id     uuid not null references accounts (id),       -- 實際評分的評審（替補後可能和席位目前的帳號不同）
  status         text not null default 'draft' check (status in ('draft', 'submitted', 'returned')),
  items          jsonb not null default '{}'::jsonb,            -- {rubric_item_id: 分數}
  total          int check (total between 0 and 100),
  strengths      text not null default '',
  improvements   text not null default '',
  submitted_at   timestamptz,
  updated_at     timestamptz not null default now(),
  unique (team_id, slot_no),                                    -- 同一作品同一席位只有一份
  check (status <> 'submitted' or (total is not null and submitted_at is not null))
);

create table if not exists score_history (
  id       bigint generated always as identity primary key,
  score_id uuid not null references scores (id) on delete cascade,
  action   text not null check (action in ('submit', 'return', 'resubmit', 'reassign')),
  snapshot jsonb not null,
  actor    uuid references accounts (id),
  reason   text not null default '',
  at       timestamptz not null default now()
);

/* ───────────── 結算與公布 ───────────── */

create table if not exists tie_decisions (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions (id) on delete cascade,
  team_ids       uuid[] not null,
  ordering       jsonb not null,                               -- 主辦方決定的先後，或 {"tied": true}
  reason         text not null check (length(trim(reason)) > 0),
  decided_by     uuid references accounts (id),
  decided_at     timestamptz not null default now()
);

create table if not exists publications (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions (id) on delete cascade,
  published_at   timestamptz not null default now(),
  published_by   uuid references accounts (id),
  snapshot       jsonb not null,                               -- 公布當下的結果快照（公開頁只讀這裡）
  revoked_at     timestamptz,
  revoked_by     uuid references accounts (id),
  revoke_reason  text
);
create unique index if not exists publications_one_live on publications (competition_id) where revoked_at is null;

/* ───────────── 紀錄 ───────────── */

create table if not exists admin_logs (
  id             bigint generated always as identity primary key,
  competition_id uuid references competitions (id) on delete cascade,
  actor          uuid references accounts (id),
  action         text not null,
  target         text not null default '',
  detail         jsonb not null default '{}'::jsonb,
  at             timestamptz not null default now()
);
create index if not exists admin_logs_competition on admin_logs (competition_id, id desc);

create table if not exists login_fails (
  key   text primary key,
  count int not null default 0,
  until timestamptz not null
);

/* ───────────── 全部上鎖：只有伺服器（service role）能讀寫 ───────────── */

do $$
declare t text;
begin
  foreach t in array array['competitions', 'accounts', 'rubrics', 'rubric_items', 'judge_slots', 'teams',
                           'video_versions', 'team_current', 'reviews', 'judging_locks', 'scores', 'score_history',
                           'tie_decisions', 'publications', 'admin_logs', 'login_fails']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;

/* ───────────── 密碼：只存 bcrypt 雜湊 ───────────── */

-- 設定或重設密碼。老師在 SQL Editor 用：select set_password('admin01', '你的密碼');
-- 後台「重設密碼」也是呼叫這個函式（由 Edge Function 以 service role 呼叫）。
create or replace function set_password(p_login text, p_pw text) returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  if length(coalesce(p_pw, '')) < 8 then raise exception '密碼至少 8 個字'; end if;
  update accounts set password_hash = crypt(p_pw, gen_salt('bf', 10)) where login_id = p_login;
  if not found then raise exception '找不到帳號 %', p_login; end if;
  return '已設定 ' || p_login || ' 的密碼';
end $$;

-- 驗證密碼：正確且帳號啟用時回傳帳號 id，否則回傳 null
create or replace function check_password(p_login text, p_pw text) returns uuid
language sql stable security definer set search_path = public, extensions as $$
  select id from accounts
  where login_id = p_login and active and password_hash is not null
    and password_hash = crypt(coalesce(p_pw, ''), password_hash);
$$;

/* ───────────── 建立競賽（第一次部署時在 SQL Editor 執行一次） ───────────── */

-- 用法：select create_competition('115 學年度專題製作競賽', 'admin01', '主辦人員', '至少8個字的密碼', 5);
-- 會建立：競賽（設為公開頁顯示的競賽）、第一位主辦人員、預設評分表（40／25／25／10）。
create or replace function create_competition(p_name text, p_admin_login text, p_admin_name text,
                                              p_admin_pw text, p_judge_count int default 5) returns uuid
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

revoke all on function set_password(text, text) from public, anon, authenticated;
revoke all on function check_password(text, text) from public, anon, authenticated;
revoke all on function create_competition(text, text, text, text, int) from public, anon, authenticated;
grant execute on function set_password(text, text) to service_role;
grant execute on function check_password(text, text) to service_role;
