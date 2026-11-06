# Connected accounts, posting, analytics and per-customer usage: owner setup

What this covers: each customer connects their own Facebook Page, Instagram, LinkedIn, TikTok, X and YouTube
accounts through **Upload-Post** and their ad accounts (Meta, Google, LinkedIn, TikTok, Pinterest, Reddit,
Microsoft) through **Zernio**; both run on their own approved platform apps and hold the logins; the app posts for
them once they confirm; the Social, Ads, SEO page and Email Analytics tabs; the Marketing hub's **Update** button; "Submit to
Google" for the SEO page; and each customer's usage, caps and a CSV to bill from (through **treg**).

Who does what:

| Service | Used for |
|---|---|
| **Upload-Post** (Advanced, white-label) | Customers' social accounts (one profile each, of 75), posting, post status, their own social stats |
| **Zernio** (formerly Late) | Ads only: customers' ad accounts and their ad results (read only; campaign changes later) |
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
| `CUSTOMER_TAG_SECRET` | Each customer's id (`cust_…`) for usage, their Upload-Post profile name (`ylb_…`) and their Zernio profile's `externalId` | 32+ random bytes. **Never change it**: each customer's history and vendor profiles would split in two. |
| `UPLOAD_POST_API_KEY` | **Turns social accounts, posting and social stats on** (Upload-Post) | Your Upload-Post API key, from app.upload-post.com → API keys. Shown masked to its last 4 characters. |
| `UPLOAD_POST_WEBHOOK_SECRET` | Checks that account and post news really comes from Upload-Post | The `whsec_…` secret Upload-Post issues (§3, step 4). |
| `UPLOAD_POST_WEBHOOK_SECRET_PREVIOUS` | Only while rotating that secret | Upload-Post's rotation is immediate: keep the old one here until deliveries use the new one. |
| `ZERNIO_API_KEY` | **Turns ad accounts on** (Zernio, ads only) | Your Zernio API key (`sk_…`), from the Zernio dashboard → API keys. |
| `ZERNIO_WEBHOOK_SECRET` | Checks that ad-account news really comes from Zernio | A random string you choose (32+ characters); you give the same value to Zernio in §3a. |
| `ZERNIO_WEBHOOK_SECRET_PREVIOUS` | Only while rotating the webhook secret | Remove it once Zernio uses the new one. |
| `MEDIA_URL_SECRET` | Short-lived links to a post's photo or video (Upload-Post fetches them) | 32+ random bytes. **Needed to post photos and videos.** |
| `TREG_TOKEN` | Analytics data, competitor ads, Google rank, Search Console | A **member-role agent token** (`treg org agent-new ylb-app`). Not your own dashboard key. |
| `TREG_ADMIN_TOKEN` | Customer caps and the usage check against treg (billing only) | Admin-role agent token; only a team owner can make one. |
| `NANGO_SECRET_KEY` | Optional, later: other integrations (booking tools, CRMs) | Leave unset until you add one (§3b). |
| `NANGO_WEBHOOK_SIGNING_KEY` | Optional, with Nango only | |

Plain settings (not secret; Replit Secrets or env):

