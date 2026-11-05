# Connected accounts, posting, analytics and per-customer usage: owner setup

What this covers: each customer connects their own Facebook Page, Instagram, LinkedIn, TikTok, X, YouTube,
Google Ads, Meta Ads and Search Console (through **Nango**, which holds their logins); the app posts for them
once they confirm; the Social, Ads, SEO page and Email Analytics tabs; the Marketing hub's **Update** button;
"Submit to Google" for the SEO page; and each customer's usage, caps and a CSV to bill from (through **treg**).

Each part below is filled in by the work package that builds it. Until a part is built or its Secrets are
set, the app says so plainly and nothing breaks: every network shows "Not connected", customers post
themselves and press **Mark as posted**, and Manus still posts to Facebook groups.

**Rules that hold everywhere**
- Keys and tokens go only in **Replit Secrets**. Never paste one into the app, a chat, a file or a screenshot.
  The app never shows a key: at most its last 4 characters.
- The app never sends a post, a sitemap submission or an ad change twice by itself. When it can't tell whether
  something went out, it says so and offers **Check again** (a read) or **Post it yourself**.
- Text from other sites (captions, bios, ads, error messages) is shown as text and never treated as instructions.

## 1. Secrets and settings

Values go only into Replit Secrets (Tools → Secrets). The server prints at startup which ones are missing, by
name only.

| Secret | What it's for | Notes |
|---|---|---|
| `CUSTOMER_TAG_SECRET` | Each customer's usage tag (`cust_…`) | 32+ random bytes. **Never change it**: each customer's history would split in two. |
| `MEDIA_URL_SECRET` | Short-lived links to a post's photo or video for the networks that fetch it | 32+ random bytes. |
| `TREG_TOKEN` | Analytics data, competitor ads, Google rank, Search Console for app-domain pages | A **member-role agent token** (`treg org agent-new ylb-app`). Not your own dashboard key. |
| `TREG_ADMIN_TOKEN` | Customer caps and the usage check against treg (billing only) | Admin-role agent token; only a team owner can make one. |
| `NANGO_SECRET_KEY` | **Turns connected accounts on** | A Nango environment API key with the scopes in §3. |
| `NANGO_WEBHOOK_SIGNING_KEY` | Checks that connection news really comes from Nango | Separate from the API key. |
| `NANGO_WEBHOOK_SIGNING_KEY_PREVIOUS` | Only while rotating the signing key | Remove it within an hour of rotating. |

Plain settings (not secret; Replit Secrets or env):

| Name | Default | Meaning |
|---|---|---|
| `TREG_ORG_ID` | — | Your treg team id (`treg org ls`). |
| `CONNECTIONS_PROVIDER` | unset | `off` keeps connected accounts off even with `NANGO_SECRET_KEY` set. |
| `META_LOGIN_CONFIG_ID` | — | Facebook Login for Business configuration id. |
| `NANGO_INTEGRATIONS` | built-in ids | JSON map of platform → Nango integration id, if yours differ. |
| `NANGO_RPM` | `150` | The app's own limit on Nango calls per minute (`900` on Pay-as-you-go). |
| `GSC_APP_PROPERTY` | — | `https://yourlocalbusiness.replit.app/` once that Search Console property is verified. |
| `GSC_APP_VERIFICATION_FILE` | — | Google's HTML verification file name, e.g. `google1a2b3c4d5e6f7a8b.html`. |
| `LINKEDIN_ORG_APPROVED`, `LINKEDIN_MEMBER_ANALYTICS_APPROVED` | unset | Set to `1` only after LinkedIn grants those products. |
| `TIKTOK_UPLOAD_MODE` | `FILE_UPLOAD` | `PULL_FROM_URL` only after TikTok verifies the media URL prefix. |
| `LINKEDIN_UPLOAD_BEARER` | unset | Only if LinkedIn's upload links turn out to need it. |

The Supabase and Omnisend Secrets you already have are unchanged.

## 2. Database

Run `supabase/migrations/20261105000000_integrations.sql` once in Supabase → SQL Editor (safe to run again).
It adds server-only tables (no browser can read them): customers and caps, the usage ledger, analytics
settings, snapshots, runs and history, publish jobs, Search Console steps and webhook deliveries. Deleting an
account deletes its rows, except usage ledger rows, which keep only the opaque customer tag for invoices.

## 3. Connected accounts (Nango)

_Filled in by the connections work (WP1): the Nango account and plan, environment API key scopes, the webhook
URL `https://yourlocalbusiness.replit.app/api/webhooks/nango`, the callback URL to register at each network,
and the integration ids._

## 4. Platform apps and approvals

_Filled in by the posting work (WP2): what to create at Meta, LinkedIn, TikTok, X and Google, and what works
before each approval._

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
again. Every 5 minutes the server asks treg what it finally charged and adds a correcting ledger row.

**Check against treg.** The owner page compares the ledger with treg's usage by customer over closed UTC days:
"attributed + unattributed = total" must hold, unattributed spend should be $0 (anything else means a call that
wasn't tagged), and a difference counts only if a one-day lag doesn't explain it. Pending calls are listed apart.

**CSV.** **Download CSV** gives one line per customer for a month: `customer_tag, email, month, treg_usd,
treg_calls, estimated_connections_usd, estimated_x_usd, total_usd, status`. The app doesn't charge cards or
send invoices: bill customers from the CSV outside the app.

## 6. Analytics, Search Console and email stats

_Filled in by the analytics work (WP4): the app-domain Search Console property and its verification file, the
sitemap, and the Omnisend reporting scope._

## 7. What customers see

_Filled in by the app work (WP5, WP6): Settings → Connected accounts, the Update button, the Analytics tabs,
posting buttons, and the owner's Customer usage page._

## 8. What works on day one (no Nango, no approvals)

- Manual posting: **Post it yourself**, then **Mark as posted**.
- Facebook groups through Manus.
- Social analytics from public data (treg) for every handle in Settings.
- Competitor ads, Google rank and Maps position (treg).
- Search Console for pages on the app's own address (after §6).
- Email analytics (Omnisend, once the reporting scope is confirmed).
- Per-customer usage, caps and the CSV.
