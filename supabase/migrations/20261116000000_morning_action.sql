-- Morning action (P4): one "action for today" per business, by about 5 am in the business's own time zone
-- (docs/integrations-setup.md §13, server/morning/).
--
--   business_settings  one row per business: its time zone as the server last used it, when its next action is due
--                      (the next local 05:00), when the app last opened its Dashboard, the hourly tick's claim and
--                      lease, and what the last run did (for the owner's checks). Written only by the server.
--   daily_actions      one row per business per local "action day": the state (generating, ready, done, dismissed,
--                      failed), who started it, AI or the built-in rules, up to 3 ranked ideas and which one is shown,
--                      the owner's Not useful answers, why rules were used, our own error code, what the AI call cost,
--                      and how many attempts were made (at most 3, only ever started by the owner's own press).
--                      Written only by the server.
--
-- Users read their own rows (defence in depth: the app reads through the server's routes), except daily_actions'
-- cost_usd, provider and model; nobody but the server's secret key writes. Deleting a business deletes its rows (a trigger on user_docs); deleting an account deletes
-- everything (foreign keys). Run it after 20261102000000_accounts.sql and 20261110000000_billing.sql.
-- Safe to run again.
--
-- Owner step: run this file in Supabase → SQL Editor.
--
-- Check it:   select local_date, state, engine, count(*) from public.daily_actions group by 1, 2, 3 order by 1 desc limit 20;
--             select last_outcome, count(*) from public.business_settings group by 1;
--             select public.ylb_morning_backlog(10800);
-- Roll back:  set MORNING_ACTIONS=off on the server (no routes, no jobs). Dropping the two tables loses only the actions.

-- ───────────── tables ─────────────

create table if not exists public.business_settings (
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null check (project_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  time_zone text not null default 'UTC' check (char_length(time_zone) between 1 and 64 and time_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'),
  -- the next local 05:00 in time_zone, worked out by the server (SQL never computes a local time); null until the first visit
  next_action_at timestamptz,
  last_active_at timestamptz not null default now(),
  claim_id uuid,
  claimed_until timestamptz,
  last_outcome text check (last_outcome in ('ready', 'rules', 'failed', 'exists', 'skipped_plan', 'skipped_slot', 'skipped_late')),
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id)
);
create index if not exists business_settings_due on public.business_settings (next_action_at) where next_action_at is not null;

create table if not exists public.daily_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null check (project_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  local_date date not null,
  time_zone text not null check (char_length(time_zone) between 1 and 64),
  state text not null check (state in ('generating', 'ready', 'done', 'dismissed', 'failed')),
  source text not null check (source in ('cron', 'visit', 'manual')),
  engine text check (engine in ('ai', 'rules')),
  candidates jsonb not null default '[]'::jsonb check (jsonb_typeof(candidates) = 'array' and jsonb_array_length(candidates) <= 3 and pg_column_size(candidates) <= 8192),
  chosen smallint check (chosen between 0 and 2),
  feedback jsonb not null default '[]'::jsonb check (jsonb_typeof(feedback) = 'array' and jsonb_array_length(feedback) <= 3 and pg_column_size(feedback) <= 2048),
  fallback text check (fallback in ('no_ai', 'own_key', 'credits', 'daily_limit', 'invalid_output', 'refused', 'ai_error', 'fresh')),
  -- ours only (UNAVAILABLE, INTERRUPTED, ERROR), never a provider's or the database's words
  error_code text check (char_length(error_code) <= 40),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  own_key boolean not null default false,
  provider text check (char_length(provider) <= 40),
  model text check (char_length(model) <= 128),
  attempts smallint not null default 1 check (attempts between 1 and 3),
  started_at timestamptz not null default now(),
  generated_at timestamptz,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_actions_one_per_day unique (user_id, project_id, local_date)
);
create index if not exists daily_actions_generating on public.daily_actions (started_at) where state = 'generating';

drop trigger if exists business_settings_touch on public.business_settings;
create trigger business_settings_touch before insert or update on public.business_settings
  for each row execute function public.ylb_touch_updated_at();
drop trigger if exists daily_actions_touch on public.daily_actions;
create trigger daily_actions_touch before insert or update on public.daily_actions
  for each row execute function public.ylb_touch_updated_at();

-- ───────────── row-level security: users read their own, only the server writes ─────────────

alter table public.business_settings enable row level security;
alter table public.daily_actions enable row level security;
revoke all on table public.business_settings, public.daily_actions from anon, authenticated;
grant select on table public.business_settings to authenticated;
-- every column but what the call cost and which provider and model ran it (the app shows whole credits only)
grant select (id, user_id, project_id, local_date, time_zone, state, source, engine, candidates, chosen, feedback,
  fallback, error_code, own_key, attempts, started_at, generated_at, done_at, created_at, updated_at)
  on public.daily_actions to authenticated;

drop policy if exists "Users read their own business settings" on public.business_settings;
create policy "Users read their own business settings" on public.business_settings
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users read their own daily actions" on public.daily_actions;
create policy "Users read their own daily actions" on public.daily_actions
  for select to authenticated using ((select auth.uid()) = user_id);

-- ───────────── deleting a business deletes its morning rows ─────────────

create or replace function public.ylb_morning_on_project_delete() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  delete from public.daily_actions where user_id = old.user_id and project_id = old.id;
  delete from public.business_settings where user_id = old.user_id and project_id = old.id;
  return old;
end;
$$;
drop trigger if exists user_docs_morning_delete on public.user_docs;
create trigger user_docs_morning_delete after delete on public.user_docs
  for each row when (old.kind = 'project') execute function public.ylb_morning_on_project_delete();

-- ───────────── functions (server only) ─────────────

-- Whether a business may get a morning action: still saved and set up, its slot not locked, and on a plan (or plans
-- not enforced). A superset of the server's own check (P1's entitlement), which re-checks every claimed business.
create or replace function public.ylb_morning_eligible(s public.business_settings) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
      select 1 from public.user_docs d
      where d.user_id = s.user_id and d.kind = 'project' and d.id = s.project_id and d.data ->> 'onboarded' = 'true'
    )
    and not exists (
      select 1 from public.project_slots p where p.user_id = s.user_id and p.project_id = s.project_id and p.state = 'locked'
    )
    and (
      not public.ylb_billing_enforced()
      or exists (select 1 from public.billing_accounts a where a.user_id = s.user_id and public.ylb_slot_eligible(a))
    );
$$;

-- Claim up to p_limit due businesses for one tick: oldest due first, rows another claimer holds are skipped (never
-- waited for), each gets a fresh claim id and a lease. Two concurrent calls never return the same row.
create or replace function public.ylb_morning_claim(p_limit int, p_lease_seconds int)
  returns table (user_id uuid, project_id text, time_zone text, doc_time_zone text, next_action_at timestamptz, claim_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
declare
  lim int := greatest(1, least(coalesce(p_limit, 1), 200));
  lease int := greatest(60, least(coalesce(p_lease_seconds, 600), 3600));
begin
  return query
  with due as (
    select s.user_id, s.project_id
    from public.business_settings s
    where s.next_action_at is not null
      and s.next_action_at <= now()
      and s.last_active_at >= now() - interval '14 days'
      and (s.claimed_until is null or s.claimed_until < now())
      and public.ylb_morning_eligible(s)
    order by s.next_action_at, s.user_id, s.project_id
    limit lim
    for update of s skip locked
  ),
  claimed as (
    update public.business_settings b
       set claim_id = gen_random_uuid(), claimed_until = now() + make_interval(secs => lease)
      from due
     where b.user_id = due.user_id and b.project_id = due.project_id
    returning b.user_id, b.project_id, b.time_zone, b.next_action_at, b.claim_id
  )
  select c.user_id, c.project_id, c.time_zone,
         (select d.data ->> 'timeZone' from public.user_docs d where d.user_id = c.user_id and d.kind = 'project' and d.id = c.project_id),
         c.next_action_at, c.claim_id
  from claimed c
  order by c.next_action_at, c.user_id, c.project_id;
end;
$$;

-- How many due businesses have waited longer than p_older_than_seconds (the owner's backlog alert).
create or replace function public.ylb_morning_backlog(p_older_than_seconds int) returns int
  language sql stable security definer set search_path = '' as $$
  select count(*)::int
  from public.business_settings s
  where s.next_action_at is not null
    and s.next_action_at <= now() - make_interval(secs => greatest(0, coalesce(p_older_than_seconds, 0)))
    and s.last_active_at >= now() - interval '14 days'
    and (s.claimed_until is null or s.claimed_until < now())
    and public.ylb_morning_eligible(s);
$$;

revoke all on function public.ylb_morning_on_project_delete() from public, anon, authenticated;
revoke all on function public.ylb_morning_eligible(public.business_settings) from public, anon, authenticated;
revoke all on function public.ylb_morning_claim(int, int) from public, anon, authenticated;
revoke all on function public.ylb_morning_backlog(int) from public, anon, authenticated;
grant execute on function public.ylb_morning_eligible(public.business_settings) to service_role;
grant execute on function public.ylb_morning_claim(int, int) to service_role;
grant execute on function public.ylb_morning_backlog(int) to service_role;
