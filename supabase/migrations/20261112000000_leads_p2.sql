-- P2: every published form and result reaches Email → Leads, and a lead magnet is a real file or link at /m/<id>.
-- Safe to run again.
--
-- page_leads gains the business it came from (project_id), where it came from (source: 'page' for an SEO page,
-- 'asset' for an artifact, 'magnet' for a lead-magnet download's email gate; always set by the server, never by
-- the visitor), what kind of form it was, whether the visitor ticked the box to get emails (consent), and a small
-- whitelisted payload (a quiz result, a calculator's inputs and outputs, the service asked for). Magnet sign-ups have
-- no page name (slug '').
--
-- published_pages gains project_id, written at publish, so an artifact's leads know their business.
--
-- lead_files: a lead magnet's download, one row per file or outside link, served at /m/<id>. The id is 16 random
-- bytes (22 base64url characters): permanent and unguessable, the only permission a visitor needs. The file itself
-- is in the private lead-files bucket (lead-files/<user id>/<id>/<version>/<name>), handed out through 60-second
-- signed links. public-files holds images only (no SVG): the lead magnet's cover now, email images later, at
-- public-files/<user id>/<22-character id>.<ext>; nothing lists it.
--
-- Row-level security is on with no policies (and no storage.objects policies for the two buckets): only the server,
-- with the secret key, reads or writes them. Deleting an account deletes its rows (on delete cascade); the server
-- clears the user's folders in all three buckets.
--
-- Check:  select source, kind, count(*) from public.page_leads group by 1, 2;
--         select id, kind, downloads from public.lead_files order by created_at desc limit 20;

-- ───────────── page_leads ─────────────

alter table public.page_leads add column if not exists project_id text;
alter table public.page_leads add column if not exists source text not null default 'page';
alter table public.page_leads add column if not exists kind text not null default 'form';
alter table public.page_leads add column if not exists consent boolean not null default false;
alter table public.page_leads add column if not exists payload jsonb not null default '{}'::jsonb;

alter table public.page_leads drop constraint if exists page_leads_page_id_format;
alter table public.page_leads add constraint page_leads_page_id_format check (page_id ~ '^(seo|artifact|magnet):[A-Za-z0-9_-]{1,80}$');
alter table public.page_leads drop constraint if exists page_leads_slug_format;
alter table public.page_leads add constraint page_leads_slug_format check (slug = '' or slug ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$');
alter table public.page_leads drop constraint if exists page_leads_project_id_format;
alter table public.page_leads add constraint page_leads_project_id_format check (project_id is null or project_id ~ '^[A-Za-z0-9_-]{1,80}$');
alter table public.page_leads drop constraint if exists page_leads_source_check;
alter table public.page_leads add constraint page_leads_source_check check (source in ('page', 'asset', 'magnet'));
alter table public.page_leads drop constraint if exists page_leads_kind_check;
alter table public.page_leads add constraint page_leads_kind_check check (kind in ('form', 'lead', 'booking', 'quiz', 'calculator', 'roi', 'checklist', 'magnet'));
alter table public.page_leads drop constraint if exists page_leads_payload_check;
alter table public.page_leads add constraint page_leads_payload_check check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8192);

-- SEO pages' ids are seo:<project id> (src/lib/seoPage.ts seoPageId: only [A-Za-z0-9_-]), so their leads' business is exact
update public.page_leads set project_id = substr(page_id, 5) where project_id is null and page_id like 'seo:%';

create index if not exists page_leads_user_project_created on public.page_leads (user_id, project_id, created_at desc);
create index if not exists page_leads_user_source_created on public.page_leads (user_id, source, created_at desc);

-- ───────────── published_pages ─────────────

alter table public.published_pages add column if not exists project_id text;
alter table public.published_pages drop constraint if exists published_pages_project_id_format;
alter table public.published_pages add constraint published_pages_project_id_format check (project_id is null or project_id ~ '^[A-Za-z0-9_-]{1,80}$');
update public.published_pages set project_id = substr(page_id, 5) where project_id is null and page_id like 'seo:%';

-- ───────────── lead_files ─────────────

create table if not exists public.lead_files (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null,
  title text not null default '',
  -- the business's name as the email gate shows it ("Email me tips and offers from <brand>")
  brand text not null default '',
  kind text not null,
  file_name text not null default '',
  mime text not null default '',
  bytes bigint not null default 0,
  sha256 text not null default '',
  object_path text not null default '',
  url text not null default '',
  gate boolean not null default true,
  cover_path text not null default '',
  downloads integer not null default 0,
  last_download_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_files_id_format check (id ~ '^[A-Za-z0-9_-]{22}$'),
  constraint lead_files_project_id_format check (project_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  constraint lead_files_title_size check (length(title) <= 200),
  constraint lead_files_brand_size check (length(brand) <= 120),
  constraint lead_files_kind_check check (kind in ('file', 'url')),
  constraint lead_files_file_name_size check (length(file_name) <= 120),
  constraint lead_files_bytes_range check (bytes between 0 and 26214400),
  constraint lead_files_url_format check (length(url) <= 2000 and (url = '' or url ~ '^https?://')),
  constraint lead_files_url_needed check ((kind = 'url' and url <> '') or kind = 'file')
);

-- (a table made by an earlier run of this file gets the column too)
alter table public.lead_files add column if not exists brand text not null default '';

create index if not exists lead_files_user_project on public.lead_files (user_id, project_id);

-- updated_at is the server's clock (public.ylb_touch_updated_at is in 20261102000000_accounts.sql)
create or replace trigger lead_files_touch before insert or update on public.lead_files
  for each row execute function public.ylb_touch_updated_at();

alter table public.lead_files enable row level security;
revoke all on table public.lead_files from anon, authenticated;

-- One download, counted in one statement (no read-modify-write race between copies of the server). Server-only.
create or replace function public.lead_file_downloaded(p_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.lead_files set downloads = downloads + 1, last_download_at = now() where id = p_id;
$$;

revoke execute on function public.lead_file_downloaded(text) from public, anon, authenticated;
grant execute on function public.lead_file_downloaded(text) to service_role;

-- ───────────── buckets (no storage.objects policies: only the server reaches them) ─────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lead-files', 'lead-files', false, 26214400,
  array[
    'application/pdf', 'application/epub+zip', 'application/zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'video/mp4'
  ]
)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('public-files', 'public-files', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;
