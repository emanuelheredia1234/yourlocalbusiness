-- Yourlocalbusiness shared Marketplace: every signed-in person sees everyone's published listings,
-- and only the seller can add, change or remove their own. Buying happens on each seller's own
-- checkout link; nothing here takes payments.
--
-- Run once in Supabase (SQL editor → paste → Run). Safe to run again.

create table if not exists public.market_listings (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 80),
  -- the listing as the seller published it (images are small data URLs, capped by the app)
  data jsonb not null check (octet_length(data::text) <= 600000),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists market_listings_updated on public.market_listings (updated_at desc);

alter table public.market_listings enable row level security;

drop policy if exists "Signed-in people read every listing" on public.market_listings;
create policy "Signed-in people read every listing" on public.market_listings
  for select to authenticated using (true);

drop policy if exists "Sellers add their own listings" on public.market_listings;
create policy "Sellers add their own listings" on public.market_listings
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "Sellers change their own listings" on public.market_listings;
create policy "Sellers change their own listings" on public.market_listings
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "Sellers remove their own listings" on public.market_listings;
create policy "Sellers remove their own listings" on public.market_listings
  for delete to authenticated using ((select auth.uid()) = user_id);

-- updated_at is the server's clock (the function comes from the accounts migration)
drop trigger if exists market_listings_touch on public.market_listings;
create trigger market_listings_touch before insert or update on public.market_listings
  for each row execute function public.ylb_touch_updated_at();
