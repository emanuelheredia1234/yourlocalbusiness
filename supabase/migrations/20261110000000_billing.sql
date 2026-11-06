-- Plans and billing (Launch, Grow, Scale): docs/integrations-setup.md "Plans and billing".
--
--   billing_settings  one row: whether plans are enforced (off until the owner turns them on), the optional card trial
--                     and the free days existing accounts get when plans start. Server-only.
--   billing_accounts  one row per user: their plan as last read from Stripe (or a free/owner plan), their business
--                     limit, pending removals and downgrades, grace after a failed payment. Server-only.
--   billing_ops       one row per money operation (add or remove a business, change plan, cancel on account
--                     deletion): each is sent to Stripe once, never resent; at most one in flight per user. Server-only.
--   project_slots     which of a user's businesses (user_docs kind 'project') are active on their plan. Users read
--                     their own rows; only the functions below and the server write them.
--
-- While billing_settings.enforce is false (the default) nothing changes for anyone: every new project gets a slot
-- (a trigger), so older app versions that never claim one keep working, and the user_docs rule lets every write in.
-- Safe to run again.
--
-- Check it:   select * from public.billing_settings;
--             select status, count(*) from public.billing_accounts group by 1;
--             select state, count(*) from public.project_slots group by 1;
-- Roll back plans without losing anything: update public.billing_settings set enforce = false;

-- ───────────── tables ─────────────

create table if not exists public.billing_settings (
  id smallint primary key default 1 check (id = 1),
  enforce boolean not null default false,
  enforced_at timestamptz,
  card_trial_days int not null default 0 check (card_trial_days between 0 and 14),
  existing_trial_days int not null default 30 check (existing_trial_days between 0 and 90),
  updated_at timestamptz not null default now()
);
insert into public.billing_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.billing_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  customer_tag text not null unique check (customer_tag ~ '^cust_[0-9a-f]{24}$'),
  source text not null check (source in ('stripe', 'comp', 'owner')),
  tier text not null default 'none' check (tier in ('none', 'launch', 'grow', 'scale', 'owner')),
  interval text check (interval in ('month', 'year')),
  status text not null default 'none' check (status in ('none', 'trialing', 'active', 'past_due', 'unpaid', 'canceled',
    'incomplete', 'incomplete_expired', 'paused', 'expired')),
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  tier_item_id text,
  business_item_id text,
  extra_businesses int not null default 0 check (extra_businesses >= 0),
  comp_extra int not null default 0 check (comp_extra >= 0),
  -- null = unlimited (the owner)
  business_limit int check (business_limit is null or business_limit >= 1),
  extra_keep int not null default 0 check (extra_keep >= 0),
  extra_keep_until timestamptz,
  tier_keep text check (tier_keep in ('launch', 'grow', 'scale')),
  tier_keep_until timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  billing_anchor timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  ended_at timestamptz,
  trial_ends_at timestamptz,
  grace_until timestamptz,
  comp_until timestamptz,
  comp_note text check (char_length(comp_note) <= 500),
  checkout_session_id text,
  checkout_expires_at timestamptz,
  -- the time of the Stripe read this row reflects: an older read never overwrites a newer one
  stripe_fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists billing_accounts_status on public.billing_accounts (status);
create index if not exists billing_accounts_period_end on public.billing_accounts (current_period_end);
create index if not exists billing_accounts_grace on public.billing_accounts (grace_until) where grace_until is not null;

create table if not exists public.billing_ops (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('add_business', 'remove_business', 'undo_remove', 'change_plan', 'cancel_for_delete', 'checkout')),
  client_request_id uuid not null,
  state text not null check (state in ('sending', 'done', 'failed', 'unknown', 'not_applied')),
  -- {from:{qty,tier,interval}, to:{…}, projectId?}: never secrets
  request jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  -- {subscription, invoice}: ids only
  stripe_ref jsonb not null default '{}'::jsonb,
  -- our code (CARD_DECLINED, UNAVAILABLE, DRIFT), never Stripe's text
  error_code text,
  requested_at timestamptz not null default now(),
  finished_at timestamptz,
  checked_at timestamptz,
  unique (user_id, client_request_id)
);
-- at most one money operation in flight per user (a second answers 409 BILLING_PENDING)
create unique index if not exists billing_ops_one_live on public.billing_ops (user_id) where state in ('sending', 'unknown');
create index if not exists billing_ops_unknown on public.billing_ops (requested_at) where state = 'unknown';

