# Connected accounts, posting, analytics and per-customer usage: owner setup

What this covers: each customer connects their own Facebook Page, Instagram, LinkedIn, TikTok, X and YouTube
accounts and their ad accounts (Meta, Google, LinkedIn, TikTok, Pinterest, X, Reddit, Microsoft) through
**Zernio**, which runs on its own approved platform apps and holds their logins; the app posts for them once they
confirm; the Social, Ads, SEO page and Email Analytics tabs; the Marketing hub's **Update** button; "Submit to
Google" for the SEO page; and each customer's usage, caps and a CSV to bill from (through **treg**).

Who does what:

| Service | Used for |
|---|---|
| **Zernio** (formerly Late) | Customers' social accounts and ad accounts, posting, their own social stats, their ad results (read only), connected-account counts per customer |
| **treg** | Public social data, competitor ads, Google rank and Maps position, Search Console (on your own team connection), per-customer usage, caps and billing |
| **Omnisend** | Email stats |
| **Manus** | Only "Post to Facebook groups" |
| **Nango** | Kept for future booking tools and CRMs only. Off until you set it up; never used for social or ads |

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
| `CUSTOMER_TAG_SECRET` | Each customer's id (`cust_…`) for usage, and their Zernio profile's `externalId` | 32+ random bytes. **Never change it**: each customer's history and Zernio profile would split in two. |
| `ZERNIO_API_KEY` | **Turns connected social and ad accounts on** | Your Zernio API key (`sk_…`), from the Zernio dashboard → API keys. |
| `ZERNIO_WEBHOOK_SECRET` | Checks that account and post news really comes from Zernio | A random string you choose (32+ characters); you give the same value to Zernio in §3. |
| `ZERNIO_WEBHOOK_SECRET_PREVIOUS` | Only while rotating the webhook secret | Remove it once Zernio uses the new one. |
| `MEDIA_URL_SECRET` | Short-lived links to a post's photo or video | 32+ random bytes. |
| `TREG_TOKEN` | Analytics data, competitor ads, Google rank, Search Console | A **member-role agent token** (`treg org agent-new ylb-app`). Not your own dashboard key. |
| `TREG_ADMIN_TOKEN` | Customer caps and the usage check against treg (billing only) | Admin-role agent token; only a team owner can make one. |
| `NANGO_SECRET_KEY` | Optional, later: other integrations (booking tools, CRMs) | Leave unset until you add one (§3b). |
| `NANGO_WEBHOOK_SIGNING_KEY` | Optional, with Nango only | |

Plain settings (not secret; Replit Secrets or env):

| Name | Default | Meaning |
|---|---|---|
| `TREG_ORG_ID` | — | Your treg team id (`treg org ls`). |
| `CONNECTIONS_PROVIDER` | unset | `off` keeps connected accounts off even with `ZERNIO_API_KEY` set. |
| `ZERNIO_RPM` | `60` | The app's own limit on Zernio calls per minute. Zernio allows 60 with up to 2 connected accounts and 600 from 3; raise this to `600` then. |
| `ZERNIO_BRAND_NAME` | `Yourlocalbusiness` | The name on Zernio's connect screen ("Yourlocalbusiness wants to connect to your Instagram"). |
| `ZERNIO_BRAND_LOGO_URL` | — | An https link to a square logo for that screen. |
| `ZERNIO_BRAND_COLOR` | — | Its button colour, `#RRGGBB`. |
| `NANGO_INTEGRATIONS` | — | Only with Nango (§3b): JSON of the integrations customers may connect. |
| `GSC_APP_PROPERTY` | — | `https://yourlocalbusiness.replit.app/` once that Search Console property is verified. |
| `GSC_APP_VERIFICATION_FILE` | — | Google's HTML verification file name, e.g. `google1a2b3c4d5e6f7a8b.html`. |

The Supabase and Omnisend Secrets you already have are unchanged.

## 2. Database

Run these once in Supabase → SQL Editor (each is safe to run again):
1. `supabase/migrations/20261105000000_integrations.sql`: server-only tables (no browser can read them):
   customers and caps, the usage ledger, analytics settings, snapshots, runs and history, publish jobs, Search
   Console steps and webhook deliveries.
2. `supabase/migrations/20261106000000_zernio.sql`: lets the usage ledger record Zernio rows.

