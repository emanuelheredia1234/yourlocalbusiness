-- Connected accounts, posting, analytics and per-customer usage (docs/integrations-setup.md).
--
-- Every table here is server-only: row-level security is on with no policies, so browsers never reach them;
-- only the server, with the secret key, reads or writes them (like ai_usage_daily, app_state and page_leads).
-- Deleting an account deletes its rows through the foreign keys, except usage_ledger: its user_id has no
-- foreign key on purpose (invoices need the rows), and the server clears user_id there when an account goes,
-- keeping only the opaque customer_tag. Safe to run again.

-- Each signed-in user's opaque billing tag: 'cust_' + 24 hex of an HMAC of their id (never an email).
create table if not exists public.billing_customers (
  customer_tag text primary key check (customer_tag ~ '^cust_[0-9a-f]{24}$'),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Spending caps: the '*' row holds the defaults; a row per customer_tag overrides them (null fields inherit).
create table if not exists public.billing_caps (
  customer_tag text primary key,
  daily_cap_micro bigint,
  monthly_cap_micro bigint,
  calls_per_day int,
  posts_per_day int,
  x_posts_per_day int,
  status text not null default 'active' check (status in ('active', 'blocked')),
  note text check (char_length(note) <= 500),
  synced_to_treg_at timestamptz,
  updated_at timestamptz not null default now()
);

-- One row per metered call (treg responses, connection proxy requests, estimated X and connection costs).
create table if not exists public.usage_ledger (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  customer_tag text not null,
  user_id uuid,
  project_id text,
  feature text not null check (feature in ('social', 'seo', 'ads', 'gsc', 'email', 'posting', 'connections')),
  vendor text not null check (vendor in ('treg', 'nango', 'x', 'omnisend')),
  endpoint text not null,
  call_id text,
  cost_micro bigint not null default 0,
  -- true for list-price estimates (connections, X): shown as "estimated", never counted toward a cap
  estimated boolean not null default false,
  cache text,
  served_by text,
  http_status int,
  outcome text not null,
  run_id uuid,
  bytes bigint,
  -- the Idempotency-Key sent with the call, so a replay after our own timeout finds its first row
  idempotency_key text
);
create index if not exists usage_ledger_idem on public.usage_ledger (idempotency_key) where idempotency_key is not null;
create index if not exists usage_ledger_pending on public.usage_ledger (created_at) where outcome = 'pending';
create index if not exists usage_ledger_customer_time on public.usage_ledger (customer_tag, created_at);
create index if not exists usage_ledger_call on public.usage_ledger (call_id) where call_id is not null;

-- Per business: keywords, city and competitors, plus ids resolved once (IG user id, TikTok sec_uid, …).
create table if not exists public.analytics_settings (
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null,
  settings jsonb not null default '{}'::jsonb,
  resolved jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id)
);

-- The latest result of each analytics source per business (a failed refresh keeps the previous good data).
create table if not exists public.analytics_snapshots (
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null,
  source text not null check (source in ('social', 'ads', 'seo', 'email')),
  status text not null check (status in ('ok', 'partial', 'error', 'not_connected', 'skipped', 'pending')),
  error_code text,
  fetched_at timestamptz,
  data jsonb not null default '{}'::jsonb,
  cost_micro bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id, source)
);

-- One "Update" press: the four sources run in the background.
create table if not exists public.analytics_runs (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null,
  state text not null check (state in ('running', 'done', 'done_with_errors')),
  sources jsonb not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  cost_micro bigint not null default 0
);
create index if not exists analytics_runs_recent on public.analytics_runs (user_id, project_id, started_at desc);
-- at most one running run per business
create unique index if not exists analytics_runs_one_running on public.analytics_runs (user_id, project_id) where state = 'running';

-- The 15-minute slot, claimed atomically: inserts the run only when no run for the business started in the
-- last 15 minutes, and returns it (or nothing). Two presses at once create one run.
create or replace function public.claim_analytics_run(p_user uuid, p_project text, p_id uuid, p_sources jsonb)
returns setof public.analytics_runs
language sql
security definer
set search_path = public
as $$
  insert into public.analytics_runs (id, user_id, project_id, state, sources)
  select p_id, p_user, p_project, 'running', p_sources
  where not exists (
    select 1 from public.analytics_runs r
    where r.user_id = p_user and r.project_id = p_project and r.started_at > now() - interval '15 minutes'
  )
  on conflict do nothing
  returning *;
$$;
revoke all on function public.claim_analytics_run(uuid, text, uuid, jsonb) from public, anon, authenticated;

-- Summary numbers per update and source (change since the last update); rows older than 90 days are pruned.
create table if not exists public.analytics_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null,
  source text not null check (source in ('social', 'ads', 'seo', 'email')),
  fetched_at timestamptz not null,
  summary jsonb not null
);
create index if not exists analytics_history_recent on public.analytics_history (user_id, project_id, source, fetched_at desc);

-- Webhook deliveries seen in the last 10 minutes (sha256 of the raw body), so an identical redelivery applies once.
create table if not exists public.webhook_deliveries (
  body_hash text primary key,
  received_at timestamptz not null default now()
);

-- "Publish my page to Google" on a custom domain: each one-shot step's last outcome, per page.
create table if not exists public.seo_google_steps (
  user_id uuid not null references auth.users (id) on delete cascade,
  page_id text not null,
  step text not null check (step in ('verify_token', 'verify', 'site_add', 'sitemap', 'inspect')),
  outcome text not null check (outcome in ('ok', 'failed', 'unknown')),
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now(),
  primary key (user_id, page_id, step)
);

-- Posts sent from the app: one attempt each; an uncertain outcome is 'unknown' and is never sent again by itself.
create table if not exists public.post_publish_jobs (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null,
  post_id text not null,
  platform text not null,
  client_request_id uuid not null,
  state text not null check (state in ('queued', 'sending', 'sent', 'failed', 'unknown')),
  -- {postId, containerId, publishId, mediaIds}: the network's own ids, not secrets
  provider_ref jsonb not null default '{}'::jsonb,
  url text,
  error_code text,
  requested_at timestamptz not null default now(),
  finished_at timestamptz,
  checked_at timestamptz,
  unique (user_id, client_request_id)
);
-- a post goes to a network once: a second publish while one is live (or sent, or uncertain) is refused
create unique index if not exists post_publish_jobs_one_live on public.post_publish_jobs (user_id, post_id, platform)
  where state in ('queued', 'sending', 'sent', 'unknown');

alter table public.billing_customers enable row level security;
alter table public.billing_caps enable row level security;
alter table public.usage_ledger enable row level security;
alter table public.analytics_settings enable row level security;
alter table public.analytics_snapshots enable row level security;
alter table public.analytics_runs enable row level security;
alter table public.post_publish_jobs enable row level security;
alter table public.analytics_history enable row level security;
alter table public.webhook_deliveries enable row level security;
alter table public.seo_google_steps enable row level security;
revoke all on table public.billing_customers, public.billing_caps, public.usage_ledger, public.analytics_settings,
  public.analytics_snapshots, public.analytics_runs, public.post_publish_jobs, public.analytics_history,
  public.webhook_deliveries, public.seo_google_steps from anon, authenticated;

-- The default caps: $0.25 a day, $3.00 a month, 400 calls a day; 50 posts a day, 20 of them on X.
insert into public.billing_caps (customer_tag, daily_cap_micro, monthly_cap_micro, calls_per_day, posts_per_day, x_posts_per_day)
values ('*', 250000, 3000000, 400, 50, 20)
on conflict (customer_tag) do nothing;
