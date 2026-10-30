# Yourlocalbusiness

An AI workspace for researching, building, branding, listing and marketing digital products and local businesses. One shared **Project Context** (brand, offer, niche, assets) feeds every module, and a **Brain** of skills shapes every AI output.

## What's inside

| Area | What you can do |
| --- | --- |
| **Guided onboarding** | Product or business → new or existing → AI winning-product research (9 formats, scored ideas with price and revenue potential) or existing-brand import → AI brand identity (names, logo designer, palette, banner, pitch, URL). |
| **Dashboard** | Quick composer (AI caption + **AI image**, or your own photo/video with an AI caption), project summary, KPI snapshot with sparklines, launch readiness, upcoming posts. |
| **AI images** | Post images (portrait, square, story or landscape) and a marketplace listing set: cover mockup, in-use shot, "What's inside / What you get" checklist graphic and offer card. Choose **Photo** (made by the API key that powers Photos: OpenAI, Google, xAI, Meta, OpenRouter or a Manus task; in claude.ai, Meta Muse through Zapier) or **Illustration** (drawn by the AI as SVG). The app typesets headlines, logos, prices and lists on top, so text is always spelled right; change the headline later and the text is re-set on the same artwork without a new generation. |
| **Product / Business Studio** | Structure builder (course curriculum, guide chapters, spreadsheet tabs… or service packages, operating model and value stack), section drafting, AI code & asset generator (calculators, quizzes, booking widgets, pricing tables, spreadsheets + Apps Script…) with a live CodeMirror editor, split-pane preview, plain-language edits with undo, HTML export, AI listing images with a buyer gallery, and one-click publishing to the Marketplace. |
| **Marketing Hub** | Four channels: **SEO** (metadata, live 0–100 score with checklist, Google and link previews, click-to-edit sales page, section manager, HTML export with JSON-LD), **Email** (lead magnet, opt-in page, 5-email sequence with editable delays, time-compressed subscriber simulation, subscriber list + CSV), **Social** (cadence, watermark, 5 image + 5 video styles, platforms, post-type mix, 30-day plan, 7-day ready-to-publish batch with mockups, bulk scheduling), **Paid ads** (objectives, platforms, budget, targeting, A/B creatives, Google search ads, projections, simulated launch). |
| **Content calendar** | Scheduled (5-week calendar with drag-to-reschedule, or list), Published (live engagement counters), Drafts; full inline editor with platform preview. |
| **Analytics** | Impressions, engagement rate, clicks, opt-ins and sales with period deltas, daily chart (with table view), top post types and visual styles, platform split, funnel, top posts, sales and ad delivery. |
| **Marketplace** | Products and local businesses, search, category pills, location filter + map, listing details with booking or inquiry, cart, checkout, order history with access files. Your published listings appear instantly. |
| **Brain** | Skills (voice, audience, rules, offers, SEO, email…) written in plain language and parsed into rules, a skill library, knowledge documents (facts and key terms are extracted), a with/without playground with highlighted differences, an activity log, and learned preferences from thumbs-down feedback. |
| **Settings** | Brand kit (logo upload or designer, colors, banner, images, socials), **AI** (your API keys: what each one powers, its model and effort, priority, usage, and the Brain switch), connected accounts, projects, backup/restore, sample data, preferences. |

## What is real and what is simulated

Real:
- All generation, editing, exporting (HTML, Markdown, CSV, JSON backups, Apps Script) and local persistence.
- AI: Claude in the claude.ai Artifact; your own API keys in the self-hosted app (see "AI: one AI, powered by your API keys"); otherwise a built-in, niche-aware engine that works offline. Brain skills apply to all of them.
- AI images and videos: real files you can download, schedule with posts and publish on listings. Without a key that makes photos, a built-in brand illustration is used and labelled as such.
- When the app is opened as a shared claude.ai Artifact, published Marketplace listings and purchases sync between everyone who opens it.

Simulated (clearly labelled in the UI):
- Social account connections and publishing: no real logins or posts, except Facebook posts you hand to Manus in the claude.ai app (see "Manus through Zapier"). Engagement numbers are modeled per platform, format, style and post type.
- Checkout: no payment is taken (test card `4242 4242 4242 4242`).
- Email sending: the sequence plays in an in-app inbox; nothing is emailed.
- Ad launches: delivery is modeled from benchmark projections; no ad account is charged.
- Sample data and sample Marketplace listings are labelled "Sample" and can be cleared or hidden.

## AI: one AI, powered by your API keys