create table if not exists public.project_slots (
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null check (char_length(project_id) between 1 and 80),
  state text not null check (state in ('active', 'locked')),
  claimed_at timestamptz not null default now(),
  lock_at timestamptz,
  locked_at timestamptz,
  locked_reason text check (locked_reason in ('limit', 'removed', 'plan_ended', 'payment')),
  primary key (user_id, project_id)
);
create index if not exists project_slots_lock_at on public.project_slots (lock_at) where lock_at is not null;

alter table public.billing_settings enable row level security;
alter table public.billing_accounts enable row level security;
alter table public.billing_ops enable row level security;
alter table public.project_slots enable row level security;
revoke all on table public.billing_settings, public.billing_accounts, public.billing_ops from anon, authenticated;
revoke insert, update, delete on table public.project_slots from anon, authenticated;
grant select on table public.project_slots to authenticated;

drop policy if exists "Users read their own slots" on public.project_slots;
create policy "Users read their own slots" on public.project_slots
  for select to authenticated using ((select auth.uid()) = user_id);

-- ───────────── functions ─────────────

create or replace function public.ylb_billing_enforced() returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce((select s.enforce from public.billing_settings s where s.id = 1), false);
$$;

create or replace function public.ylb_project_write_ok(p_user uuid, p_id text) returns boolean
  language sql stable security definer set search_path = '' as $$
  select not public.ylb_billing_enforced()
    or exists (select 1 from public.project_slots s where s.user_id = p_user and s.project_id = p_id and s.state = 'active');
$$;

-- whether an account may hold active businesses: a live (or past-due) Stripe plan, a free plan still running, the owner
create or replace function public.ylb_slot_eligible(a public.billing_accounts) returns boolean
  language sql stable set search_path = '' as $$
  select a.source = 'owner'
    or (a.status in ('active', 'trialing', 'past_due') and (a.source <> 'comp' or a.comp_until is null or a.comp_until > now()));
$$;

-- one slot change at a time per user (claims, applying limits, choosing which businesses stay active)
create or replace function public.ylb_slots_lock(p_user uuid) returns void
  language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('ylb_slots:' || p_user::text, 0));
$$;

-- called by the browser before it creates a project: {ok, state?, reason?: 'plan_required'|'limit'|'locked'|'bad_request', used?, limit?}
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

-- while plans aren't enforced every new project gets a slot, so every project has one when they start
create or replace function public.ylb_slot_on_project_insert() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if not public.ylb_billing_enforced() then
    insert into public.project_slots (user_id, project_id, state) values (new.user_id, new.id, 'active')
      on conflict (user_id, project_id) do nothing;
  end if;
  return new;
end;
$$;

-- deleting a business frees its slot
create or replace function public.ylb_slot_on_project_delete() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  delete from public.project_slots where user_id = old.user_id and project_id = old.id;
  return old;
end;
$$;

drop trigger if exists user_docs_slot_insert on public.user_docs;
create trigger user_docs_slot_insert before insert on public.user_docs
  for each row when (new.kind = 'project') execute function public.ylb_slot_on_project_insert();
drop trigger if exists user_docs_slot_delete on public.user_docs;
create trigger user_docs_slot_delete after delete on public.user_docs
  for each row when (old.kind = 'project') execute function public.ylb_slot_on_project_delete();

-- the account's limit applied to its slots: due removals locked, over the limit locked newest first, under it unlocked
-- oldest first (never a business the user removed). An account that can't hold businesses keeps its oldest one.
create or replace function public.ylb_apply_slots(p_user uuid) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
declare
  acct public.billing_accounts;
  lim int;
  eligible boolean;
  reason text;
  n_active int;
  oldest text;
