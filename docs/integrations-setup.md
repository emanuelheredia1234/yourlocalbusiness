# Connected accounts, posting, analytics and per-customer usage: owner setup

What this covers: each customer connects each of their businesses' own Facebook Page, Instagram, LinkedIn, TikTok, X
and YouTube accounts through **Upload-Post** (one Upload-Post profile per business) and their ad accounts (Meta, Google, LinkedIn, TikTok, Pinterest, Reddit,
Microsoft) through **Zernio**; both run on their own approved platform apps and hold the logins; the app posts for
them once they confirm; the Social, Ads, SEO page and Email Analytics tabs; the Marketing hub's **Update** button; "Submit to
Google" for the SEO page; and each customer's usage, caps and a CSV to bill from (through **treg**).

Who does what:

| Service | Used for |
|---|---|
| **Upload-Post** (Advanced, white-label) | Customers' social accounts (one profile per business, of 75), posting, post status, their own social stats |
| **Zernio** (formerly Late) | Ads only: customers' ad accounts and their ad results (read only; campaign changes later) |
| **treg** | Public social data, competitor ads, Google rank and Maps position, Search Console (on your own team connection), per-customer usage, caps and billing |
| **Omnisend** | Email stats |
| **Gmail** | Each customer’s own mailbox for later outreach (`gmail.send`). OAuth in the app, not Nango |
| **Manus** | Only "Post to Facebook groups" |
| **Nango** | Kept for future booking tools and CRMs only. Off until you set it up; never used for social, ads or Gmail |

Until a part's Secrets are set the app says so plainly and nothing breaks: every network shows "Not connected",
customers post themselves and press **Mark as posted**, and Manus still posts to Facebook groups.

**Rules that hold everywhere**
- Keys and tokens go only in **Replit Secrets**. Never paste one into the app, a chat, a file, a prompt or a
  screenshot. The app never shows or logs a key: at most its last 4 characters.
- The app never sends a post, a sitemap submission or an ad change twice by itself. When it can't tell whether
  something went out, it says so and offers **Check again** (a read) or **Post it yourself**.
- Text from other sites (captions, bios, ads, campaign names, error messages) is shown as text and never treated
  as instructions.

## 1. Secrets and settings

Values go only into Replit Secrets (Tools → Secrets). The server prints at startup which ones are missing, by
name only.

| Secret | What it's for | Notes |
|---|---|---|
| `CUSTOMER_TAG_SECRET` | Each customer's id (`cust_…`) for usage, their businesses' Upload-Post profile names (`ylb_…_…`) and their Zernio profile's `externalId` | 32+ random bytes. **Never change it**: each customer's history would split in two, and businesses connected after the change would get new profiles (names already made are stored and kept). |
| `UPLOAD_POST_API_KEY` | **Turns social accounts, posting and social stats on** (Upload-Post) | Your Upload-Post API key, from app.upload-post.com → API keys. Shown masked to its last 4 characters. |
| `UPLOAD_POST_WEBHOOK_SECRET` | Checks that account and post news really comes from Upload-Post | The `whsec_…` secret Upload-Post issues (§3, step 4). |
| `UPLOAD_POST_WEBHOOK_SECRET_PREVIOUS` | Only while rotating that secret | Upload-Post's rotation is immediate: keep the old one here until deliveries use the new one. |
| `ZERNIO_API_KEY` | **Turns ad accounts on** (Zernio, ads only) | Your Zernio API key (`sk_…`), from the Zernio dashboard → API keys. |
| `ZERNIO_WEBHOOK_SECRET` | Checks that ad-account news really comes from Zernio | A random string you choose (32+ characters); you give the same value to Zernio in §3a. |
| `ZERNIO_WEBHOOK_SECRET_PREVIOUS` | Only while rotating the webhook secret | Remove it once Zernio uses the new one. |
| `MEDIA_URL_SECRET` | Short-lived links to a post's photo or video (Upload-Post fetches them), and to a Meta ad's image | 32+ random bytes. **Needed to post photos and videos, and to launch on Meta.** |
| `ADS_REVIEW_SECRET` | Signs each ad launch or change review, so what is sent is exactly what the customer confirmed (§3c) | 32+ random bytes. Unset, the app derives one from `CUSTOMER_TAG_SECRET`. Changing it only makes open reviews stale. |
| `TREG_TOKEN` | Analytics data, competitor ads, Google rank, Search Console | A **member-role agent token** (`treg org agent-new ylb-app`). Not your own dashboard key. |
| `TREG_ADMIN_TOKEN` | Customer caps and the usage check against treg (billing only) | Admin-role agent token; only a team owner can make one. |
| `CRON_SECRET` | The bearer for `POST /api/cron/tick`, which runs the scheduled jobs (§2a) | 32+ random bytes (`openssl rand -hex 32`). The **same value** goes into the Supabase Vault secret `cron_secret`. Unset on the published app, no scheduled job runs (the tick answers 503 NOT_SET_UP). |
| `NANGO_SECRET_KEY` | Optional, later: other integrations (booking tools, CRMs) | Leave unset until you add one (§3b). Not used for Gmail. |
| `NANGO_WEBHOOK_SIGNING_KEY` | Optional, with Nango only | |
| `NANGO_WEBHOOK_SIGNING_KEY_PREVIOUS` | Only while rotating Nango's signing key | Remove it once Nango signs with the new one. |
| `GOOGLE_CLIENT_ID` | **Turns customer Gmail connect on** | The OAuth web client's id, from Google Cloud → Credentials (§3d). |
| `GOOGLE_CLIENT_SECRET` | With `GOOGLE_CLIENT_ID` | The OAuth web client's secret. Replit Secrets only. Never in the repo. |

Plain settings (not secret; Replit Secrets or env):

| Name | Default | Meaning |
|---|---|---|
| `TREG_ORG_ID` | — | Your treg team id (`treg org ls`). |
| `CONNECTIONS_PROVIDER` | unset | `off` keeps social and ad accounts off even with their keys set. |
| `UPLOAD_POST_RPM` | `150` | The app's own limit on Upload-Post calls per minute (plus 2 per profile; the Advanced plan allows 200 plus 2 per profile, and 1,000 per 10 minutes plus 10 per profile). |
| `UPLOAD_POST_ALERT_REMAINING` | `5` | How many free profile slots (of the plan's 75) are left when the owner is alerted. |
| `UPLOAD_POST_MAX_PROFILES_PER_USER` | `3` | How many of one user's businesses can have social accounts (one Upload-Post profile each), so one user making businesses can't use up the plan's 75. Past it the customer reads "You can connect social accounts for up to 3 businesses…" and you get an alert naming the customer. Raise it for everyone here. |
| `UPLOAD_POST_NEW_PROFILES_PER_DAY` | `20` | New Upload-Post profiles a day at most, for everyone together (a burst of throwaway sign-ups can't fill the plan); past it customers read "temporarily full" and you get an alert. A create Upload-Post refuses outright gives its slot back. One user can start at most `UPLOAD_POST_MAX_PROFILES_PER_USER` (at least 3) new profiles a day, so one user connecting, deleting and connecting again can't use up the day for everyone; past it that user reads "Try again tomorrow". |
| `UPLOAD_POST_RECLAIM_DAYS` | `7` | A business's profile with nothing connected for this many days goes back to the plan (it's made again, with the same name, on that business's next Connect). |
| `UPLOAD_POST_X_LINKS` | unset | `on` once you've bought Upload-Post's X Links add-on: links stay in X posts. Unset, the app tells customers links are taken out on X. |
| `UPLOAD_POST_X_LINK_POSTS_PER_CUSTOMER` | `5` | With X Links on: each customer's X posts with a link a month (the add-on's 50 are shared by everyone). |
| `UPLOAD_POST_BRAND_LOGO_URL` | — | An https link to your logo for Upload-Post's hosted connect page. |
| `UPLOAD_POST_CONNECT_TITLE` | `Connect your social accounts` | That page's title. |
| `UPLOAD_POST_CONNECT_DESCRIPTION` | a short default | That page's description. |
| `UPLOAD_POST_BACK_BUTTON_TEXT` | `Back to Yourlocalbusiness` | That page's back button. It opens Settings → Connected accounts (`/?settings=accounts#workspace-settings`) on the host of `GSC_APP_PROPERTY` (default `https://yourlocalbusiness.replit.app`). |
| `UPLOAD_POST_BASE_URL` | — | Tests and the mock only (`node server/test/mock-uploadpost.mjs`). |
| `ZERNIO_BASE_URL`, `NANGO_BASE_URL`, `TREG_BASE_URL` | — | Tests and mocks only; leave unset in production. |
| `MEDIA_PUBLIC_BASE_URL` | `ALLOWED_ORIGIN`, else `https://yourlocalbusiness.replit.app` | The public address Upload-Post fetches a post's photo or video from. Set it only if the app's public address is not one of those. |
| `ZERNIO_RPM` | `60` | The app's own limit on Zernio calls per minute. Zernio allows 60 with up to 2 connected accounts and 600 from 3; raise this to `600` then. |
| `ADS_LAUNCH_ENABLED` | unset (off) | `1` lets customers launch ads and raise budgets, end dates and resume (§3c). Pausing and ending always work. |
| `ADS_HARD_MAX_DAILY` | `500` | Ceiling for any customer's daily ad limit; Owner → Billing → Ad limits can't go above it. |
| `ADS_HARD_MAX_CHANGE` | `200` | Ceiling for the most one launch or increase can add a day. |
| `ZERNIO_BRAND_NAME` | `Yourlocalbusiness` | The name on Zernio's ads connect screen ("Yourlocalbusiness wants to connect to your Meta Ads account"). |
| `ZERNIO_BRAND_LOGO_URL` | — | An https link to a square logo for that screen. |
| `ZERNIO_BRAND_COLOR` | — | Its button colour, `#RRGGBB`. |
| `NANGO_INTEGRATIONS` | — | Only with Nango (§3b): JSON of the integrations customers may connect. |
| `CRON_BUDGET_MS` | `40000` | How long one cron tick may run jobs before it answers (§2a); a job still running then finishes in the background. |
| `MORNING_ACTIONS` | on | `off` turns the morning action off (§13): its routes answer 503 NOT_SET_UP and its jobs don't run. |
| `MORNING_PER_TICK` | `24` | Businesses the hourly `morning-actions` job handles at most per tick (1–200; the rest wait for the next tick or their first Dashboard visit). |
| `MORNING_CONCURRENCY` | `6` | How many of them at a time (1–10). |
| `GSC_APP_PROPERTY` | — | `https://yourlocalbusiness.replit.app/` once that Search Console property is verified. Its host is also the app's own address for the back button on Upload-Post's connect page (unset: `https://yourlocalbusiness.replit.app`), so set it to the app's real address if that ever changes. |
| `GSC_APP_VERIFICATION_FILE` | — | Optional extra HTML verification file name, e.g. `google1a2b3c4d5e6f7a8b.html`. The homepage file `google2598e017b2dc1e02.html` is already served (§6). |

The Supabase and Omnisend Secrets you already have are unchanged (`SUPABASE_SERVICE_ROLE_KEY` is still read as an older name for `SUPABASE_SECRET_KEY`).

## 2. Database

Run these once in Supabase → SQL Editor (each is safe to run again):
1. `supabase/migrations/20261105000000_integrations.sql`: server-only tables (no browser can read them):
   customers and caps, the usage ledger, analytics settings, snapshots, runs and history, publish jobs, Search
   Console steps and webhook deliveries.
2. `supabase/migrations/20261106000000_zernio.sql`: lets the usage ledger record Zernio rows.
3. `supabase/migrations/20261107000000_upload_post.sql`: lets the usage ledger record Upload-Post rows
   (vendor `uploadpost`).
4. `supabase/migrations/20261108000000_ads_launch.sql`: launched ad campaigns, their jobs and audit log, each
   business's chosen ad account, and the owner's ad limits (`ad_limits`; ads start **off** for everyone).
5. `supabase/migrations/20261109000000_cron_tick.sql`: turns on pg_cron and pg_net and schedules the hourly call to
   `POST /api/cron/tick` (§2a). Create the Vault secret first (§2a, step 2).
6. `supabase/migrations/20261112000000_leads_p2.sql` (P2, §11): tags every lead with its business, source and kind,
   adds the `lead_files` table and the `lead-files` (private) and `public-files` (public, images only) buckets.
   Run it after `20261103050000_page_leads.sql`.
7. `supabase/migrations/20261113000000_offers.sql` (P3, §12): offers, payment connections, sales and their refunds,
   buy link clicks. Run it after `20261105000000_integrations.sql`.
8. `supabase/migrations/20261114000000_trial_paywall.sql` (P1c, §10 "Free trial, paywall and cancelling"): the first
   business needs no plan, the 7-day card trial (`billing_trials`), the cancel survey (`cancel_surveys`, with the
   owner's totals `ylb_cancel_survey_totals`) and the cancel / resume / end-trial operations. Run it after
   `20261110000000_billing.sql`. Until it is run, no trial is offered and Cancel plan / Keep my plan open the
   Customer Portal instead.
9. `supabase/migrations/20261115000000_ad_job_error_detail.sql` (§3c): `ad_jobs.error_detail`, why Zernio refused a
   launch or a change. Run it after `20261108000000_ads_launch.sql`.
10. `supabase/migrations/20261116000000_morning_action.sql` (P4, §13): `business_settings` (each business's zone and
   when its next action is due) and `daily_actions` (one action per business per local day); users read their own
   rows and only the server writes; the claim and backlog functions for the hourly job; deleting a business deletes
   its morning rows. Run it after `20261110000000_billing.sql`.
11. `supabase/migrations/20261116100000_ad_policy_confirmed.sql` (§3c "Before your first ad"):
   `ad_account_choices.policy_confirmed_for` and `policy_confirmed_at`, the customer's answer that a business admin
   accepted Meta's non-discrimination policy for the chosen ad account. Run it after `20261108000000_ads_launch.sql`.
   Until it is run, the policy shows as not confirmed and ticking the box says it couldn't be saved (log:
   `ads_policy_confirm_not_saved`).

Deleting an account deletes its rows, except usage ledger rows, which keep only the opaque customer tag for
invoices, and `billing_trials` rows, which keep only keyed hashes of the email and card (their `user_id` becomes
null) so the same email or card can't start a second free trial on a new account. Their ad accounts are disconnected at Zernio first (every account in their Zernio profile, then the
profile). Their Upload-Post profiles (one per business, with every social connection in them) are deleted once the
account itself is gone, so a deletion that stops half way loses no connection; if a delete fails, the daily check
finishes it. Deleting one business in the app deletes that business's profile right away.

