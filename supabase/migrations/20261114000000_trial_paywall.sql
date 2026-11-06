-- P1c: the paywall after onboarding, the 7-day card trial and the cancel survey (docs/integrations-setup.md
-- "Plans and billing" → "Free trial and cancelling"). Run after 20261110000000_billing.sql. Safe to run again.
--
--   claim_project_slot  a user's FIRST business is allowed without a plan (setup needs it); every other one still needs
--                       a plan with a free slot. Nothing changes while plans aren't enforced.
--   billing_settings    card_trial_days defaults to 7 (the owner's decision); a row still at 0 while plans are off is
--                       set to 7 (the owner can set it back in Customer usage › Plans).
--   billing_trials      one row per card trial that started: who, a keyed hash of their email and card fingerprint
--                       (never the card or the address), and what happened. One trial per person. Server-only.
--   cancel_surveys      why people cancel: in-app answers before cancelling, and the Customer Portal's own survey read
--                       from the subscription's cancellation_details. Server-only; the owner reads counts and comments.
--   billing_ops.kind    adds 'cancel' and 'resume' (cancel at period end / keep the plan) and 'end_trial' (a second
--                       trial on a card or email already used ends at once). Each is sent to Stripe once, never resent.
--
-- Check it:   select card_trial_days from public.billing_settings;
--             select outcome, count(*) from public.billing_trials group by 1;
--             select reason, count(*) from public.cancel_surveys group by 1 order by 2 desc;
-- Roll back:  the old claim_project_slot is in 20261110000000_billing.sql; the new tables can stay (nothing reads them
--             without this app version).

-- ───────────── the trial length ─────────────

alter table public.billing_settings alter column card_trial_days set default 7;
update public.billing_settings set card_trial_days = 7 where card_trial_days = 0 and enforce = false;

-- ───────────── trials ─────────────

create table if not exists public.billing_trials (
  subscription_id text primary key check (subscription_id ~ '^sub_[A-Za-z0-9_]{6,200}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  customer_tag text not null check (customer_tag ~ '^cust_[0-9a-f]{24}$'),
  -- HMAC-SHA256 with CUSTOMER_TAG_SECRET (hex): the same email or card matches, the value can't be read back
  email_hash text check (email_hash ~ '^[0-9a-f]{64}$'),
  card_hash text check (card_hash ~ '^[0-9a-f]{64}$'),
  tier text check (tier in ('launch', 'grow', 'scale')),
  started_at timestamptz not null default now(),
  trial_ends_at timestamptz,
  -- 'trialing' while it runs; 'duplicate' when this person or card had a trial before (it is ended at once);
  -- 'ended_early' once that end went through; 'end_failed' when Stripe refused it (the owner is alerted)
  outcome text not null default 'trialing' check (outcome in ('trialing', 'duplicate', 'ended_early', 'end_failed')),
  updated_at timestamptz not null default now()
);
create index if not exists billing_trials_user on public.billing_trials (user_id);
create index if not exists billing_trials_email on public.billing_trials (email_hash) where email_hash is not null;
create index if not exists billing_trials_card on public.billing_trials (card_hash) where card_hash is not null;

-- ───────────── cancel surveys ─────────────

create table if not exists public.cancel_surveys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  customer_tag text check (customer_tag ~ '^cust_[0-9a-f]{24}$'),
  -- 'app': the survey in Settings › Plan; 'portal': Stripe's Customer Portal survey (cancellation_details)
  source text not null check (source in ('app', 'portal')),
  reason text not null check (reason in ('too_expensive', 'not_using', 'missing_feature', 'results', 'switching',
    'too_hard', 'short_term', 'other')),
  comment text check (char_length(comment) <= 1000),
  -- the alternative the app offered (switch_plan, tips, tell_feature) and what the person did
  offer text check (offer in ('cheaper_plan', 'tips', 'tell_feature', 'none')),
  outcome text not null check (outcome in ('cancelled', 'kept', 'switched')),
  tier text check (tier in ('launch', 'grow', 'scale')),
  status text,
  subscription_id text,
  created_at timestamptz not null default now()
);
create index if not exists cancel_surveys_created on public.cancel_surveys (created_at desc);
-- the portal's answer is read on every sync of a cancelled subscription: kept once
create unique index if not exists cancel_surveys_portal_once on public.cancel_surveys (subscription_id) where source = 'portal';

alter table public.billing_trials enable row level security;
alter table public.cancel_surveys enable row level security;
revoke all on table public.billing_trials, public.cancel_surveys from anon, authenticated;

-- ───────────── money operations: cancel, resume, end a duplicate trial ─────────────

alter table public.billing_ops drop constraint if exists billing_ops_kind_check;
alter table public.billing_ops add constraint billing_ops_kind_check check (kind in ('add_business', 'remove_business',
  'undo_remove', 'change_plan', 'cancel_for_delete', 'checkout', 'cancel', 'resume', 'end_trial'));

-- ───────────── the first business needs no plan ─────────────

create or replace function public.claim_project_slot(p_project_id text) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  acct public.billing_accounts;
  existing public.project_slots;
  used int;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_project_id is null or char_length(p_project_id) not between 1 and 80 then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;
  perform public.ylb_slots_lock(uid);
  select * into existing from public.project_slots where user_id = uid and project_id = p_project_id;
  if found then
    if existing.state = 'active' then
      return jsonb_build_object('ok', true, 'state', 'active');
    end if;
    return jsonb_build_object('ok', false, 'reason', 'locked', 'state', 'locked');
  end if;
  if not public.ylb_billing_enforced() then
    insert into public.project_slots (user_id, project_id, state) values (uid, p_project_id, 'active');
    return jsonb_build_object('ok', true, 'state', 'active');
  end if;
  select * into acct from public.billing_accounts where user_id = uid;
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'ylb_role', '') = 'admin' or (found and acct.source = 'owner') then
    insert into public.project_slots (user_id, project_id, state) values (uid, p_project_id, 'active');
    return jsonb_build_object('ok', true, 'state', 'active');
  end if;
  if acct.user_id is null or not public.ylb_slot_eligible(acct) then
    -- no plan yet: the first business only (setup makes it before the plan is chosen); a plan that ended keeps its
    -- oldest business active anyway (ylb_apply_slots), so this only ever lets someone with no business at all start one
    if not exists (select 1 from public.project_slots where user_id = uid) then
      insert into public.project_slots (user_id, project_id, state) values (uid, p_project_id, 'active');
      return jsonb_build_object('ok', true, 'state', 'active', 'used', 1, 'limit', 1, 'starter', true);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'plan_required');
  end if;
  select count(*) into used from public.project_slots where user_id = uid and state = 'active';
  if acct.business_limit is not null and used >= acct.business_limit then
    return jsonb_build_object('ok', false, 'reason', 'limit', 'used', used, 'limit', acct.business_limit);
  end if;
  insert into public.project_slots (user_id, project_id, state) values (uid, p_project_id, 'active');
  return jsonb_build_object('ok', true, 'state', 'active', 'used', used + 1, 'limit', acct.business_limit);
end;
$$;
revoke all on function public.claim_project_slot(text) from public, anon;
grant execute on function public.claim_project_slot(text) to authenticated;