begin
  perform public.ylb_slots_lock(p_user);
  update public.project_slots set state = 'locked', locked_at = now(), locked_reason = 'removed', lock_at = null
    where user_id = p_user and lock_at is not null and lock_at <= now();
  if not public.ylb_billing_enforced() then
    return jsonb_build_object('active', (select count(*) from public.project_slots where user_id = p_user and state = 'active'),
      'locked', (select count(*) from public.project_slots where user_id = p_user and state = 'locked'));
  end if;
  select * into acct from public.billing_accounts where user_id = p_user;
  if acct.user_id is null then
    -- no plan row yet (a new sign-up): nothing to change
    return jsonb_build_object('active', (select count(*) from public.project_slots where user_id = p_user and state = 'active'),
      'locked', (select count(*) from public.project_slots where user_id = p_user and state = 'locked'));
  end if;
  eligible := public.ylb_slot_eligible(acct) and acct.status <> 'unpaid';
  lim := acct.business_limit;
  if acct.source = 'owner' then
    lim := null;
  elsif not eligible then
    lim := 1;
  end if;
  reason := case when eligible then 'limit' when acct.status = 'unpaid' then 'payment' else 'plan_ended' end;
  if lim is not null then
    select count(*) into n_active from public.project_slots where user_id = p_user and state = 'active';
    if not eligible then
      select project_id into oldest from public.project_slots where user_id = p_user and state = 'active'
        order by claimed_at, project_id limit 1;
      update public.project_slots set state = 'locked', locked_at = now(), locked_reason = reason
        where user_id = p_user and state = 'active' and project_id is distinct from oldest;
    elsif n_active > lim then
      update public.project_slots set state = 'locked', locked_at = now(), locked_reason = reason
        where user_id = p_user and project_id in (
          select project_id from public.project_slots where user_id = p_user and state = 'active'
            order by claimed_at desc, project_id desc limit (n_active - lim));
    end if;
  end if;
  if eligible then
    select count(*) into n_active from public.project_slots where user_id = p_user and state = 'active';
    update public.project_slots set state = 'active', locked_at = null, locked_reason = null
      where user_id = p_user and project_id in (
        select project_id from public.project_slots where user_id = p_user and state = 'locked'
          and coalesce(locked_reason, '') <> 'removed'
          order by claimed_at, project_id
          limit case when lim is null then 2147483647 else greatest(0, lim - n_active) end);
  end if;
  return jsonb_build_object('active', (select count(*) from public.project_slots where user_id = p_user and state = 'active'),
    'locked', (select count(*) from public.project_slots where user_id = p_user and state = 'locked'));
end;
$$;

-- the user picks which businesses stay active (at most their limit; all must be theirs): {ok, active?, reason?}
create or replace function public.ylb_choose_active_slots(p_user uuid, p_ids text[]) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
declare
  acct public.billing_accounts;
  lim int;
  mine int;
begin
  perform public.ylb_slots_lock(p_user);
  select * into acct from public.billing_accounts where user_id = p_user;
  lim := case when acct.source = 'owner' then null when acct.user_id is null or not public.ylb_slot_eligible(acct) then 1 else acct.business_limit end;
  if p_ids is null or cardinality(p_ids) = 0 or (lim is not null and cardinality(p_ids) > lim) then
    return jsonb_build_object('ok', false, 'reason', 'limit', 'limit', lim);
  end if;
  select count(*) into mine from public.project_slots where user_id = p_user and project_id = any (p_ids);
  if mine <> cardinality(array(select distinct unnest(p_ids))) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  update public.project_slots set state = 'locked', locked_at = now(), locked_reason = 'limit'
    where user_id = p_user and state = 'active' and not (project_id = any (p_ids));
  update public.project_slots set state = 'active', locked_at = null, locked_reason = null, lock_at = null
    where user_id = p_user and project_id = any (p_ids);
  return jsonb_build_object('ok', true, 'active', cardinality(p_ids));
end;
$$;

-- the server writes what it read from Stripe (or a free plan): only when this read is not older than the stored one
create or replace function public.ylb_billing_apply(p_user uuid, p_row jsonb, p_fetched_at timestamptz) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
declare
  stored timestamptz;
  wrote boolean := false;
