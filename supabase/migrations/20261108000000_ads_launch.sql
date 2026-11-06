-- Launching and changing Meta and Google ad campaigns from the app, through Zernio (server/ads/). Every table is
-- server-only (row-level security on, no policies, nothing granted to anon or authenticated): the server reaches
-- them with the secret key and every query names the server-resolved user. Ad spend is never in the app's ledger:
-- Meta and Google bill it to the customer's own payment method.
--
-- Nothing here changes billing_caps or the usage_ledger constraints: 'zernio' and the 'ads' feature are already
-- allowed (20261107000000_upload_post.sql, 20261105000000_integrations.sql).

-- The ad account (inside the business's Zernio connection) each business launches on, per platform. A row whose
-- zernio_account_id isn't the business's current connection is stale: the server ignores it and asks again.
create table if not exists public.ad_account_choices (
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null,
  platform text not null check (platform in ('meta', 'google')),
  zernio_account_id text not null check (zernio_account_id ~ '^[0-9a-f]{24}$'),
  ad_account_id text not null,               -- act_… or the Google customer id (digits)
  ad_account_name text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  timezone text not null,
  chosen_at timestamptz not null default now(),
  primary key (user_id, project_id, platform)
);

-- One row per launch that reached the send step.
create table if not exists public.ad_campaigns (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  customer_tag text not null,
  project_id text not null,
  plan_id text not null,
  platform text not null check (platform in ('meta', 'google')),
  zernio_account_id text not null check (zernio_account_id ~ '^[0-9a-f]{24}$'),
  ad_account_id text not null,
  ad_account_name text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  timezone text not null,
  name text not null,                        -- ends with "· YLB <12 hex>" (from launch_key): how it is found again
  launch_key uuid not null,                  -- the create's Idempotency-Key
  goal text not null check (goal in ('traffic', 'awareness')),
  budget_level text not null default 'adset' check (budget_level in ('adset', 'campaign')),
  daily_budget numeric(14, 3) not null check (daily_budget > 0),   -- whole units of `currency`
  spend_cap numeric(14, 3),                  -- the Meta campaign spending limit as last set or read; null on Google
  start_at timestamptz not null,
  end_at timestamptz,
  launched_as text not null check (launched_as in ('PAUSED', 'ACTIVE')),
  state text not null check (state in ('launching', 'in_review', 'active', 'paused', 'rejected', 'with_issues',
                                       'completed', 'ended', 'failed', 'unknown')),
  configured_status text,                    -- the campaign's own switch (ACTIVE/PAUSED): drives "committed daily"
  review jsonb not null default '{}'::jsonb, -- our words + cut platform reasons
  remote jsonb not null default '{}'::jsonb, -- {campaignId, adSetId, adIds[], zernioAdIds[], creativeIds[], offAds[]}
  sent_body jsonb not null,                  -- the confirmed Zernio body (image links replaced by media:<id>)
  results jsonb,                             -- {spend, impressions, clicks, ctr, conversions, asOf}
  last_read_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- a plan runs once per platform at a time: launched again only after it is ended or failed
create unique index if not exists ad_campaigns_one_live on public.ad_campaigns (user_id, plan_id, platform)
  where state not in ('ended', 'failed');
create index if not exists ad_campaigns_user_project on public.ad_campaigns (user_id, project_id);
create index if not exists ad_campaigns_customer on public.ad_campaigns (customer_tag);

-- Every write attempt (one job = one customer or owner confirm; never re-sent by itself).
create table if not exists public.ad_jobs (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  campaign_id uuid not null references public.ad_campaigns (id) on delete cascade,
  kind text not null check (kind in ('launch', 'pause', 'resume', 'end', 'budget', 'end_date', 'creative')),
  actor text not null default 'customer' check (actor in ('customer', 'owner')),
  client_request_id uuid not null,
  state text not null check (state in ('queued', 'sending', 'done', 'failed', 'unknown')),
  request jsonb not null,                    -- what the confirm showed: amounts, dates, status, account tail
  before jsonb,                              -- live values read at preview
  provider_ref jsonb not null default '{}'::jsonb, -- step, sentAt, ids, createdObjects, unconfirmedWrite (ids only)
  error_code text,
  requested_at timestamptz not null default now(),
  finished_at timestamptz,
  checked_at timestamptz,
  constraint ad_jobs_user_client_request unique (user_id, client_request_id)
);
-- one write at a time per campaign; an unknown write blocks the next one until it is checked
create unique index if not exists ad_jobs_one_live on public.ad_jobs (campaign_id)
  where state in ('queued', 'sending', 'unknown');
create index if not exists ad_jobs_user_time on public.ad_jobs (user_id, requested_at desc);

-- Append-only log the customer can see. The server has no update or delete path for it.
create table if not exists public.ad_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid not null references auth.users (id) on delete cascade,
  customer_tag text not null,
  project_id text,
  campaign_id uuid,
  job_id uuid,
  actor text not null check (actor in ('customer', 'owner', 'platform')),
  action text not null,                      -- launch|pause|resume|end|budget|end_date|creative|check|limits|review
  summary text not null check (char_length(summary) <= 500),
  before jsonb,
  after jsonb,
  outcome text not null check (outcome in ('sending', 'done', 'failed', 'unknown', 'refused', 'info'))
);
create index if not exists ad_audit_user_time on public.ad_audit (user_id, at desc);

-- The owner's ad limits per customer ('*' = the defaults; a null field inherits). Ads stay off until the owner
-- turns them on. A change bumps `version`, which makes every open review stale.
create table if not exists public.ad_limits (
  customer_tag text primary key,
  ads_enabled boolean,
  ads_currency text check (ads_currency ~ '^[A-Z]{3}$'),
  ads_max_daily numeric(12, 2) check (ads_max_daily >= 0),
  ads_max_change numeric(12, 2) check (ads_max_change >= 0),
  ads_max_campaign_total numeric(12, 2) check (ads_max_campaign_total >= 0),
  ads_launches_per_day int check (ads_launches_per_day >= 0),
  ads_changes_per_day int check (ads_changes_per_day >= 0),
  version int not null default 1,
  updated_at timestamptz not null default now()
);
insert into public.ad_limits (customer_tag, ads_enabled, ads_currency, ads_max_daily, ads_max_change,
  ads_max_campaign_total, ads_launches_per_day, ads_changes_per_day)
  values ('*', false, 'USD', 50, 50, 750, 3, 20) on conflict do nothing;

-- A launch begins in one transaction: the campaign row, its job and the "sending" audit row, or nothing.
-- The same client_request_id answers the job that is there (a double press). A second live launch of the same
-- plan on the same platform fails on ad_campaigns_one_live (23505).
create or replace function public.ads_begin_launch(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c jsonb := p -> 'campaign';
  j jsonb := p -> 'job';
  a jsonb := p -> 'audit';
  job_row public.ad_jobs;
  camp_row public.ad_campaigns;
begin
  select * into job_row from public.ad_jobs
    where user_id = (j ->> 'user_id')::uuid and client_request_id = (j ->> 'client_request_id')::uuid;
  if found then
    select * into camp_row from public.ad_campaigns where id = job_row.campaign_id and user_id = job_row.user_id;
    return jsonb_build_object('existing', true, 'job', to_jsonb(job_row), 'campaign', to_jsonb(camp_row));
  end if;
  insert into public.ad_campaigns (id, user_id, customer_tag, project_id, plan_id, platform, zernio_account_id,
      ad_account_id, ad_account_name, currency, timezone, name, launch_key, goal, budget_level, daily_budget,
      spend_cap, start_at, end_at, launched_as, state, configured_status, review, remote, sent_body)
    values ((c ->> 'id')::uuid, (c ->> 'user_id')::uuid, c ->> 'customer_tag', c ->> 'project_id', c ->> 'plan_id',
      c ->> 'platform', c ->> 'zernio_account_id', c ->> 'ad_account_id', c ->> 'ad_account_name', c ->> 'currency',
      c ->> 'timezone', c ->> 'name', (c ->> 'launch_key')::uuid, c ->> 'goal', coalesce(c ->> 'budget_level', 'adset'),
      (c ->> 'daily_budget')::numeric, (c ->> 'spend_cap')::numeric, (c ->> 'start_at')::timestamptz,
      (c ->> 'end_at')::timestamptz, c ->> 'launched_as', c ->> 'state', c ->> 'configured_status',
      coalesce(c -> 'review', '{}'::jsonb), coalesce(c -> 'remote', '{}'::jsonb), c -> 'sent_body')
    returning * into camp_row;
  insert into public.ad_jobs (id, user_id, campaign_id, kind, actor, client_request_id, state, request, before,
      provider_ref)
    values ((j ->> 'id')::uuid, (j ->> 'user_id')::uuid, camp_row.id, j ->> 'kind', coalesce(j ->> 'actor', 'customer'),
      (j ->> 'client_request_id')::uuid, j ->> 'state', j -> 'request', j -> 'before',
      coalesce(j -> 'provider_ref', '{}'::jsonb))
    returning * into job_row;
  insert into public.ad_audit (user_id, customer_tag, project_id, campaign_id, job_id, actor, action, summary, before,
      after, outcome)
    values ((a ->> 'user_id')::uuid, a ->> 'customer_tag', a ->> 'project_id', camp_row.id, job_row.id,
      a ->> 'actor', a ->> 'action', a ->> 'summary', a -> 'before', a -> 'after', a ->> 'outcome');
  return jsonb_build_object('existing', false, 'job', to_jsonb(job_row), 'campaign', to_jsonb(camp_row));
end;
$$;
revoke all on function public.ads_begin_launch(jsonb) from public, anon, authenticated;

-- A change to a launched campaign begins in one transaction: its job and the "sending" audit row. A second live
-- job for the same campaign fails on ad_jobs_one_live (23505).
create or replace function public.ads_begin_change(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j jsonb := p -> 'job';
  a jsonb := p -> 'audit';
  job_row public.ad_jobs;
begin
  select * into job_row from public.ad_jobs
    where user_id = (j ->> 'user_id')::uuid and client_request_id = (j ->> 'client_request_id')::uuid;
  if found then
    return jsonb_build_object('existing', true, 'job', to_jsonb(job_row));
  end if;
  insert into public.ad_jobs (id, user_id, campaign_id, kind, actor, client_request_id, state, request, before,
      provider_ref)
    values ((j ->> 'id')::uuid, (j ->> 'user_id')::uuid, (j ->> 'campaign_id')::uuid, j ->> 'kind',
      coalesce(j ->> 'actor', 'customer'), (j ->> 'client_request_id')::uuid, j ->> 'state', j -> 'request',
      j -> 'before', coalesce(j -> 'provider_ref', '{}'::jsonb))
    returning * into job_row;
  insert into public.ad_audit (user_id, customer_tag, project_id, campaign_id, job_id, actor, action, summary, before,
      after, outcome)
    values ((a ->> 'user_id')::uuid, a ->> 'customer_tag', a ->> 'project_id', job_row.campaign_id, job_row.id,
      a ->> 'actor', a ->> 'action', a ->> 'summary', a -> 'before', a -> 'after', a ->> 'outcome');
  return jsonb_build_object('existing', false, 'job', to_jsonb(job_row));
end;
$$;
revoke all on function public.ads_begin_change(jsonb) from public, anon, authenticated;

alter table public.ad_account_choices enable row level security;
alter table public.ad_campaigns enable row level security;
alter table public.ad_jobs enable row level security;
alter table public.ad_audit enable row level security;
alter table public.ad_limits enable row level security;
revoke all on table public.ad_account_choices, public.ad_campaigns, public.ad_jobs, public.ad_audit, public.ad_limits
  from anon, authenticated;