## 2a. Scheduled jobs (the cron tick)

Replit Autoscale stops the app when nobody uses it, so the app can't wake itself for periodic work. Supabase does it
instead: **pg_cron** calls `POST https://yourlocalbusiness.replit.app/api/cron/tick` at minute 7 of every hour
through **pg_net**, with `Authorization: Bearer <CRON_SECRET>`. Each tick runs the jobs that are due (`server/cron/`):

| Job | How often | What it does |
|---|---|---|
| `treg-settle` | hourly (each tick) | Asks treg what slow ("pending") calls finally cost and adds the correcting ledger rows (§5) |
| `uploadpost-meter` | daily from 02:10 UTC | Last month's estimated Upload-Post profile rows per customer (once per month) |
| `zernio-meter` | daily from 02:20 UTC | Last month's estimated Zernio rows per customer (once per month) |
| `uploadpost-reconcile` | daily from 03:10 UTC | The Upload-Post daily check (§3): accounts against our records, the profile cap, cleanup |
| `offers-webhooks` | daily from 04:17 UTC | Reads each Whop connection's webhook; a turned-off one shows a banner (§12) |
| `offers-reconcile` | daily from 04:47 UTC | Reads the last 72 hours of Whop payments and records missed sales for the customer's offers (§12) |
| `posting-sweep`, `analytics-sweep`, `ads-sweep` | hourly (each tick) | Posts, analytics runs and ad changes left "sending"/"running" by a restart become "unknown"/ended; nothing is re-sent |
| `morning-actions` | hourly (each tick, first; leaves 8 s of the tick to the rest) | Makes the morning action of each business that is due (§13), up to `MORNING_PER_TICK`; the rest wait. Marks interrupted ones failed; never re-runs one |
| `morning-prune` | daily from 05:23 UTC | Deletes morning actions older than 120 days |

Each job runs **at most once per period**: the run is claimed first in `app_state` (one row per job), so a repeated
call, a slow pg_net retry or two copies of the app never run it twice. A job that fails is recorded and waits for
its next period; it is never retried in the same one. A tick stops starting jobs after `CRON_BUDGET_MS` (40 s) and
answers with a JSON summary (`ran`, `failed`, each job's `status`: `ran`, `skipped` with a reason, `failed` with an
error code, or `running`). The secret is compared in constant time and never logged or shown.

**Owner steps (once):**
1. Make a secret: `openssl rand -hex 32`. Put it in Replit Secrets as `CRON_SECRET` (workspace and deployment) and
   republish.
2. In Supabase → SQL Editor, store **the same value** in Vault (never in a file or a chat):
   `select vault.create_secret('<the CRON_SECRET value>', 'cron_secret', 'Bearer for POST /api/cron/tick');`
3. Run `supabase/migrations/20261109000000_cron_tick.sql` (safe to run again; it replaces the `ylb-cron-tick` job).
4. Check it after the next hour: `select * from cron.job_run_details order by start_time desc limit 5;` and
   `select status_code, left(content, 200) from net._http_response order by created desc limit 5;` (200 with
   `"ok":true`). 401 means the two values differ; 503 means `CRON_SECRET` isn't on the published app.

To rotate: `select vault.update_secret((select id from vault.secrets where name = 'cron_secret'), '<new>');`, then
the new value in `CRON_SECRET`, then republish (ticks in between answer 401 and simply run next hour).

**Running it yourself:** `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://yourlocalbusiness.replit.app/api/cron/tick`
(harmless: what already ran this period is skipped). **Local dev:** without `CRON_SECRET` and outside a Replit
deployment (`REPLIT_DEPLOYMENT` unset), the server ticks itself every minute, so nothing needs setting up. On the
published app the tick is the only driver.

## 3. Social accounts and posting (Upload-Post)

Upload-Post (Advanced plan, white-label, 75 profiles) holds each customer's social logins on its own approved
apps, so **no Meta, LinkedIn, TikTok, X or Google app review is needed**. A profile holds one account per network,
so **each business (each project in the app) gets its own Upload-Post profile** and connects its own Facebook Page,
Instagram, TikTok, X, YouTube and LinkedIn. A business's profile is made the first time someone presses Connect for
that business (never just because a business was made), so only businesses with social accounts use one of
the plan's 75 profiles. Facebook groups stay with Manus.

- **Profile names**: `ylb_` + the 24 hex characters of the customer id + `_` + 8 hex characters of a keyed hash
  (HMAC-SHA256 with `CUSTOMER_TAG_SECRET`) of the user and the business, for example
  `ylb_3f2a9c4e8d1b4c6f9a2e1b7d_5c0e19a2` (37 characters: letters, digits and `_`, which Upload-Post allows). It
  never contains an email, a user id or the business's own id. Upload-Post names can't be changed, so the name is
  stored the first time and never computed again. Webhooks find their customer from the first part and their
  business from the stored names, so each event reaches exactly one customer and one business.
- **Business slots**: each user can have social accounts on at most `UPLOAD_POST_MAX_PROFILES_PER_USER` businesses
  (default 3), so one user making businesses can't use up the plan. The slot is reserved before Upload-Post is
  asked, so two Connect clicks at once never make two profiles or pass the limit. Settings → Connected accounts
  shows each user how many of their slots are used. A profile whose delete hasn't gone through yet still counts
  (it still uses one of the plan's), so failing deletes can't pile up plan profiles.
- **Deleting a business** (Settings → Projects & data, the assistant, a cancelled setup, a workspace reset or a
  backup import) disconnects its social accounts and deletes its profile, freeing the slot; the delete confirm (read
  fresh from the server) and the import confirm name what is disconnected. The app sends the release for every
  deleted business, whatever it last heard (the server answers "nothing to free" for one without social accounts;
  60 releases an hour per user). If the app couldn't reach the server, the daily check deletes the profile once the
  business has been gone from the account for 2 days, and the user can also free the slot on Connected accounts:
  **Free it** shows only for slots whose business the server finds gone from the account (never one another device
  made that this one hasn't loaded yet), asks first, and the server refuses it while the business is still saved.
- **A profile deleted by hand** in Upload-Post's dashboard stops holding its user's slot and stops being billed as
  soon as a read of it (Check, Connect) or the daily check (which reads by name any profile our records have that
  Upload-Post's list doesn't, at most 25 a day) gets a 404. The business's next Connect makes it again, with the
  same name.

**Set it up once**
1. Subscribe to Upload-Post's **Advanced** plan, billed **yearly** ($1,411 a year, about $118 a month; $147 month
   to month). It includes 75 profiles (one per business with social accounts), white label and unlimited uploads.
   More profiles: the +25 ($65 a month or $650 a year) or +50 ($115 a month or $1,150 a year) add-on; they don't
   stack, so past 125 profiles you need a bigger plan or a second account. There is **no sandbox**: every test post
   is real, so make your own test profile with test social accounts for the first live check. On it, check once: a LinkedIn post with
   `(brackets)` and a `#hashtag` shows them as written (the app sends plain text), a photo and a video post go
   out (Upload-Post fetches them from links ending in `.jpg` / `.mp4`), and an X post with blank lines stays one
   post (the app counts each line break as 2, since the upload sends it as CR LF).
   Use **one Upload-Post account (API key) per environment**: a staging or dev copy on the same key sees the live
   customers' profiles (the daily check never deletes those, but it tells you they aren't its customers).
2. app.upload-post.com → **API keys** → create a key. Paste it **only** into Replit Secrets as
   `UPLOAD_POST_API_KEY`; the app shows at most its last 4 characters. Upload-Post locks the server's address out
   for 5 minutes after 10 tries with a wrong key, so after one refused key the app stops calling for 60 seconds
   and tells you (Customer usage → "Social posting needs attention").
3. Webhook (Upload-Post dashboard → Notifications → Webhook): register
   `https://yourlocalbusiness.replit.app/api/webhooks/upload-post` and turn on the events `upload_completed`,
   `social_account_connected`, `social_account_disconnected` and `social_account_reauth_required`.
4. Copy the `whsec_…` webhook secret Upload-Post shows into Replit Secrets as `UPLOAD_POST_WEBHOOK_SECRET`. Each
   delivery is signed (`X-Upload-Post-Signature`, HMAC-SHA256 of `<timestamp>.<body>`); the app refuses unsigned
   deliveries and ones more than 5 minutes old, and applies each event once. It answers each delivery at once and
   works on it afterwards (Upload-Post waits 10 seconds, and pauses deliveries for 30 minutes after 5 failures).
   Upload-Post sends each webhook only once and never retries, so the app also reads post status itself, reads a
   business's profile back while a connect is waiting (and on Check and Connect), and once a day compares every
   profile's accounts with what it has.
   Rotating: Upload-Post's new secret works at once, so put the old one in `UPLOAD_POST_WEBHOOK_SECRET_PREVIOUS`
   for the switchover, then remove it.
5. White label. The app sends the whole branding with every connect link (Upload-Post clears any field left
   out): `UPLOAD_POST_BRAND_LOGO_URL` (an https link to your logo), `UPLOAD_POST_CONNECT_TITLE`,
   `UPLOAD_POST_CONNECT_DESCRIPTION`, `UPLOAD_POST_BACK_BUTTON_TEXT`, the one network being connected, a light
   theme and no calendar (the app has its own). White label comes with the Advanced plan: nothing to turn on in
   Upload-Post's dashboard.
6. Set `MEDIA_URL_SECRET` (32+ random bytes): Upload-Post fetches each photo and video from a short-lived link on
   this app, so no photo or video can be posted without it.
7. X: links in X posts are removed unless you buy Upload-Post's **X Links** add-on ($19 a month or $152 a year,
   50 link posts a month **shared by all customers**); once bought, set `UPLOAD_POST_X_LINKS=on`. Each customer
   then has `UPLOAD_POST_X_LINK_POSTS_PER_CUSTOMER` link posts a month (past it nothing is sent and they're told
   to take the link out), and you get an alert at 40 of the 50 and when Upload-Post takes links out. X post stats
   are a shared daily budget too (5,000 posts a day for the whole account).
8. Your privacy notice must name Upload-Post's company, **TONVI TECH SL** (Spain), as a processor.
9. Run the migrations in §2, redeploy, and check the startup notes say "Social accounts and posting: on
   (Upload-Post)". Settings → Connected accounts then shows Connect on every social network.

**What the app does with Upload-Post**
- **Connect**: Settings → Connected accounts → Social accounts → Connect opens Upload-Post's hosted page (always
  on app.upload-post.com; no custom domain) for that one network and the business on screen, with your logo and
  text. A fresh link is made for every press (Upload-Post's links last 48 hours; the app never stores them).
  Customers come back with its back button to Settings → Connected accounts. The app sees the new account from the
  webhook, and also reads the business's profile back while the row waits (at most every 30 seconds), when they
  press Check, and before making another link, so a lost webhook never leaves them stuck. **Reconnect** shows when
  a network asks the customer to sign in again; **Disconnect** removes that network from that business only.
- **Facebook Page and LinkedIn page**: each business picks its own, on its own profile (a business with several
  Pages that hasn't picked is asked to; LinkedIn posts as the person until then). The hosted page also lets the
  customer pin a Page on the business's profile, and Upload-Post's pin wins over the Page each post names: the app
  reads the pin and shows it, and when the business picks another Page in the app, the pin is cleared.
- **Post**: one upload per post, through the profile of the post's business, with the job id as `request_id`,
  `Idempotency-Key` and `external_id`. Photos and
  videos go as the app's short-lived link. The network's own result decides; videos finish in the background and
  the app reads their status by the job id. A timeout or a 5xx reads "It may have been posted - check before
  trying again": **Check again** reads the status by the job id and never sends it again. A post Upload-Post
  lists as still queued, or as failed-but-retrying, keeps waiting; a TikTok that failed with TikTok's internal
  error (which TikTok sometimes publishes after moderation) reads "may have been posted". A TikTok video keeps the
  account's own audience (none is sent); a photo needs one (read from that business's TikTok), so it goes public,
  or to followers on a private account. A TikTok that lands in the account's drafts reads "Sent to your TikTok
  drafts", also when only the webhook said it was done. LinkedIn gets plain text and plain `#hashtags`.
  A try that failed and that Upload-Post then posted after all (its own retry) reads "Posted"; if the customer had
  posted it again in the meantime, the old try records "posted after all" (it stays out of the one-live-post rule)
  and the post says it may now appear twice, so the customer can delete one. Nothing is ever sent again.
- **Stats**: per business, from its own profile: each connected account's followers, reach, views, engagement and its daily series (reach on
  Facebook, Instagram and LinkedIn; views on TikTok and YouTube; impressions on X), at most 80 reads per
  5 minutes for the whole app. Top posts come from the business's public handle (treg), as for networks that
  aren't connected. A LinkedIn personal profile has no stats at Upload-Post, so it shows public data.
- **Usage**: each post, "Check again" read, stats read and X link post is a row in the customer's usage ledger
  (vendor `uploadpost`, no cost, tagged with the business; profile and connect reads aren't), and once a month each
  business profile gets an estimated row on its customer, tagged with the business (`project_id`): $147 / 75 ≈
  $1.96 a profile-month, prorated (a business deleted mid-month is charged up to then; a customer deleted mid-month
  gets theirs then). A customer's totals and CSV line add up all their businesses. A month counts as done only when
  every row was written, so a failed write is finished the next day. The owner's Customer usage page shows profiles
  used out of 75, and per customer their profiles (businesses), social and ad account counts.
- **Team-level problems never reach customers**: our key, the profile cap, a blocked profile, the scheduled-post
  cap and the shared X and analytics budgets show customers a plain "temporarily unavailable, we've been notified"
  and leave an owner alert (one per kind in `uploadpost:alerts`; Customer usage shows the most serious, a key or
  rate alert ends at the next call that works) and hint. One customer's social sign-in running out (Upload-Post
  answers some reads with 401 `facebook_reauth_required`) is that customer's Reconnect, never a key alert.