begin
  perform public.ylb_slots_lock(p_user);
  select stripe_fetched_at into stored from public.billing_accounts where user_id = p_user;
  if not found then
    insert into public.billing_accounts select * from jsonb_populate_record(null::public.billing_accounts,
      p_row || jsonb_build_object('user_id', p_user, 'stripe_fetched_at', p_fetched_at, 'created_at', now(), 'updated_at', now()));
    wrote := true;
  elsif stored is null or p_fetched_at is null or stored <= p_fetched_at then
    update public.billing_accounts a set
      (customer_tag, source, tier, interval, status, stripe_customer_id, stripe_subscription_id, tier_item_id,
       business_item_id, extra_businesses, comp_extra, business_limit, extra_keep, extra_keep_until, tier_keep,
       tier_keep_until, current_period_start, current_period_end, billing_anchor, cancel_at_period_end, canceled_at,
       ended_at, trial_ends_at, grace_until, comp_until, comp_note, checkout_session_id, checkout_expires_at,
       stripe_fetched_at, updated_at) =
      (select r.customer_tag, r.source, r.tier, r.interval, r.status, r.stripe_customer_id, r.stripe_subscription_id,
         r.tier_item_id, r.business_item_id, r.extra_businesses, r.comp_extra, r.business_limit, r.extra_keep,
         r.extra_keep_until, r.tier_keep, r.tier_keep_until, r.current_period_start, r.current_period_end,
         r.billing_anchor, r.cancel_at_period_end, r.canceled_at, r.ended_at, r.trial_ends_at, r.grace_until,
         r.comp_until, r.comp_note, r.checkout_session_id, r.checkout_expires_at, coalesce(p_fetched_at, a.stripe_fetched_at), now()
       from jsonb_populate_record(a, p_row) r)
      where a.user_id = p_user;
    wrote := true;
  end if;
  perform public.ylb_apply_slots(p_user);
  return wrote;
end;
$$;

-- plans start: every existing user with at least one business and no plan row gets free Grow for p_days with their
-- current number of businesses. p_tags: {user_id: customer_tag} (the server computes the tags). Returns rows added.
create or replace function public.ylb_billing_start_existing(p_days int, p_tags jsonb) returns int
  language plpgsql volatile security definer set search_path = '' as $$
declare
  added int;
begin
  with counts as (
    select d.user_id, count(*)::int as n from public.user_docs d
      where d.kind = 'project' and not exists (select 1 from public.billing_accounts a where a.user_id = d.user_id)
      group by d.user_id
  ), ins as (
    insert into public.billing_accounts (user_id, customer_tag, source, tier, status, trial_ends_at, comp_until, comp_extra,
      business_limit, comp_note)
    select c.user_id, p_tags ->> c.user_id::text, 'comp', 'grow', 'trialing', now() + make_interval(days => p_days),
      now() + make_interval(days => p_days), greatest(0, c.n - 1), greatest(1, c.n), 'existing account'
    from counts c where p_tags ? c.user_id::text
    on conflict (user_id) do nothing
    returning 1
  )
  select count(*) into added from ins;
  return added;
end;
$$;

revoke all on function public.ylb_billing_enforced() from public, anon;
revoke all on function public.ylb_project_write_ok(uuid, text) from public, anon;
revoke all on function public.ylb_slot_eligible(public.billing_accounts) from public, anon, authenticated;
revoke all on function public.ylb_slots_lock(uuid) from public, anon, authenticated;
revoke all on function public.claim_project_slot(text) from public, anon;
revoke all on function public.ylb_apply_slots(uuid) from public, anon, authenticated;
revoke all on function public.ylb_choose_active_slots(uuid, text[]) from public, anon, authenticated;
revoke all on function public.ylb_billing_apply(uuid, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.ylb_billing_start_existing(int, jsonb) from public, anon, authenticated;
grant execute on function public.ylb_billing_enforced() to authenticated, service_role;
grant execute on function public.ylb_project_write_ok(uuid, text) to authenticated, service_role;
grant execute on function public.claim_project_slot(text) to authenticated;
grant execute on function public.ylb_apply_slots(uuid) to service_role;
grant execute on function public.ylb_choose_active_slots(uuid, text[]) to service_role;
grant execute on function public.ylb_billing_apply(uuid, jsonb, timestamptz) to service_role;
grant execute on function public.ylb_billing_start_existing(int, jsonb) to service_role;

-- ───────────── user_docs: a project is written only while it holds an active slot (once plans are enforced) ─────────────
-- An upsert checks the insert rule on the proposed row too, so a locked business is refused both ways (intended).

drop policy if exists "Users add their own docs" on public.user_docs;
create policy "Users add their own docs" on public.user_docs
  for insert to authenticated
  with check ((select auth.uid()) = user_id and (kind <> 'project' or public.ylb_project_write_ok(user_id, id)));

drop policy if exists "Users change their own docs" on public.user_docs;
create policy "Users change their own docs" on public.user_docs
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id and (kind <> 'project' or public.ylb_project_write_ok(user_id, id)));

-- ───────────── backfill: every existing business has an active slot ─────────────

insert into public.project_slots (user_id, project_id, state, claimed_at)
select d.user_id, d.id, 'active', d.updated_at from public.user_docs d where d.kind = 'project'
on conflict (user_id, project_id) do nothing;
