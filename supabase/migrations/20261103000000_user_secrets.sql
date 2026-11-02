-- Each user's own API keys (e.g. Manus), encrypted by the app's server.
-- Row-level security is on with no policies, so browsers (anon and signed-in users) can't read or
-- write it at all; only the server, with the secret key, can. Safe to run again.

create table if not exists public.user_secrets (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('manus')),
  ciphertext text not null,
  last4 text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.user_secrets enable row level security;
revoke all on table public.user_secrets from anon, authenticated;