**Limits to know**
- **Profiles**: 75 on Advanced, **one per business** that has pressed Connect (businesses that never connect a
  social account use none). More: the +25 add-on ($65 a month, or $650 a year) or the +50 add-on ($115 a month, or
  $1,150 a year); **they don't stack**, so past 125 you need a bigger plan or a second account. Each user can use at
  most `UPLOAD_POST_MAX_PROFILES_PER_USER` (default 3) of them. With 5 or fewer left (`UPLOAD_POST_ALERT_REMAINING`)
  you get an alert; at 0, customers connecting a new business read "Social connections are temporarily full. We've
  been notified" until you add profiles. If Upload-Post refuses to make a profile for another reason (a 400, say),
  customers read "temporarily unavailable" and you get the "refused to make a new business profile" alert. At most
  `UPLOAD_POST_NEW_PROFILES_PER_DAY` new profiles are made a day (and a few per user), and
  a business's profile with nothing connected for `UPLOAD_POST_RECLAIM_DAYS` goes back to the plan. Deleting a
  business deletes its profile; deleting an account deletes all of them. The daily check (at most 10 deletions a
  day) only touches `ylb_` profiles it can map to one customer and one of their businesses, or that account deletion
  marked: it deletes a marked profile whose customer is gone, a business's profile whose delete failed, one whose
  business has been gone from the account for 2 days (only when the account's other businesses are in this
  database), and the one-per-customer profile of an earlier build of this branch (development data). It never
  deletes one because its customer looks absent (a doc it can't read, an empty database, another copy of the app
  on the same key): it tells you how many such profiles it saw instead. Profiles with other names are never
  touched.
- **API rate**: 200 calls a minute and 1,000 per 10 minutes for the account, plus 2 a minute and 10 per 10 minutes
  for each profile. The app keeps itself under `UPLOAD_POST_RPM` (150) plus the per-profile allowance, and waits
  once on a 429 for reads; posts are never repeated.