`Settings → AI` in the self-hosted app (for example on Replit). There is one AI for the whole app: each API key powers the functions you tick, with the model and effort you choose. In the claude.ai Artifact, Claude does the writing instead and this page says so (keys can't be used there: the page can't reach outside APIs).

**Keys.** There's a card for each provider. Paste a key in the app, or (better on Replit) add it as a Secret under Tools → Secrets. Secrets win over keys typed in the app and survive restarts and publishing. Keys stay on the server (`DATA_DIR/ai-providers.json`, file mode 600, git-ignored), and the page only ever shows their last four characters.

| Provider | Secret name |
| --- | --- |
| OpenRouter | `OPENROUTER_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |
| xAI Grok | `XAI_API_KEY` |
| Anthropic Claude | `ANTHROPIC_API_KEY` |
| Meta Muse | `META_MODEL_API_KEY` |
| Manus | `MANUS_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |

**Powers.** Each card has a dropdown of everything AI does in the app, stacked as checkboxes:
- **Writing & research:** product research, brand kit & voice, outline & chapters, product files, business model, marketplace listing, code & assets, SEO & sales pages, emails & lead magnets, social posts & campaigns, ads and illustrations.
- **Media:** photos and videos.
- **Agents:** Facebook scheduling.

What a provider can't do is greyed out with the reason. A new key powers everything it can until you choose.

**Effort**, per key and per kind of work, is sent in the provider's own setting. The options follow the model you pick (each card also lists every model your key can use):

| Provider | Writing | Photos | Videos | Cost shown |
| --- | --- | --- | --- | --- |
| Anthropic | `output_config.effort`: low … max | – | – | tokens × list price (thinking is billed as output) |
| OpenAI | `reasoning.effort`: the model's subset of none … max | `quality`: low … max (GPT Image 2.5) | – (OpenAI shut down Sora) | tokens × list price |
| Google | `generation_config.thinking_level`: minimal … high | `image_size`: 1K / 2K / 4K | `resolution`: 360p … 4K (Gemini Omni) | tokens × list price |
| xAI | `reasoning_effort`: low … xhigh | `quality`: low / medium | `resolution`: 480p / 720p / 1080p | tokens × list price |
| Meta | `reasoning_effort`: minimal … max | `reasoning_strength`: low / high | – | Meta's reported charge |
| OpenRouter | `reasoning.effort`: none … max | set by the model | `resolution`: 480p / 768p / 2K (HeyGen) | OpenRouter's exact cost |
| Manus | – | `agent_profile` (photos as a task) | – | Manus credits; Facebook scheduling uses `agent_profile` lite … max-ultra |

**Priority.** Keys are tried in the order shown (move them with the arrows). If the first one fails (outage, rate limit, no credit, bad key), the next key that powers the same function answers, and the result says so. A blocked prompt isn't sent elsewhere. Videos and agent tasks move on only when the first provider certainly started nothing, so a paid job is never doubled.

**Proof of effort.**
- Every result names the key, model and effort, and shows the tokens (reasoning included) and cost. Hover for every number.
- **Compare efforts** on a card sends one short prompt at two efforts and shows the time, reasoning tokens and cost side by side. It costs a fraction of a cent on most models.
- **Test key** is a free check.
- **Recent usage** lists each request, with 14-day totals per key.

**Brain.** One switch for every key: writing follows your Brain skills, and photos and videos get the Brain's art direction.

**Admin token.** Keys and settings can only be changed from the machine running the server, or with `ADMIN_TOKEN`. On Replit, add a Secret named `ADMIN_TOKEN` (any long password), restart the app, and enter it on the page. Settings live in `DATA_DIR`. A published Replit app starts from the workspace's files and doesn't keep changes made inside it, so set things up in the workspace (Run), then publish, and keep keys in Secrets.

**More details.**
- A function with no key: the built-in engine writes it, and the result says what to set up. Photos and videos are off.
- Keys from the old "Image generation" page are imported once, powering Photos.
- Generation is rate-limited per client (`RATE_LIMIT_PER_MIN`). Anyone who can open a public deployment can spend your keys, so put it behind your own login if you share the address.
- The AI's replies are always conformed onto the app's data shapes, so a partial or malformed reply can't break a page. If a call fails, the built-in result is used and the UI says why.
- Prompts never ask image or video models for text: headlines, logos, prices and checklists are drawn by the app.

## Product files: designed PDF / ebook and .xlsx workbook

Product Studio → Structure → **Product files** turns your outline into the file you sell. It works everywhere: in claude.ai the AI writing is done by Claude, elsewhere by the key that powers Product files (or the built-in writer). The files are made in the browser.

