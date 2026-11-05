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

**Testing without Nango.** `NANGO_WEBHOOK_URL=http://127.0.0.1:<server port>/api/webhooks/nango node
server/test/mock-nango.mjs 9921` runs a stand-in (then set
`NANGO_BASE_URL=http://127.0.0.1:9921`, `NANGO_SECRET_KEY=test-nango-key`,
`NANGO_WEBHOOK_SIGNING_KEY=test-nango-signing-key`); its connect page has a **Complete** button that sends the
signed webhook. Nothing in the tests calls Nango or a network.

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
again. Every 5 minutes the server asks treg what it finally charged and adds a correcting ledger row. The same
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

### Posting buttons (WP6)

Every post shows one posting button, by its state:

- **Post on Facebook** (or the post's network) when that account is connected. It opens a confirm window with the
  account, exactly what goes out, the image or video, where the link goes and the first comment. Nothing is sent
  until the customer confirms, and each confirm is one attempt.
- **Posting…** while the server sends it, then **Posted** with **View post**.
- **Try again** only when the network refused the post (nothing went out). It opens a new confirm.
- **Check again** when the app couldn't confirm the post went out. It is a read-only check, and the post is never
  sent again by itself. The customer can also **Mark as posted** or **Post it yourself**.
- **Post it yourself** when the account isn't connected: copy the text, download the image or video, open the
  network, then **Mark as posted**.

Manus only posts in Facebook groups (**Post to groups** on a Facebook post). Posts sent with Manus by older
versions show **Sent with Manus earlier**, read-only. There is no bulk send: each post is confirmed on its own.
Nothing to set up for this beyond the connected accounts (§3) and the posting backend (§4).

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
