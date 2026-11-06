-- P3: offers and buy links. One offer is one thing a business sells, with one permanent buy link /b/<id>. Assets,
-- the SEO checkout page, listings and emails hold the offer (its id), never a provider's URL. Safe to run again.
--
-- payment_connections: a user's own Whop account, connected with their own account API key (one live connection
-- per user and environment: sandbox or production). The key and the webhook's signing secret are sealed by the
-- server (AES-256-GCM, a key of its own, bound to the row); the browser only ever sees the key's last 4 characters.
-- A disconnected row stays (without its key) so its sales keep their history; a reconnect makes a new row. `kind`
-- is 'account_key' now; 'app_install' is kept for a later Whop App install.
--
-- offers: the id (16 random bytes, 22 base64url characters) is the /b/<id> address: permanent and unguessable.
-- provider 'whop' points at the stored Whop checkout link (made once, when the plan was attached), 'external' at the
-- owner's own checkout link, 'stripe' is kept for later (the server doesn't make one yet). provider_ref holds the
-- provider's ids and the link, never a key.
--
-- sales: one row per provider payment, written only from the provider's signed webhook (and the read-only
-- reconcile). record_sale never moves a sale backwards (pending < failed < paid < partly refunded < refunded,
-- disputed last), so repeated and out-of-order deliveries change nothing. The buyer's email is the owner's own
-- customer data: shown to them in the app, never logged.
--
-- Row-level security is on with no policies: only the server, with the secret key, reads or writes these. Deleting
-- an account deletes its rows (on delete cascade).
--
-- Check:  select provider, environment, status, webhook_state, count(*) from public.payment_connections group by 1, 2, 3, 4;
--         select provider, status, count(*), sum(clicks) from public.offers group by 1, 2;
--         select environment, status, currency, count(*), sum(amount_minor) from public.sales group by 1, 2, 3;

-- ───────────── payment_connections ─────────────

create table if not exists public.payment_connections (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  kind text not null default 'account_key',
  environment text not null,
  account_id text not null,
  account_name text not null default '',
  key_ciphertext text not null,
  key_last4 text not null,
  webhook_id text,
  webhook_secret_ciphertext text,
  webhook_mode text not null default 'none',
  webhook_state text not null default 'missing',
  status text not null default 'active',
  last_event_at timestamptz,
  checked_at timestamptz,
  reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_connections_id_format check (id ~ '^[A-Za-z0-9_-]{22}$'),
  constraint payment_connections_provider_check check (provider in ('whop', 'stripe')),
  constraint payment_connections_kind_check check (kind in ('account_key', 'app_install')),
  constraint payment_connections_environment_check check (environment in ('sandbox', 'production')),
  constraint payment_connections_account_format check (account_id ~ '^biz_[A-Za-z0-9]{4,64}$'),
  constraint payment_connections_account_name_size check (length(account_name) <= 120),
  constraint payment_connections_last4_size check (length(key_last4) <= 4),
  constraint payment_connections_webhook_id_size check (webhook_id is null or length(webhook_id) <= 100),
  constraint payment_connections_webhook_mode_check check (webhook_mode in ('none', 'auto', 'manual')),
  constraint payment_connections_webhook_state_check check (webhook_state in ('missing', 'ok', 'unknown', 'disabled')),
  constraint payment_connections_status_check check (status in ('active', 'key_rejected', 'disconnected'))
);