| Name | Default | Meaning |
|---|---|---|
| `TREG_ORG_ID` | — | Your treg team id (`treg org ls`). |
| `CONNECTIONS_PROVIDER` | unset | `off` keeps social and ad accounts off even with their keys set. |
| `UPLOAD_POST_RPM` | `150` | The app's own limit on Upload-Post calls per minute (plus 2 per profile; the Advanced plan allows 200 plus 2 per profile, and 1,000 per 10 minutes plus 10 per profile). |
| `UPLOAD_POST_ALERT_REMAINING` | `5` | How many free profile slots (of the plan's 75) are left when the owner is alerted. |
| `UPLOAD_POST_BRAND_LOGO_URL` | — | An https link to your logo for Upload-Post's hosted connect page. |
| `UPLOAD_POST_CONNECT_TITLE` | `Connect your social accounts` | That page's title. |
| `UPLOAD_POST_CONNECT_DESCRIPTION` | a short default | That page's description. |
| `UPLOAD_POST_BACK_BUTTON_TEXT` | `Back to Yourlocalbusiness` | That page's back button (it returns to Settings → Connected accounts). |
| `UPLOAD_POST_BASE_URL` | — | Tests and the mock only (`node server/test/mock-uploadpost.mjs`). |
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
3. `supabase/migrations/20261107000000_upload_post.sql`: lets the usage ledger record Upload-Post rows
   (vendor `uploadpost`).

Deleting an account deletes its rows, except usage ledger rows, which keep only the opaque customer tag for
invoices. Each customer's Upload-Post profile is deleted (with its social connections) and their ad accounts are
disconnected at Zernio first.

## 3. Social accounts and posting (Upload-Post)

Upload-Post (Advanced plan, white-label, 75 profiles) holds each customer's social logins on its own approved
apps, so **no Meta, LinkedIn, TikTok, X or Google app review is needed**. Each customer gets one Upload-Post
**profile**, made the first time they press Connect, named `ylb_` + the 24 hex characters of their customer id
(never an email or a user id; Upload-Post profile names can't be changed). A profile holds one account per
network, so Instagram, TikTok, X and YouTube are one account per customer, shared by their businesses; for
Facebook and LinkedIn each business picks its Page. Facebook groups stay with Manus.

**Set it up once**
1. Subscribe to Upload-Post's **Advanced** plan, billed **yearly** ($1,411 a year, about $118 a month; $147 month
   to month). It includes 75 profiles, white label and unlimited uploads. More profiles: the +25 ($650 a year or
   $65 a month) or +50 ($1,150 a year or $115 a month) add-on; they don't stack, so past 125 profiles you need a
   bigger plan or a second account. There is **no sandbox**: every test post is real, so make your own test
   profile with test social accounts for the first live check.
2. app.upload-post.com → **API keys** → create a key. Paste it **only** into Replit Secrets as
   `UPLOAD_POST_API_KEY`; the app shows at most its last 4 characters. Upload-Post locks the server's address out
   for 5 minutes after 10 tries with a wrong key, so after one refused key the app stops calling for 60 seconds
   and tells you (Customer usage → "Social posting needs attention").
3. Webhook (Upload-Post dashboard → Notifications → Webhook): register
   `https://yourlocalbusiness.replit.app/api/webhooks/upload-post` and turn on the events `upload_completed`,
   `social_account_connected`, `social_account_disconnected` and `social_account_reauth_required`.
4. Copy the `whsec_…` webhook secret Upload-Post shows into Replit Secrets as `UPLOAD_POST_WEBHOOK_SECRET`. Each
   delivery is signed (`X-Upload-Post-Signature`, HMAC-SHA256 of `<timestamp>.<body>`); the app refuses unsigned
   deliveries and ones more than 5 minutes old, and applies each event once. Upload-Post sends each webhook only
   once and never retries, so the app also reads post status itself and checks every profile once a day.
   Rotating: Upload-Post's new secret works at once, so put the old one in `UPLOAD_POST_WEBHOOK_SECRET_PREVIOUS`
   for the switchover, then remove it.
5. White label. The app sends the whole branding with every connect link (Upload-Post clears any field left
   out): `UPLOAD_POST_BRAND_LOGO_URL` (an https link to your logo), `UPLOAD_POST_CONNECT_TITLE`,
   `UPLOAD_POST_CONNECT_DESCRIPTION`, `UPLOAD_POST_BACK_BUTTON_TEXT`, the one network being connected, a light
   theme and no calendar (the app has its own). Nothing to set in Upload-Post's dashboard for this.
6. Set `MEDIA_URL_SECRET` (32+ random bytes): Upload-Post fetches each photo and video from a short-lived link on
   this app, so no photo or video can be posted without it.
7. X: links in X posts are removed unless you buy Upload-Post's **X Links** add-on ($19 a month or $152 a year,
   50 link posts a month **shared by all customers**). X post stats are a shared daily budget too (5,000 posts a
   day for the whole account).
8. Your privacy notice must name Upload-Post's company, **TONVI TECH SL** (Spain), as a processor.
9. Run the migrations in §2, redeploy, and check the startup notes say "Social accounts and posting: on
   (Upload-Post)". Settings → Connected accounts then shows Connect on every social network.

