-- P6: Stripe Connect. Sellers get paid through their own Stripe account; we keep a fee by plan (3/1/0%). Safe to run
-- again.
--
-- connect_accounts: one row per seller, per environment (sandbox: a test key; production: a live key), per Stripe
-- account. The account is made by this server with POST /v1/accounts (the seller owns it, sees the full Stripe
-- Dashboard, pays Stripe's fees; Stripe backs negative balances) and is never deleted by us. The row is written BEFORE
-- the one-shot create ('creating'); a create that timed out is 'unknown' and is found again by its metadata, never
-- sent again by the server. `requirements` holds counts and codes only (never what a requirement names: those can
-- describe people). Written by server/payments/stripeConnect.mjs and the Connect webhook.
--
-- offers: a 'stripe' offer sells through its seller's connect_accounts row, with a price the server checks; its
-- delivery is 'none' (the seller delivers) or 'file' (a product file, lead_files.purpose = 'product').
--
-- lead_files.purpose: 'magnet' (free, at /m/<id>) or 'product' (paid: only through /b/<offer>/file after a sale,
-- never at /m/).
--
-- sales: Stripe sales carry their Checkout Session, our fee (percent and tier when the session was made, the
-- application fee's id), how much of our fee went back to the seller, the dispute's status, and the downloads.
-- record_sale fills them (coalesce: set once); record_sale_dispute keeps the dispute's newest status.
--
-- connect_fee_returns: our fee going back to the seller after a refund or a lost dispute, once per refund or dispute
-- (the row is written before the one-shot write; an unclear answer is read back hourly, never resent).
--
-- connect_alerts: platform-level problems the owner sees in Owner › Billing › Stripe Connect (codes only).
--
-- Row-level security is on with no policies: only the server, with the secret key, reads or writes these.
--
-- Check:  select environment, status, count(*) from public.connect_accounts group by 1, 2;
--         select environment, state, count(*), sum(amount_minor) from public.connect_fee_returns group by 1, 2;
--         select kind, count, last_at, resolved_at from public.connect_alerts order by last_at desc;
--         select environment, fee_tier, currency, count(*), sum(application_fee_minor), sum(fee_returned_minor)
--           from public.sales where provider = 'stripe' group by 1, 2, 3;

-- ───────────── connect_accounts ─────────────

create table if not exists public.connect_accounts (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  environment text not null,
  stripe_account_id text,
  status text not null default 'creating',
  country text not null,
  default_currency text,
  display_name text not null default '',
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  requirements jsonb not null default '{}'::jsonb,
  tax_status text,
  tax_enabled boolean not null default false,
  payout_failed_at timestamptz,
  terms_version text not null,
  terms_accepted_at timestamptz not null,
  create_key text not null,
  create_started_at timestamptz not null default now(),
  last_event_at timestamptz,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint connect_accounts_id_format check (id ~ '^[A-Za-z0-9_-]{22}$'),
  constraint connect_accounts_environment_check check (environment in ('sandbox', 'production')),
  constraint connect_accounts_account_format check (stripe_account_id is null or stripe_account_id ~ '^acct_[A-Za-z0-9]{6,64}$'),
  constraint connect_accounts_account_needed check (stripe_account_id is not null or status in ('creating', 'unknown')),
  constraint connect_accounts_status_check check (status in ('creating', 'unknown', 'onboarding', 'restricted', 'active', 'rejected', 'disconnected')),
  constraint connect_accounts_country_format check (country ~ '^[A-Z]{2}$'),
  constraint connect_accounts_currency_format check (default_currency is null or default_currency ~ '^[a-z]{3}$'),
  constraint connect_accounts_display_name_size check (length(display_name) <= 120),
  constraint connect_accounts_requirements_check check (jsonb_typeof(requirements) = 'object' and pg_column_size(requirements) <= 2048),
  constraint connect_accounts_tax_status_check check (tax_status is null or tax_status in ('active', 'pending')),
  constraint connect_accounts_terms_size check (length(terms_version) <= 40),
  constraint connect_accounts_create_key_size check (length(create_key) <= 100)
);

-- one live account per user and environment (a disconnected one doesn't count); one row per Stripe account
create unique index if not exists connect_accounts_one_live on public.connect_accounts (user_id, environment)
  where status <> 'disconnected';
create unique index if not exists connect_accounts_acct on public.connect_accounts (environment, stripe_account_id)
  where stripe_account_id is not null;
create index if not exists connect_accounts_user on public.connect_accounts (user_id);
-- the daily sync takes the least recently synced first
create index if not exists connect_accounts_synced on public.connect_accounts (status, synced_at);

create or replace trigger connect_accounts_touch before insert or update on public.connect_accounts
  for each row execute function public.ylb_touch_updated_at();

alter table public.connect_accounts enable row level security;
revoke all on table public.connect_accounts from anon, authenticated;

-- ───────────── offers ─────────────

alter table public.offers add column if not exists connect_account_id text references public.connect_accounts (id) on delete set null;
create index if not exists offers_connect_account on public.offers (connect_account_id);

alter table public.offers drop constraint if exists offers_stripe_account;
alter table public.offers add constraint offers_stripe_account check (
  provider <> 'stripe' or status = 'archived'
  or (connect_account_id is not null and price_minor > 0 and currency is not null)
);
alter table public.offers drop constraint if exists offers_delivery_kind;
alter table public.offers add constraint offers_delivery_kind check (
  delivery->>'kind' in ('provider', 'none', 'file')
  and (delivery->>'kind' <> 'file' or coalesce(delivery->>'fileId', '') ~ '^[A-Za-z0-9_-]{22}$')
);

-- ───────────── lead_files ─────────────

alter table public.lead_files add column if not exists purpose text not null default 'magnet';
alter table public.lead_files drop constraint if exists lead_files_purpose_check;
alter table public.lead_files add constraint lead_files_purpose_check check (purpose in ('magnet', 'product'));

-- ───────────── sales ─────────────

alter table public.sales add column if not exists checkout_session_id text;
alter table public.sales add column if not exists fee_pct smallint;
alter table public.sales add column if not exists fee_tier text;
alter table public.sales add column if not exists application_fee_id text;
alter table public.sales add column if not exists fee_returned_minor bigint not null default 0;
alter table public.sales add column if not exists dispute_status text;
alter table public.sales add column if not exists dispute_amount_minor bigint;
alter table public.sales add column if not exists dispute_at timestamptz;
alter table public.sales add column if not exists downloads integer not null default 0;

alter table public.sales drop constraint if exists sales_connect_fields;
alter table public.sales add constraint sales_connect_fields check (
  (checkout_session_id is null or (length(checkout_session_id) <= 255 and checkout_session_id ~ '^cs_'))
  and (fee_pct is null or fee_pct between 0 and 100)
  and (fee_tier is null or fee_tier in ('launch', 'grow', 'scale', 'owner', 'legacy', 'none'))
  and (application_fee_id is null or (length(application_fee_id) <= 100 and application_fee_id ~ '^fee_'))
  and fee_returned_minor >= 0
  and (dispute_status is null or length(dispute_status) <= 40)
  and downloads >= 0
);

create unique index if not exists sales_one_per_session on public.sales (provider, environment, checkout_session_id)
  where checkout_session_id is not null;

-- ───────────── connect_fee_returns ─────────────

create table if not exists public.connect_fee_returns (
  environment text not null,
  source_id text not null,
  sale_id uuid not null references public.sales (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  application_fee_id text not null,
  amount_minor bigint not null,
  idempotency_key text not null,
  state text not null default 'sending',
  fee_refund_id text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (environment, source_id),
  constraint connect_fee_returns_environment_check check (environment in ('sandbox', 'production')),
  constraint connect_fee_returns_source_format check (source_id ~ '^(re|dp|du)_[A-Za-z0-9_]{4,100}$'),
  constraint connect_fee_returns_amount_check check (amount_minor > 0),
  constraint connect_fee_returns_state_check check (state in ('sending', 'ok', 'unknown', 'failed', 'skipped')),
  constraint connect_fee_returns_sizes check (length(application_fee_id) <= 100 and length(idempotency_key) <= 255
    and (fee_refund_id is null or length(fee_refund_id) <= 100) and (error_code is null or length(error_code) <= 60))
);

create index if not exists connect_fee_returns_state on public.connect_fee_returns (state, updated_at);

create or replace trigger connect_fee_returns_touch before insert or update on public.connect_fee_returns
  for each row execute function public.ylb_touch_updated_at();

alter table public.connect_fee_returns enable row level security;
revoke all on table public.connect_fee_returns from anon, authenticated;

-- ───────────── connect_alerts ─────────────

create table if not exists public.connect_alerts (
  kind text primary key,
  count integer not null default 1,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  constraint connect_alerts_kind_format check (kind ~ '^[a-z0-9_]{1,60}$'),
  constraint connect_alerts_detail_check check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 1024)
);

alter table public.connect_alerts enable row level security;
revoke all on table public.connect_alerts from anon, authenticated;

-- ───────────── functions (server-only) ─────────────

-- Record what a provider event says about one payment: 'inserted', 'updated' or 'kept' (P3's rule, plus P6's fee
-- fields: checkout_session_id, fee_pct, fee_tier, application_fee_id and application_fee_minor are set once,
-- coalesce(stored, incoming)). server/offers/sales.mjs mergeSale is the same rule in JS.
-- The status changes only to one of the same or a later rank, or (between pending and failed only) to a newer
-- event's. refunded_minor only grows; the other amounts, the email, the paid time and the membership are kept once
-- set. A row of another user is never changed. The row is locked while it's decided.
create or replace function public.record_sale(p jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  r public.sales%rowtype;
  v_status text := p->>'status';
  v_at timestamptz := (p->>'last_event_at')::timestamptz;
  v_refunded bigint := coalesce((p->>'refunded_minor')::bigint, 0);
  v_amount bigint := coalesce((p->>'amount_minor')::bigint, 0);
  v_applies boolean;
  n_status text;
  n_at timestamptz;
  n_refunded bigint;
  n_amount bigint;
  n_net bigint;
  n_email text;
  n_paid timestamptz;
  n_member text;
  n_session text;
  n_fee_pct smallint;
  n_fee_tier text;
  n_fee_id text;
  n_fee bigint;
begin
  insert into public.sales (user_id, project_id, offer_id, provider, environment, provider_account, provider_payment_id,
    provider_membership_id, status, amount_minor, refunded_minor, net_minor, application_fee_minor, currency, buyer_email,
    paid_at, last_event_at, checkout_session_id, fee_pct, fee_tier, application_fee_id)
  values ((p->>'user_id')::uuid, p->>'project_id', p->>'offer_id', p->>'provider', p->>'environment', p->>'provider_account',
    p->>'provider_payment_id', p->>'provider_membership_id', v_status, v_amount, v_refunded, (p->>'net_minor')::bigint,
    (p->>'application_fee_minor')::bigint, p->>'currency', p->>'buyer_email', (p->>'paid_at')::timestamptz, v_at,
    p->>'checkout_session_id', (p->>'fee_pct')::smallint, p->>'fee_tier', p->>'application_fee_id')
  on conflict (provider, environment, provider_payment_id) do nothing
  returning id into v_id;
  if v_id is not null then
    return 'inserted';
  end if;

  select * into r from public.sales
    where provider = p->>'provider' and environment = p->>'environment' and provider_payment_id = p->>'provider_payment_id'
    for update;
  if not found or r.user_id <> (p->>'user_id')::uuid then
    return 'kept';
  end if;

  v_applies := public.ylb_sale_rank(v_status) >= public.ylb_sale_rank(r.status)
    or (v_at > r.last_event_at and r.status in ('pending', 'failed') and v_status in ('pending', 'failed'));
  n_status := case when v_applies then v_status else r.status end;
  n_at := greatest(r.last_event_at, v_at);
  n_refunded := greatest(r.refunded_minor, v_refunded);
  n_amount := case when r.amount_minor > 0 then r.amount_minor else greatest(r.amount_minor, v_amount) end;
  n_net := coalesce(r.net_minor, (p->>'net_minor')::bigint);
  n_email := coalesce(r.buyer_email, p->>'buyer_email');
  n_paid := coalesce(r.paid_at, (p->>'paid_at')::timestamptz);
  n_member := coalesce(r.provider_membership_id, p->>'provider_membership_id');
  n_session := coalesce(r.checkout_session_id, p->>'checkout_session_id');
  n_fee_pct := coalesce(r.fee_pct, (p->>'fee_pct')::smallint);
  n_fee_tier := coalesce(r.fee_tier, p->>'fee_tier');
  n_fee_id := coalesce(r.application_fee_id, p->>'application_fee_id');
  n_fee := coalesce(r.application_fee_minor, (p->>'application_fee_minor')::bigint);

  if n_status is not distinct from r.status and n_at is not distinct from r.last_event_at
    and n_refunded = r.refunded_minor and n_amount = r.amount_minor and n_net is not distinct from r.net_minor
    and n_email is not distinct from r.buyer_email and n_paid is not distinct from r.paid_at
    and n_member is not distinct from r.provider_membership_id
    and n_session is not distinct from r.checkout_session_id and n_fee_pct is not distinct from r.fee_pct
    and n_fee_tier is not distinct from r.fee_tier and n_fee_id is not distinct from r.application_fee_id
    and n_fee is not distinct from r.application_fee_minor then
    return 'kept';
  end if;

  update public.sales set status = n_status, last_event_at = n_at, refunded_minor = n_refunded, amount_minor = n_amount,
    net_minor = n_net, buyer_email = n_email, paid_at = n_paid, provider_membership_id = n_member,
    checkout_session_id = n_session, fee_pct = n_fee_pct, fee_tier = n_fee_tier, application_fee_id = n_fee_id,
    application_fee_minor = n_fee
    where id = r.id;
  return 'updated';
end;
$$;

revoke execute on function public.record_sale(jsonb) from public, anon, authenticated;
grant execute on function public.record_sale(jsonb) to service_role;

-- A dispute's newest status on its sale: only an event at least as new as the last one changes it; the sale's status
-- moves to 'disputed' by the rank rule (it never goes back: a dispute won stays 'disputed' with dispute_status 'won').
-- 'updated' | 'kept' | 'missing'.
create or replace function public.record_sale_dispute(p_provider text, p_env text, p_payment_id text, p_user uuid,
  p_status text, p_amount bigint, p_at timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.sales%rowtype;
begin
  select * into r from public.sales
    where provider = p_provider and environment = p_env and provider_payment_id = p_payment_id
    for update;
  if not found or r.user_id <> p_user then
    return 'missing';
  end if;
  if r.dispute_at is not null and p_at < r.dispute_at then
    return 'kept';
  end if;
  update public.sales set dispute_status = left(p_status, 40), dispute_amount_minor = p_amount, dispute_at = p_at,
    status = case when public.ylb_sale_rank('disputed') >= public.ylb_sale_rank(r.status) then 'disputed' else r.status end,
    last_event_at = greatest(r.last_event_at, p_at)
    where id = r.id;
  return 'updated';
end;
$$;

revoke execute on function public.record_sale_dispute(text, text, text, uuid, text, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.record_sale_dispute(text, text, text, uuid, text, bigint, timestamptz) to service_role;

-- Our fee back on a sale as one absolute value, in one statement: the greatest of what it says now, the sum of the
-- sale's fee returns confirmed ('ok') and what Stripe says of the application fee (p_fee_refunded, its
-- amount_refunded; 0 when not known). Never added to, so a fee refund seen by two paths (the write's answer, the
-- hourly read-back, application_fee.refunded) counts once. The new value, or null for no such sale.
create or replace function public.sale_fee_returned(p_sale uuid, p_fee_refunded bigint)
returns bigint
language sql
security definer
set search_path = ''
as $$
  update public.sales s set fee_returned_minor = greatest(s.fee_returned_minor, coalesce(p_fee_refunded, 0),
    coalesce((select sum(r.amount_minor) from public.connect_fee_returns r where r.sale_id = s.id and r.state = 'ok'), 0))
  where s.id = p_sale
  returning s.fee_returned_minor;
$$;

revoke execute on function public.sale_fee_returned(uuid, bigint) from public, anon, authenticated;
grant execute on function public.sale_fee_returned(uuid, bigint) to service_role;

-- One more download of a sale's product file, in one statement: the new count, or null once p_max is reached.
create or replace function public.sale_downloaded(p_id uuid, p_max integer)
returns integer
language sql
security definer
set search_path = ''
as $$
  update public.sales set downloads = downloads + 1 where id = p_id and downloads < p_max returning downloads;
$$;

revoke execute on function public.sale_downloaded(uuid, integer) from public, anon, authenticated;
grant execute on function public.sale_downloaded(uuid, integer) to service_role;

-- An owner alert: a new kind, or one more of a known one (unresolved again).
create or replace function public.connect_alert(p_kind text, p_detail jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.connect_alerts (kind, count, first_at, last_at, detail, resolved_at)
  values (p_kind, 1, now(), now(), coalesce(p_detail, '{}'::jsonb), null)
  on conflict (kind) do update set count = public.connect_alerts.count + 1, last_at = now(),
    detail = coalesce(excluded.detail, '{}'::jsonb), resolved_at = null;
$$;

revoke execute on function public.connect_alert(text, jsonb) from public, anon, authenticated;
grant execute on function public.connect_alert(text, jsonb) to service_role;
