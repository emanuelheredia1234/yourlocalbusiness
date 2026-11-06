-- P1b: weekly AI video limits (shared/plans.json videosPerWeek: Launch 3, Grow 5, Scale unlimited) per business.
-- Safe to run again.
--
-- video_starts: one row per AI video the server started (POST /api/ai/video, which the composer, the video panel and
-- the assistant's make_video all use). week_start is the Monday of the business's week (Monday 00:00 to Sunday 23:59
-- in its time zone), worked out by the server. state: 'pending' while the provider is being asked, 'started' once it
-- accepted the job, 'refunded' when it certainly never started (a refusal before any paid work): refunded rows never
-- count. own_key: made with the user's own AI key; recorded, never counted (own keys never use credits either).
-- Row-level security is on with no policies: only the server, with the secret key, reads or writes it.
--
-- Check:  select week_start, project_id, state, count(*) from public.video_starts group by 1, 2, 3 order by 1 desc;

create table if not exists public.video_starts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null default '',
  week_start date not null,
  state text not null default 'pending' check (state in ('pending', 'started', 'refunded')),
  own_key boolean not null default false,
  job_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists video_starts_user_week on public.video_starts (user_id, week_start);

alter table public.video_starts enable row level security;
revoke all on table public.video_starts from anon, authenticated;

-- Claims one video start for a business's week, atomically: a transaction-scoped advisory lock per user and week
-- means two parallel starts can never both pass at the limit (on any copy of the server). p_limit: the business's
-- weekly limit (null = unlimited, or plans not enforced: counted, never refused). p_user_limit: the account's total
-- for the week (the limit times its businesses), so made-up business ids can't get around the limit. p_own: own-key
-- videos are recorded but never counted or refused.
-- p_id: the claim's id, made by the server before it asks, so a claim whose answer was lost (a timeout) can still be
-- settled ('refunded' when the server then refuses the video).
-- Returns {ok, id?, used, limit, reason?}: used = this business's counted videos this week, including this one; for
-- reason 'account', used and limit are the account's (so the app's count matches the refusal).
drop function if exists public.ylb_claim_video_start(uuid, text, date, int, int, boolean);
create or replace function public.ylb_claim_video_start(
  p_id uuid,
  p_user uuid,
  p_project text,
  p_week date,
  p_limit int default null,
  p_user_limit int default null,
  p_own boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  proj text := coalesce(p_project, '');
  own boolean := coalesce(p_own, false);
  used_project int;
  used_user int;
  new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('ylb_video_week:' || p_user::text || ':' || p_week::text, 0));
  select count(*) filter (where s.project_id = proj), count(*)
    into used_project, used_user
    from public.video_starts s
   where s.user_id = p_user and s.week_start = p_week and s.state <> 'refunded' and not s.own_key;
  if not own then
    if p_limit is not null and used_project >= p_limit then
      return jsonb_build_object('ok', false, 'used', used_project, 'limit', p_limit, 'reason', 'business');
    end if;
    if p_user_limit is not null and used_user >= p_user_limit then
      return jsonb_build_object('ok', false, 'used', used_user, 'limit', p_user_limit, 'reason', 'account');
    end if;
  end if;
  new_id := coalesce(p_id, gen_random_uuid());
  insert into public.video_starts (id, user_id, project_id, week_start, own_key)
  values (new_id, p_user, proj, p_week, own)
  on conflict (id) do nothing;
  return jsonb_build_object('ok', true, 'id', new_id, 'used', used_project + case when own then 0 else 1 end, 'limit', p_limit);
end;
$$;

revoke execute on function public.ylb_claim_video_start(uuid, uuid, text, date, int, int, boolean) from public, anon, authenticated;
grant execute on function public.ylb_claim_video_start(uuid, uuid, text, date, int, int, boolean) to service_role;
