-- Yourlocalbusiness accounts: each user's saved data and media files.
--
-- Run once in Supabase (SQL editor → paste → Run), or let the Supabase GitHub integration apply
-- it from this folder. Safe to run again.

-- ───────────── saved data: one row per project, post, ad, skill, listing, order, … ─────────────

create table if not exists public.user_docs (
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('project', 'post', 'ad', 'skill', 'gen', 'listing', 'order', 'sale', 'notice', 'settings')),
  id text not null check (char_length(id) between 1 and 80),
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, id)
);

create index if not exists user_docs_user_updated on public.user_docs (user_id, updated_at);

alter table public.user_docs enable row level security;

drop policy if exists "Users read their own docs" on public.user_docs;
create policy "Users read their own docs" on public.user_docs
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Users add their own docs" on public.user_docs;
create policy "Users add their own docs" on public.user_docs
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "Users change their own docs" on public.user_docs;
create policy "Users change their own docs" on public.user_docs
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "Users delete their own docs" on public.user_docs;
create policy "Users delete their own docs" on public.user_docs
  for delete to authenticated using ((select auth.uid()) = user_id);

-- updated_at is the server's clock, so devices agree on what changed when
create or replace function public.ylb_touch_updated_at() returns trigger
  language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_docs_touch on public.user_docs;
create trigger user_docs_touch before insert or update on public.user_docs
  for each row execute function public.ylb_touch_updated_at();

-- ───────────── media files: uploads, AI images and videos, product PDFs and spreadsheets ─────────────

insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', false, 52428800)
on conflict (id) do nothing;

-- each user reads and writes only the folder named after their id: media/<user id>/<file id>
drop policy if exists "Users read their own media" on storage.objects;
create policy "Users read their own media" on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Users upload their own media" on storage.objects;
create policy "Users upload their own media" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Users replace their own media" on storage.objects;
create policy "Users replace their own media" on storage.objects
  for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Users delete their own media" on storage.objects;
create policy "Users delete their own media" on storage.objects
  for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