- **Per social account, per 24 hours**: Instagram 50, TikTok 15 (and 6 a minute), LinkedIn 150, YouTube 30,
  Facebook 25 per Page, X 30, Threads 50, Pinterest 20. Over one, the post fails plainly ("This account has
  reached the network's posting limit for now") and nothing is retried.
- **Shared across all customers**: the X Links allowance (50 link posts a month) and X post stats (5,000 posts a
  day); the analytics reads the app allows itself (80 per 5 minutes); 40,000 pending scheduled posts.
- **Not supported by Upload-Post**: Facebook groups and personal profiles (groups stay with Manus), Reddit.

## 3a. Ad accounts (Zernio)

Zernio is kept **for ads only**: connecting Meta, Google, LinkedIn, TikTok, Pinterest, Reddit and Microsoft ad
accounts, reading ad results, and launching and changing Meta and Google Search campaigns (§3c). Social accounts and posting are
Upload-Post's (§3). Each customer gets one Zernio **profile**, made the first time they connect an ad account,
with `externalId` = their customer id (`cust_…`, never an email). Zernio account ids never reach the browser.

**Set it up once**
1. Create a Zernio account at zernio.com. The first 2 connected accounts are free; after that Zernio bills per
   connected account per month (about $6 each for the first 10, less after that). Analytics, comments, ads and
   unlimited posts come with every connected account.
2. Dashboard → **API keys** → create a key. Paste it **only** into Replit Secrets as `ZERNIO_API_KEY`.
3. Pick a webhook secret (32+ random characters) and paste it into Replit Secrets as `ZERNIO_WEBHOOK_SECRET`.
4. Dashboard → **Webhooks** → add an endpoint:
   - URL: `https://yourlocalbusiness.replit.app/api/webhooks/zernio`
   - Secret: the same value as `ZERNIO_WEBHOOK_SECRET`
   - Events: `account.connected`, `account.disconnected`, and for launched campaigns `ad.review.approved`,
     `ad.review.rejected`, `ad.status_changed`, `ad.delivery_issue`, `ad_account.status_changed` (same URL, same
     secret; post events aren't needed any more). Subscribing to the ad events needs the ads add-on.
   Press **Send test**: the app answers 200. Zernio signs each delivery (`X-Zernio-Signature`, HMAC-SHA256 of the
   body); the app ignores anything unsigned or for a profile that isn't one of your customers, and applies each
   event once.
5. **White-label the connect screen** (optional, recommended): either set `ZERNIO_BRAND_NAME`,
   `ZERNIO_BRAND_LOGO_URL` and `ZERNIO_BRAND_COLOR` (sent on every connect link), or save your brand once in the
   Zernio dashboard's welcome-screen settings. Customers then see "Yourlocalbusiness wants to connect to your Meta
   Ads account" (or Google Ads, LinkedIn Ads, …) before the network's own sign-in. The network's own consent screen
   still names Zernio's app.
6. Turn on the **ads add-on** in Zernio if customers will connect ad accounts.
7. Run the migration in §2, redeploy, and check the startup notes say "Ad accounts: on (Zernio)".

**Later (optional): your own platform apps.** Zernio can connect through your own Meta, LinkedIn, TikTok, X or
Google apps instead of its own (Zernio dashboard → OAuth apps), so the consent screens show your app's name and
the network's limits are yours. That needs each network's app review (often weeks). The app needs no change for
it beyond Zernio's settings.

**What the app does with Zernio**
- **Connect**: Settings → Connected accounts → Connect on an ad account opens Zernio's branded ads connect. X Ads
  is "Coming soon": Zernio's X Ads connect needs an X account inside Zernio, and X posting is Upload-Post's.
- **Disconnect and deletion**: Zernio's Meta Ads connect also makes a hidden Facebook account (not billed, not
  postable) that holds the customer's Facebook token. Disconnecting Meta Ads removes it too, and deleting a
  customer's account removes every account in their Zernio profile, then the profile.
- **Stats**: each ad account's daily spend and campaigns (read here; launches and changes are §3c).
- **Usage**: every Zernio call is a ledger row (vendor `zernio`, no cost), and once a month an estimated "ad
  accounts" row (count × Zernio's list price).
- Rate limits: the app stays under `ZERNIO_RPM`; a read that gets a 429 waits once (10 s at most); writes are
  never repeated.

## 3c. Ads: launching and changing campaigns

**What it does.** Customers launch a saved Ads plan on **Meta** (Facebook and Instagram feed: one campaign, one ad
set, 1 to 3 ads from the plan's picked A/B/C) and **Google Search** (one campaign, one ad group, one responsive
search ad from the plan's search ad), then pause, resume, end, change the daily budget, change the end date (Meta
only) and swap the ad from the Campaigns tab. Ad spend is billed by Meta or Google to **the customer's own**
payment method; the app never handles ad money. Not from the app yet: TikTok, LinkedIn, Google Display, PMax and
Video, lead forms, pixels and conversion goals, custom audiences, sitelinks, creating ad accounts or payment
methods, deleting campaigns, special ad categories (housing, jobs, credit, politics, gambling), EU targeting and
the verified beneficiary and payer Meta asks for in some countries (Australia, Brazil, India, Malaysia, Singapore,
Taiwan, Thailand: Zernio's `verified_advertiser_required`; customers are told to use Ads Manager for those).

**Turn it on**
1. Run `supabase/migrations/20261108000000_ads_launch.sql`, `20261115000000_ad_job_error_detail.sql` and
   `20261116100000_ad_policy_confirmed.sql` (§2).
2. Zernio: the **ads add-on** must be on your Zernio plan (`ads_addon_required` otherwise). Managed ads cost $0.01
   per active ad a month after the first 500 free, and Zernio needs a payment method on your team past 500 live ads
   (`ads_allowance_exceeded`). These calls show in the ledger as vendor `zernio` with no cost: check Zernio's invoice.
3. Replit Secrets: `ADS_REVIEW_SECRET` (32+ random bytes) and `MEDIA_URL_SECRET` (Meta fetches ad images from the
   app). Add the ad events to the Zernio webhook (§3a step 4).
4. Owner → Billing → Ad limits: set the defaults (or one customer's) and turn **ads on** there. Ads stay off until
   **both** `ADS_LAUNCH_ENABLED=1` and the customer's (or the default) `ads on` are set.

**In Zernio, for ads** (once): the API key in `ZERNIO_API_KEY` (§3a step 2); the **ads add-on** on the plan;
the webhook from §3a step 4 subscribed to the five ad events (`ad.review.approved`, `ad.review.rejected`,
`ad.status_changed`, `ad.delivery_issue`, `ad_account.status_changed`) on the same URL and secret (without them the
Campaigns tab still updates on Refresh, just later); a payment method on your Zernio team before you pass 500 live
ads. Zernio's plan, billing, add-on or key problems are never shown to customers: they see "Launching and changing
ads from the app isn't available right now. The app owner has been told." and you get the alert in Owner → Billing
(and the server log, `zernio_owner_alert`).

**What customers need** (the launch window's checklist): Meta ads or Google Ads connected in Settings → Connected
accounts and chosen for the business; an ad account picked (active, not a Google manager or test account); on Meta
a payment method on the ad account, a Facebook Page (an Instagram professional account is optional), Meta's
non-discrimination policy accepted, no security hold; on Google an approved billing setup in Google Ads → Billing
(advisory: the app warns, Google won't show ads without it). Google reviews every ad; Meta does too.

**Before your first ad (Meta).** Once Meta ads is connected (Settings → Connected accounts → Ad accounts, for the
business on screen, which first asks which ad account it launches on) and again at the top of the launch window, the
chosen ad account gets three items, each **Done**, **Not done**, **Not confirmed** or **Can't tell**:
- *Payment method*: Zernio's live payment check and the listing's `billingStatus`. Not done or can't tell links that
  ad account's own payment settings: `https://business.facebook.com/billing_hub/payment_settings/?asset_id=<digits>`
  (the `act_` prefix dropped, digits only; anything else gets `https://business.facebook.com/billing_hub/`).
- *Meta's non-discrimination policy*: Meta has no check for it before a create, so the customer ticks "A business
  admin has accepted Meta's non-discrimination policy for the business that owns this ad account." (kept per ad
  account, `ad_account_choices.policy_confirmed_for`). Unticked is a warning with the link, never a block: Meta
  decides at the launch, and the server enforces nothing from the box. A policy refusal Zernio remembers
  (`last_refusal`, 7 days) or reports live makes it **Not done**, ticked or not. It says plainly that only a business
  admin can accept, with the steps and two links (below).
- *Facebook Page*: Zernio's page check, as before.

**Meta's non-discrimination policy: where it is accepted.** Zernio's fix link,
`https://www.facebook.com/certification/nondiscrimination`, only records the policy for the person signed in and
takes no business or ad account; it is not where a business accepts it (the live refusal of 7 Nov). Meta's own
refusal text says a business admin must accept it "by going to Business Settings, then System Users" (Meta developer
forum, developers.secure.facebook.com/community/threads/874355924886502), and Meta's 2022 notice says system users
"will not be able to create ads until the business admins do so" (quoted by jonloomer.com). Admin help pages agree on
the steps (Phorest, Blend 2026-01-20, Understory, Ako). So every policy fix link (refusal messages and job cards, the
activity log, the setup checklist and "Before your first ad") on Meta is the documented Business Settings entry,
`https://business.facebook.com/latest/settings/business_users`, whatever Zernio sends, with these steps: sign in as an
admin with full control of the business that owns the ad account (only they can accept); open Business Settings and
check the business name in the top-left menu is the one that owns ad account …<tail>, switching to it if not (the
link carries no `business_id`: Zernio's listing gives no owning business, so Meta opens the business last used); go
to Users → System users; click "Review policy" (or "Add" if there's no banner), then "I accept"; no system user needs
to be made; come back and tick the box. Zernio's personal page stays as an optional second link ("Your own acceptance
on Facebook (only if Meta asks you)"). Acceptance is once per business; the box is per ad account because ad
accounts can belong to different businesses. A Google refusal never gets these Meta links (Zernio's own safe link
only). A live policy blocker reads "Meta reports that this ad account's non-discrimination policy hasn't been
accepted…"; only a remembered one says "in the last 7 days… you can launch again". **Unconfirmed** (no signed-in
check was made): whether `/latest/settings/business_users` opens Business Settings → Users for the business last used
(and the System users page's own path), a `business_id` parameter on it, the payment link's `asset_id` parameter (Billing Hub itself is documented; the documented fallback is
`https://business.facebook.com/ads/manager/account_settings/account_billing/?act=<id>`), whether Zernio creates ads
as the customer or through a system user, any acceptance prompt inside Ads Manager, and Meta's error subcodes
(2859024, 2859002), and what Zernio's payment check `status: 'error'` means (the panel reads it as "Can't tell"). If
the link ever lands on the wrong page, the steps still name the menu. Ticking the box before the migration is run
logs `ads_policy_confirm_not_saved` with `pg` (`PGRST204` or `42703`) and the migration hint; any other database code
is logged without the hint.

**Limits** (`ad_limits`, `'*'` = defaults, a customer row overrides field by field):
| Limit | Default | Checked on |
|---|---|---|
| ads on | off | launch, resume, increases |
| currency | USD | limits apply only to ad accounts in this currency; another one is refused ("Ask the app owner to set your ad limit in EUR") |
| daily limit | $50 | committed daily across the customer's campaigns whose switch is (or may be) on, after the change |
| per change | $50 | a launch's daily, and one increase's added daily |
| per campaign | $750 | a launch's daily × days; a resume, increase or later end date: spent so far + what's left |
| launches a day | 3 | launch attempts that reached the send, per UTC day |
| changes a day | 20 | resumes, budget, end date and ad swaps (pause and end never count) |
A customer blocked in Billing can't launch, resume or increase. `ADS_HARD_MAX_DAILY` and `ADS_HARD_MAX_CHANGE` cap
what you can set. Every change to a limit bumps its version (open reviews must be done again) and shows in the
customer's activity ("The app owner set your daily limit … to $100.00"). **Pausing and ending always work**: with
ads off, a blocked customer, `ADS_LAUNCH_ENABLED` unset or the daily change limit used up. **Pause all** on a
customer's row pauses every campaign of theirs that is on, one by one (audited as "Paused by the app owner").
Turning ads off or blocking a customer never pauses anything by itself.

**Money safety.** Every launch, on Meta and Google, is created with its campaign switched off, and switched on by
the launch's own next step only if the customer chose Active (so a create that answers late can never be running
untracked). On Meta the app first sets a campaign spending limit equal to the confirmed planned total (at least
Meta's smallest limit, 100 US dollars, which the confirm shows); a budget increase or a later end date raises that
limit first, and the app never lowers it. Google has no such limit from the app: the owner limits and the end date
are the bounds there. Each review can start one write only, and launches or increases sent at the same moment are
checked against the limits one after another. Every launch and every change that
can raise spend needs the customer's spend confirm with the amounts, dates and account; the server sends exactly
what the review showed (a plan edited, a limit changed or a budget changed in Ads Manager since then is refused
before anything is sent). Meta's text optimisations are all off; Google gets at least 3 headlines and 2
descriptions of the customer's own, so neither writes copy for them. Claim words ("licensed", "guarantee",
"reviews", …) need the customer's tick.

**Unknown outcomes.** A write is sent **once**. A timeout, a cut connection or a 5xx makes it "unknown": "It may
have happened - check status before trying again." **Check status** only reads (live on Meta; on Google it waits
for a sync newer than the send, as Google's data reaches Zernio 15 to 60 minutes late). Nothing is ever re-sent by
itself, on a page load or on a restart. To look for a launch in Ads Manager yourself, search for the tag in its
name: `YLB` and 12 letters and digits (e.g. `Winter pipes · Meta · YLB 1a2b3c4d5e6f`). "Launch again" (only after
the check says it wasn't created) uses a new tag.

**Meta's 24-hour rule.** Meta runs a daily budget only on an ad set scheduled for more than 24 hours, and the last
day ends 23:59:59 in the ad account's zone, so a 1-day Meta launch is always refused (the launch of 6 Nov: as soon
as approved at 5:40 PM, 1 day, about 6 hours). The review now blocks it before anything is sent ("Meta needs a
daily-budget ad to run more than 24 hours. Choose at least 2 days."), counting "as soon as approved" or a start
already past from the latest the launch can go out (the review lasts 10 minutes), and Budget and dates starts Meta at
2 days or more. Launch again goes through the same check; Google runs whole days and is unchanged. Changing a running
Meta ad set's end date isn't checked: Zernio's docs don't say Meta applies the rule there (if it refuses, the
customer sees why, below).

**Why a launch or change was refused.** The job keeps the refusal's safe fields in `ad_jobs.error_detail` and its
audit row in `after` (Zernio's code, type, field and step, its hint cut to 300 characters, the fix link on Meta's,
Google's or Zernio's docs only, and Meta's subcode and own words); `error_code` keeps our category. Customers read
our own sentence for Zernio's Meta refusal codes (payment method, non-discrimination policy, Lead Ads terms,
verified advertiser, unusable ad account, security check, blocked action, budget too low, object not accessible,
permissions…) with Meta's fix link (ours for the policy and a payment method: see "Before your first ad" above),
then what the refusal left:
- nothing: "Nothing was created and no money was spent." (or "Nothing was changed.");
- a launch whose campaign and ad set Meta kept (Zernio couldn't delete them): those parts, listed ("campaign …1234"),
  which can't spend and can be deleted in Ads Manager;
- a change that went through in part (the spending limit raised before Meta refused the budget, the end date or the
  campaign switch): "Only the first part of this change went through…", never "Nothing was changed";
- a refused pause or end: "It's still running: pause it in Meta Ads Manager now", never "wait";
- a launch made but not switched on: why, with the fix link.

A refusal with no code of ours shows Zernio's hint as "Meta's message: "…"", plain text; "budget too low" also shows
Meta's own message, which names Meta's minimum. Fix links go only to an exact list of hosts (`facebook.com`,
`www.`, `business.` and `adsmanager.facebook.com`, `www.` and `transparency.meta.com`, `ads.google.com`,
`support.google.com`), never through a redirect. Zernio plan, add-on, billing, key and rate-limit problems are never
shown to customers: plan, add-on, billing and key problems alert you (Owner → Billing, `zernio_owner_alert`); a rate
limit on our key only tells the customer to try again in a minute (no alert). To look one up: `select error_code,
error_detail, provider_ref from public.ad_jobs where id = '…';` (`provider_ref.done`: the steps of a change that went
through; `leftBehind`: what Meta kept of a launch). Before the migration is run, jobs finish without the detail and the
log says `ads_error_detail_not_saved`.

**Where live spend is named.** Deleting the app account, disconnecting Meta ads or Google Ads, and deleting a plan
list the campaigns still on and what keeps running ("they keep running until you pause them in Ads Manager"); the
first two need the customer's tick (`ackLiveAds=1`).

**Removing a failed launch.** A failed launch with no platform id, no job sending or unknown and nothing left behind (no kept, unknown or left-behind created object, no `PARTIAL_LEFT`) gets **Remove** on the Campaigns tab (and the assistant's `remove_failed_launch`, after a confirm, current business only) once its confirm has run out (10 minutes after the send; a day for a Google "not created"): `DELETE /api/ads/campaigns/:id?projectId=` writes the audit line first, then deletes our row and its jobs, never calls Zernio, Meta or Google, and otherwise answers "Check Ads Manager first".

**Routes** (signed in, same site): `/api/ads/accounts`, `/accounts/choice`, `/accounts/policy`, `/targeting/search`, `/launch/preview`,
`/launch`, `/campaigns`, `/campaigns/refresh`, `/campaigns/:id/change/preview`, `/campaigns/:id/change`,
`/campaigns/:id/review`, `/jobs/:id`, `/jobs/:id/check`, `/audit`, `/live`; owner only: `/admin/limits`,
`/admin/limits/:tag` and `/defaults`, `/admin/customers/:tag/pause-all/preview` and `/pause-all`. Code:
`server/ads/` (`zernioAds.mjs` is the only file that sends ad writes). Tests run against
`server/test/mock-zernio-ads.mjs` only.

## 3b. Other integrations (Nango, for later)

Nango stays in the app for **future** integrations that aren't social or ads, such as booking tools and CRMs.
It is off until `NANGO_SECRET_KEY` is set, and nothing shows in the app until you also list an integration:

1. Create the integration in the Nango dashboard (for example `ylb-calendly`).
2. Set `NANGO_SECRET_KEY` and `NANGO_WEBHOOK_SIGNING_KEY` in Replit Secrets.
3. Set `NANGO_INTEGRATIONS`, for example
   `{"calendly": {"id": "ylb-calendly", "label": "Calendly", "category": "booking"}}`.
4. In Nango, point the webhook at `https://yourlocalbusiness.replit.app/api/webhooks/nango`.

Customers then see **Settings → Connected accounts → Other integrations** with Connect and Disconnect. A key or
integration id that names a social network, an ad platform or Search Console is refused (those go through
Upload-Post, Zernio and treg). Gmail is not one of these: customers connect it in the app (§3d).

## 3d. Gmail (the customer's own mailbox, for later outreach)

Each signed-in customer connects **one** Gmail account from Settings → Connected accounts → Gmail. The app asks
only to send mail and to see which mailbox it is. It does not read the inbox. Tokens stay on the server,
encrypted in `app_state`, one connection per customer (the same way Omnisend stores a connection). Nango is not
used. A customer with several businesses sends later outreach from that one mailbox.

Nothing is sent from the app yet. A later outreach step calls the server helper. There is no send button and no
`/api/integrations/gmail/send` route (that path answers 404).

**Authorized redirect URI** (the only one; register it exactly on the Google OAuth web client):

`https://yourlocalbusiness.replit.app/api/integrations/gmail/callback`

There is no localhost or other dev redirect. Connect only starts on the published app, so Google returns to that
same host (the same rule as Omnisend).

**Secrets** (Replit Secrets only; never in the repo, a chat, or the app):

| Secret | What it is |
|---|---|
| `GOOGLE_CLIENT_ID` | The OAuth web client's id |
| `GOOGLE_CLIENT_SECRET` | The OAuth web client's secret |

**Set it up once**

1. Google Cloud Console → the project **yourlocalbusiness** (Gmail API is already enabled; the OAuth consent
   screen is External and saved in Testing). There is no OAuth client until you create one.
2. APIs & Services → Credentials → Create credentials → **OAuth client ID** → **Web application**.
3. Authorized redirect URI: the URL above, and no other.
4. Put the client id and secret in Replit Secrets as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. The app requests these scopes and no others. The consent screen needs `gmail.send`; the other two name the mailbox. Do not add `gmail.readonly`, `gmail.modify`, `gmail.compose`, or `profile`.
   - `https://www.googleapis.com/auth/gmail.send`
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email`
6. While the consent screen is in **Testing**, add each person who should connect (including you) as a test user.
   Otherwise Google shows that the app isn't verified.
7. Republish. The startup notes say "Gmail outreach: on", or they name `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET` if one is missing. They never print the values. The redirect URI is in that note too.
8. As a signed-in customer, open Settings → Connected accounts → Gmail → **Connect**. Google sends the browser
   to the redirect URI above. The app then opens Settings → Connected accounts and shows the mailbox address.
   **Disconnect** forgets the tokens and asks Google to revoke the grant. Deleting the account does the same.

Access tokens expire (about an hour). The app refreshes them with the stored refresh token. If Google revokes
the grant, the customer is asked to connect again.

Verification of `gmail.send` is still required before anyone who isn't a test user can connect (§9 item 3).
Paste these public pages into the OAuth consent screen. Both are real documents (not the app shell), readable
without signing in:

- Privacy policy: `https://yourlocalbusiness.replit.app/privacy`
- Terms of service: `https://yourlocalbusiness.replit.app/terms`

`/privacy-policy` redirects to `/privacy`. `/terms-of-service` redirects to `/terms`. The privacy policy names
Upload-Post’s company, TONVI TECH SL (Spain), as a processor.

## 4. Platform approvals

None are needed to start: Upload-Post's apps (social) and Zernio's apps (ads) are already approved on every
network. Networks still apply their own rules to each account (for example, Instagram needs a professional
account, Facebook posts go to a Page the customer manages, Meta Ads needs a Facebook Page). TikTok only offers
the audience settings the account allows; when TikTok limits the app, a post may land in the account's drafts,
and the post then reads "Sent to your TikTok drafts. Open TikTok to publish it."

**How posting works once an account is connected**
- The customer presses **Post on Facebook** (or another network) and confirms. The app sends the post **once**.
  If it can't tell whether the post went out, the post shows **It may have been posted - check before trying
  again** with
  **Check again** (a read, at most every 30 seconds) and **Post it yourself**. It never sends the post again by
  itself, and there's no "Try again" for that case.
- The post that goes out is the one saved in the customer's account. If the screen shows something older, the app
  asks them to save first.
- Daily caps per customer: 20 posts on X, 50 on each other network. Change them in the `billing_caps` table
  (`x_posts_per_day`, `posts_per_day`; the `*` row is the default). Upload-Post adds its own daily caps per
  account (Instagram 50, TikTok 15, LinkedIn 150, YouTube 30, Facebook 25 per Page, X 30); over one, the post
  fails plainly and nothing is retried.
- Formats: Instagram takes JPEG photos and MP4 Reels; Facebook and LinkedIn take photos and MP4 videos; TikTok
  needs a video or a photo; X takes up to one photo or video; YouTube needs a video. The first comment goes out
  with Facebook, Instagram and LinkedIn posts; on X and TikTok the customer adds it themselves.

## 5. treg, caps and billing

treg supplies the public social data, competitor ads, Google rank and Maps position, and Search Console for
pages on the app's own address. Every call goes through one server function (`server/treg.mjs`), is tagged with
the customer's opaque tag (`cust_…`, never an email), and is written to the usage ledger, success or failure.

**Once, before customers press Update**
1. In treg: top up the balance and turn on auto top-up (Team → Billing). The prepaid balance is the only hard
   limit; when it runs out, customers see "Analytics are temporarily unavailable" and you see a notice on the
   Customer usage page and the Marketing hub.
2. Mint two agent tokens and paste each **only** into Replit Secrets:
   - `TREG_TOKEN`: member role, for the app's calls (`treg org agent-new ylb-app`). Not your own dashboard key.
   - `TREG_ADMIN_TOKEN`: admin role, for caps and the usage check only (only a team owner can mint it).
   - `TREG_ORG_ID`: your team id (`treg org ls`; not secret).
   Usage tracking needs `CUSTOMER_TAG_SECRET` too (32+ random bytes; never change it).
3. Open **Settings → Billing (owner)** and press **Set up caps**. That declares the `customer` budget dimension
   at treg once and sends the default caps. The app never calls treg's `public-token` route.

**Caps.** Defaults: $0.25 a day, $3.00 a month and 400 calls a day per customer for analytics data; 50 posts a
day (20 on X) for posting from the app. A customer's own cap overrides a default field by field (an empty field
uses the default); **Block** stops their analytics at once; **Reset to default** removes their override. Each
change is sent to treg, whose budget is the authoritative ceiling; if that fails the row says "Not synced" and
saving it again retries. The app also checks before each paid call, counting real treg spend only: the
estimated costs of connected accounts and X posts are shown, labelled estimated, but never block anyone.
Several calls at once can go over a cap by about one call each, so each customer runs at most 4 at a time.

**Slow answers.** A treg answer that is still running after a minute comes back as "pending": it is never sent
again. The `treg-settle` job (once an hour, run by the hourly cron tick, §2a; and once when the server starts)
asks treg what it finally charged and adds a correcting ledger row. The same
goes for a call our server gave up waiting on whose one repeat found it still running at treg (whether treg
names the call in that answer is to be confirmed on the first live check). Calls still unsettled after 7 days
are no longer asked about; they stay listed as pending in the check against treg.

**Check against treg.** The owner page compares the ledger with treg's usage by customer over closed UTC days:
"attributed + unattributed = total" must hold, unattributed spend should be $0 (anything else means a call that
wasn't tagged), and a difference counts only if a one-day lag doesn't explain it. Pending calls are listed apart.

**CSV.** **Download CSV** gives one line per customer for a month: `customer_tag, email, month, treg_usd,
treg_calls, estimated_connections_usd, estimated_x_usd, total_usd, status`. The app doesn't charge cards or
send invoices: bill customers from the CSV outside the app.

## 6. Analytics, Search Console and email stats

**The Update button** (Marketing hub) fetches four sources in the background, at most once every 15 minutes per
business: Social (public stats through treg for each handle in Settings; a connected account's own stats from
Upload-Post instead), Ads (every connected ad account's results from Zernio, read only, plus up to 3 competitors'
active ads through treg), SEO page
(Google rank and Maps position per keyword in the business's city, Search Console numbers for this page) and
Email (Omnisend). A source that fails keeps showing its last good numbers with an "as of" time. Before anything is
spent, an Update is refused when the customer is over their daily or monthly cap (estimated connection and X costs
never count). Until the treg wrapper (section 5) is in the app, these routes answer "not available yet".

**Search Console for pages on the app's own address** (one property for every customer's page):
1. In Google Search Console, add the URL-prefix property `https://yourlocalbusiness.replit.app/`.
2. Choose **HTML file** verification. The homepage file is already served, with no sign-in and not the app shell:
   `https://yourlocalbusiness.replit.app/google2598e017b2dc1e02.html`
   (the body is exactly `google-site-verification: google2598e017b2dc1e02.html`). Press **Verify** in Google.
   A different file name can still be set as `GSC_APP_VERIFICATION_FILE`; the app answers that URL too.
3. Set `GSC_APP_PROPERTY` to `https://yourlocalbusiness.replit.app/`. Its host is also where the back button on
   Upload-Post's connect page takes customers (§3); unset, that is `https://yourlocalbusiness.replit.app`.
4. Connect Search Console to your treg team with the **write** capability (`treg connections connect --provider
   google-search-console`), pick the property, and check that `google-search-console.sites` lists it as
   `siteOwner`.

The app now serves `https://yourlocalbusiness.replit.app/sitemap.xml` (every customer's published sales page on
the app's address; pages on a customer's own domain are in that domain's sitemap instead, rebuilt at most every
10 minutes) and `/robots.txt` (everything allowed except `/api/`, pointing at the sitemap).

**Submit to Google** (SEO page → Analytics): for an app-address page the shared sitemap is submitted at most
once a day across all customers, and the page is inspected (Google allows 2,000 inspections a day for the whole
property: the app stops at 1,500, and at 20 per customer, and inspects a page at most once a week until it is
indexed). Google decides when to index; there is no "request indexing" API.

**Search Console for pages on a customer's own domain** (also on your treg team connection, in your own Search
Console account; customers connect nothing):
1. The first **Submit to Google** for a domain adds it to your Search Console as a Domain property
   (`sc-domain:<domain>`), unverified. The customer reads "The app's owner verifies it with Google first".
2. In Google Search Console, open that property → **Verify** → **DNS record**. Google shows a TXT record
   (`google-site-verification=…`) for the domain: send it to the customer to add at their DNS host (the same place
   they added the app's `_ylb-domain` record), or add it yourself if you manage their DNS. Press **Verify** in
   Google once it's there.
3. The customer presses **Submit to Google** again: the app sees the domain verified in your account, submits
   `https://<domain>/sitemap.xml` once and inspects the page. Its Search Console numbers appear on the next Update.
Nothing is sent twice by itself: when Google's answer was lost, the next press first checks, and sends again only
after the customer confirms.

**Email stats** come from Omnisend's reports, at most one live call per Omnisend account per hour and 40 a day
(Omnisend allows 55). The OAuth scope Omnisend needs for reports isn't confirmed yet: once it is, add it to
`OMNISEND_OPTIONAL_SCOPES` in `server/omnisend.mjs`. New connections then ask for it, existing customers are not
forced to reconnect (drafts keep working), and only the Email Analytics tab asks them to reconnect.

## 7. What customers see

### Settings → Connected accounts

One screen with two sections:

- **Social accounts** (Upload-Post), for the business on screen: "Each business connects its own accounts. These
  are <business>'s." Switching business shows that business's accounts. Facebook Page, Instagram, LinkedIn,
  TikTok, X, YouTube, and Pinterest as "Coming soon". Each row shows its state and one action: **Connect** (opens
  the hosted sign-in page in a new tab; the row reads "Waiting for Instagram…" with **Check** until the network
  answers, and "That didn't finish. Try again." after 30 minutes), **Reconnect** when the network asks to sign in
  again, and a ⋯ menu on connected rows (choose the Page for this business, check the connection, **Disconnect**,
  which stops only this business using it). **Business slots: 2 of 3 used** says how many of the user's businesses
  have social accounts; with all in use, a business without one is told to delete a business it no longer uses,
  and a slot still held by a business the server finds deleted shows **Free it** (with a confirm). The "How connecting works" tip says plainly that
  the sign-in page is run by Upload-Post, so its name shows there and on the network's permission screen.
- **Ad accounts** (Zernio): Google Ads, Meta Ads, LinkedIn Ads, TikTok Ads, Pinterest Ads, Reddit Ads, Microsoft
  Ads, and X Ads as "Coming soon". The card says: "See your ad results here. When launching is turned on, you can
  also launch and change campaigns from the app, and each change waits for your confirmation."
- **Coming back from Zernio's connect page.** The connect link sends the browser back to `APP_URL/?ylb_connect=<platform>`
  and Zernio adds `connected=<platform>&profileId=&accountId=` on success, or `error=&platform=&error_reason=&
  error_message=&is_user_fixable=` on failure. On success the app checks that platform at once
  (`POST …/<platform>/check {accountId}`: the account id is a hint, only the user's own rows count) and says it is
  connected. On failure it calls `POST …/<platform>/abandon {reason}` (the row stops waiting and keeps the reason)
  and says why in its own words for `no_pages_granted`, `page_not_granted`, `ad_accounts_not_granted`,
  `state_expired` / `invalid_state`, `reconnect_required`, `meta_ads_authorization_denied` and `connection_failed`.
  `ads_addon_required` and `payment_required` are the Zernio team's problem: the owner is told what to fix and an
  owner alert is logged; customers see "isn't available right now". Zernio's `error_message` is never shown. The
  parameters are then taken out of the address bar.
- **Reading accounts back** asks `GET /v1/accounts` with `adAccountRows=true` (one row per ad account; without it
  Zernio lists each ads login once, so a second Meta ad account on the same login would be missed), and accepts a
  `profileId` given as the id or as the Profile object.
- **Gmail** (§3d): one mailbox for this account, for outreach later. **Connect** and **Disconnect**. Until
  `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set, customers see that Gmail isn’t set up yet and the owner
  sees those secret names and the redirect URI. Nothing is sent from this screen.
- A side whose key isn't set says "Connecting social accounts isn't available yet" (or ad accounts) and shows no
  Connect buttons; with both off, one note: "Connecting accounts is coming soon. You can still post yourself and
  mark posts as posted."
- **The owner** also sees an "Owner setup" box with the missing Secrets (names only), the steps for each side
  that's off and the webhook address to register. Customers never see it.
- Team-level problems (our key, the profile cap, plan limits) show customers only "temporarily unavailable,
  we've been notified"; the owner sees the reason on Customer usage.
- Deleting a business (Settings → Projects & data) says "Its connected social accounts are disconnected too, which
  frees one of your business slots" when it has any, then disconnects them.
- **Other integrations** appears only once Nango is set up and lists at least one integration (§3b).

### Posting buttons and post status

Every post shows one posting button, by its state:

- **Post on Facebook** (or the post's network) when that account is connected. It opens a confirm window with the
  account, exactly what goes out, the image or video, where the link goes and the first comment. Nothing is sent
  until the customer confirms, and each confirm is one attempt.
- **Posting…** while the server sends it (a video can take up to 10 minutes), then **Posted** with **View post**.
- **In TikTok drafts** when TikTok put the post in the account's drafts: "Sent to your TikTok drafts. Open TikTok
  to publish it." It is never sent again.
- **May be on Facebook twice** when a try that didn't go out was posted by the network after all while the customer
  had posted it again: check the network and delete one. It is never sent again.
- **Try again** only when the network refused the post (nothing went out), with the reason in plain words (for
  example "This looks the same as a recent post on this network", "This account has reached the network's posting
  limit for now", "The connection to this account needs to be renewed"). It opens a new confirm.
- **Check again** when the app couldn't confirm the post went out: "It may have been posted - check before
  trying again." It is a read-only check (at most every 30 seconds) and the post is never sent again by itself.
  The customer can also **Mark as posted** or **Post it yourself**.
- **Post it yourself** when the account isn't connected: copy the text, download the image or video, open the
  network, then **Mark as posted**.
- On X, a post with a link warns "The link may not show on X" (the X Links allowance is shared).

Scheduled posts stay on the app's own calendar; the app sends each one only when the customer presses **Post**
and confirms. Manus only posts in Facebook groups (**Post to groups** on a Facebook post). Posts sent with Manus
by older versions show **Sent with Manus earlier**, read-only. There is no bulk send.

### Analytics and the Update button

- **Marketing → Overview → Update** (top right, the only filled button there) fetches every source for the
  active business, once per 15 minutes. A row under the header shows Social, Ads, SEO and Email as they finish;
  after 5 minutes the button comes back and the row says "Still updating in the background". Nothing is retried
  by the app: a refusal (today's limit, nothing to update yet, too soon) shows as a Callout or a toast.
- **Analytics tabs**: Social (a connected account's own stats from Upload-Post, otherwise public stats through
  treg; "Reconnect to see your own stats" when a network asks), Ads (connected ad accounts from Zernio, plus up
  to 3 competitors through treg), SEO page (treg and Search Console) and Email (Omnisend). Each shows the last
  fetched numbers with their "as of" time and a 7/30-day range.

### Ads: Launch… and the Campaigns tab

Marketing → Ads has three tabs: **Plans** (the planner), **Campaigns** (what was launched) and **Analytics**. With
launching on for the customer, a plan for Meta and/or Google with its page and ads shows **Launch…** (the full app
only; the artifact build keeps copy and CSV export). The launch window has one tab per platform and five steps:
**Ad account** (the business's connection, "Change in Connected accounts", then the ad accounts inside it with the
setup checklist), **Who sees it** (each place in the plan becomes a lookup and the customer picks every match; Meta:
radius and interests; Google: language; the "housing, jobs, credit…" question with no default), **The ads** (Meta:
1 to 3 versions, each with its image: "Make the image" or "Use my photo"), **Budget and dates** (a daily amount per
platform in that account's own currency, never converted; two platforms start empty under the plan's total; start,
days and the computed last day with the time zone, at least 2 days on Meta (§3c); the customer's limit and what's in
use; **Paused / Active** with no default) and **Review** (the server's own review of exactly what will be sent, with
blockers, claim ticks, warnings and what's left out). **Continue to confirm** opens the spend confirm: account and
id tail, daily, dates with the time zone, planned total, Meta's spending limit (or Google's "pause or end it to
stop"), Paused or Active, the ads and the link, the limit after this, and for an Active launch the "I understand
this will spend real money" tick. The button repeats the choice and the amount ("Launch on Meta and spend $25.00 a
day").

The **Campaigns** tab: the limits strip (daily limit, committed, live campaigns), Refresh (reads Meta and Google at
most every 5 minutes; also when the tab opens), the setup summary per platform, one row per campaign (state in plain
words, daily, dates, spent so far, results as of their read time, Manage, Open in Ads Manager) and the full **Ad
activity** (newest first, CSV). A row whose outcome is unknown shows the "may have happened" note and **Check
status**, never "Try again". A refused launch or change says why and what it left (nothing, a change done in part,
parts Meta kept, a campaign still running), and links Meta's fix page when there is one (§3c); a refused launch
offers **Launch again**. **Manage** shows the numbers, each ad's review, the campaign's activity, and Pause / Resume
/ Change daily budget / Change end date (Meta) / Swap ad / End, each with a preview and a confirm (the spend confirm
for anything that can raise spend), and off with the reason while a change is still going or unconfirmed. The planner
shows "Launched on Meta · Paused" on a launched plan and says edits don't change the live campaign.

The assistant can list launched campaigns and **open** the launch or change window; it never launches, resumes or
changes a budget, never picks Paused or Active and never ticks a box.

### Customer usage (owner only)

Settings → AI keys → **Billing (owner)** opens **Customer usage**: per customer, analytics cost (treg) today and
over 30 days, analytics calls, **Social (Upload-Post)** (social accounts connected now across their businesses,
their profiles (one per business), Upload-Post calls and the estimated profile cost) and **Ads (Zernio)** (ad
accounts connected now and their estimate), caps (edit, block, reset) and status. Above the table: **Upload-Post
profiles** used of the plan's limit (its tip gives each customer's limit of businesses) and, when there is one,
Upload-Post's last alert in plain words ("profiles are running low", "the API key was refused", "a customer reached
their limit of businesses" with which customer, …). Estimates
never count toward a cap. "Check against treg" and the monthly CSV are unchanged. It tracks usage only; it
charges nothing. Below it, **Ad limits** (§3c): the defaults, each customer's own limits (empty = the default),
committed daily and campaigns on, and **Pause all** for a customer (a preview of what's on, then one pause each).

The artifact build shows "Connected accounts and live analytics need the full app" instead of any of this.

## 8. What works on day one (no Upload-Post or Zernio key yet, no approvals)

- Manual posting: **Post it yourself**, then **Mark as posted**.
- Facebook groups through Manus.
- Social analytics from public data (treg) for every handle in Settings.
- Competitor ads, Google rank and Maps position (treg).
- Search Console for pages on the app's own address (after §6), and on customers' own domains once you verify
  each one (§6).
- Email analytics (Omnisend, once the reporting scope is confirmed).
- Gmail connect (§3d), once `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. Sending waits for outreach.
- Per-customer usage, caps and the CSV.

**As soon as `UPLOAD_POST_API_KEY`, `UPLOAD_POST_WEBHOOK_SECRET` and `MEDIA_URL_SECRET` are set** (and the §2
migrations run): customers connect each business's social accounts, post from the app after a confirm, and see
each business's own stats. **With `ZERNIO_API_KEY` and `ZERNIO_WEBHOOK_SECRET`**: they connect ad accounts and see their ad results.
Each side works without the other. No network approvals are needed: Upload-Post's apps (social) and Zernio's
apps (ads) are already approved.

## 9. Owner checklist: before paid plans (P0)

These start the things later phases wait on. None of them charges anyone.

1. **Cron tick** (§2a): `CRON_SECRET` in Replit Secrets, the same value as the Vault secret `cron_secret`, then
   run `supabase/migrations/20261109000000_cron_tick.sql` and check the first tick.
2. **Stripe Sandbox**: in the Stripe Dashboard, create a Sandbox for "Your Local Business". Put its **secret key**
   (`sk_test_…`) in the Replit **workspace** Secrets only (Tools → Secrets in the workspace, not the deployment) as
   `STRIPE_SECRET_KEY`. The live key comes later (P1), as a restricted key in the deployment Secrets. Never paste a
   key anywhere else; the app only ever shows its last 4 characters. Tests use `server/test/mock-stripe.mjs` and
   never call Stripe.
3. **Google OAuth verification for `gmail.send`** (needed before outreach goes beyond test users, P10): the
   connect flow, the OAuth client and the redirect URI are §3d. The redirect URI is
   `https://yourlocalbusiness.replit.app/api/integrations/gmail/callback`. Secrets: `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`. In Google Cloud Console → APIs & Services → OAuth consent screen, add the
   `https://www.googleapis.com/auth/gmail.send` scope, the app's domain, and these pages, then submit for
   verification:
   - Privacy policy: `https://yourlocalbusiness.replit.app/privacy`
   - Terms of service: `https://yourlocalbusiness.replit.app/terms`
   It is a sensitive scope (not restricted): Google reviews the app and a demo video; it can take a few weeks.
   Until Google verifies the app, keep the consent screen in Testing and use test users (§3d).
4. **Microsoft publisher verification** (for `Mail.Send` from Outlook, P10): in Microsoft Entra → App registrations,
   link the app to a verified Microsoft Partner Network ID (Publisher verification), so customers see a verified
   publisher instead of "unverified" on the consent screen.
5. **Stripe Connect platform profile** (sellers take payments, P6): in the Stripe Dashboard → Connect → Get started,
   fill in the platform profile (what the platform does, who the sellers are, that sellers own their Stripe
   accounts and see the full Stripe Dashboard, that Stripe collects its fees from the seller and sellers carry
   negative balances). Don't enable live charges yet.

## 10. Plans and billing (P1: Launch, Grow, Scale)

Code: `server/billing/stripe.mjs` (routes, webhook, money operations, cron), `server/billing/entitlement.mjs` (what a
plan allows), `server/billing/plans.mjs` + `shared/plans.json` (every price and limit), `server/billing/accounts.mjs`
(the tables), `scripts/stripe-setup.mjs` (products and prices). Database: `supabase/migrations/20261110000000_billing.sql`.
Nothing is enforced until the owner turns plans on; until then the app behaves as before.

### Owner steps, in order

1. **Stripe Sandbox first.** In the Stripe Dashboard, open a Sandbox (Developers → Sandboxes) and copy its secret key
   (`sk_test_…`) into the workspace Secrets as `STRIPE_SECRET_KEY`. Everything below is done in the Sandbox, end to
   end, before anything live.
2. Run the migration `supabase/migrations/20261110000000_billing.sql` (and check the rule on a branch, below), then
   `20261111000000_video_week.sql` (P1b) and `20261114000000_trial_paywall.sql` (P1c: the free first business, the
   7-day card trial and the cancel survey; until it is run no trial is offered).
3. Set `APP_URL` (the app's https address).
4. **Products and prices** with the setup script (below): a dry run, then `--apply`.
5. **Webhook** (below): the endpoint URL and the 10 events; its signing secret into `STRIPE_WEBHOOK_SECRET`.
6. **Customer Portal** settings (below), with the cancellation reason survey on. In Stripe → Settings → Billing →
   Subscriptions and emails: Smart Retries ("Failed payments", below) and the free trial reminder ("Send a reminder
   email 7 days before a free trial ends", see "Free trial, paywall and cancelling").
7. Optional: **Stripe Tax** (below).
8. Try it in the Sandbox: create an account and set up a business, then on `#plans` start the 7-day free trial with
   `4242 4242 4242 4242` (once plans are on, setup's Launch step shows the same plans); Settings › Plan shows the days
   left. Try **Cancel trial** (the survey) and **Keep my plan**. A trial on a card that already had one is cancelled
   at once, by design: every `4242…` test card has the same fingerprint, so a second test trial needs another test
   card (for example `5555 5555 5555 4444`). For the paid path, set **Card trial** to 0 in Customer usage › Plans,
   then on a new account choose a plan on `#plans`, pay with `4242 4242 4242 4242`, come back to the app, add a
   business, and try `4000 0000 0000 0341` (a card that declines later) for the failed-payment path.
9. Owner → Billing → Plans → **Turn on plans**.
10. Live (only with the owner's explicit OK): create a **restricted live key** (`rk_live_…`, permissions below), run
    the setup script with it and `--live`, add the live webhook endpoint and its secret, set up the live Portal, and
    swap the Secrets.
11. **$1 live check** (with the owner's OK, before turning plans on in live): the app has no promotion codes, so a $1
    charge is made in the Dashboard, not through `#plans`. Stripe → Customers → add a customer with the owner's own
    email (not linked to any app account) → Invoice → one item, $1.00, charge automatically → pay it with the owner's
    own card. Check: the payment shows as succeeded; Developers → Webhooks → the live endpoint shows the
    `invoice.paid` delivery answered 200 (the app ignores it as not its customer, which proves the live signing secret
    works); then refund the $1 (Payments → the payment → Refund). Only after that, one real Launch purchase on the
    owner's own app account is optional: cancel it in the Portal and refund it in the Dashboard.

### Secrets

| Secret | What it is |
|---|---|
| `STRIPE_SECRET_KEY` | In production a **restricted live key** (`rk_live_…`) with: Customers write, Checkout Sessions write, Subscriptions write, Billing Portal write (sessions; configurations if you use `--portal`), Prices read, Products read, Invoices read, Events read, PaymentMethods read (the trial's one-card check reads the card's fingerprint; without it the owner is alerted with `billing_alert_trial_card_unread` and the card isn't checked). For setup only, the script needs Products and Prices write too (use a separate key for that, or add and remove the permission). The Sandbox key (`sk_test_…`) goes in the workspace Secrets only. The app shows only its last 4 characters. |
| `STRIPE_WEBHOOK_SECRET` | The endpoint's signing secret (`whsec_…`). |
| `STRIPE_WEBHOOK_SECRET_PREVIOUS` | Only while rotating the signing secret: the old one, so events signed with it still verify. Remove it once rotated. |
| `STRIPE_PORTAL_CONFIGURATION` | Optional: the Customer Portal configuration id (`bpc_…`) to use instead of the default one. |
| `STRIPE_AUTOMATIC_TAX` | Optional: `1` turns on Stripe Tax at Checkout (decide on tax registration first). |
| `APP_URL` | The app's https address (Checkout and the portal return there). Falls back to `GSC_APP_PROPERTY`. |
| `STRIPE_API_BASE` | Tests only (the mock). Honoured only with an `sk_test_` key, so a live key only ever goes to Stripe. |
| `CUSTOMER_TAG_SECRET` | Already set for usage tracking; plans use the same customer tag. |

### Webhook

Stripe Dashboard → Developers → Webhooks → Add endpoint: `https://yourlocalbusiness.replit.app/api/webhooks/stripe`,
events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid`,
`invoice.payment_succeeded`, `invoice.payment_failed`, `invoice.payment_action_required`. Copy its signing secret into
`STRIPE_WEBHOOK_SECRET`. The app checks the signature on the raw body, records each event id once
(`webhook_deliveries`, `stripe:<evt_id>`), reads the subscription again from Stripe instead of trusting the event, and
answers 500 when it couldn't finish (Stripe then delivers it again). A live-mode event with a test key (or the other
way round) and Connect events are ignored.

### Products and prices: `npm run stripe:setup`

Prices are found by lookup key, never by id: `ylb_{launch,grow,scale,business}_{monthly,yearly}` (products
`ylb_launch`, `ylb_grow`, `ylb_scale`, `ylb_additional_business`). Run it in this order:

1. `npm run stripe:setup` with the Sandbox key: a dry run. It lists each lookup key as `ok`, `missing (dry run)` or
   `MISMATCH` and changes nothing.
2. `npm run stripe:setup -- --apply` creates what's missing (each write has a fixed Idempotency-Key: running it twice
   never makes a second product or price). `--portal` also makes a Customer Portal configuration and prints its id.
3. A `MISMATCH` (an amount, currency or interval that differs) stops with exit 1. Prices can't be edited: decide, then
   `--apply --replace` makes a new price that takes the lookup key (existing subscriptions keep the old price).
4. Live: the same with the live key and `--live`, only with the owner's explicit OK.

### Customer Portal

Stripe → Settings → Billing → Customer portal (or `--apply --portal`): payment methods on, invoice history on,
cancel **at period end** on with the **cancellation reason survey on** (every reason: too expensive, missing features,
switched service, unused, too complex, low quality, customer service, other: the app reads the answer from the
subscription's `cancellation_details` and counts it with its own survey), **subscription updates (plan and quantity
changes) off** (the app does those so each one is sent once and confirmed). Business information and links to the terms and privacy pages
(`https://yourlocalbusiness.replit.app/terms` and `https://yourlocalbusiness.replit.app/privacy`).

### Stripe Tax (optional)

Off by default. Decide on tax registration first (Stripe → Tax → Registrations), then set `STRIPE_AUTOMATIC_TAX=1`:
Checkout then collects the address it needs and adds tax where it applies (prices are `tax_behavior=exclusive`, so
tax goes on top). Leaving it off charges the plan price only.

### Failed payments (dunning)

Stripe → Settings → Billing → Subscriptions and emails: Smart Retries for 2 weeks, then **cancel** the subscription;
send emails for failed payments and expiring cards. In the app a failed payment gives 7 days of full access
(`grace_until`), then paid actions pause (402 `PAYMENT_REQUIRED`); `unpaid` locks businesses above the first;
everything comes back when a payment goes through.

### Turning on plans

Owner → Billing → Plans → Turn on plans (`PUT /api/billing/settings {enforce: true}`). It refuses until the Stripe
key, the webhook secret, `APP_URL` and all 8 prices are in place, and says which is missing. When it turns on:

- Every existing account with at least one business gets **30 days of Grow free** (`existing_trial_days`), with as many
  businesses as it has. Then they choose a plan; Checkout preselects their extra businesses.
- New sign-ups set up their first business free, then meet the paywall at setup's Launch step (the 7-day card trial,
  `card_trial_days`, 7 by default; see "Free trial, paywall and cancelling").
- Every business already has a slot (the migration's backfill, and the trigger while plans were off).

**Rollback**: turn plans off (the same switch). Everything is ungated again at once; nothing is deleted, and turning
them on again later doesn't restart the free days (they start at the first `enforced_at`).

### In the app: attaching payment and where buy links go

- **Settings → Payments** (signed in, self-hosted only): a card for **Live** and one for **Test mode** (Whop's
  sandbox). Connected, it shows the account, the key's last 4 characters, whether sales updates arrive ("Receiving
  sales", "Not confirmed yet", "Whop turned off sales updates" with **Turn back on**), the last sale update, **Check
  again**, **Replace key** and **Disconnect** (a second confirm pauses the buy links that use it). The key and the
  webhook secret are password fields, emptied after every try, success or not.
- **Attach payment** (one dialog everywhere): pick one of the business's offers, or make one: **Whop** (product, then
  plan; the price comes from Whop; one request id per dialog, so a double press makes one link; "Whop didn't
  confirm the link yet" offers **Check again**) or **your own link** (address, price text, title; the hint says
  whether buyers go straight there or see the "you're leaving" page first). Signed out, with offers off on the
  server, or in the claude.ai build, the old plain link field shows instead.
- **Where it's used:** an asset's **Payment** row (Code & assets: the AI then writes its Buy buttons as plain
  `<a href="{{buy:<id>}}">` links, with no checkout of its own and no price but the offer's), the SEO page's
  payment under **Page type** (the checkout page shows the offer's price), the listing's **Buy link** (the published
  listing carries `https://<app>/b/<id>` and "Secure checkout on whop.com"), and an email's button (**Use a buy
  link**). Pages hold the token `{{buy:<id>}}`; publishing asks the server which offers are the business's and
  writes `/b/<id>` (relative, so a page on the customer's own domain stays there); any other id becomes `#`. The
  in-app preview shows `#buy-preview`; a copy or export gets the full address. Published pages stay sandboxed: a Buy
  button is a plain link.
- **Studio → Listing & publish → Offers:** each offer with who takes the payment, Test mode, its state, clicks, live
  sales and where it's used; **Copy link**, **Refresh from Whop** (re-reads the plan's price), **Pause**/**Resume**
  and **Archive** (its link then says it's no longer available).
- **Analytics → Sales:** live sales, revenue per currency (gross, refunds under it) and buy link clicks for the
  range; Test mode sales only as a note; the sales list (Live/Test, CSV). Refunded, Partly refunded and "Disputed:
  see Whop" come from Whop's events; refunds and disputes are handled in Whop.

### Money rules (what the code guarantees)

- One money operation in flight per user (`billing_ops`); each Stripe write is sent once with a fixed Idempotency-Key
  built from the user and the app's request id. A timeout is read back from Stripe and never resent; after 10 minutes
  without the change it's marked `not_applied` and the user may try again. An op a crashed process left `sending` is
  read back the same way after 2 minutes (never resent).
- One Checkout at a time per user: before a new Checkout page is made, every other open page of the customer is
  expired (`POST /v1/checkout/sessions/:id/expire`, its own Idempotency-Key), so two pages can never both be paid.
- Adding a business charges the prorated price now (`always_invoice` + `error_if_incomplete`): a declined card changes
  nothing. Removing one lowers the quantity with no proration (no refund, no charge); the business stays until the
  period ends, then the hourly job locks the one the user chose. Upgrades and monthly → yearly are immediate and
  charged now; a downgrade applies at renewal and keeps the old tier's features until then; yearly → monthly is done
  by support in the Stripe Dashboard (the webhook picks it up). A lower plan together with yearly is two steps (the
  lower plan first). What was paid for a period is kept to its end: a second removal or downgrade never cuts the
  first one's keep, moving back up to (or below) the tier paid for is free, and above it is refused until the user
  switches back. Undoing a removal is free only within the same period (after a switch to yearly it's an add).
- The owner's account is the `owner` plan: no Stripe Customer is ever made for it.
- Deleting an account cancels every subscription of its Stripe customer that isn't over (read from Stripe, not only
  the stored one); if that can't be confirmed the deletion stops (409 `BILLING_PENDING`), and Stripe failing is a 503
  in our words. The Stripe Customer is kept (receipts, tax records).
- Owner rights come from `isAdmin` at sign-in, never from the stored row alone: the owner row is made the first time
  any gated request of theirs is seen, and a former admin's row goes back to no plan.
- A free (comp) plan is never replaced by an old subscription's events, only by a plan the customer buys.
- Turning plans on gives existing users their free days first; if that fails, plans stay off and the switch can be
  pressed again.
- A business locked on the plan can't post, connect accounts or refresh analytics (402 `BUSINESS_LIMIT`).
- After a plan ends, published pages keep serving 30 days; data is kept 90 days and is never deleted automatically
  (the owner list shows `dataExpiresAt`).

### What customers see (the app)

- **`#plans`** (public, signed out too): a Monthly / Annual switch (annual shows "2 months free" and the saving),
  the Launch, Grow ("Most popular") and Scale cards, the comparison table and the FAQ, all from `shared/plans.json`.
  **Start with …** signed out remembers the choice, opens Create your account ("Then you'll finish starting Grow
  ($197/month) with Stripe."), and after sign-in goes straight to Stripe Checkout; back in the app
  (`?billing=success&session_id=…`) the plan is read again: "You're on Grow.", or "Payment is still processing" with
  a refresh. Signed in with a plan, the buttons read Current plan / Switch to … (upgrades and monthly → yearly are
  charged now, downgrades start at renewal; yearly → monthly says to contact support).
- **New sign-ups** with plans on and no plan see the plan picker before their first business.
- **Every new business claims a slot first** (project menu, palette, Settings › Projects & data, the setup, the
  assistant, a backup import). A full paid plan opens **Add a business** ($97/month, charged today for the rest of
  the period; a declined card changes nothing; "Confirming your payment…" is read back, never re-sent); no plan opens
  `#plans`; the assistant only says the plan is full (it never buys).
- **A business the account refused** (no free slot: the database's rule) stays on that device with a note: Add a
  business, or Remove from this device. Other changes keep saving.
- **Settings › Plan**: the plan, price, status (Active, Trial ends, Payment problem until, Cancels, Ended), next
  renewal, the AI credits meter, Change plan, Manage billing (the Portal: card, invoices, cancelling); the businesses
  (N of M, Active / Locked / Ends), Add a business, Remove one at renewal (choose which; no refund), Undo, and
  Choose which businesses stay active when over the limit. The owner sees "Owner plan — unlimited".
- **Banners** for a failed payment (grace, then paused), a trial ending, a plan that cancels or ended; **one upgrade
  prompt** for any refused paid action (`PLAN_REQUIRED`, `PAYMENT_REQUIRED`, `CREDITS_USED`, `BUSINESS_LIMIT`,
  `CARD_DECLINED`) with the server's own sentence and See plans / Upgrade to … / Update card / Add a business / Use my
  own AI keys. Ads' Launch shows "Part of Grow and Scale" on Launch; longer videos show the tier that has them.
- Owner → Billing → **Plans**: the switch (with what's missing), card-trial days, free days for existing accounts,
  every account's plan (Stripe ids as …last4), Grant free plan, Re-check with Stripe.
- None of this exists in the claude.ai artifact build.

### Weekly AI videos (P1b)

- **Limits** (`shared/plans.json` `videosPerWeek`): Launch 3, Grow 5, Scale unlimited, per business; the owner is
  unlimited. A business's week runs Monday 00:00 to Sunday 23:59 in its time zone (Settings › Brand › Business
  details; else the browser's zone sent with the request; else UTC).
- **Counting** (`server/videoWeek.mjs`, table `video_starts` from `supabase/migrations/20261111000000_video_week.sql`):
  a video counts when the server asks a provider for it (`POST /api/ai/video`, which the video panel, the composer and
  the assistant's `make_video` all use). It's claimed before the provider is asked, under a per-user, per-week
  advisory lock, so two parallel starts can't both pass at the limit. It is refunded only when the provider certainly
  never started it (it refused before any paid work, or no key could make it); when in doubt it counts, and it is
  never retried. If the claim's answer is lost (a timeout) while a limit applies, the route refunds that claim id and
  answers 503 without asking the provider. The account's total is also held to the limit times its businesses; a
  refusal for that reason says `scope: 'account'` with the account's numbers ("…across your businesses").
- **Business check** (while a limit applies, provider-key videos only): the business id must be one of the account's
  businesses (`project_slots`): unknown gives `404 UNKNOWN_BUSINESS`, a locked (paused) business `402 BUSINESS_LIMIT`,
  a failed lookup 503. The business's saved time zone wins over the one the request sends.
- **Own keys**: videos made with the customer's own AI key are recorded but never counted or refused, the same rule as
  AI credits (own keys never use credits).
- **Plans not turned on**: videos are counted, never refused. Once on: `402 VIDEO_WEEK_LIMIT { used, limit, resetsAt }`
  ("You’ve made 3 of 3 videos this week. Resets Monday."), shown in the upgrade prompt with Upgrade and Use my own AI
  keys. `GET /api/ai/video/week?projectId=` answers the count the video panel and the campaign setup show ("2 of 3
  videos used this week").
- **Video days**: the campaign setup chooses how many videos go out on each posting day (`CampaignConfig.videoDays`,
  Monday first; default Mon/Wed/Fri, 3 a week; older setups' "videos per day" become that count on each posting day
  when the workspace opens). More videos a week than the plan makes is a warning (with "See plans" while plans are on:
  "…so the rest won't be made"); it never blocks the 30-day plan. Applying a strategy caps its video days to the plan's
  weekly videos, spread across the week, and the saved plan view fits each day's formats to the video days.
- Before the migration is run, the counts live in the server's memory (they reset when it restarts).

### Free trial, paywall and cancelling (P1c)

Migration `supabase/migrations/20261114000000_trial_paywall.sql`. No new Secrets: the trial's email and card hashes
are keyed with `CUSTOMER_TAG_SECRET`.

- **Sign-up and setup are free.** With plans on, a new account makes its first business without a plan
  (`claim_project_slot` lets someone with no business start one; any other business still needs a plan's slot) and
  goes through setup: business, brand board, strategy, first drafts. Setup's AI runs on a one-off allowance
  (`starter.aiCredits` in `shared/plans.json`, 200 credits ≈ $2, never renewed; own AI keys never count).
- **Locked before a plan:** publishing pages and assets, posting, connecting accounts, analytics updates, launching
  ads, AI video and every other paid action answer 402 `PLAN_REQUIRED`; the app shows **Start your free trial**.
  Browsing and editing stay open. A plan that ended gets no allowance and no trial.
- **The paywall** is setup's Launch step: the plan cards with **Start 7-day free trial** and "Not now, look around
  first". `#plans`, the sign-up screen, Settings › Plan and the upgrade prompt say the same.
- **The trial:** Stripe Checkout with `trial_period_days` (the owner's `card_trial_days`, 7 by default; 0 turns it
  off in Customer usage › Plans), the card required (`payment_method_collection=always`) and the subscription
  cancelled if the card is gone at the end. Nothing is charged until day 8. A trial Checkout takes cards only
  (`payment_method_types=card`: Link has no card fingerprint) and says on Stripe's page, next to the pay button, "One
  free trial per person and card…". The trial gives the chosen tier's features with its own AI allowance
  (`cardTrial.aiCredits`, 300 credits ≈ $3) for the whole trial, counted from its first UTC day: what setup spent that
  day before the trial began is stored with the trial (`billing_trials.ai_baseline_usd`) and not counted. It covers the
  plan's one business: a Checkout with extra businesses starts paid (no trial; Stripe's page says so), and Add a
  business answers "Extra businesses start after your free trial" until it ends (Stripe would bill an added business
  $0 until day 8). The app shows the days left, and "ending soon" in the last `cardTrial.endingSoonDays` (3) days.
  **Turn on Stripe's trial reminder** (owner step): Stripe → Settings → Billing → Subscriptions and emails → Email
  notifications and customer management → "Send a reminder email 7 days before a free trial ends". For a 7-day trial
  Stripe sends it as the trial starts (the end date and the price); there is no "3 days before" setting, and Stripe
  sends none in a sandbox. The app's own copy says only that.
  If the card fails on day 8, the normal past-due grace applies.
- **One trial per person:** never after a plan, a free plan or a trial on the account, nor for an email that had one
  (HMAC of the address in `billing_trials`, kept when the account is deleted). Checkout can't check the card before
  it's typed in, so a trial whose card fingerprint (HMAC) already had a trial on another account is **cancelled at
  once, nothing charged** (never turned into a charge the customer didn't agree to): one
  `DELETE /v1/subscriptions/<id>?invoice_now=false&prorate=false` with Idempotency-Key `ylb-trial-cancel-<subscription>`,
  recorded as a money operation so it is never resent (an unclear answer is read back). The app then says "Your free
  trial didn't start… nothing was charged" and offers the plan without a trial; that Checkout says "This plan starts
  today: free trials are for first plans only." on Stripe's page. Of two trials on one card, the one that started
  first keeps it. A card that couldn't be read (`billing_alert_trial_card_unread`: no PaymentMethods permission, a
  failed read) is read again on every sync while its trial runs; a later trial on it that got through is cancelled
  at its own next sync. The owner is alerted (`billing_alert_trial_duplicate`; `billing_alert_trial_end_failed` when
  Stripe refuses the cancel or it is never confirmed: that trial then runs on as Checkout said, and nothing more is
  sent).
- **Cancel plan** (Settings › Plan): a short survey first: one required reason (too expensive, not using it enough,
  missing a feature, results not good enough, switching to another tool, too hard to use, only needed it for a short
  time, other) and an optional comment. The reason brings up one alternative (a cheaper plan, tips through Strategy or
  own AI keys, "tell us the missing feature"), never blocking the cancel. Cancelling is
  `POST /api/billing/cancel` → `cancel_at_period_end` with Stripe's `cancellation_details` (sent once per press,
  Idempotency-Key `ylb-cancel-<user>-<id>`); a trial cancelled this way ends without a charge. After a failed payment
  (past due, unpaid) Cancel ends the plan now instead (`DELETE` with `invoice_now=false`, `prorate=false`: Stripe stops
  trying the card, nothing more is charged); every other change still waits for the card. The answer is kept once
  the cancel went through (read back, if its answer was unclear), never for one that failed. A change that was read
  back and isn't there answers `409 NOT_APPLIED` (the app's next press is a new request). **Keep my plan** undoes it
  (`POST /api/billing/resume`, also while past due). Taking the alternative saves the answer only
  (`POST /api/billing/cancel/survey`). Before the migration is run, both answer `409 USE_PORTAL` and the app opens the
  Customer Portal.
- **What the owner sees:** Customer usage › Plans → **Why people cancel** (`GET /api/billing/surveys`): totals by
  reason over every answer (cancelled and stayed; `ylb_cancel_survey_totals`), the latest comments (from the app and
  from the Portal), trials running and second trials stopped. The accounts table shows when each trial ends.

### Cron jobs

`billing-hourly` (pending removals and downgrades at period end, due locks, free trials ending, unknown operations
read back, slots claimed for a business that was never saved freed after a day), `stripe-reconcile` (04:17 UTC: re-reads every subscription, adopts a completed Checkout whose webhook was
missed; never writes to Stripe, except cancelling a second trial on an already-used card once (nothing charged), as
an operation that is never resent), `billing-retention` (04:47 UTC: counts accounts past 90 days; deletes nothing).

### The database rule (check on a Supabase branch, with the owner's OK)

The migration makes `user_docs` project rows writable only while the business holds an active `project_slots` row
(once plans are enforced). Tests check it against the mock only; check the real policy on a Supabase branch before
production:

1. Create a branch, apply `supabase/migrations/20261110000000_billing.sql`, `update billing_settings set enforce = true`.
2. As an authenticated test user (no plan): inserting a `user_docs` row with `kind='project'` is refused (42501).
3. Give the user a plan row (`billing_accounts`, status `active`, `business_limit` 1), call
   `select claim_project_slot('p1')` as that user, then insert project `p1`: allowed; a second project's claim answers
   `{"ok":false,"reason":"limit"}`.
4. Lock the slot (`update project_slots set state='locked'`): updating `p1` is refused. Delete `p1`: its slot is gone.
5. `update billing_settings set enforce = false`: inserting a new project works and gets a slot by itself.
6. Two sessions calling `claim_project_slot` at once at limit − 1: exactly one gets it.

## 11. Leads and lead magnets (P2)

Every form a customer publishes now sends to the app, and every answer shows in **Marketing Hub → Email → Leads**:
the SEO page's form, an asset's widget (a lead form, a booking request, a quiz result, a calculator or ROI estimate, a
checklist request), a Manus or Viktor page's form, and the lead magnet's sign-up.

### Owner steps

1. Run `supabase/migrations/20261112000000_leads_p2.sql` in Supabase → SQL Editor (safe to run again) **before**
   deploying the P2 code. It needs `20261103050000_page_leads.sql` first. If the code went out first, page and asset
   forms still work (kept without their business, source and result fields, so "This business" shows the SEO page's
   leads), the source filter names the file, and lead magnet downloads answer "not found". Assets published in that
   time have no business on the server: once the file has run, publish them again, then run the file once more. It
   marks their earlier leads as Assets and gives them the business their page now has.
2. Optional: set `LEAD_LINK_SECRET` (16+ random characters) as a Secret. It signs the 15-minute download links a
   sign-up gets. Without it, a key derived from `SUPABASE_SECRET_KEY` is used; changing either only ends links that
   are still open. Start-up shows its last 4 characters, never more.
3. Optional limits (defaults in brackets): `LEADS_PER_IP_PER_HOUR` (10) for every form, the lead magnet's gate
   included; `LEADS_PER_PAGE_PER_HOUR` (30) for page and asset forms; `MAGNET_SIGNUPS_PER_FILE_PER_HOUR` (300) for
   the gate's sign-ups per download (its own count: a link in an email reaches many people at once);
   `MAGNET_HITS_PER_IP_PER_HOUR` (60) and `MAGNET_DOWNLOADS_PER_FILE_PER_HOUR` (600) for `/m/<id>`.
4. Republish pages and assets made before P2 if their forms should send: publishing is what turns `{{lead-action}}`
   into the page's `/<name>/lead`. Existing assets aren't rewritten.

### Where responses go

| What the visitor uses | Sent to | In Leads as |
|---|---|---|
| The SEO page's form | `POST /<name>/lead` (plain form post: SEO pages run no scripts) | source **Pages**, kind form (lead with a lead magnet) |
| An asset's lead form, booking widget, quiz, calculator, ROI or checklist step | `POST /<name>/lead` (the widget's script, `Accept: application/json`; a plain post without scripts) | source **Assets**, kind lead, booking, quiz, calculator, roi or checklist, with its result, score, answers, inputs or estimate |
| A Manus or Viktor asset's form | the same (the app makes each form that fits post there; forms it can't receive are taken out) | source **Assets** |
| The lead magnet's email gate | `POST /m/<id>` | source **Lead magnet**, kind magnet |

- Nothing is emailed to visitors and nothing goes to an email provider: the owner reads leads in the app, adds one to
  Subscribers (asked first when they didn't tick the email box) or exports a CSV (date, source, kind, business, page,
  contact fields, consent and every result field).
- Only a ticked "Email me tips and offers from {Brand}" box (`consent=yes`) counts as agreeing to emails. Sending
  the form or downloading doesn't.
- A widget's form sends nothing in the preview, nor in a copy of an asset that isn't published (it says so). A copy
  of a published asset sends to its full `https://<app>/<name>/lead`.
- The source filter and the CSV follow **This business / All businesses** and **All · Pages · Assets · Lead magnet**.
  The filter is kept in memory only: leads are people's details, never saved in the browser.

### The lead magnet download

In **Email › Lead magnet › Delivery** the customer publishes the download once: a PDF made from the guide (the app's
ebook builder, in the brand's colours with the listing cover), an uploaded file (PDF, EPUB, ZIP, Word, Excel,
PowerPoint, PNG, JPEG, WebP, MP3 or MP4, up to 25 MB; never SVG or HTML) or a link to a page. "Ask for an email before
the download" is on by default. The link is `https://<app>/m/<id>` and never changes: **Update download** replaces the
file behind it, **Unpublish** ends it. It also answers on the owner's verified domains (`https://<domain>/m/<id>`),
but the app always shows and emails the app's address, which keeps working whatever happens to a domain. Emails'
`{{lead_magnet_link}}` is that link, and `{{product_link}}` is the page posts link to; until they exist the preview
says what to add (for the lead magnet's link: publish the download) and Omnisend drafts are refused.

A link download (to a page of the owner's) redirects only on the owner's verified domain. On the app's address,
`/m/<id>` shows a page that names the other site with a "Continue to <site>" link, so the app's address can't be
used to bounce people somewhere else.

A lead form or SEO page form that sends the magnet's id needs an email (as the gate does) and answers with a direct
download for 15 minutes. Forms carry the download's id from when they were **published**: the SEO page picks it up
when it's published (it shows as a change to publish), and a lead-form widget writes `{{lead-magnet}}`, which
publishing fills in. So after publishing a download for the first time, or after **Unpublish** and publishing again
(a new id), publish the SEO page and any lead-form assets again so their forms offer it; the app says so. Downloads
stop 30 days after the plan ends.

Deleting an account deletes its leads and downloads (the rows cascade) and empties its folders in the `media`,
`lead-files` and `public-files` buckets.


## 12. Payments: offers and Whop (P3)

An **offer** is one thing a business sells, with one permanent buy link: `https://<app>/b/<id>`. Assets, the SEO
checkout page, listings and emails hold the offer, never a provider's URL, so the checkout behind it can change
without republishing anything. Two kinds now:

- **Whop:** the customer connects their own Whop account and picks one of their products and plans. The app makes
  one Whop checkout link for it (once, when the plan is attached) and `/b/<id>` sends buyers there. Sales come back
  through that account's signed webhook and show in the app. There is no platform fee on Whop sales.
- **Your own checkout link:** any checkout page the customer already has. Known checkout sites
  (`shared/checkout-hosts.json`: Stripe Payment Links, Gumroad, Lemon Squeezy, PayPal, Square, Shopify, Etsy, Payhip,
  Ko-fi, Buy Me a Coffee, Whop, Podia, Kajabi, Thinkific, Teachable, Calendly, Cal.com) get a direct redirect; any
  other site gets a short "This checkout is on another website" page on the app's address (a redirect only on the
  customer's own verified domain). The app can't see those sales, only the clicks.

### Owner steps

1. Run `supabase/migrations/20261113000000_offers.sql` in Supabase → SQL Editor (safe to run again). It needs the
   earlier files (`ylb_touch_updated_at` from `20261102000000_accounts.sql`, `webhook_deliveries` from
   `20261105000000_integrations.sql`). Until it has run, the offers routes answer "isn't set up" (admins see the
   file's name) and `/b/` links answer "not found".
2. Set `PAYMENT_KEYS_SECRET` (32+ random characters) **before anyone connects Whop**, and never change it. It seals
   each customer's Whop key and webhook secret (AES-256-GCM, its own key, bound to the row). Without it, a key made
   from `USER_KEYS_SECRET` (else `SUPABASE_SECRET_KEY`) is used; changing whichever one is used makes every saved
   Whop key unreadable (customers then use "Replace key" and paste the webhook secret again).
3. Set `APP_PUBLIC_URL` to the app's https address (for example `https://yourapp.replit.app`). Whop sends each
   connection's events to `APP_PUBLIC_URL/api/webhooks/whop/<connection id>`, and buyers come back to
   `APP_PUBLIC_URL/b/<id>/done`. Without it the request's own address is used, and on a local or http address the
   webhook can't be made automatically (customers make it by hand, below).
4. Optional: `OFFERS_PROVIDER=off` turns offers off (routes 503, `/b/` "not found"); `WHOP_ENABLED=off` keeps
   offers with outside links only; `OFFER_CLICKS_PER_IP_PER_HOUR` (60) and `OFFER_CLICKS_PER_OFFER_PER_HOUR` (3000)
   limit `/b/` per visitor and per offer.
5. **Before Whop goes live (with the owner's OK only):** in the Whop **sandbox** (cards only, `4242 4242 4242 4242`)
   connect a sandbox account key in Test mode, attach a plan, buy through `/b/<id>`, see the sale arrive, refund it
   in Whop and see "Refunded". Also send Whop's test webhook (Developer → Webhooks → Send test) and check the server
   log says `whop_webhook` (not `whop_webhook_bad_signature`). This confirms what Whop's docs leave open: how the
   `ws_…` secret becomes the HMAC key (`whopHmacKey` in `server/payments/whopWebhook.mjs`, the only place to change),
   the API version date, the refund and dispute payload shapes, and whether an account key may manage webhooks. No
   build step calls production Whop.

The owner needs no Whop account or Secret of their own: each customer brings their own key.

### What a customer does (Settings → Payments)

1. In Whop's dashboard (Developer → API keys), make an account API key with these permissions:
   `access_pass:basic:read`, `plan:basic:read`, `checkout_configuration:create`,
   `checkout_configuration:basic:read`, `payment:basic:read`, `member:email:read` (without it sales arrive without
   the buyer's email), `webhook_receive:payments`, and optionally `developer:manage_webhook` (then the app makes the
   webhook itself).
2. Copy the account id (`biz_…`).
3. Paste both in Live or Test mode. The app checks the key with reads first and names any missing permission.

Without `developer:manage_webhook` the app shows the webhook URL and the events (`payment.succeeded`,
`payment.failed`, `payment.pending`, `refund.created`, `refund.updated`, `dispute.created`, `dispute.updated`):
make it in Whop's dashboard and paste its signing secret (`ws_…`). If Whop turns the webhook off (72 hours of
failed deliveries), the daily check shows it and the customer turns it back on with one click; Whop doesn't resend
what it missed, so the daily reconcile reads the last 72 hours of payments and records any it finds.

### Money rules (what the code guarantees)

- A buyer's click never calls Whop: `/b/<id>` redirects to the checkout link stored when the plan was attached,
  re-checked on every click (https, exactly `whop.com` or `sandbox.whop.com` for the offer's environment, no user
  name or port, the stored `ch_` id). Anything else is a "not available right now" page, never a redirect. The
  query string is ignored.
- Each Whop write is tried once with an `Idempotency-Key` and never sent again by itself. A timeout or 5xx is
  "Whop didn't confirm the link yet": "Check again" sends the **same** request with the **same** key (Whop answers
  the first result) within 24 hours; after that, make a new link.
- A sale is recorded only from the signed webhook (raw body, 5-minute timestamp window, constant-time compare,
  deduped on `webhook-id` in `webhook_deliveries`) and only when its metadata names one of that customer's Whop
  offers on that account and checkout. The seller's other Whop sales are acknowledged and dropped. A sale never
  moves backwards (`record_sale`), so repeated and out-of-order deliveries change nothing.
- Refunds and disputes stay in Whop: the app shows their status and does nothing that moves money. Only a refund
  that went through (`succeeded`) changes a sale; a pending one may still fail. Without the payment's own refunded
  total, each refund is kept once by its id (`sale_refunds`) and the distinct ones are added up (two $10 refunds are
  $20), never more than was paid. A refund whose payment comes without our metadata changes the sale already
  recorded for that payment id.
- An outside checkout link is https only. A Whop offer whose checkout link was made can't be deleted (its checkout
  stays open at Whop): it's archived, and a sale through it is still recorded. A paused Whop offer sells again only
  while its connection is connected (a reconnect is a new connection: attach another plan).
- Whop's own error text is never shown or logged; keys, webhook secrets and buyers' emails never appear in a log.
  The email is shown to the customer in their own sales list only.
- Deleting an account stops its buy links on that server at once and makes one attempt at removing each webhook
  the app made; the rows go with the account.

### Cron jobs

`offers-webhooks` (daily 04:17 UTC): reads each active connection's webhook (or key) not checked for 20 hours;
`disabled` or `key_rejected` shows a banner in the app, nothing turns itself back on. `offers-reconcile` (daily
04:47 UTC): reads the last 72 hours of payments per connection (5 pages at most) and records the ones for the
customer's offers; 50 connections a run, never-reconciled ones first, then the least recently reconciled
(`reconciled_at`), so every connection gets its turn. Both only read Whop.

### Offline QA

`node server/test/mock-whop.mjs 0 sandbox` prints a stand-in Whop API (keys, products and plans, checkout links with
idempotency, webhooks, payments, and hooks to pay, refund, dispute and redeliver). Tests point the server at it with
`whopBases`; no environment variable can point production traffic elsewhere.

## 13. Morning action (P4)

Each business gets one **action for today** on its Dashboard by about 5:00 AM in its own time zone: the one most
useful thing to do today, why, and a Do it button that opens the right screen (or the assistant with a message in its
box). Nothing is ever posted, sent, bought or launched: it's advice plus a link inside the app.

### Owner steps

1. Run `supabase/migrations/20261116000000_morning_action.sql` in Supabase → SQL Editor (after
   `20261110000000_billing.sql`; safe to run again).
2. In Settings › AI keys, leave **Morning action** ticked only on a **low-cost** key (a fast, cheap model is enough:
   one short request a day per business; the app caps the effort at low and asks for a short answer). A key saved
   before this function existed has it ticked on every writing key: untick it on the expensive ones. Without a key
   for it, actions come from the built-in rules (the startup notes say so).
3. Optional: `MORNING_PER_TICK`, `MORNING_CONCURRENCY` (§1). Nothing new is secret.

### Who is due, and when

A business is due when it is set up (onboarded), its Dashboard was opened in the last 14 days, its slot isn't locked,
and it is on a plan (every business while plans aren't enforced). Its action day starts at 05:00 local (daylight
saving, :30 and :45 zones and the date line come from the server's tz data). The tick runs at minute 7 UTC, so the
first chance is **05:07** local in whole-hour zones, **05:37** in :30 zones (India, Adelaide) and **05:52** in :45
zones (Nepal, Chatham). Between 02:00 and 05:00 local nothing new is made for the day that's ending. The first
Dashboard visit after 05:00 makes the action when the tick hasn't (about 3–20 s); two tabs or a tick at the same
moment still make one.

### Capacity and the backlog alert

`morning-actions` runs first in each tick, so slower jobs can't push it out of its hour, and it keeps the last 8 s of
the 40 s tick for the other jobs. It starts a batch of `MORNING_CONCURRENCY` (6) only while more than 22 s (the AI's
20 s limit plus 2 s) are left of its 32 s, so with the defaults it makes **6 per tick**, or **12** when the first batch
answers in under about 10 s: roughly **145–290 a day**. Mornings cluster (US time zones), so a backlog drains over the
next hours, and anyone the tick hasn't reached gets theirs on their first visit. When businesses wait more than 3
hours, Customer usage shows "Morning actions are falling behind": raise `MORNING_CONCURRENCY` (up to 10 per batch,
so 10–20 per tick) and, if the platform allows a longer request, `CRON_BUDGET_MS` (each extra 20 s fits one more
batch). `MORNING_PER_TICK` only caps the total.

### AI, credits and fallbacks

The AI request goes through the same gate as every AI request: own keys first, then the plan, the daily limit and
the monthly credits; the owner is never metered (while plans aren't enforced the owner is metered like everyone,
which only touches their own counters). A key that may have billed is never followed by a second key. Built-in rules
pick instead when: no key powers Morning action, the customer's credits or daily limit are used up (no provider is
called), the answer fails the schema check (the call was paid and is still metered), the provider refused, timed out
or failed, or the business is brand new. Customers only ever read our words: "Your own AI key didn't answer…", "This
month's AI credits are used up…" or "Today's AI limit is reached…". Problems with your keys (refused, out of credits,
rate limited, model not found) raise an owner alert instead (Customer usage, and the `morning_owner_alert` log line,
kinds only).

### Failures: "Get today's action"

A generation fails only when the business's data couldn't be read or the server stopped mid-way (swept after 10
minutes as interrupted). A billing read that fails during the tick skips nothing: the business stays due and the next
tick tries again, before any AI call. It is **never re-run by itself**: the card shows "Today's action didn't come through" and a
**Get today's action** button, which tries again up to 3 times a day, each try metered like any AI request.

### What customers see

The card on the Dashboard: the action ("AI pick" or "From your plan"), Do it, Done (with Undo) and Not useful (with an
optional reason; the next idea shows, and later days avoid it for 30 days). Before 5 am: "Your next action comes at
5:00 AM". A paused plan: "Your morning action is part of every plan" with the trial or card button. In the claude.ai
build, without accounts or as a guest: a built-in version made in the browser ("Built in"), with no server calls.

### Customer usage (owner)

The **Morning action** section: the last run's counts, whether a key powers it, the per-tick settings, and one
warning per alert of the last week.

### Turning it off

`MORNING_ACTIONS=off` and republish: the card disappears and the jobs stop. Dropping the two tables loses only the
actions.

### How to test

- **Offline:** `node server/test/mock-supabase.mjs 54321` and `node server/test/mock-providers.mjs 9911`, then the app
  against them: sign up, make a business with a Strategy plan, set its time zone (Settings › Brand › Business
  details) to one just past 5 am, open the Dashboard: the card appears. Type `qa-morning-invalid` in Strategy → Your
  details → Anything else to see the rule fallback.
- **Published app:** `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://yourlocalbusiness.replit.app/api/cron/tick`
  and look for `morning-actions` in the summary.
- **SQL checks:** `select local_date, state, engine, count(*) from public.daily_actions group by 1, 2, 3 order by 1 desc limit 20;`
  and `select public.ylb_morning_backlog(10800);`.
- **On a Supabase branch, with the owner's OK:** a signed-in user selects only their own rows (and never
  `daily_actions.cost_usd`, `provider` or `model`: those columns aren't granted) and can't insert, update or delete; two SQL sessions calling `ylb_morning_claim` at once get disjoint rows.
