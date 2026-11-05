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

Nango holds each customer's own logins; the app keeps, per customer, which connection is which network and
which Page, channel, ad account or site they chose. Connection ids and account ids never reach the browser.
Until `NANGO_SECRET_KEY` is set, every network shows "Not connected" and customers post themselves.

1. **Account and plan.** Create a Nango account. The Free plan (10 connections, 200 API requests a minute,
   hard caps) is for testing only. For real customers use Pay-as-you-go ($50 a month including $50 of credits,
   $0.29 per connected account per month, $0.50 per GB through the proxy) and set `NANGO_RPM=900`. The app
   writes these costs as **estimated** rows on each customer's usage once a month; estimated rows never count
   toward a cap.
2. **Environment API key** (Environment Settings → API Keys) with only these scopes, then paste it into the
   Replit Secret `NANGO_SECRET_KEY`:
   - `environment:connect_sessions:write`
   - `environment:connections:read`
   - `environment:connections:delete`
   - `environment:proxy`
   - `environment:connections:read_credentials` only if you turn on Microsoft Ads or TikTok Ads later.
   - **Not** `connections:list`: without it, a leaked key can't list your customers' connections.
3. **Webhook** (Environment Settings → Webhooks): URL `https://yourlocalbusiness.replit.app/api/webhooks/nango`,
   with **on auth creation** and **on auth refresh error** turned on. Copy the signing key into the Replit Secret
   `NANGO_WEBHOOK_SIGNING_KEY` (it is not the API key). When you rotate it, put the old one in
   `NANGO_WEBHOOK_SIGNING_KEY_PREVIOUS` and remove that within an hour.
4. **Callback URL** to register in each network's developer app: `https://api.nango.dev/oauth/callback`.
5. **Integrations** (Integrations → Add), each with your own OAuth app's client id and secret entered **in the
   Nango dashboard** (never in this app). Use these ids, or map yours with `NANGO_INTEGRATIONS`
   (JSON, e.g. `{"facebook":"my-facebook"}`):

   | Network | Nango provider | Integration id |
   |---|---|---|
   | Facebook Pages and Instagram (Facebook Login) | `facebook` | `ylb-facebook` |
   | LinkedIn | `linkedin` | `ylb-linkedin` |
   | TikTok | `tiktok-personal` | `ylb-tiktok` |
   | X | `twitter-v2` | `ylb-x` |
   | YouTube | `youtube` | `ylb-youtube` |
   | Google Ads | `google-ads` | `ylb-google-ads` |
   | Meta Ads | `meta-marketing-api` | `ylb-meta-ads` |
   | Search Console | `google-search-console` | `ylb-gsc` |
   | Coming later: Pinterest, Microsoft Ads, TikTok Ads | `pinterest`, `microsoft-ads`, `tiktok-ads` | `ylb-pinterest`, `ylb-microsoft-ads`, `ylb-tiktok-ads` |

   The app asks each network for these permissions when a customer connects (set the same in your apps):
   - Facebook: `pages_show_list, pages_manage_posts, pages_read_engagement, pages_manage_engagement,
     read_insights, instagram_basic, instagram_content_publish, instagram_manage_insights,
     instagram_manage_comments, business_management`. With Facebook Login for Business, put its configuration
     id in `META_LOGIN_CONFIG_ID` and the permissions in that configuration instead.
   - LinkedIn: `openid, profile, w_member_social`. Only after LinkedIn approves the products: set
     `LINKEDIN_ORG_APPROVED=1` (adds company pages) and `LINKEDIN_MEMBER_ANALYTICS_APPROVED=1` (adds member post
     stats). Asking for a permission LinkedIn hasn't granted breaks every LinkedIn connect.
   - TikTok: `user.info.basic, user.info.stats, video.list, video.publish`.
   - X: `tweet.read, tweet.write, users.read, media.write, offline.access`.
   - YouTube: `youtube.upload, youtube.readonly, yt-analytics.readonly`.
   - Google Ads: `adwords`. Don't set a developer token (Google retired them in September 2026).
   - Meta Ads: `ads_read, business_management` (read only; the app never changes ads).
   - Search Console: `webmasters, siteverification`.

**What customers see.** Settings → Connected accounts: Connect opens the network's sign-in in a new tab; the
row shows "Waiting for …" for up to 30 minutes, then Connected (or "That didn't finish. Try again."). If a
network gives more than one Page or account they choose one; a single one is chosen for them. Rows say
plainly when something is limited: a permission wasn't allowed, they can't post on that Page, or the network
hasn't approved the app yet. Disconnect removes the connection at Nango; it doesn't remove the app's access
inside the network itself (that is done in the network's own settings).

**If something goes wrong**
- "Not set up" for the owner: the hint names the missing Secret (names only, never values), or the integration
  id Nango doesn't know.
- Nango's Free-plan cap reached: customers read "isn't available right now" and nothing is retried.
- A connection whose login expired shows **Reconnect needed**; Facebook logins last about 60 days, so after 50
  days the row says **Expires soon**.
- Deleting a customer's account deletes each of their connections at Nango once. A failure is logged as
  `nango_forget_delete_failed` with the customer tag: delete that connection by hand in the Nango dashboard.

**Testing without Nango.** `node server/test/mock-nango.mjs 9921` runs a stand-in (set
`NANGO_BASE_URL=http://127.0.0.1:9921`, `NANGO_SECRET_KEY=test-nango-key`,
`NANGO_WEBHOOK_SIGNING_KEY=test-nango-signing-key`); its connect page has a **Complete** button that sends the
signed webhook. Nothing in the tests calls Nango or a network.

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

## 8. What works on day one (no Nango, no approvals)

- Manual posting: **Post it yourself**, then **Mark as posted**.
- Facebook groups through Manus.
- Social analytics from public data (treg) for every handle in Settings.
- Competitor ads, Google rank and Maps position (treg).
- Search Console for pages on the app's own address (after §6).
- Email analytics (Omnisend, once the reporting scope is confirmed).
- Per-customer usage, caps and the CSV.
