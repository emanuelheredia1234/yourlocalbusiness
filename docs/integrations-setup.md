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

_Filled in by the treg and billing work (WP3): topping up, minting the two tokens, "Set up caps", the default
caps ($0.25 a day, $3.00 a month, 400 calls a day; 50 posts a day, 20 on X), reconcile and the CSV._

## 6. Analytics, Search Console and email stats

_Filled in by the analytics work (WP4): the app-domain Search Console property and its verification file, the
sitemap, and the Omnisend reporting scope._

## 7. What customers see

_Filled in by the app work (WP5, WP6): Settings → Connected accounts, the Update button, the Analytics tabs,
posting buttons, and the owner's Customer usage page._

### Analytics, Settings and Customer usage (WP5)

- **Marketing → Overview → Update** (top right, the only filled button there) fetches every source for the
  active business, once per 15 minutes. A row under the header shows Social, Ads, SEO and Email as they finish;
  after 5 minutes the button comes back and the row says "Still updating in the background". Nothing is retried
  by the app: a refusal (today's limit, nothing to update yet, too soon) shows as a Callout or a toast.
- **Analytics tabs** on Social, Ads (Campaigns | Analytics), SEO page (Page | Analytics) and Email show the last
  fetched numbers with their "as of" time and a 7/30-day range (remembered in the browser under
  `ylb-analytics-range`). Competitors (up to 3) and keywords (up to 10) are edited in a drawer on the Ads and SEO
  tabs. **Submit to Google** on the SEO tab is one confirmed press; Google decides when to index.
- **Settings → Connected accounts** lists Social, Ads and Search Console with each account's state. Until
  `NANGO_SECRET_KEY` is set it says "Connecting accounts is coming soon" and shows no Connect buttons; the owner
  also sees which Replit Secret is missing (the name only).
- **Settings → AI keys → Analytics data costs**: each signed-in person's own usage against their caps, estimated
  costs labelled. The owner also sees **Billing (owner)**, which opens **Customer usage**: per-customer totals,
  caps (edit, block, reset), "Check against treg", and the monthly CSV. It tracks usage only; it charges nothing.
- The artifact build shows "Connected accounts and live analytics need the full app" instead of any of this.

## 8. What works on day one (no Nango, no approvals)

- Manual posting: **Post it yourself**, then **Mark as posted**.
- Facebook groups through Manus.
- Social analytics from public data (treg) for every handle in Settings.
- Competitor ads, Google rank and Maps position (treg).
- Search Console for pages on the app's own address (after §6).
- Email analytics (Omnisend, once the reporting scope is confirmed).
- Per-customer usage, caps and the CSV.
