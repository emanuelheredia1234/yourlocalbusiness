-- The public marketplace (P7): listings their sellers chose to put on the web, at /market/<slug> on the app's own
-- host, and the reports visitors send about them (docs/integrations-setup.md §17, server/market/).
--
--   public_listings          one row per listing a seller put on the web: its text (stored plain, as typed after the
--                            server's cleanup, escaped every time it is shown), its hosted images (public-files/<uid>/
--                            l-…, never data URLs), its offer (the P3/P6 buy link), the address it got the first time
--                            (never changed), the last quality check (why it isn't indexable yet), and one status:
--                            live (indexed), thin (public, noindex), held (visitor reports, noindex), over_limit (a
--                            downgrade), unlisted (the seller turned it off) or hidden (the app's owner did).
--   public_listing_reports   visitors' and users' reports: a reason, a short note, a keyed hash of who sent it (never
--                            an address), one per reporter per listing per day; the owner dismisses or acts on them.
--   ylb_market_set_public    the one write path for "Public on the web": a lock per seller, then the plan's limit and
--                            the per-day count, then the upsert (two toggles at once never pass the limit).
--
-- Row-level security is on with NO policies: only the server's secret key reads or writes these tables (the browser
-- never does; visitors only ever see pages the server renders). The in-app market_listings table is not changed.
-- Deleting an account deletes its rows (foreign keys). Run it after 20261118000000_stripe_connect.sql. Safe to run
-- again.
--
-- Owner step: run this file once in Supabase (SQL editor → paste → Run). Safe to run again.
--
-- Check:     select status, count(*) from public.public_listings group by 1 order by 1;
--            select slug, status, quality->'missing' from public.public_listings order by updated_at desc limit 20;
--            select reason, status, count(*) from public.public_listing_reports group by 1, 2 order by 1, 2;
-- Roll back: set MARKET_PUBLIC=off on the server (every /market page "not found", the API 503). Dropping the two
--            tables loses only the public copies; the in-app listings stay.

-- ───────────── tables ─────────────

-- The search column's text. A generated column needs an immutable expression, and array_to_string is only stable,
-- so it lives in this immutable SQL function (it reads nothing but its arguments).
create or replace function public.ylb_market_search_text(p_title text, p_tagline text, p_category text, p_tags text[])
  returns tsvector
  language sql immutable parallel safe set search_path = '' as $$
  select pg_catalog.to_tsvector('simple'::regconfig,
    p_title || ' ' || coalesce(p_tagline, '') || ' ' || p_category || ' ' || coalesce(pg_catalog.array_to_string(p_tags, ' '), ''))
$$;

create table if not exists public.public_listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  listing_id text not null check (char_length(listing_id) between 1 and 80),
  project_id text not null check (project_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$'),
  kind text not null check (kind in ('product', 'business')),
  title text not null check (char_length(title) between 4 and 120),
  tagline text not null default '' check (char_length(tagline) <= 160),
  description text not null check (char_length(description) between 80 and 5000 and octet_length(description) <= 20000),
  category text not null check (char_length(category) between 1 and 60),
  category_slug text not null check (category_slug ~ '^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$|^[a-z0-9]$'),
  tags text[] not null default '{}' check (cardinality(tags) <= 10),
  price_minor bigint check (price_minor is null or price_minor >= 0),
  currency text not null default 'usd' check (currency in ('usd')),
  price_model text not null check (price_model in ('one-time', 'monthly', 'yearly', 'per-session', 'project', 'quote', 'free')),
  compare_at_minor bigint check (compare_at_minor is null or compare_at_minor >= 0),
  services jsonb not null default '[]' check (jsonb_typeof(services) = 'array' and jsonb_array_length(services) <= 12 and octet_length(services::text) <= 8000),
  includes text[] not null default '{}' check (cardinality(includes) <= 8),
  location jsonb check (location is null or (jsonb_typeof(location) = 'object' and octet_length(location::text) <= 400)),
  seller_name text not null check (char_length(seller_name) between 1 and 80),
  website text check (website is null or (char_length(website) <= 300 and website like 'https://%')),
  outside_buy_url text check (outside_buy_url is null or (char_length(outside_buy_url) <= 300 and outside_buy_url like 'https://%')),
  phone text check (phone is null or char_length(phone) <= 32),
  offer_id text check (offer_id is null or offer_id ~ '^[A-Za-z0-9_-]{22}$'),
  cover_path text check (cover_path is null or cover_path ~ '^[0-9a-f-]{36}/l-[A-Za-z0-9_-]{22}\.(jpg|png|webp|gif)$'),
  gallery_paths text[] not null default '{}' check (cardinality(gallery_paths) <= 3),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  quality jsonb not null default '{}' check (jsonb_typeof(quality) = 'object' and octet_length(quality::text) <= 2000),
  status text not null check (status in ('live', 'thin', 'held', 'unlisted', 'hidden', 'over_limit')),
  public_at timestamptz,
  content_updated_at timestamptz not null default now(),
  unlisted_at timestamptz,
  hidden_at timestamptz,
  hidden_reason text check (hidden_reason is null or hidden_reason in ('spam', 'scam', 'prohibited', 'offensive', 'misleading', 'other')),
  held_at timestamptz,
  report_count integer not null default 0 check (report_count >= 0),
  search tsvector generated always as (public.ylb_market_search_text(title, tagline, category, tags)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, listing_id)
);

create index if not exists public_listings_live on public.public_listings (status, content_updated_at desc) where status = 'live';
create index if not exists public_listings_cat on public.public_listings (category_slug, content_updated_at desc) where status = 'live';
create index if not exists public_listings_user on public.public_listings (user_id);
create index if not exists public_listings_hash on public.public_listings (content_hash);
create index if not exists public_listings_search on public.public_listings using gin (search);

drop trigger if exists public_listings_touch on public.public_listings;
create trigger public_listings_touch before update on public.public_listings
  for each row execute function public.ylb_touch_updated_at();

create table if not exists public.public_listing_reports (
  id uuid primary key default gen_random_uuid(),
  public_listing_id uuid not null references public.public_listings (id) on delete cascade,
  reason text not null check (reason in ('spam', 'scam', 'prohibited', 'offensive', 'misleading', 'other')),
  note text not null default '' check (char_length(note) <= 500),
  reporter_hash text not null check (reporter_hash ~ '^[0-9a-f]{64}$'),
  reporter_kind text not null check (reporter_kind in ('visitor', 'user')),
  day date not null,
  status text not null default 'open' check (status in ('open', 'dismissed', 'actioned')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (public_listing_id, reporter_hash, day)
);

create index if not exists public_listing_reports_open on public.public_listing_reports (status, created_at desc);
create index if not exists public_listing_reports_listing on public.public_listing_reports (public_listing_id, created_at desc);

-- Only the server (the secret key) reads or writes: RLS on, no policies, nothing granted to the browser's roles.
alter table public.public_listings enable row level security;
alter table public.public_listing_reports enable row level security;
revoke all on table public.public_listings, public.public_listing_reports from anon, authenticated;
comment on table public.public_listings is 'P7 public marketplace: server-only (RLS on, no policies). Visitors see server-rendered pages only.';
comment on table public.public_listing_reports is 'P7 visitor reports: server-only (RLS on, no policies). No addresses: reporter_hash is a keyed hash.';

-- ───────────── the one write path ─────────────

-- p_row: the server's validated columns (kind … status). Keeps an existing row's slug, public_at, hidden and held
-- state. → {ok: true, row} | {ok: false, code: 'HIDDEN' | 'LIMIT' | 'DAILY', used?}. A slug taken by another row
-- raises unique_violation (the server picks another and calls again).
create or replace function public.ylb_market_set_public(p_user uuid, p_listing_id text, p_limit int, p_new_per_day int, p_row jsonb)
  returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
declare
  v_old public.public_listings;
  v_new public.public_listings;
  v_used int;
  v_today int;
  r public.public_listings;
begin
  perform pg_advisory_xact_lock(hashtext('market:' || p_user::text));
  select * into v_old from public.public_listings where user_id = p_user and listing_id = p_listing_id;
  if found and v_old.hidden_at is not null then
    return jsonb_build_object('ok', false, 'code', 'HIDDEN');
  end if;
  select count(*) into v_used from public.public_listings
    where user_id = p_user and listing_id <> p_listing_id and status in ('live', 'thin', 'held');
  if p_limit is not null and v_used >= p_limit then
    return jsonb_build_object('ok', false, 'code', 'LIMIT', 'used', v_used);
  end if;
  if v_old.id is null and p_new_per_day is not null then
    select count(*) into v_today from public.public_listings
      where user_id = p_user and public_at > now() - interval '24 hours';
    if v_today >= p_new_per_day then
      return jsonb_build_object('ok', false, 'code', 'DAILY');
    end if;
  end if;
  r := jsonb_populate_record(null::public.public_listings, p_row);
  insert into public.public_listings as t (
    user_id, listing_id, project_id, slug, kind, title, tagline, description, category, category_slug, tags,
    price_minor, currency, price_model, compare_at_minor, services, includes, location, seller_name, website,
    outside_buy_url, phone, offer_id, cover_path, gallery_paths, content_hash, quality, status, public_at,
    content_updated_at
  ) values (
    p_user, p_listing_id, r.project_id, r.slug, r.kind, r.title, coalesce(r.tagline, ''), r.description, r.category,
    r.category_slug, coalesce(r.tags, '{}'), r.price_minor, coalesce(r.currency, 'usd'), r.price_model,
    r.compare_at_minor, coalesce(r.services, '[]'), coalesce(r.includes, '{}'), r.location, r.seller_name, r.website,
    r.outside_buy_url, r.phone, r.offer_id, r.cover_path, coalesce(r.gallery_paths, '{}'), r.content_hash,
    coalesce(r.quality, '{}'), r.status, now(), now()
  )
  on conflict (user_id, listing_id) do update set
    project_id = excluded.project_id, kind = excluded.kind, title = excluded.title, tagline = excluded.tagline,
    description = excluded.description, category = excluded.category, category_slug = excluded.category_slug,
    tags = excluded.tags, price_minor = excluded.price_minor, currency = excluded.currency,
    price_model = excluded.price_model, compare_at_minor = excluded.compare_at_minor, services = excluded.services,
    includes = excluded.includes, location = excluded.location, seller_name = excluded.seller_name,
    website = excluded.website, outside_buy_url = excluded.outside_buy_url, phone = excluded.phone,
    offer_id = excluded.offer_id, cover_path = excluded.cover_path, gallery_paths = excluded.gallery_paths,
    content_hash = excluded.content_hash, quality = excluded.quality,
    status = case when t.held_at is not null then 'held' else excluded.status end,
    public_at = coalesce(t.public_at, excluded.public_at),
    content_updated_at = now(), unlisted_at = null
  returning * into v_new;
  return jsonb_build_object('ok', true, 'row', to_jsonb(v_new) - 'search');
end $$;

revoke all on function public.ylb_market_set_public(uuid, text, int, int, jsonb) from public, anon, authenticated;