- **Designed PDF** (guides, ebooks, course workbooks): the AI first writes any chapters that have no draft yet, then the welcome page, how-to-use tips, one workbook page per chapter, next steps and a disclaimer that fits your niche. The layout has a cover (with your listing cover photo if you have one), copyright page, clickable contents and PDF bookmarks, branded chapter openers, chapters typeset from the Markdown drafts (headings, lists, checklists, tip boxes, tables), **fillable** workbook pages (text boxes and checkboxes that work in any PDF reader), next steps and a back cover. Choose **Modern** or **Classic** and **US Letter** or **A4**; "Re-layout only" changes the design without asking the AI again. It uses the standard PDF fonts (Helvetica, Times), so emoji and non-Latin scripts are left out of the file.
- **Excel workbook (.xlsx)**: the AI designs the tabs from your outline: typed columns, dropdowns, example rows, per-row formulas and dashboard metrics. A strict compiler turns its `[Column]` formulas into Excel formulas and leaves out anything it can't verify (the panel lists what was left out), so the file always opens cleanly. Every workbook has a **Start here** tab with links, branded tabs with frozen headers, filters, totals, banding and 200 ready rows, and a **Dashboard** with key numbers and a category breakdown with data bars. It opens in Excel, Google Sheets, Numbers and LibreOffice. Charts aren't included.
- Files are saved in the workspace (the newest six of each kind) with Download and Delete. They're checked with openpyxl and LibreOffice (formulas recalculated) during development.

## Photos with Meta Muse Image (claude.ai Artifact)

In the claude.ai Artifact, **Photo · Muse** makes post and listing photos with **Meta Muse Image** (`meta/muse-image`) through **OpenRouter in your Zapier** connector. A photo takes a few seconds and OpenRouter bills about $0.01 each to the OpenRouter account connected in Zapier (the "API KEY 1" connection is the default).

- Zapier side: three custom actions on the OpenRouter app: `generate_image` (OpenRouter `/api/v1/images`, image returned as base64, 2 MB cap), `list_image_models` and `key_and_credits` (read-only checks).
- If OpenRouter is out of credits, the app says so; add credits at openrouter.ai/settings/credits.
- Manus no longer makes photos here; a Manus photo started before this change can still be picked up. In the self-hosted app, photos come from your keys (above).

### Brain skills in photos and videos

Photos and videos follow your Brain too, whichever key makes them. The app adds a short **Art direction** to the image or video prompt. It takes **Visual style** skills in full, plus only the picture-related sentences of your other skills, such as "always show people of different ages" or "never show alcohol". Anything about words, captions or logos is left out, because those models must draw no text: the app sets the text itself. Photos for posts use your social skills and listing photos and demo videos use your studio skills. The panels show which skills applied ("Brain art direction: …"), and the Brain switch turns this off as well. The library has two starter visual skills: *Authentic, real-life imagery* and *Clean, premium product visuals*. Illustrations already get the full Brain, since the AI draws them from the writing prompt.

## Videos with HeyGen (claude.ai Artifact)

Video posts (Reels, TikTok, Stories) get an **AI video** panel, and Product Studio has a **Product demo video** for listings. Both use **HeyGen Video 1** (`heygen/heygen-video-1`) through **OpenRouter in your Zapier** connector.

- Choose the shape (vertical, square, portrait, wide), the length (5–15 s) and the quality (480p, 768p, 2K). The panel shows OpenRouter's list price before you generate: $0.02, $0.036 or $0.10 per second (the test clip was billed at half that). A listing demo can start from your cover photo.
- A clip takes about a minute. The app checks progress every 15 seconds and brings the MP4 back in pieces of about 1.5 MB. A video uses roughly 4–8 Zapier tasks. If you reload, the panel offers to pick the video up again (OpenRouter keeps it for about a day).
- Zapier side: three custom OpenRouter actions: `start_video`, `video_status` and `video_chunk`. The video's link never leaves Zapier.
- Self-hosted, videos come from the key that powers Videos (OpenRouter HeyGen, Google Gemini Omni or xAI Grok Imagine), at that key's quality; the panel shows which one.

## Manus through Zapier (claude.ai Artifact)

When the app runs as a claude.ai Artifact and you have the **Zapier** connector in claude.ai with **Manus** connected in Zapier:

