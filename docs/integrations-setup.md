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

Start these early: nothing posts publicly until each network has approved your app. Create the apps and start
Business Verification any time; register the OAuth redirect URI `https://api.nango.dev/oauth/callback` at each
network only when you set up Nango (§3). Client ids and secrets go **in the Nango dashboard**, never in the app.
The waits below are typical estimates, not promises.

| Network | What to create | Approval and typical wait | Before approval |
|---|---|---|---|
| Meta (Facebook Pages, Instagram, Meta Ads) | A Business-type Meta app, a Facebook Login for Business configuration (its id goes in `META_LOGIN_CONFIG_ID`), products Pages, Instagram and Marketing API | App Review for Advanced Access (pages_manage_posts, pages_manage_engagement, instagram_content_publish, instagram_manage_comments, read_insights, ads_read) and Business Verification: often 1–4 weeks | Only the app's admins and testers can connect |
| LinkedIn | A developer app with "Share on LinkedIn" (self-serve); the Community Management API on a fresh app with no other products | Community Management: Development tier, then Standard tier (screencast): weeks | Members can post as themselves; company pages wait. Set `LINKEDIN_ORG_APPROVED=1` only once it's granted |
| TikTok | A developer app with Content Posting API and Login Kit | The Direct Post audit: weeks | Posts are private (only the poster sees them) and at most 5 people a day can post |
| X | A developer account with pay-per-use credits | None; prepaid credits (about $0.015 a post, $0.20 with a link) | Works as soon as there are credits |
| Google (YouTube, Ads, Search Console) | One Cloud project and OAuth client; turn on YouTube Data, YouTube Analytics, Google Ads, Search Console and Site Verification APIs | OAuth verification for sensitive scopes: weeks. YouTube allows 100 uploads a day per project | Testing mode: up to 100 test users, sign-ins last 7 days |

**How posting works once an account is connected**
- The customer presses **Post on Facebook** (or another network) and confirms. The app sends the post **once**.
  If it can't tell whether the post went out (a timeout or a network error), the post shows **We couldn't confirm
  the post went out** with **Check again** (a read, at most every 30 seconds) and **Post it yourself**. It never
  sends the post again by itself, and there's no "Try again" for that case.
- The post that goes out is the one saved in the customer's account. If the screen shows something older, the app
  asks them to save first.
- Facebook posts use the Page's own access, fetched for that one post and never stored. Photos and videos for
  Instagram, Facebook and TikTok are shared through a private link that lasts 30 minutes (2 hours for a video):
  `https://yourlocalbusiness.replit.app/api/media/public/…`. LinkedIn, X and YouTube get the file uploaded by the
  server.
- Daily caps per customer: 20 posts on X (X bills each post), 50 on each other network. Change them in the
  `billing_caps` table (`x_posts_per_day`, `posts_per_day`; the `*` row is the default).
- Formats: Instagram takes JPEG photos and MP4 Reels; Facebook and LinkedIn take photos (video is coming); TikTok
  needs a video or a photo; X takes up to one photo or video here; YouTube needs a video.

**Settings for posting** (plain settings, not secret)

| Name | Default | Meaning |
|---|---|---|
| `TIKTOK_UPLOAD_MODE` | `FILE_UPLOAD` | `FILE_UPLOAD` sends TikTok videos from the server. Set `PULL_FROM_URL` only after TikTok has verified the URL prefix `https://yourlocalbusiness.replit.app/api/media/public/` in its developer portal; TikTok photo posts need that too. |
| `LINKEDIN_UPLOAD_BEARER` | unset | Set to `1` only if LinkedIn's upload links turn out to need the member's sign-in (the upload then goes through Nango). |
| `MEDIA_PUBLIC_BASE_URL` | `ALLOWED_ORIGIN`, else `https://yourlocalbusiness.replit.app` | The address networks fetch shared photos and videos from. |

`MEDIA_URL_SECRET` (§1) signs those links: without it, photo and video posts to Instagram, Facebook and TikTok
say "isn't set up yet" and nothing is sent.

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