**What the app does with Upload-Post**
- **Connect**: Settings → Connected accounts → Social accounts → Connect opens Upload-Post's hosted page (always
  on app.upload-post.com; no custom domain) for that one network, with your logo and text. A fresh link is made
  for every press (Upload-Post's links last 48 hours; the app never stores them). Customers come back with its
  back button; the app sees the new account from the webhook and reads the profile again when they return.
  **Reconnect** shows when a network asks the customer to sign in again; **Disconnect** removes that network
  from their profile.
- **Post**: one upload per post, with the job id as `request_id`, `Idempotency-Key` and `external_id`. Photos and
  videos go as the app's short-lived link. The network's own result decides; videos finish in the background and
  the app reads their status by the job id. A timeout or a 5xx reads "It may have been posted - check before
  trying again": **Check again** reads the status by the job id and never sends it again. TikTok's audience setting
  is checked first; a TikTok that lands in the account's drafts reads "Sent to your TikTok drafts".
- **Stats**: each connected account's followers, reach, views, engagement and reach series, and cached top posts
  (at most 80 reads per 5 minutes for the whole app).
- **Usage**: every Upload-Post call is a row in the customer's usage ledger (vendor `uploadpost`, no cost), and
  once a month each customer with a profile gets an estimated row ($147 / 75 ≈ $1.96 a profile-month, prorated).
  The owner's Customer usage page shows social and ad account counts and profiles used out of 75.
- **Team-level problems never reach customers**: our key, the profile cap, a blocked profile, the scheduled-post
  cap and the shared X and analytics budgets show customers a plain "temporarily unavailable, we've been notified"
  and leave an owner alert (`uploadpost:alert`) and hint.

**Limits to know**
- **Profiles**: 75 on Advanced, one per customer who has pressed Connect (customers who never connect a social
  account use none). With 5 or fewer left (`UPLOAD_POST_ALERT_REMAINING`) you get an alert; at 0 new customers
  read "Social connections are temporarily full. We've been notified" until you add profiles. Deleting an account deletes its profile, and a daily check deletes `ylb_` profiles whose customer is gone (at
  most 10 a day; profiles with other names are never touched).
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
accounts and reading ad results (later: launching and changing campaigns). Social accounts and posting are
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
   - Events: `account.connected`, `account.disconnected` (post events aren't needed any more).
   Press **Send test**: the app answers 200. Zernio signs each delivery (`X-Zernio-Signature`, HMAC-SHA256 of the
   body); the app ignores anything unsigned or for a profile that isn't one of your customers, and applies each
   event once.
5. **White-label the connect screen** (optional, recommended): either set `ZERNIO_BRAND_NAME`,
   `ZERNIO_BRAND_LOGO_URL` and `ZERNIO_BRAND_COLOR` (sent on every connect link), or save your brand once in the
   Zernio dashboard's welcome-screen settings. Customers then see "Yourlocalbusiness wants to connect to your
   Instagram" before the network's own sign-in. The network's own consent screen still names Zernio's app.
6. Turn on the **ads add-on** in Zernio if customers will connect ad accounts.
7. Run the migration in §2, redeploy, and check the startup notes say "Ad accounts: on (Zernio)".

**Later (optional): your own platform apps.** Zernio can connect through your own Meta, LinkedIn, TikTok, X or
Google apps instead of its own (Zernio dashboard → OAuth apps), so the consent screens show your app's name and
the network's limits are yours. That needs each network's app review (often weeks). The app needs no change for
it beyond Zernio's settings.

**What the app does with Zernio**
- **Connect**: Settings → Connected accounts → Connect on an ad account opens Zernio's branded ads connect. X Ads
  is "Coming soon": Zernio's X Ads connect needs an X account inside Zernio, and X posting is Upload-Post's.
- **Stats**: each ad account's daily spend and campaigns (read only: the app makes no ad changes yet).
- **Usage**: every Zernio call is a ledger row (vendor `zernio`, no cost), and once a month an estimated "ad
  accounts" row (count × Zernio's list price).
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
integration id that names a social network, an ad platform or Search Console is refused (those go through
Upload-Post, Zernio and treg).

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
Upload-Post instead), Ads (every connected ad account's results from Zernio, read only, plus up to 3 competitors'
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

### Settings → Connected accounts

One screen with two sections:

- **Social accounts** (Upload-Post): Facebook Page, Instagram, LinkedIn, TikTok, X, YouTube, and Pinterest as
  "Coming soon". Each row shows its state and one action: **Connect** (opens the hosted sign-in page in a new
  tab; the row reads "Waiting for Instagram…" with **Check** until the network answers, and "That didn't finish.
  Try again." after 30 minutes), **Reconnect** when the network asks to sign in again, and a ⋯ menu on connected
  rows (choose the Page for this business, check the connection, **Disconnect**). The "How connecting works" tip
  says plainly that the sign-in page is run by Upload-Post, so its name shows there and on the network's
  permission screen; one account per network serves all of a customer's businesses, and for Facebook and
  LinkedIn each business picks its Page. A Page picked on the hosted page applies to every business; changing it
  means reconnecting.
- **Ad accounts** (Zernio): Google Ads, Meta Ads, LinkedIn Ads, TikTok Ads, Pinterest Ads, Reddit Ads, Microsoft
  Ads, and X Ads as "Coming soon". Read only: "The app only reads them and never changes your ads or spends
  money."
- A side whose key isn't set says "Connecting social accounts isn't available yet" (or ad accounts) and shows no
  Connect buttons; with both off, one note: "Connecting accounts is coming soon. You can still post yourself and
  mark posts as posted."
- **The owner** also sees an "Owner setup" box with the missing Secrets (names only), the steps for each side
  that's off and the webhook address to register. Customers never see it.
- Team-level problems (our key, the profile cap, plan limits) show customers only "temporarily unavailable,
  we've been notified"; the owner sees the reason on Customer usage.
- **Other integrations** appears only once Nango is set up and lists at least one integration (§3b).

### Posting buttons and post status

Every post shows one posting button, by its state:

- **Post on Facebook** (or the post's network) when that account is connected. It opens a confirm window with the
  account, exactly what goes out, the image or video, where the link goes and the first comment. Nothing is sent
  until the customer confirms, and each confirm is one attempt.
- **Posting…** while the server sends it (a video can take up to 10 minutes), then **Posted** with **View post**.
- **In TikTok drafts** when TikTok put the post in the account's drafts: "Sent to your TikTok drafts. Open TikTok
  to publish it." It is never sent again.
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

### Customer usage (owner only)

Settings → AI keys → **Billing (owner)** opens **Customer usage**: per customer, analytics cost (treg) today and
over 30 days, analytics calls, **Social (Upload-Post)** (social accounts connected now, Upload-Post calls and the
estimated profile cost) and **Ads (Zernio)** (ad accounts connected now and their estimate), caps (edit, block,
reset) and status. Above the table: **Upload-Post profiles** used of the plan's limit and, when there is one,
Upload-Post's last alert in plain words ("profiles are running low", "the API key was refused", …). Estimates
never count toward a cap. "Check against treg" and the monthly CSV are unchanged. It tracks usage only; it
charges nothing.

The artifact build shows "Connected accounts and live analytics need the full app" instead of any of this.

## 8. What works on day one (no Upload-Post or Zernio key yet, no approvals)

- Manual posting: **Post it yourself**, then **Mark as posted**.
- Facebook groups through Manus.
- Social analytics from public data (treg) for every handle in Settings.
- Competitor ads, Google rank and Maps position (treg).
- Search Console for pages on the app's own address (after §6), and on customers' own domains once you verify
  each one (§6).
- Email analytics (Omnisend, once the reporting scope is confirmed).
- Per-customer usage, caps and the CSV.

**As soon as `UPLOAD_POST_API_KEY`, `UPLOAD_POST_WEBHOOK_SECRET` and `MEDIA_URL_SECRET` are set** (and the §2
migrations run): customers connect their social accounts, post from the app after a confirm, and see their own
stats. **With `ZERNIO_API_KEY` and `ZERNIO_WEBHOOK_SECRET`**: they connect ad accounts and see their ad results.
Each side works without the other. No network approvals are needed: Upload-Post's apps (social) and Zernio's
apps (ads) are already approved.
