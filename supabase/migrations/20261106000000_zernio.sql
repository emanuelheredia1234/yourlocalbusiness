-- Connected social and ad accounts moved to Zernio (server/connections/zernio.mjs): its rows in the usage ledger
-- (per-customer Zernio calls and the monthly connected-account estimate) carry vendor 'zernio'. Nango stays for
-- future non-social integrations, so 'nango' stays allowed.
alter table public.usage_ledger drop constraint if exists usage_ledger_vendor_check;
alter table public.usage_ledger add constraint usage_ledger_vendor_check check (vendor in ('treg', 'zernio', 'nango', 'x', 'omnisend'));
