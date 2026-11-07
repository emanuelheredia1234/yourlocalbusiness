-- A/B tests and Instagram Trial Reels (P4b): "Make variations" of a post, an email or the SEO page, and which one did
-- better (docs/integrations-setup.md §14, server/experiments/).
--
--   experiments          one row per test: its business, kind (post, email, page), how it runs (posts at different
--                        times, Trial Reels, Omnisend's own A/B draft, a split), the one thing that differs, the metric,
--                        what it tests (the source post, the page, the email step), its state (draft → running →
--                        finished / stopped; cancelled), the decision deadline, the last computed result, the
--                        winner the customer used, the credit window it counted in (its monthly limit), and the
--                        hourly result reader's claim. Written only by the server.
--   experiment_variants  A (the original) and B, or B and C: the post each one is (and its posting job, which is
--                        Upload-Post's request id), its planned time, its Trial Reel mode, a page's version B HTML,
--                        the Omnisend campaign, the last metrics read (numbers only; our own error code), and a
--                        page split's visitors, views and leads (counted only by ylb_experiment_add_counts).
--   page_leads           + experiment_id, variant_key: which version of a page a lead came from.
--
-- Users read their own rows (defence in depth: the app reads through the server's routes), except a page version's
-- HTML; nobody but the server's secret key writes. Deleting a business deletes its tests (a trigger on user_docs);
-- deleting an account deletes everything (foreign keys). Run it after 20261103050000_page_leads.sql,
-- 20261112000000_leads_p2.sql and 20261116000000_morning_action.sql. Safe to run again.
--
-- Owner step: run this file in Supabase → SQL Editor.
--
-- Check it:   select kind, mode, state, count(*) from public.experiments group by 1, 2, 3 order by 1, 2, 3;
--             select counted_month, count(*) from public.experiments where counted_month is not null group by 1 order by 1 desc limit 6;
--             select experiment_id, key, visitors, views, leads from public.experiment_variants where visitors > 0 limit 20;
--             select count(*) from public.page_leads where experiment_id is not null;
-- Roll back:  set EXPERIMENTS=off on the server (no routes, no jobs; pages serve version A only and stop counting).
--             Dropping the two tables loses only the tests; the two page_leads columns can stay.

-- ───────────── tables ─────────────

create table if not exists public.experiments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null check (project_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  kind text not null check (kind in ('post', 'email', 'page')),
  mode text not null,
  changed text not null,
  network text check (network is null or network in ('instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'youtube')),
  metric text not null,
  subject_ref text not null check (char_length(subject_ref) between 1 and 120),
  name text not null default '' check (char_length(name) <= 120),
  state text not null check (state in ('draft', 'running', 'finished', 'stopped', 'cancelled')),
  started_at timestamptz,
  ends_at timestamptz,
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 4096),
  winner text check (winner in ('a', 'b', 'c')),
  winner_used_at timestamptz,
  -- the first day (UTC) of the AI-credit window this test counted in; null while it's a draft (or after a refund)
  counted_month date,
  last_read_at timestamptz,
  read_claim uuid,
  read_claimed_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint experiments_mode_check check (
    (kind = 'post' and mode in ('times', 'trial_reels'))
    or (kind = 'email' and mode in ('omnisend_ab', 'split'))
    or (kind = 'page' and mode = 'split')
  ),
  constraint experiments_changed_check check (
    (kind = 'post' and changed in ('hook', 'caption', 'visual', 'cta', 'time'))
    or (kind = 'email' and changed in ('subject', 'opening'))
    or (kind = 'page' and changed in ('headline', 'hero', 'cta'))
  ),
  constraint experiments_metric_check check (
    (kind = 'post' and metric in ('engagement_rate', 'views', 'reach'))
    or (kind = 'email' and metric in ('open_rate', 'click_rate'))
    or (kind = 'page' and metric = 'lead_rate')
  ),
  constraint experiments_trial_reels_instagram check (mode <> 'trial_reels' or network = 'instagram'),
  constraint experiments_post_network check (kind <> 'post' or network is not null)
);
create index if not exists experiments_by_business on public.experiments (user_id, project_id, created_at desc);
create index if not exists experiments_running_ends on public.experiments (ends_at) where state = 'running';
-- at most one running split per page
create unique index if not exists experiments_one_running_page on public.experiments (user_id, subject_ref) where kind = 'page' and state = 'running';

create table if not exists public.experiment_variants (
  experiment_id uuid not null references public.experiments (id) on delete cascade,
  key text not null check (key in ('a', 'b', 'c')),
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null default '' check (char_length(label) <= 80),
  post_id text check (post_id is null or char_length(post_id) between 1 and 120),
  -- the post_publish_jobs id once posted: Upload-Post's request_id for this variant's post analytics
  job_id uuid,
  planned_at timestamptz,
  share_mode text check (share_mode in ('CUSTOM', 'TRIAL_REELS_SHARE_TO_FOLLOWERS_IF_LIKED', 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS')),
  html text check (html is null or octet_length(html) <= 1500000),
  html_sha256 text check (html_sha256 is null or html_sha256 ~ '^[0-9a-f]{64}$'),
  omnisend_campaign_id text check (omnisend_campaign_id is null or omnisend_campaign_id ~ '^[0-9a-f]{24}$'),
  omnisend_variant_id text check (omnisend_variant_id is null or char_length(omnisend_variant_id) <= 64),
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object' and pg_column_size(metrics) <= 4096),
  metrics_at timestamptz,
  -- ours only (unavailable, not_found, reconnect, delayed), never a provider's words
  metrics_error text check (char_length(metrics_error) <= 40),
  visitors bigint not null default 0 check (visitors >= 0),
  views bigint not null default 0 check (views >= 0),
  leads int not null default 0 check (leads >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (experiment_id, key)
);
-- a post is a variant of one test only
create unique index if not exists experiment_variants_one_per_post on public.experiment_variants (user_id, post_id) where post_id is not null;
create index if not exists experiment_variants_job on public.experiment_variants (job_id) where job_id is not null;

drop trigger if exists experiments_touch on public.experiments;
create trigger experiments_touch before insert or update on public.experiments
  for each row execute function public.ylb_touch_updated_at();
drop trigger if exists experiment_variants_touch on public.experiment_variants;
create trigger experiment_variants_touch before insert or update on public.experiment_variants
  for each row execute function public.ylb_touch_updated_at();

-- which page version a lead came from (null: no test, or a lead from before this migration)
alter table public.page_leads add column if not exists experiment_id uuid;
alter table public.page_leads add column if not exists variant_key text;
alter table public.page_leads drop constraint if exists page_leads_variant_key_check;
alter table public.page_leads add constraint page_leads_variant_key_check check (variant_key is null or variant_key in ('a', 'b', 'c'));
create index if not exists page_leads_by_experiment on public.page_leads (user_id, experiment_id) where experiment_id is not null;

-- ───────────── row-level security: users read their own, only the server writes ─────────────

alter table public.experiments enable row level security;
alter table public.experiment_variants enable row level security;
revoke all on table public.experiments, public.experiment_variants from anon, authenticated;
grant select on table public.experiments to authenticated;
-- every column but a page version's HTML (the app reads it through the server)
grant select (experiment_id, key, user_id, label, post_id, job_id, planned_at, share_mode, html_sha256, omnisend_campaign_id,
  omnisend_variant_id, metrics, metrics_at, metrics_error, visitors, views, leads, created_at, updated_at)
  on public.experiment_variants to authenticated;

drop policy if exists "Users read their own experiments" on public.experiments;
create policy "Users read their own experiments" on public.experiments
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users read their own experiment variants" on public.experiment_variants;
create policy "Users read their own experiment variants" on public.experiment_variants
  for select to authenticated using ((select auth.uid()) = user_id);

-- ───────────── deleting a business deletes its tests (the variants go with them) ─────────────

create or replace function public.ylb_experiments_on_project_delete() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  delete from public.experiments where user_id = old.user_id and project_id = old.id;
  return old;
end;
$$;
drop trigger if exists user_docs_experiments_delete on public.user_docs;
create trigger user_docs_experiments_delete after delete on public.user_docs
  for each row when (old.kind = 'project') execute function public.ylb_experiments_on_project_delete();

-- ───────────── functions (server only) ─────────────

-- Start a draft test, counted in the user's credit window: 'ok', 'limit' (p_limit tests already started in that
-- window; null = no limit), 'state' (not a draft any more), 'running' (another split already runs on that page) or
-- 'missing'. One start at a time per user and window (an advisory lock), so two at the limit can't both pass.
create or replace function public.ylb_experiment_start(p_id uuid, p_user uuid, p_window_start date, p_limit int)
  returns text
  language plpgsql volatile security definer set search_path = '' as $$
declare
  cur text;
  used int;
begin
  perform pg_advisory_xact_lock(hashtextextended('ylb_experiment_start:' || p_user::text || ':' || p_window_start::text, 0));
  select e.state into cur from public.experiments e where e.id = p_id and e.user_id = p_user for update;
  if cur is null then return 'missing'; end if;
  if cur <> 'draft' then return 'state'; end if;
  select count(*)::int into used from public.experiments e
   where e.user_id = p_user and e.counted_month = p_window_start and e.state <> 'draft';
  if p_limit is not null and used >= p_limit then return 'limit'; end if;
  begin
    update public.experiments
       set state = 'running', started_at = now(), counted_month = p_window_start
     where id = p_id and user_id = p_user and state = 'draft';
  exception when unique_violation then
    return 'running';
  end;
  return 'ok';
end;
$$;

-- How many tests the user started in a credit window ("2 of 10 used").
create or replace function public.ylb_experiment_count(p_user uuid, p_window_start date) returns int
  language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.experiments e
   where e.user_id = p_user and e.counted_month = p_window_start and e.state <> 'draft';
$$;

-- Add a page split's counts: [{experiment_id, key, visitors, views, leads}], at most 200 rows, only to running tests.
-- Returns how many variant rows changed.
create or replace function public.ylb_experiment_add_counts(p_rows jsonb) returns int
  language plpgsql volatile security definer set search_path = '' as $$
declare
  n int;
begin
  if jsonb_typeof(p_rows) <> 'array' then return 0; end if;
  with raw as (
    select x from jsonb_array_elements(p_rows) with ordinality as t(x, i) where i <= 200
  ), rows as (
    select (x ->> 'experiment_id')::uuid as eid, x ->> 'key' as k,
           sum(greatest(0, coalesce((x ->> 'visitors')::bigint, 0))) as v,
           sum(greatest(0, coalesce((x ->> 'views')::bigint, 0))) as w,
           sum(greatest(0, coalesce((x ->> 'leads')::int, 0)))::int as l
      from raw
     where (x ->> 'experiment_id') ~ '^[0-9a-f-]{36}$' and x ->> 'key' in ('a', 'b', 'c')
     group by 1, 2
  )
  update public.experiment_variants ev
     set visitors = ev.visitors + r.v, views = ev.views + r.w, leads = ev.leads + r.l
    from rows r, public.experiments e
   where ev.experiment_id = r.eid and ev.key = r.k and e.id = ev.experiment_id and e.state = 'running';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Claim running post and email tests whose results are due a read (posts every 3 hours, email every 6), oldest read
-- first; rows another claimer holds are skipped (never waited for), each gets a claim id and a lease. Two concurrent
-- calls never return the same row.
create or replace function public.ylb_experiment_claim_reads(p_limit int, p_lease int)
  returns table (id uuid, user_id uuid, read_claim uuid)
  language plpgsql volatile security definer set search_path = '' as $$
declare
  lim int := greatest(1, least(coalesce(p_limit, 1), 200));
  lease int := greatest(60, least(coalesce(p_lease, 600), 3600));
begin
  return query
  with due as (
    select e.id
      from public.experiments e
     where e.state = 'running'
       and e.kind in ('post', 'email')
       and (e.read_claimed_until is null or e.read_claimed_until < now())
       and (e.last_read_at is null
            or (e.kind = 'post' and e.last_read_at < now() - interval '3 hours')
            or (e.kind = 'email' and e.last_read_at < now() - interval '6 hours'))
     order by e.last_read_at nulls first, e.id
     limit lim
     for update of e skip locked
  )
  update public.experiments x
     set read_claim = gen_random_uuid(), read_claimed_until = now() + make_interval(secs => lease)
    from due
   where x.id = due.id
  returning x.id, x.user_id, x.read_claim;
end;
$$;

revoke all on function public.ylb_experiments_on_project_delete() from public, anon, authenticated;
revoke all on function public.ylb_experiment_start(uuid, uuid, date, int) from public, anon, authenticated;
revoke all on function public.ylb_experiment_count(uuid, date) from public, anon, authenticated;
revoke all on function public.ylb_experiment_add_counts(jsonb) from public, anon, authenticated;
revoke all on function public.ylb_experiment_claim_reads(int, int) from public, anon, authenticated;
grant execute on function public.ylb_experiment_start(uuid, uuid, date, int) to service_role;
grant execute on function public.ylb_experiment_count(uuid, date) to service_role;
grant execute on function public.ylb_experiment_add_counts(jsonb) to service_role;
grant execute on function public.ylb_experiment_claim_reads(int, int) to service_role;
