-- "Before your first ad" (docs/integrations-setup.md §3c): the customer's own answer that a business admin accepted
-- Meta's non-discrimination policy for the business's chosen Meta ad account. Meta offers no check for it before a
-- launch, so the app asks; nothing is enforced from it (Meta decides at the launch).
--
-- policy_confirmed_for holds the ad account id (act_…) the answer is for, so it never carries over when the business
-- picks another ad account; null is "not confirmed". policy_confirmed_at is when it was ticked. Server-only like the
-- rest of ad_account_choices. Safe to run again. Until it is run, the app shows the policy as not confirmed and
-- ticking the box says "couldn't be saved" (the server log says ads_policy_confirm_not_saved).
--
-- Check:  select project_id, ad_account_id, policy_confirmed_for, policy_confirmed_at from public.ad_account_choices
--           where platform = 'meta';

alter table public.ad_account_choices add column if not exists policy_confirmed_for text;
alter table public.ad_account_choices add column if not exists policy_confirmed_at timestamptz;

alter table public.ad_account_choices drop constraint if exists ad_account_choices_policy_confirmed_shape;
alter table public.ad_account_choices add constraint ad_account_choices_policy_confirmed_shape
  check (policy_confirmed_for is null or (platform = 'meta' and policy_confirmed_for ~ '^act_[0-9]{1,30}$'));