- **Photos for posts and listings**: each image is one Manus task (usually about 3 minutes and roughly 40 Manus credits in testing). The app polls the task, brings the finished image back, adds your headline, logo and prices, and saves it. Listing sets run their four images in parallel. If you reload mid-way, the app offers to pick the task up again; "Watch it in Manus" links to the task.
- **Image size**: Manus is asked for a JPEG under 1.5 MB at the image's final size, because its image tools otherwise save PNGs of about 5 MB, too big to come back through Zapier (the app accepts up to 2 MB). If the file is still too big, or Manus didn't attach one, the app asks once, in the same task, for a smaller JPEG (Zapier's built-in Manus **Continue Task** action).
- **Facebook scheduling**: on any Facebook image post (composer, post cards, post editor, calendar list) choose **Schedule on Facebook**. After you confirm the Page, time and text, Manus opens Meta Business Suite in its own browser and schedules exactly that post (never "publish now"). The post shows live status: working, **Manus needs you** (for example, sign in to Facebook inside Manus the first time), scheduled, or failed, with a link to the task. The app checks every 45 seconds while it's open, or press **Check now**.
- Setup on the Zapier side (already done for this workspace): Manus enabled on your Zapier MCP plus two custom Manus actions, `create_task_with_image` (Manus API `task.create`, optionally with an image) and `task_output` (`task.detail` + `task.listMessages`, returning images as base64 so the page can show them; the app first lists the files without their bytes, then downloads only the first one that fits).
- Zapier runs custom actions as "write" calls, so claude.ai may ask you to approve them. To stop the prompts during long Manus tasks, set Zapier's **execute write action** tool to **Always allow** in claude.ai connector settings.
- Other platforms keep the in-app (simulated) scheduler.
- Self-hosted, the same Facebook scheduling runs with your Manus API key (tick Facebook scheduling on the Manus card; its agent profile is the key's effort).

## Run it

```bash
npm install
npm run server              # http://localhost:8787: the AI server (add keys in Settings → AI, or as env vars / Secrets)
npm run dev                 # http://localhost:5173: the app; it proxies /api to the server
```

On Replit, **Run** starts both (see `.replit`); add your keys under Tools → Secrets.

Production:

```bash
npm run build               # dist/
npm run server              # serves dist/ and /api on PORT (default 8787)
```

Server environment:
- the key Secrets above
- `PORT` and `HOST`
- `ALLOWED_ORIGIN` (enables CORS for one origin)
- `RATE_LIMIT_PER_MIN` (default 30)
- `DATA_DIR` (default `./.data`)
- `ADMIN_TOKEN`
- `AI_PROVIDER_BASE_URLS`: a JSON map of provider id to base URL, for a proxy or the test mock

`GET /api/health` returns `{ ok, ai }`, where `ai` lists each key's readiness, model and effort, and which keys power each function.

claude.ai Artifact:

```bash
npm run build:artifact      # dist-artifact/yourlocalbusiness.html (single file)
```

## Going to production

The simulated integrations are isolated so they can be swapped for real ones:
- Social publishing: `src/components/posts/Connect.tsx` (OAuth) and `schedulePostsFlow` / `publishNowFlow` in `src/components/posts/PostCard.tsx`.
- Payments: `CheckoutModal` in `src/pages/store/StoreOverlays.tsx` (e.g. Stripe Checkout or Payment Element on your server).
- Email delivery: export the sequence or connect an email provider where subscribers are added (`src/pages/marketing/email/shared.tsx`).
- Ads: `src/pages/marketing/AdsEngine.tsx` launch handlers.
- Shared marketplace outside claude.ai: replace the Artifact database calls in `src/lib/community.ts` with your API.

## Data

Everything is stored in the browser: app state in `localStorage`, uploaded and AI-generated images and videos in IndexedDB. Export or import a JSON backup from `Settings → Projects & data` (media files aren't included in backups). The server only stores your AI keys and settings (`DATA_DIR/ai-providers.json`) and a usage log (`DATA_DIR/ai-usage.json`).

## Project layout

```
src/
  ai/            AI engine: tasks, functions catalog, server and Claude adapters, Brain, niche knowledge, built-in generators (local/*)
  components/    UI kit, charts, brand/logo, post visuals, code editor, layout
  lib/           types, utilities, storage, metrics, routing, platform (Artifact runtime) bindings
  pages/         onboarding, dashboard, studio, marketing (seo/email/social/ads), calendar, analytics, store, brain, settings
  store/         zustand stores (persisted project context, UI state, sample data)
shared/          ai-functions.json: what AI does in the app (used by the app and the server)
server/          AI server (ai-server.mjs) + static server; providers/: registry, key store, adapters, router, routes, usage log;
                 test/mock-providers.mjs: a stand-in for every provider's API
scripts/         Artifact packaging
```

## Checks

```bash
npm run typecheck
npm test                    # includes the real server against the provider mock
node server/test/mock-providers.mjs 9911   # offline QA: prints the AI_PROVIDER_BASE_URLS to start the server with
```