-- one live connection per user, provider and environment (a disconnected one doesn't count)
create unique index if not exists payment_connections_one_live on public.payment_connections (user_id, provider, environment)
  where status <> 'disconnected';
create index if not exists payment_connections_user on public.payment_connections (user_id);
-- the daily reconcile takes the least recently reconciled connections first (a table made by an earlier run of this
-- file gets the column here)
alter table public.payment_connections add column if not exists reconciled_at timestamptz;

create or replace trigger payment_connections_touch before insert or update on public.payment_connections
  for each row execute function public.ylb_touch_updated_at();

alter table public.payment_connections enable row level security;
revoke all on table public.payment_connections from anon, authenticated;

-- ───────────── offers ─────────────

create table if not exists public.offers (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null,
  title text not null,
  price_display text not null default '',
  price_minor bigint,
  currency text,
  provider text not null,
  connection_id text references public.payment_connections (id) on delete set null,
  provider_ref jsonb not null default '{}'::jsonb,
  delivery jsonb not null default '{"kind":"provider"}'::jsonb,
  status text not null default 'active',
  clicks integer not null default 0,
  last_click_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offers_id_format check (id ~ '^[A-Za-z0-9_-]{22}$'),
  constraint offers_project_id_format check (project_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  constraint offers_title_size check (length(title) <= 200),
  constraint offers_price_display_size check (length(price_display) <= 40),
  constraint offers_currency_format check (currency is null or currency ~ '^[a-z]{3}$'),
  constraint offers_provider_check check (provider in ('whop', 'external', 'stripe')),
  constraint offers_status_check check (status in ('draft', 'active', 'paused', 'checkout_unknown', 'archived')),
  constraint offers_provider_ref_check check (jsonb_typeof(provider_ref) = 'object' and pg_column_size(provider_ref) <= 4096),
  constraint offers_delivery_check check (jsonb_typeof(delivery) = 'object' and pg_column_size(delivery) <= 1024),
  constraint offers_whop_connection check (provider <> 'whop' or connection_id is not null),
  constraint offers_external_url check (provider <> 'external' or provider_ref ? 'url')
);

create index if not exists offers_user_project on public.offers (user_id, project_id);
create index if not exists offers_connection on public.offers (connection_id);

create or replace trigger offers_touch before insert or update on public.offers
  for each row execute function public.ylb_touch_updated_at();

alter table public.offers enable row level security;
revoke all on table public.offers from anon, authenticated;

-- ───────────── sales ─────────────

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null,
  offer_id text references public.offers (id) on delete set null,
  provider text not null,
  environment text not null,
  provider_account text not null,
  provider_payment_id text not null,
  provider_membership_id text,
  status text not null,
  amount_minor bigint not null default 0,
  refunded_minor bigint not null default 0,
  net_minor bigint,
  application_fee_minor bigint,
  currency text not null,
  buyer_email text,
  paid_at timestamptz,
  last_event_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_project_id_format check (project_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  constraint sales_provider_check check (provider in ('whop', 'stripe')),
  constraint sales_environment_check check (environment in ('sandbox', 'production')),
  constraint sales_status_check check (status in ('pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'disputed')),
  constraint sales_currency_format check (currency ~ '^[a-z]{3}$'),
  constraint sales_buyer_email_size check (buyer_email is null or length(buyer_email) <= 254),
  constraint sales_ids_size check (length(provider_account) <= 100 and length(provider_payment_id) <= 100 and (provider_membership_id is null or length(provider_membership_id) <= 100))
);

create unique index if not exists sales_one_per_payment on public.sales (provider, environment, provider_payment_id);
create index if not exists sales_user_project_paid on public.sales (user_id, project_id, paid_at desc);
create index if not exists sales_offer on public.sales (offer_id);

create or replace trigger sales_touch before insert or update on public.sales
  for each row execute function public.ylb_touch_updated_at();

alter table public.sales enable row level security;
revoke all on table public.sales from anon, authenticated;

-- ───────────── sale_refunds ─────────────

-- Each refund of a sale, once, by the provider's refund id: when a refund event doesn't carry its payment's own
-- refunded total, the sale's refunded amount is the sum of its distinct refunds (two $10 refunds are $20).
create table if not exists public.sale_refunds (
  provider text not null,
  environment text not null,
  refund_id text not null,
  provider_payment_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  amount_minor bigint not null default 0,
  created_at timestamptz not null default now(),
  primary key (provider, environment, refund_id),
  constraint sale_refunds_provider_check check (provider in ('whop', 'stripe')),
  constraint sale_refunds_environment_check check (environment in ('sandbox', 'production')),
  constraint sale_refunds_amount_check check (amount_minor >= 0),
  constraint sale_refunds_ids_size check (length(refund_id) <= 100 and length(provider_payment_id) <= 100)
);

create index if not exists sale_refunds_payment on public.sale_refunds (provider, environment, provider_payment_id);

alter table public.sale_refunds enable row level security;
revoke all on table public.sale_refunds from anon, authenticated;

-- ───────────── functions (server-only) ─────────────

-- One click on a buy link, counted in one statement (no read-modify-write race between copies of the server).
create or replace function public.offer_clicked(p_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.offers set clicks = clicks + 1, last_click_at = now() where id = p_id;
$$;

revoke execute on function public.offer_clicked(text) from public, anon, authenticated;
grant execute on function public.offer_clicked(text) to service_role;

-- A sale status's place: an event never moves a sale to an earlier one (server/offers/sales.mjs has the same table).
create or replace function public.ylb_sale_rank(p_status text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'pending' then 0 when 'failed' then 1 when 'paid' then 2
    when 'partially_refunded' then 3 when 'refunded' then 4 when 'disputed' then 5
    else -1 end;
$$;

revoke execute on function public.ylb_sale_rank(text) from public, anon, authenticated;
grant execute on function public.ylb_sale_rank(text) to service_role;

-- Record what a provider event says about one payment: 'inserted', 'updated' or 'kept'.
-- The status changes only to one of the same or a later rank, or (between pending and failed only) to a newer
-- event's. refunded_minor only grows; the other amounts, the email, the paid time and the membership are kept once
-- set. A row of another user is never changed. The row is locked while it's decided: two copies of the server
-- applying events of the same payment at once end the same as one after the other.
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
begin
  insert into public.sales (user_id, project_id, offer_id, provider, environment, provider_account, provider_payment_id,
    provider_membership_id, status, amount_minor, refunded_minor, net_minor, application_fee_minor, currency, buyer_email,
    paid_at, last_event_at)
  values ((p->>'user_id')::uuid, p->>'project_id', p->>'offer_id', p->>'provider', p->>'environment', p->>'provider_account',
    p->>'provider_payment_id', p->>'provider_membership_id', v_status, v_amount, v_refunded, (p->>'net_minor')::bigint,
    (p->>'application_fee_minor')::bigint, p->>'currency', p->>'buyer_email', (p->>'paid_at')::timestamptz, v_at)
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

  if n_status is not distinct from r.status and n_at is not distinct from r.last_event_at
    and n_refunded = r.refunded_minor and n_amount = r.amount_minor and n_net is not distinct from r.net_minor
    and n_email is not distinct from r.buyer_email and n_paid is not distinct from r.paid_at
    and n_member is not distinct from r.provider_membership_id then
    return 'kept';
  end if;

  update public.sales set status = n_status, last_event_at = n_at, refunded_minor = n_refunded, amount_minor = n_amount,
    net_minor = n_net, buyer_email = n_email, paid_at = n_paid, provider_membership_id = n_member
    where id = r.id;
  return 'updated';
end;
$$;

revoke execute on function public.record_sale(jsonb) from public, anon, authenticated;
grant execute on function public.record_sale(jsonb) to service_role;