Deleting an account deletes its rows, except usage ledger rows, which keep only the opaque customer tag for
invoices. Each customer's connected accounts are disconnected at Zernio first.

## 3. Connected accounts (Zernio)

Zernio holds each customer's logins on its own approved apps for every network, so **no Meta, LinkedIn, TikTok,
X or Google app review is needed** to start. Each customer gets one Zernio **profile**, made the first time they
press Connect, with `externalId` = their customer id (`cust_…`, never an email). The app keeps, per customer,
which accounts are theirs and which account each of their businesses uses; Zernio account ids never reach the
browser.

**Set it up once**
1. Create a Zernio account at zernio.com. The first 2 connected accounts are free; after that Zernio bills per
   connected account per month (about $6 each for the first 10, less after that). Analytics, comments, ads and
   unlimited posts come with every connected account.
2. Dashboard → **API keys** → create a key. Paste it **only** into Replit Secrets as `ZERNIO_API_KEY`.
3. Pick a webhook secret (32+ random characters) and paste it into Replit Secrets as `ZERNIO_WEBHOOK_SECRET`.
4. Dashboard → **Webhooks** → add an endpoint:
   - URL: `https://yourlocalbusiness.replit.app/api/webhooks/zernio`
   - Secret: the same value as `ZERNIO_WEBHOOK_SECRET`
   - Events: `account.connected`, `account.disconnected`, `post.published`, `post.partial`, `post.failed`,
     `post.platform.published`, `post.platform.failed`.
   Press **Send test**: the app answers 200. Zernio signs each delivery (`X-Zernio-Signature`, HMAC-SHA256 of the
   body); the app ignores anything unsigned or for a profile that isn't one of your customers, and applies each
   event once.
5. **White-label the connect screen** (optional, recommended): either set `ZERNIO_BRAND_NAME`,
   `ZERNIO_BRAND_LOGO_URL` and `ZERNIO_BRAND_COLOR` (sent on every connect link), or save your brand once in the
   Zernio dashboard's welcome-screen settings. Customers then see "Yourlocalbusiness wants to connect to your
   Instagram" before the network's own sign-in. The network's own consent screen still names Zernio's app.
6. Turn on the **ads add-on** in Zernio if customers will connect ad accounts.
7. Run the migration in §2, redeploy, and check the startup notes say "Connected accounts (social and ads): on
   (Zernio)".

**Later (optional): your own platform apps.** Zernio can connect through your own Meta, LinkedIn, TikTok, X or
Google apps instead of its own (Zernio dashboard → OAuth apps), so the consent screens show your app's name and
the network's limits are yours. That needs each network's app review (often weeks). The app needs no change for
it beyond Zernio's settings.

**What the app does with Zernio**
- **Connect**: Settings → Connected accounts → Connect opens Zernio's branded screen in a new tab, then the
  network's sign-in. Ad accounts use Zernio's ads connect (Meta, Google, LinkedIn, TikTok, Pinterest, X, Reddit,
  Microsoft; X Ads needs the X account first). A customer with several Pages or accounts on one network picks
  which one each business uses. Pinterest posting is "Coming soon" (posts in the app have no Pinterest format).
- **Post**: one `POST /v1/posts` per post with `publishNow`, an `Idempotency-Key` (the job id) and our job id in
  the post's metadata. Photos and videos are uploaded to Zernio's storage first. A timeout or a Zernio 5xx is
  "We couldn't confirm the post went out": **Check again** reads the post's status at Zernio (by its id, or by
  the job id in its metadata) and never sends it again. A `post.*` webhook finishes such a job too.
- **Stats**: the Update button reads each connected account's daily metrics, follower counts and top posts, and
  each ad account's daily spend and campaigns (read only: the app makes no ad changes).
