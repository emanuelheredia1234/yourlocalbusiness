# Yourlocalbusiness

An AI workspace for researching, building, branding, listing and marketing digital products and local businesses. One shared **Project Context** (brand, offer, niche, assets) feeds every module, and a **Brain** of skills shapes every AI output.

## What's inside

| Area | What you can do |
| --- | --- |
| **Guided onboarding** | Product or business → new or existing → AI product ideas (9 formats, each with a suggested price and why it could fit you; suggestions, not market research) or existing-brand import → AI brand identity (names, logo designer, palette, banner, pitch). Your website is only ever the one you enter. |
| **Dashboard** | Post ideas that open **Create individual post**, project summary, KPI snapshot with sparklines, launch readiness, upcoming posts. |
| **AI images** | Post images (portrait, square, story or landscape) and a marketplace listing set: cover, in-use shot (for a business: the work in action, or a customer for a shop), "What's inside / What you get" checklist graphic and offer card. A business's images are described from its own details (type, specialty, top package, listing title, description, audience, city), without the business name; a stock setting is added only when the type clearly fits it. Edited descriptions are saved with the listing. You can upload your own photo (JPG, PNG or WebP) for any of the four: "Generate full set" keeps it, and "Add my details" typesets the checklist or offer on it without AI. Published images are sized to what the shared Marketplace keeps (gallery: 3). Choose **Photo** (made by the API key that powers Photos: OpenAI, Google, xAI, Meta, OpenRouter or a Manus task; in claude.ai, Meta Muse through Zapier) or **Illustration** (drawn by the AI as SVG). The app typesets headlines, logos, prices and lists on top, so text is always spelled right; change the headline later and the text is re-set on the same artwork without a new generation. |
| **Product / Business Studio** | Structure builder (course curriculum, guide chapters, spreadsheet tabs… or service packages, operating model and value stack), section drafting, AI code & asset generator (calculators, quizzes, booking widgets, pricing tables, spreadsheets + Apps Script…) that you describe and guide in your own words, with your own images, a live CodeMirror editor, split-pane preview, "Edit with AI" with undo, HTML export and a public page for each asset at an address you name (see "Code & assets: guide, edit, images, publish"), AI listing images with a buyer gallery, and one-click publishing to the Marketplace. |
| **Marketing Hub** | Four channels: **SEO** (metadata, live 0–100 score with checklist, Google and link previews, click-to-edit sales page, section manager; guide the AI in your own words, edit with AI (the whole page or one section) with undo, your own photos as the main image and a gallery, publish at an address you name, HTML export with JSON-LD), **Email** (lead magnet, opt-in page copy and preview, 5-email sequence with editable delays, preview and CSV export for your email provider, subscriber list with CSV import and export), **Social** (cadence, watermark, 5 image + 5 video styles, platforms and your handles, post-type mix, 30-day plan, 7-day ready-to-post batch with mockups, add to calendar in bulk, and a **Create individual post** tab for one post at a time), **Paid ads** (objectives, platforms, budget, targeting, A/B creatives, Google search ads, then copy or CSV export to each platform's ads manager). |
| **Content calendar** | Planned (5-week calendar with drag-to-move, or list; posts whose time has passed are flagged **Due**), Posted (by Manus, or marked by you, with the real link when there is one), Drafts; full inline editor with a platform preview. Nothing posts on its own: Manus posts when you confirm, or you post yourself and choose **Mark as posted**. |
| **Analytics** | Real counts only: posts that went out (reported by Manus or marked by you) with period deltas, posts planned and due, things made with AI, a daily chart (with table view), posts by network, type and format, and the posted list with links. Likes, views, clicks and sales live on each network and on your own checkout, so the app doesn't show or estimate them. |
| **Marketplace** | Products and local businesses, search, category pills, location filter + map, and listing details. Buyers buy, book or get in touch through each seller's own checkout or booking link, website, email or phone: the app takes no payments and sends no messages. No ratings, reviews or sold counts (nothing measures them). |
| **Brain** | Skills (voice, audience, rules, offers, SEO, email…) written in plain language and parsed into rules, a skill library, knowledge documents (facts and key terms are extracted), a with/without playground with highlighted differences, an activity log, and learned preferences from thumbs-down feedback. |
| **Settings** | Brand kit (logo upload or designer, colors, banner, images, socials), **AI** (your API keys: what each one powers, its model and effort, priority, usage, and the Brain switch), social accounts, projects, backup/restore, preferences, and **Account** (save status, password, log out, delete account). |
| **Accounts** | Sign up and sign in with email and password; each person's workspace and files are saved to their account (Supabase) and open on any device. |
| **Assistant** | A chat button at the bottom right: ask about the app or your workspace, or tell it what to do. It asks before anything paid, public or permanent (see "Assistant"). |

## What the app does, and what it leaves to other tools

Real:
- All generation, editing, exporting (HTML, Markdown, CSV, JSON backups, Apps Script) and local persistence.
- Accounts (with Supabase): sign-up, email confirmation, password reset, and saving each person's workspace and files to their account.
- AI: Claude in the claude.ai Artifact; your own API keys in the self-hosted app (see "AI: one AI, powered by your API keys"); otherwise a built-in, niche-aware engine that works offline. Brain skills apply to all of them.
- AI images and videos: real files you can download, schedule with posts and publish on listings. Without a key that makes photos, a built-in brand illustration is used and labelled as such.
- Posting: Manus posts on Facebook, Instagram, TikTok, LinkedIn and X for you, in its own browser signed in as you (see "Posting with Manus"). The app itself never logs in to a network and never posts on its own. Without Manus, copy the text and download the image or video from a post's ⋯ menu, post it yourself, and mark it posted.
- Shared Marketplace: with accounts (Supabase), everyone signed in sees every published listing (`market_listings` table: anyone signed in can read, each seller can only add, change or remove their own; signed-out visitors see nothing). In claude.ai as a shared Artifact, listings sync between everyone who opens it. Without either, listings stay in your browser. Buyers pay on each seller's own link.

Not done by the app (it says so where it matters):
- Sending email: you export the sequence to your email provider (Kit, Mailchimp, MailerLite…), which collects sign-ups and sends it.
- Running ads: you copy the campaign into Meta Ads Manager, Google Ads, TikTok or LinkedIn, where you launch and pay for it. The app shows only your own budget, never estimated reach or results.
- Taking payments: buyers pay on each seller's own checkout link.

## AI: one AI, powered by your API keys

`Settings → AI` in the self-hosted app (for example on Replit). There is one AI for the whole app: each API key powers the functions you tick, with the model and effort you choose. In the claude.ai Artifact, Claude does the writing instead and this page says so (keys can't be used there: the page can't reach outside APIs).

**Keys.** There's a card for each provider. Paste a key in the app, or (better on Replit) add it as a Secret under Tools → Secrets. Secrets win over keys typed in the app and survive restarts and publishing. Keys stay on the server (`DATA_DIR/ai-providers.json`, file mode 600, git-ignored), and the page only ever shows their last four characters.

| Provider | Secret name |
| --- | --- |
| OpenRouter (4 slots) | `OPENROUTER_API_KEY`, and `OPENROUTER_API_KEY_2`, `_3`, `_4` for OpenRouter 2–4 |
| Google Gemini | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |
| xAI Grok | `XAI_API_KEY` |
| Anthropic Claude | `ANTHROPIC_API_KEY` |
| Meta Muse | `META_MODEL_API_KEY` |
| Manus | `MANUS_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |

**OpenRouter slots.** There are four OpenRouter cards, so different OpenRouter keys can power different things, each with its own model and effort. For example, give OpenRouter 2 a key that powers only Product research (the "Pick a product idea" page): tick just that in its Powers list, and either untick it on your other keys or move OpenRouter 2 above them.

**Powers.** Each card has a dropdown of everything AI does in the app, stacked as checkboxes:
- **Writing & research:** product research, brand kit & voice, outline & chapters, product files, business model, marketplace listing, code & assets, SEO & sales pages, emails & lead magnets, social posts & campaigns, ads, illustrations and the Assistant (the chat; keys saved before it existed power it too, until you untick it).
- **Media:** photos and videos.
- **Agents:** Social posting (Facebook, Instagram, TikTok, LinkedIn and X, by Manus). It also covers Manus reading a profile's posts when you let it learn your brand voice.

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
| Manus | – | `agent_profile` (photos as a task) | – | Manus credits; Social posting uses `agent_profile` lite … max-ultra |

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

## Code & assets: guide, edit, images, publish

Product Studio → **Code & assets**.
- **Describe it and guide the AI:** pick a type, then say in your own words what it should do, include and look like. If your words name another type ("a booking widget…"), the app offers to switch. Ctrl+Enter (⌘+Enter on a Mac) generates.
- **Images:** add up to 8 per asset (JPEG, PNG, WebP or GIF; paste or drop them on either box too), each with an optional note such as "our shop front, use at the top". The AI is sent the first 4 and may show only your images. The code refers to each one as `{{img-1}}`, `{{img-2}}`…, never by an address or base64. Anything else that would show a picture is taken out of the AI's answer, and the app says so. The preview, Copy HTML and Export fill in the pictures (Copy and Export embed them in the file).
- **Edit with AI:** say what to change, add images to place, or use a quick edit. Undo goes back one AI change at a time and brings back any image that version used. If you remove an image the code still uses, the app says so and offers to take it out of the code.
- **Without an AI** (no key, or the server is off), the built-in engine makes the asset from a template and puts your first image where it fits: the hero's picture, the lead form's cover, a sheet's logo, or the top. Its editor understands themes, corners, text size, colors, fonts, centering, shadows, and adding or taking out an image ("put image 2 at the top", "remove image 1"). The app says when it couldn't follow your words.
- **Publish:** the **Publish** button on an asset gives it a public page at `https://<your app>/<name>`. You choose the name, and can also show it on one of your own domains (see "Publishing pages"). Each published asset's link shows in the asset list, with "changes not published" until you press **Update**. Published pages run in a sandbox without storage of their own, so the page gets an in-memory stand-in: anything it saves lasts until the visitor leaves. Deleting an asset takes its page down too. Publishing isn't offered in the claude.ai Artifact.

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
- **Posting**: see "Posting with Manus" below. In claude.ai it runs through this same Zapier connection (images and text; videos need the self-hosted app).
- Setup on the Zapier side (already done for this workspace): Manus enabled on your Zapier MCP plus two custom Manus actions, `create_task_with_image` (Manus API `task.create`, optionally with an image) and `task_output` (`task.detail` + `task.listMessages`, returning images as base64 so the page can show them; the app first lists the files without their bytes, then downloads only the first one that fits).
- Zapier runs custom actions as "write" calls, so claude.ai may ask you to approve them. To stop the prompts during long Manus tasks, set Zapier's **execute write action** tool to **Always allow** in claude.ai connector settings.
- Self-hosted, posting runs with your Manus API key (tick **Social posting** on the Manus card; its agent profile is the key's effort). Everyone else posts with their own Manus key, on their own accounts.

## Posting with Manus

Manus is an AI agent with its own browser. You sign in to each network once inside Manus; after that it posts for you. This app never connects to your social accounts itself.

- **Where**: Facebook (a Page, through Meta Business Suite), Instagram (instagram.com, or Meta Business Suite to schedule), TikTok (TikTok Studio), LinkedIn (your profile or a company Page) and X.
- **How**: choose **Post on Instagram** (or any network) on a post card, in the post editor or in the calendar list, or **Post with Manus** in **Create individual post** (Social media engine) for every network you picked at once. The calendar also offers **Post N due with Manus** and **Send all to Manus**.
  - Confirm the account for each network (it remembers the last one per project, then uses your handles from Settings → Social accounts) and choose **Post now** or **Schedule** (for each post's own time: at least 30 minutes ahead, and up to 75 days for Facebook, Instagram and X, 90 for LinkedIn, 10 for TikTok).
  - Posts go to Manus one after another; each is its own Manus task and uses your Manus credits. Nothing is ever sent twice by itself.
  - To be quick, Manus goes straight to posting: it doesn't first look for an earlier copy of the post on the account. So when a try fails, sending it again on that network shows a warning: a post may already be out, and a scheduled one may already be in the network's list of scheduled posts, or out once its time has passed (the warning says which to check, or check the task in Manus). The calendar's planned bar and a window with several posts say how many failed last time.
  - Manus posts exactly that post: the text and hashtags, and the image or video as they are. It posts once, never adds anything else, never splits an X post into a thread, and stops to ask when it can't tell which account to use.
  - Instagram and TikTok need an image or a video; X warns when text is over 280 characters (longer works only on accounts that allow it).
- **Status**: the post shows posting or scheduling, **Manus needs you** (for example, to sign in the first time), posted or scheduled, or failed, with a link to the task. When Manus reports it posted, the post moves to **Posted** with its link, if Manus saw one (only links on that network's own website are kept). The app checks every 45 seconds while it's open, or press **Check now**. "Posted" is Manus's own report.
- **Facebook groups**: on a Facebook post (planned or already posted), **Post to groups** lists the groups to share it in (names or facebook.com/groups links, up to 10, remembered per project) and, optionally, the Page to post as where a group allows it. Manus opens each group you're already a member of, reads its rules (and skips groups that don't allow this kind of post), posts the same text and image or video once, waits about 2 minutes between groups, and never joins groups or comments. The post shows each group's result: posted (with its link), waiting for admin approval, skipped (with the rule) or failed. Manus doesn't look for an earlier copy before posting, so sending a post to groups again leaves out the groups Manus reported as posted or waiting for approval (they stay on the post with their results; if it reported all of them, the window says sending again posts twice) and warns before you send. Manus reports the groups at the end of its run, so after a run that stopped partway (for example, out of credits) the app may not know which groups already have it: check the task in Manus, or the groups, first. Group posts happen right away; groups don't take scheduled posts from Manus.
- **Videos** (self-hosted only): the video goes to Manus first, through your server, using Manus's file upload (up to 300 MB here). Signed in, the server takes the video straight from your account's storage with a private link that lasts 10 minutes, so big videos never pass through the browser. Replit's published apps refuse uploads over about 32 MB, so without accounts keep videos under that.
- **Older workspaces**: earlier versions pretended to connect accounts and publish posts, and offered sample data and simulated buyers. When a workspace opens, posts that version marked published (without Manus) go back on the calendar as planned, its handles move to your brand's social handles, and sample posts, subscribers and sales, simulated sales (and what they added to your listings' sold counts), the social plan's invented reach estimate and the notices about them are removed. So are the pretend checkout's orders, sales and cart, the sample Marketplace listings, and the made-up ratings, reviews, "verified" badges and sold counts on listings, the email simulator's test subscribers (and its opens, clicks and "customers" on the rest), and ad campaigns' simulated launches, projections and audience sizes. Once per project, it also removes the claims older versions made up: research scores and revenue ranges, sales-page testimonials and stats, template opening hours and guarantees, value-stack dollar amounts, a made-up https://{name}.com website, and the Brain's sample "proof points"; website widgets that pretended to send forms or showed fake booked slots are flagged to regenerate. Projects made by this version are never touched. Posts Manus really posted stay posted.

## Learning your brand voice from your posts (Manus)

Each social profile (onboarding, Settings → Brand → Social profiles, and Settings → Social accounts) has a **Learn my brand voice from these posts** switch. The profiles are only links or handles: nothing is connected.

- **Turning it on** starts one Manus task. Manus opens the profile in its own browser and reads the 15 latest posts the account published (the text, and how the images and videos look; never the comments). It only reads: it never posts, likes, follows, comments or messages. It reports the tone, "we", "I" or "you", phrases it reuses, how posts open and close, emoji, hashtags, length and layout, topics, the look of its photos and videos, and 3 new example captions it writes in that voice. It runs on the Manus key's **Social posting** power (in claude.ai, the Zapier connection) and uses your Manus credits.
- **Status** under the profile: reading, **Manus needs you** (for example, to sign in to the network inside Manus the first time), learned (with a one-line summary and "What Manus learned"), or couldn't read, with the reason and a link to the task. A private profile, or one Manus can't find, fails with the reason; a Facebook or LinkedIn name that matches several Pages makes Manus ask which one. The app checks every 45 seconds while it's open, or press **Check now**. A read is never started again by itself.
- **The Brain skill**: a finished read becomes "Brand voice from your Instagram posts" (Brand voice), for that project only (the Brain says which; deleting the project deletes it). New posts, captions, emails and pages continue that voice, and photos and videos get its look as art direction. The app writes the skill from the checked report and keeps it short (about 1,500 characters, plus the examples): prices, offers, dates, hours, contact details, @mentions, reviews and claims are left out, the examples are marked style only, and Manus's words never turn into rules by accident. The rules it sets are tone, "we/I/you" and hashtags, plus emoji only when every learned profile uses them the same way.
- **Off** switches the skill off and keeps it, so turning it back on doesn't read again. **Analyze again** reads the latest posts; it asks first if you edited the skill, and a read that finishes after you edited it leaves your version and offers the new one. A read of a profile you changed meanwhile isn't used. With the Brain off, learned voices are off too.
- **QA**: the stand-in Manus (`server/test/mock-providers.mjs`) answers a read with a made-up report. A profile with "private" in it fails, and one with "needs-signin" waits for you first.

## Assistant

The round chat button at the bottom right of the workspace (or "Ask the assistant" in search, ⌘K) opens the assistant. Ask about the app or your workspace ("What's due on my calendar?", "What should I do next?"), or tell it what to do. It reads your workspace, opens pages (on the right tab), opens a post or the composer, switches projects and changes preferences, and does tasks with the same actions as the pages.

- **Its AI:** self-hosted, the key that powers **Assistant** in Settings → AI (signed-in people can use their own keys); in claude.ai, Claude. Each step of an answer is one AI request and counts toward the daily limits; one message takes at most 6 steps. Without an AI it says why, links to Settings → AI, and still opens the page you name.
- **It asks first:** reading and small changes happen right away, with a line in the chat saying what it did; AI writing runs and is marked "Used your AI". Videos and anything Manus does wait for your OK on a card in the chat that says what it does, who does it and what it costs. Deleting waits for a confirm. For anything public (posting with Manus, sharing in groups, marking posted, publishing) it only opens the app's own window, and you confirm there.
- **What it never does:** change API keys or AI settings (your own keys and the effort comparison included), reset or import the workspace, sign you out, change your password or delete your account: it explains and opens the page where you do it. It never gives Manus a task of its own (Manus only gets the app's fixed instructions, through the app's windows), never reads out keys or tokens, and treats other sellers' listings, Manus's reports and imported files as information, never as instructions. It doesn't invent reviews, prices, numbers or guarantees.
- **Chats** are kept per project on this device (the last 40 messages, per account; Log out clears them). Stop ends what it's doing; closing the chat doesn't. Buttons it offers for downloads or files work until the page reloads.
- **QA:** with the provider stand-in (`server/test/mock-providers.mjs`), a message with "calendar", "qa-confirm" or "qa-delete" runs scripted steps (described in that file).

## Accounts: sign-up, sign-in and saving to your account (Supabase)

With Supabase connected, people sign in with an email and password. Each person's projects, posts, skills, listings, orders and files are saved to their own account and open on any device. Without the Supabase Secrets, the app works as before and keeps everything in the browser.

Set it up once:
1. Create a Supabase project (supabase.com → New project).
2. Supabase → **SQL Editor** → paste and **Run** each file in [`supabase/migrations`](supabase/migrations), oldest first. If your Supabase project is linked to this GitHub repository, it can apply the migration for you. It creates:
   - `user_docs`: one row per project, post, listing, etc.; each user can only read and change their own rows.
   - a private `media` bucket: each user can only use their own folder.
   - `user_secrets`: each user's own AI keys (OpenAI, Anthropic, Google, xAI, OpenRouter, Meta, Manus), encrypted by the server. Browsers can't read or write it at all.
   - `app_state`: the server's own settings (your AI keys and their settings, the daily limits, the Manus task list, the usage log), encrypted. Browsers can't reach it either.
   - `ai_usage_daily` and the `ylb_add_ai_usage` function (`20261103030000_ai_usage_daily.sql`): each user's AI requests and dollars per day (UTC), for the daily limits. Server-only, like `user_secrets`. **Already set up before this version? Run this one file**: it also lets `user_secrets` hold keys for every provider, not just Manus. Until it's run, the counters live in the server's memory (they reset when it restarts) and only Manus keys can be saved.
   - `published_pages` and `published_domains` (`20261103040000_published_pages.sql`): published pages and people's own domains (see "Publishing pages"). Server-only.
3. Supabase → **Authentication** → Sign In / Providers → Email: keep **Confirm email** on. The owner check below relies on confirmed emails.
4. Supabase → **Authentication** → **URL Configuration**:
   - Set **Site URL** to your app's address (for example `https://your-app.replit.app`).
   - Add the same address, and your Replit workspace preview address if you use it, under **Redirect URLs**. Confirmation and password-reset links come back there.
5. Replit → Tools → **Secrets**:
   - `SUPABASE_URL`: the Project URL (Supabase → Project Settings → API).
   - `SUPABASE_PUBLISHABLE_KEY`: the publishable key (`sb_publishable_…`). It is meant to be public; row-level security protects the data. The legacy `anon` key also works, as `SUPABASE_ANON_KEY`.
   - `SUPABASE_SECRET_KEY`: the secret key (`sb_secret_…`). It stays on the server. It lets the server:
     - keep the AI keys and settings you type into Settings → AI in Supabase, encrypted. Without it they live in the server's files, which Replit's published apps wipe when they restart or sleep;
     - let people delete their account and files;
     - let people save their own AI keys, and keep everyone's daily AI counters.
   - `ADMIN_EMAILS` (optional): the owner's email. You can also make an account the owner in Supabase (SQL Editor): `update auth.users set raw_app_meta_data = raw_app_meta_data || '{"ylb_role": "admin"}'::jsonb where lower(email) = 'you@example.com';` (it applies at that account's next sign-in, or within the hour). The owner manages the AI keys, models, effort and usage log; everyone else uses those keys. Without this Secret the owner is `hectorheredia242@gmail.com` (`DEFAULT_ADMIN_EMAILS` in `server/auth.mjs`).
6. Press Run, or republish. The server log says `Accounts: on (Supabase), sign-in required`.
7. Let other people sign up: add your own email sender (Supabase → Authentication → Emails → **SMTP Settings**, with a service such as Resend, Postmark, Brevo or Amazon SES). Until then, Supabase's built-in sender only emails members of your Supabase team (so only you can confirm an account) and sends a few emails an hour; anyone else sees "This app can't send emails to that address yet".

What people get:
- **Screens:** Sign in, Create account and Forgot password. The email links open the app.
- **Account menu with Log out:** in the top bar, at the bottom of the sidebar, and in the setup screens.
- **Settings → Account:** save status, change password, log out, and delete account.
- **Automatic saving:**
  - About 1–2 seconds after each change.
  - Changes made offline wait on the device and save once you're back online.
  - Coming back to the tab picks up changes made on other devices.
- **Logging out** removes the account's copy from that device. It stays in the account.
- **Moving an older workspace in:** the first time an account is opened in a browser that has a workspace from before accounts, the app offers to add it to the account, with its images and files.
- **AI for everyone signed in, on your keys:**
  - Only the `ADMIN_EMAILS` account can see and change keys or read the usage log. Everyone else sees what powers each function.
  - **Daily limits:** each signed-in person (not the owner) gets, by default, 50 requests and $1 a day on your keys (writing, photos and videos), counted per UTC day. Over the limit they get "You've reached today's limit on the app's AI keys… It resets at midnight UTC" and a pointer to add their own keys. A request counts once it reaches a provider, and requests running at the same time count against each other, so parallel requests can't slip past a limit. Its cost is added when known; a video's estimated cost (price per second × length, or $0.05 a second when the price list doesn't say) counts as soon as it starts, so a video that alone would go over the dollar limit is refused, and is corrected to the real cost when the job finishes (the server checks on it even if nobody asks). If Supabase can't be read for a moment, the last count read is used, and someone not counted yet is asked to try again in a minute. Change or turn off either limit (0 = no limit) with `PUT /api/ai/limits` (owner only). The owner is never limited.
  - **Their own keys:** anyone can add their own OpenAI, Anthropic, Google, xAI, OpenRouter, Meta or Manus key in Settings → AI. Each key is checked with the provider for free first (it lists the account's models), encrypted, and shown only by its last 4 characters. Their writing, photos and videos then run on their own key whenever it can do that kind of work (with that provider's default model and effort), never on yours and never limited; only what their keys can't do falls back to your keys, within the limits. A failing own key doesn't fall back to yours.
  - **Usage:** each person sees today's counts and the last 7 days (`GET /api/ai/my-usage`, own-key requests counted apart); the owner sees everyone's per day with their email (`GET /api/ai/usage/users?days=7`).
  - Video jobs and Manus tasks belong to whoever started them.
  - **Manus is yours alone.** It's an agent with its own browser, signed in to your accounts (Facebook, Instagram…), so only the owner can give your Manus key a task.
  - **Everyone else can use their own Manus.** Settings → AI → "Use your own Manus" links to manus.im and explains how to create an API key (Manus → Settings → API Integration → Create API Key).
    - The key is checked with Manus, encrypted on the server (AES-256-GCM, from `USER_KEYS_SECRET` if set, otherwise from the secret key) and kept in `user_secrets`.
    - The app only ever shows its last 4 characters.
    - Their Manus photos and social posts then run in their own Manus account, on their credits.
- **A separate AI server:** if the app and the AI server run at different addresses (Settings → AI → Advanced), the sign-in is only sent to that server after you press **Test connection** there. This is remembered per account on that device and forgotten at Log out, so a half-typed address, or one from an imported backup, never receives it.
- **One tab at a time:** an account works in one tab per browser. Opening it in a second tab moves it there; the first tab offers "Use it here".
- **Optional sign-in:** `SIGN_IN_REQUIRED=false` makes signing in optional. "Continue without an account" keeps work in that browser, and AI then works without signing in. Signed-out visitors get the same daily limits, counted per network address in the server's memory (behind a proxy they share one count), so signing out never lifts a limit.

## SEO page: guide, edit, images, publish

Marketing → SEO sales page.
- **Guide the AI**: what the page should stress, who it's for, how it should sound. It's saved with the project and used each time the AI writes the page (Generate, Rewrite page) or its metadata. The AI's rules come first: whatever the guidance asks, it never writes testimonials, ratings, numbers, guarantees or prices; you add your real ones on the page.
- **Images**: add up to 8 in "Guide the AI" (or paste or drop them on its text box), each with an optional note. The AI puts one beside the headline and the others in a photo gallery (added after "Solution & features"), and writes alt text and captions from what it can see or your note. The built-in engine can't see images: it puts the first one beside the headline and the rest in the gallery. Images not on the page yet are listed with **Add to the page**; removing an image from the list takes it off the page. In Edit, each image has its alt text and a Remove button. Only image files you add are used (JPEG, PNG, WebP or GIF), never addresses.
- **Edit with AI** (above the page): say what to change, for the whole page or one section, optionally with new images. It starts from the page as it is: sections keep their ids, order and visibility, your facts stay as they are, the look (font, light or dark, corners) changes only when you ask, and if the AI can't answer nothing changes. In Sections, **Rewrite with AI** also takes an optional request.
- **Undo** takes back the last AI change (up to 15; kept while the app is open, not saved).
- **Copy HTML** and **Export HTML** put the images inside the file. The HTML source view shows them as `{{img-1}}`.
- **Public page** (beside the score): publish the page at `https://<your app>/<name>`, and on your own domain (see below). The name starts as the page's URL slug. The published page's canonical address and `og:url` are where it's published, unless you pasted a canonical address of your own; its main image is the link-preview image (`og:image`, `twitter:image`) and the schema's `image`.

## Publishing pages

Signed-in people can publish their SEO page and each artifact at a public address they name, `https://<your app>/<name>`, and also show it on a domain of their own (`https://their-domain.com/<name>`, or as that domain's home page). The server keeps a copy of each published page and its images; the live page changes only when they publish again.

Set it up once:
1. Accounts on, with the `SUPABASE_SECRET_KEY` Secret (see above).
2. Supabase → SQL Editor → run `supabase/migrations/20261103040000_published_pages.sql`. Until then, publishing says which file to run.

Own domains:
1. The person adds the domain in Settings → Domains. Each domain belongs to the first account that adds it.
2. The app's owner links it in Replit: open the app → Deployments → Settings → Domains → "Use a domain you already own". The person then adds the A and TXT records Replit shows at their registrar (Cloudflare: DNS only, not proxied).
3. Back in Settings → Domains, **Check**: the server asks `https://<domain>/.well-known/ylb-domain-check` for the domain's code.
- On someone's domain, the server answers only with their published pages, a `robots.txt` and a `sitemap.xml`: never the app or `/api`.
- If the app itself also runs on a domain of yours, add it to the `APP_HOSTS` Secret (comma-separated) so nobody can claim it.

Security: published pages are other people's HTML and scripts, served from the app's own address, where the app keeps its sign-in. So on the app's address every page is sent with a `Content-Security-Policy: sandbox` header that never allows the app's origin: the page can't read the sign-in or use the API as the visitor, and SEO pages can't run scripts at all. Images are served only when they're listed with their page and are still the exact files checked when it was published (JPEG, PNG, WebP or GIF; never SVG). On a person's own domain, pages run unsandboxed on that domain's own origin.

API (signed in, same site only): `GET /api/pages`, `GET /api/pages/check?slug=&pageId=`, `PUT` and `DELETE /api/pages/<pageId>`, `POST /api/domains`, `POST /api/domains/<domain>/check`, `DELETE /api/domains/<domain>`.

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
- accounts: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `ADMIN_EMAILS`, `SIGN_IN_REQUIRED` (see "Accounts")
- `APP_HOSTS`: other domains the app itself runs on (see "Publishing pages")

`GET /api/config` tells the app whether accounts are on and whether it can publish pages, and `DELETE /api/account` deletes the signed-in user, with their saved workspace, files and published pages.

`GET /api/health` returns `{ ok, ai }`, where `ai` lists each key's readiness, model and effort, and which keys power each function.

claude.ai Artifact:

```bash
npm run build:artifact      # dist-artifact/yourlocalbusiness.html (single file)
```

## Going to production

Where to plug in real integrations:
- Posting through the networks' own APIs instead of Manus: `startManusPost` in `src/ai/manusPost.ts` is the one place a post leaves the app.
- Payments: sellers use their own checkout link (a listing's `buyUrl`). To take payments in the app, add Stripe Checkout on your server and record paid orders from its webhook.
- Email delivery: connect an email provider's API where the sequence is exported (`src/pages/marketing/email/PreviewPanel.tsx`).
- Ads: push campaigns through the platforms' marketing APIs from `ExportPanel` in `src/pages/marketing/AdsEngine.tsx`.
- Shared marketplace outside claude.ai: replace the Artifact database calls in `src/lib/community.ts` with your API.

## Data

With accounts on, each user's workspace is saved in Supabase:
- each project, post, ad, skill, generation, listing, order, sale and notice is a row in `user_docs`, plus one row for account-level settings;
- their files go to Storage, under `media/<user id>/` (a published page's images under `media/<user id>/published/`);
- published pages are rows in `published_pages`, and their own domains in `published_domains`;
- each device they use keeps a copy for speed and offline work.

Theme, server address and demo switches stay per device.

Without accounts, everything is stored in the browser: app state in `localStorage`, uploaded and AI-generated images and videos in IndexedDB. Export or import a JSON backup from `Settings → Projects & data` (media files aren't included in backups). The server only stores your AI keys and settings (`DATA_DIR/ai-providers.json`) and a usage log (`DATA_DIR/ai-usage.json`).

## Project layout

```
src/
  ai/            AI engine: tasks, functions catalog, server and Claude adapters, Brain, niche knowledge, built-in generators (local/*),
                 the in-app assistant (assistant/: its protocol, prompt, turn and policy, and tools by group)
  components/    UI kit, charts, brand/logo, post visuals, code editor, layout
  lib/           types, utilities, storage, metrics, routing, platform (Artifact runtime) bindings
  lib/cloud/     accounts: Supabase sign-in (auth.ts), saving the workspace (sync.ts) and files (media.ts)
  pages/         onboarding, dashboard, studio, marketing (seo/email/social/ads), calendar, analytics, store, brain, settings
  store/         zustand stores (persisted project context, UI state, cleanup of data older versions made up)
shared/          ai-functions.json: what AI does in the app (used by the app and the server)
server/          AI server (ai-server.mjs) + static server; providers/: registry, key store, adapters, router, routes, usage log;
                 auth.mjs: checks the Supabase sign-in token; pages.mjs: published pages and people's own domains;
                 test/mock-providers.mjs: a stand-in for every provider's API;
                 test/mock-supabase.mjs: a stand-in for Supabase Auth, the database and Storage
supabase/        migrations: the accounts tables, bucket and row-level security
scripts/         Artifact packaging
```

## Checks

```bash
npm run typecheck
npm test                    # includes the real server against the provider mock
node server/test/mock-providers.mjs 9911   # offline QA: prints the AI_PROVIDER_BASE_URLS to start the server with
node server/test/mock-supabase.mjs 54321   # offline accounts QA: use its url and keys as SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY
```
