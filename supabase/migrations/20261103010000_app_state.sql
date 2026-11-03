-- The app server's own settings, kept here so they survive restarts and every copy of the server
-- shares them: the owner's AI keys and their settings, the Manus tasks the app started, and the usage
-- log. Each value is encrypted by the server. Row-level security is on with no policies, so browsers
-- can't read or write it at all; only the server, with the secret key, can. Safe to run again.

create table if not exists public.app_state (
  key text primary key check (char_length(key) between 1 and 80),
  ciphertext text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;
revoke all on table public.app_state from anon, authenticated;

-- The app's owner (manages the AI keys everyone uses) can also be set here, independent of the
-- ADMIN_EMAILS Secret. Users can't change app_metadata themselves. For example:
--   update auth.users set raw_app_meta_data = raw_app_meta_data || '{"ylb_role": "admin"}'::jsonb
--   where lower(email) = 'owner@example.com';
