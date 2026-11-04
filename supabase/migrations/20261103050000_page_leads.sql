-- Leads: what visitors send with a published page's form (a lead form page, a booking request, a question).
-- Visitors post the form to the server (POST /<name>/lead); owners read and delete their leads through the
-- server (/api/leads). Browsers never reach this table: row-level security is on with no policies, so only
-- the server, with the secret key, reads or writes it. Deleting an account deletes its leads. Safe to run again.

create table if not exists public.page_leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  slug text not null,
  page_id text not null,
  name text not null default '',
  email text not null default '',
  phone text not null default '',
  message text not null default '',
  time text not null default '',
  created_at timestamptz not null default now(),
  constraint page_leads_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$'),
  constraint page_leads_page_id_format check (page_id ~ '^(seo|artifact):[A-Za-z0-9_-]{1,80}$'),
  constraint page_leads_sizes check (length(name) <= 120 and length(email) <= 254 and length(phone) <= 40 and length(message) <= 2000 and length(time) <= 120),
  constraint page_leads_contact check (email <> '' or phone <> '')
);

create index if not exists page_leads_user_created on public.page_leads (user_id, created_at desc);
create index if not exists page_leads_user_page_created on public.page_leads (user_id, page_id, created_at desc);

alter table public.page_leads enable row level security;
revoke all on table public.page_leads from anon, authenticated;
