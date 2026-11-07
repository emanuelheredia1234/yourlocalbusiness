-- Why Zernio refused a launch or a change, kept with the job (server/ads/zernioAds.mjs refusalDetail). Until now a
-- refused job kept only our category in error_code (REFUSED for anything Zernio had no code of ours for), so the
-- customer read "Open Meta Ads Manager to see why" even when nothing had been created there.
--
-- error_detail holds the refusal's safe fields, as data: Zernio's ErrorResponse code, type and the field it named
-- (param), the failed step, its English hint (at most 300 characters) and fix link ({ label, url }: https on Meta's,
-- Google's or Zernio's own site only), and for a Meta platform error Meta's subcode and its own title and message
-- (cut). A team-level problem (our Zernio plan, add-on, billing, key or rate limits) keeps its code and type only,
-- with owner: true. error_code keeps its meaning (our category). The app shows our own sentence for the codes it
-- knows and Zernio's hint, labelled as Meta's message, only for the rest; the audit row of the same job keeps the
-- same fields in `after` ({ refusal }).
--
-- Nullable (older jobs have none), server-only like the rest of ad_jobs. Safe to run again. The server still
-- finishes jobs before this is run (without the detail), and says so in its log (ads_error_detail_not_saved).
--
-- Check:  select error_code, error_detail ->> 'code' as zernio_code, count(*) from public.ad_jobs
--           where state = 'failed' group by 1, 2 order by 3 desc;

alter table public.ad_jobs add column if not exists error_detail jsonb;

-- a small object, never a list, text or a whole platform payload
alter table public.ad_jobs drop constraint if exists ad_jobs_error_detail_shape;
alter table public.ad_jobs add constraint ad_jobs_error_detail_shape
  check (error_detail is null or (jsonb_typeof(error_detail) = 'object' and pg_column_size(error_detail) <= 4096));
