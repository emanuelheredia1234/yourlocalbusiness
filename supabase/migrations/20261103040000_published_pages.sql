-- Published pages: an SEO page or an artifact at a public address (https://<app>/<slug>), and the
-- owners' own domains they can also show on (https://<domain>/<slug>, or the domain's home page).
--
-- The browser never reads or writes these tables: it publishes through the server (/api/pages,
-- /api/domains), which checks the address and the images, and serves the pages to visitors.
-- Row-level security is on with no policies, so only the server, with the secret key, reaches them.
-- A page's images are kept in the private media bucket, at media/<user id>/published/<page>/<name>,
-- so deleting an account removes them with the user's other files. Safe to run again.

-- ── Domains: claimed by one account; verified once the domain answers with this app ──
create table if not exists public.published_domains (
  domain text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  token text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint published_domains_format check (length(domain) <= 253 and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
);

create index if not exists published_domains_user on public.published_domains (user_id);

-- ── Pages: one row per published page; the slug is its name on the app's address ──
create table if not exists public.published_pages (
  slug text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  page_id text not null,
  kind text not null check (kind in ('seo', 'artifact')),
  title text not null default '',
  html text not null,
  images jsonb not null default '[]'::jsonb,
  domain text references public.published_domains (domain) on delete set null,
  home boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint published_pages_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$'),
  constraint published_pages_page_id_format check (page_id ~ '^(seo|artifact):[A-Za-z0-9_-]{1,80}$'),
  constraint published_pages_html_size check (octet_length(html) <= 1500000),
  constraint published_pages_title_size check (length(title) <= 300),
  unique (user_id, page_id)
);

-- one home page per domain
create unique index if not exists published_pages_domain_home on public.published_pages (domain) where home;
create index if not exists published_pages_domain on public.published_pages (domain);
create index if not exists published_pages_user on public.published_pages (user_id);

-- updated_at is the server's clock (public.ylb_touch_updated_at is in 20261102000000_accounts.sql)
-- "create or replace" (Postgres 14+) keeps this re-runnable without a drop statement
create or replace trigger published_pages_touch before insert or update on public.published_pages
  for each row execute function public.ylb_touch_updated_at();

alter table public.published_domains enable row level security;
alter table public.published_pages enable row level security;
revoke all on table public.published_domains from anon, authenticated;
revoke all on table public.published_pages from anon, authenticated;