- **Usage**: every Zernio call is a row in the customer's usage ledger (vendor `zernio`, no cost), and once a
  month each customer gets an estimated "connected accounts" row (count × Zernio's list price). The owner's
  Customer usage page shows each customer's connected-account count.
- Rate limits: the app stays under `ZERNIO_RPM`; a read that gets a 429 waits once (10 s at most); writes are
  never repeated.

## 3b. Other integrations (Nango, for later)

Nango stays in the app for **future** integrations that aren't social or ads, such as booking tools and CRMs.
It is off until `NANGO_SECRET_KEY` is set, and nothing shows in the app until you also list an integration:

1. Create the integration in the Nango dashboard (for example `ylb-calendly`).
2. Set `NANGO_SECRET_KEY` and `NANGO_WEBHOOK_SIGNING_KEY` in Replit Secrets.
3. Set `NANGO_INTEGRATIONS`, for example
   `{"calendly": {"id": "ylb-calendly", "label": "Calendly", "category": "booking"}}`.
4. In Nango, point the webhook at `https://yourlocalbusiness.replit.app/api/webhooks/nango`.

Customers then see **Settings → Connected accounts → Other integrations** with Connect and Disconnect. A key or
integration id that names a social network, an ad platform or Search Console is refused (those go through Zernio
and treg).

## 4. Platform approvals

None are needed to start: Zernio's own apps are already approved on every network. Networks still apply their
own rules to each account (for example, Instagram needs a professional account, Facebook posts go to a Page the
customer manages, Meta Ads needs a Facebook Page, TikTok videos are public only on TikTok Business connections).

**How posting works once an account is connected**
- The customer presses **Post on Facebook** (or another network) and confirms. The app sends the post **once**.
  If it can't tell whether the post went out, the post shows **We couldn't confirm the post went out** with
  **Check again** (a read, at most every 30 seconds) and **Post it yourself**. It never sends the post again by
  itself, and there's no "Try again" for that case.
- The post that goes out is the one saved in the customer's account. If the screen shows something older, the app
  asks them to save first.
- Daily caps per customer: 20 posts on X, 50 on each other network. Change them in the `billing_caps` table
  (`x_posts_per_day`, `posts_per_day`; the `*` row is the default). Zernio adds its own limits (25 posts an hour
  per account, and daily caps per network).
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
business: Social (public stats through treg for each handle in Settings; a connected account's own stats from
Zernio instead), Ads (every connected ad account's results from Zernio, read only, plus up to 3 competitors'
active ads through treg), SEO page
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
Nothing to set up for this beyond Zernio (§3).

### Analytics, Settings and Customer usage (WP5)

- **Marketing → Overview → Update** (top right, the only filled button there) fetches every source for the
  active business, once per 15 minutes. A row under the header shows Social, Ads, SEO and Email as they finish;
  after 5 minutes the button comes back and the row says "Still updating in the background". Nothing is retried
  by the app: a refusal (today's limit, nothing to update yet, too soon) shows as a Callout or a toast.
- **Analytics tabs** on Social, Ads (Campaigns | Analytics), SEO page (Page | Analytics) and Email show the last
  fetched numbers with their "as of" time and a 7/30-day range (remembered in the browser under
  `ylb-analytics-range`). Competitors (up to 3) and keywords (up to 10) are edited in a drawer on the Ads and SEO
  tabs. **Submit to Google** on the SEO tab is one confirmed press; Google decides when to index.
- **Settings → Connected accounts** lists Social and Ads with each account's state (connected through Zernio).
  Until `ZERNIO_API_KEY` is set it says "Connecting accounts is coming soon" and shows no Connect buttons; the
  owner also sees which Replit Secret is missing (the name only). **Other integrations** appears only once Nango
  is set up and lists at least one integration (§3b).
- **Settings → AI keys → Analytics data costs**: each signed-in person's own usage against their caps, estimated
  costs labelled. The owner also sees **Billing (owner)**, which opens **Customer usage**: per-customer totals,
  caps (edit, block, reset), "Check against treg", and the monthly CSV. It tracks usage only; it charges nothing.
- The artifact build shows "Connected accounts and live analytics need the full app" instead of any of this.

## 8. What works on day one (no Zernio key yet, no approvals)

- Manual posting: **Post it yourself**, then **Mark as posted**.
- Facebook groups through Manus.
- Social analytics from public data (treg) for every handle in Settings.
- Competitor ads, Google rank and Maps position (treg).
- Search Console for pages on the app's own address (after §6), and on customers' own domains once you verify
  each one (§6).
- Email analytics (Omnisend, once the reporting scope is confirmed).
- Per-customer usage, caps and the CSV.

**As soon as `ZERNIO_API_KEY` and `ZERNIO_WEBHOOK_SECRET` are set** (and the §2 migrations run): customers connect
their social and ad accounts, post from the app after a confirm, and see their own stats and ad results. No
network approvals are needed, because Zernio's apps are already approved.
