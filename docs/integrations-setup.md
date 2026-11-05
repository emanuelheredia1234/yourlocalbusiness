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

**The Update button** (Marketing hub) fetches four sources in the background, at most once every 15 minutes per
business: Social (public stats through treg for each handle in Settings; a connected account's own stats
instead), Ads (connected Google Ads / Meta Ads results, read only, plus up to 3 competitors' active ads), SEO page
(Google rank and Maps position per keyword in the business's city, Search Console numbers for this page) and
Email (Omnisend). A source that fails keeps showing its last good numbers with an "as of" time. Before anything is
spent, an Update is refused when the customer is over their daily or monthly cap (estimated connection and X costs
never count). Until the treg wrapper (section 5) is in the app, these routes answer "not available yet".

**Search Console for pages on the app's own address** (one property for every customer's page):
1. In Google Search Console, add the URL-prefix property `https://yourlocalbusiness.replit.app/`.
2. Choose **HTML file** verification. Put the file name Google gives you (for example
   `google1a2b3c4d5e6f7a8b.html`) in the plain setting `GSC_APP_VERIFICATION_FILE`, redeploy, then press
   **Verify** in Google. The app answers `https://yourlocalbusiness.replit.app/<that file>` itself.
3. Set `GSC_APP_PROPERTY` to `https://yourlocalbusiness.replit.app/`.
4. Connect Search Console to your treg team with the **write** capability (`treg connections connect --provider
   google-search-console`), pick the property, and check that `google-search-console.sites` lists it as
   `siteOwner`.

The app now serves `https://yourlocalbusiness.replit.app/sitemap.xml` (every customer's published sales page on
the app's address; pages on a customer's own domain are in that domain's sitemap instead, rebuilt at most every
10 minutes) and `/robots.txt` (everything allowed except `/api/`, pointing at the sitemap).

**Submit to Google** (SEO page → Analytics): for an app-address page the shared sitemap is submitted at most
once a day across all customers, and the page is inspected (Google allows 2,000 inspections a day for the whole
property: the app stops at 1,500, and at 20 per customer, and inspects a page at most once a week until it is
indexed). For a page on the customer's own domain, the customer connects their own Search Console; the steps are
the DNS TXT record, Verify, adding the site, submitting the domain's sitemap and inspecting the page. Nothing is
sent twice by itself: when Google's answer was lost, the next press first checks, and sends again only after the
customer confirms. Google decides when to index; there is no "request indexing" API.

**Email stats** come from Omnisend's reports, at most one live call per Omnisend account per hour and 40 a day
(Omnisend allows 55). The OAuth scope Omnisend needs for reports isn't confirmed yet: once it is, add it to
`OMNISEND_OPTIONAL_SCOPES` in `server/omnisend.mjs`. New connections then ask for it, existing customers are not
forced to reconnect (drafts keep working), and only the Email Analytics tab asks them to reconnect.

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
