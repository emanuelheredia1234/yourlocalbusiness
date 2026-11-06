-- Social accounts, posting and social stats moved to Upload-Post (server/connections/uploadpost.mjs); Zernio keeps
-- the ad accounts. Upload-Post's rows in the usage ledger (per-customer calls and the monthly estimated profile row)
-- carry vendor 'uploadpost'. No new tables: the per-customer Upload-Post doc lives in app_state, webhook repeats in
-- webhook_deliveries, and post_publish_jobs.provider_ref (jsonb) holds { via: 'upload_post', requestId, platform }.
alter table public.usage_ledger drop constraint if exists usage_ledger_vendor_check;
alter table public.usage_ledger add constraint usage_ledger_vendor_check check (vendor in ('treg', 'uploadpost', 'zernio', 'nango', 'x', 'omnisend'));
