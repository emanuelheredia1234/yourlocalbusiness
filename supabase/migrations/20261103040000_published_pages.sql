-- Published pages: an SEO page or an artifact at a public address (https://<app>/<slug>), and the
-- owners' own domains they can also show on (https://<domain>/<slug>, or the domain's home page).
--
-- The browser never reads or writes these tables: it publishes through the server (/api/pages,
-- /api/domains), which checks the address and the images, and serves the pages to visitors.
-- Row-level security is on with no policies, so only the server, with the secret key, reaches them.
-- A page's images are kept in the private media bucket, at media/<user id>/published/<page>/<name>,
-- so deleting an account removes them with the user's other files. Safe to run again.

-- ── Domains: added by one account; verified once its TXT record _ylb-domain.<domain> has that account's token ──
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
-- the server keeps the names that exist in memory, and reads what changed since it last looked
create index if not exists published_pages_updated on public.published_pages (updated_at);
create index if not exists published_domains_verified on public.published_domains (verified_at);

-- A page is on a domain only while its owner has that domain: a publish that was under way when the domain
-- changed hands is refused, and a domain changes hands only once the previous owner's pages are off it.
-- Checked when each change is saved (deferred), so removing a domain still just takes it off its pages first
-- (the foreign key above: on delete set null). Pages from before this, on a domain someone else has now,
-- come off it here.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'published_domains_domain_user' and conrelid = 'public.published_domains'::regclass) then
    alter table public.published_domains add constraint published_domains_domain_user unique (domain, user_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'published_pages_domain_owner' and conrelid = 'public.published_pages'::regclass) then
    update public.published_pages p set domain = null, home = false
      where p.domain is not null
        and not exists (select 1 from public.published_domains d where d.domain = p.domain and d.user_id = p.user_id);
    alter table public.published_pages add constraint published_pages_domain_owner
      foreign key (domain, user_id) references public.published_domains (domain, user_id)
      deferrable initially deferred;
  end if;
end
$$;

-- updated_at is the server's clock (public.ylb_touch_updated_at is in 20261102000000_accounts.sql)
-- "create or replace" (Postgres 14+) keeps this re-runnable without a drop statement
create or replace trigger published_pages_touch before insert or update on public.published_pages
  for each row execute function public.ylb_touch_updated_at();

alter table public.published_domains enable row level security;
alter table public.published_pages enable row level security;
revoke all on table public.published_domains from anon, authenticated;
revoke all on table public.published_pages from anon, authenticated;
