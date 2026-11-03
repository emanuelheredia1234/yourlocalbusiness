-- Accounts 2: daily AI counters per user, and users' own keys for every AI provider.
-- Safe to run again.

-- ── Daily counters (UTC days) ──
-- requests / usd: what a user ran on the app owner's keys (what the owner's daily limits apply to).
-- own_requests / own_usd: what they ran with their own keys (shown to them; never limited).
-- Row-level security is on with no policies: only the server, with the secret key, reads or writes it.

create table if not exists public.ai_usage_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  email text not null default '',
  requests int not null default 0,
  usd numeric(12, 6) not null default 0,
  own_requests int not null default 0,
  own_usd numeric(12, 6) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.ai_usage_daily add column if not exists own_requests int not null default 0;
alter table public.ai_usage_daily add column if not exists own_usd numeric(12, 6) not null default 0;

create index if not exists ai_usage_daily_day on public.ai_usage_daily (day desc);

alter table public.ai_usage_daily enable row level security;
revoke all on table public.ai_usage_daily from anon, authenticated;

-- Adds to a user's counters for a day in one atomic statement (copies of the server never lose a count).
create or replace function public.ylb_add_ai_usage(
  p_user uuid,
  p_day date,
  p_email text,
  p_requests int,
  p_usd numeric,
  p_own_requests int default 0,
  p_own_usd numeric default 0
)
returns public.ai_usage_daily
language sql
security definer
set search_path = ''
as $$
  insert into public.ai_usage_daily as d (user_id, day, email, requests, usd, own_requests, own_usd, updated_at)
  values (p_user, p_day, coalesce(p_email, ''), greatest(coalesce(p_requests, 0), 0), greatest(coalesce(p_usd, 0), 0),
          greatest(coalesce(p_own_requests, 0), 0), greatest(coalesce(p_own_usd, 0), 0), now())
  on conflict (user_id, day) do update set
    requests = d.requests + excluded.requests,
    usd = d.usd + excluded.usd,
    own_requests = d.own_requests + excluded.own_requests,
    own_usd = d.own_usd + excluded.own_usd,
    email = case when excluded.email <> '' then excluded.email else d.email end,
    updated_at = now()
  returning d.*;
$$;

revoke execute on function public.ylb_add_ai_usage(uuid, date, text, int, numeric, int, numeric) from public, anon, authenticated;
grant execute on function public.ylb_add_ai_usage(uuid, date, text, int, numeric, int, numeric) to service_role;

-- ── Users' own keys: every provider a person can use, not just Manus ──
alter table public.user_secrets drop constraint if exists user_secrets_provider_check;
alter table public.user_secrets add constraint user_secrets_provider_check
  check (provider in ('openai', 'anthropic', 'google', 'xai', 'openrouter', 'meta', 'manus'));
