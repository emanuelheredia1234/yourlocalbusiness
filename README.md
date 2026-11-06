# Yourlocalbusiness

An AI workspace for researching, building, branding, listing and marketing digital products and local businesses. One shared **Project Context** (brand, offer, niche, assets) feeds every module, and a **Brain** of skills shapes every AI output.

## What's inside

| Area | What you can do |
| --- | --- |
| **Guided onboarding** | Product or business → new or existing → AI product ideas (9 formats, each with a suggested price and why it could fit you; suggestions, not market research) or existing-brand import → AI brand identity (names, logo designer, palette, banner, pitch). Your website is only ever the one you enter. |
| **Dashboard** | Post ideas that open **Create individual post**, project summary, KPI snapshot with sparklines, launch readiness, upcoming posts. |
| **Strategy** | Research and a plan to get clients and sales: where buyers look and what gets attention (a web search with sources and dates when the key that powers Strategy can search, otherwise labelled the AI's general knowledge), where and how to promote, which page to build first (lead form, booking, website, landing, showcase or checkout) and where its link goes on each network (post, first comment or bio), social content and a campaign setup, assets to create, outreach emails you send yourself, guidance for your SEO page, and a 4-week plan with "Do it" buttons. Optional deep research with Manus. "Guide my other tabs" adds Brain skills, SEO guidance, campaign and link settings, each after a preview. |
| **AI images** | Post images (portrait, square, story or landscape) and a marketplace listing set: cover, in-use shot (for a business: the work in action, or a customer for a shop), "What's inside / What you get" checklist graphic and offer card. A business's images are described from its own details (type, specialty, top package, listing title, description, audience, city), without the business name; a stock setting is added only when the type clearly fits it. Edited descriptions are saved with the listing. You can upload your own photo (JPG, PNG or WebP) for any of the four: "Generate full set" keeps it, and "Add my details" typesets the checklist or offer on it without AI. Published images are sized to what the shared Marketplace keeps (gallery: 3). Choose **Photo** (made by the API key that powers Photos: OpenAI, Google, xAI, Meta, OpenRouter or a Manus task; in claude.ai, Meta Muse through Zapier) or **Illustration** (drawn by the AI as SVG). The app typesets headlines, logos, prices and lists on top, so text is always spelled right; change the headline later and the text is re-set on the same artwork without a new generation. |
| **Product / Business Studio** | Structure builder (course curriculum, guide chapters, spreadsheet tabs… or service packages, operating model and value stack), section drafting, AI code & asset generator (calculators, quizzes, booking widgets, pricing tables, spreadsheets + Apps Script…) that you describe and guide in your own words, with your own images, a live CodeMirror editor, split-pane preview, "Edit with AI" with undo, HTML export and a public page for each asset at an address you name (see "Code & assets: guide, edit, images, publish"), AI listing images with a buyer gallery, and one-click publishing to the Marketplace. |
| **Marketing Hub** | Four channels: **SEO** (metadata, live 0–100 score with checklist, Google and link previews, click-to-edit sales page, section manager; guide the AI in your own words, edit with AI (the whole page or one section) with undo, your own photos as the main image and a gallery, publish at an address you name, HTML export with JSON-LD), **Email** (lead magnet, opt-in page copy and preview, 5-email sequence with editable delays, preview and CSV export for your email provider, subscriber list with CSV import and export), **Social** (cadence, watermark, 5 image + 5 video styles, platforms and your handles, post-type mix, 30-day plan, 7-day ready-to-post batch with mockups, add to calendar in bulk, and a **Create individual post** tab for one post at a time), **Paid ads** (objectives, platforms, budget, targeting, A/B creatives, Google search ads, then copy or CSV export to each platform's ads manager, or **Launch…** on Meta and Google Search from the app with a spend confirm, and a **Campaigns** tab to pause, resume, end, change the budget or end date and swap the ad; see docs §3c). |
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
- Lead forms: a published page's form sends what visitors type to the app's server, and it shows in Marketing Hub → Email → Leads. The app doesn't reply or send email.

Not done by the app (it says so where it matters):
- Sending email: you export the sequence to your email provider (Kit, Mailchimp, MailerLite…), which collects sign-ups and sends it. With Omnisend connected, the app can create campaign drafts there, which you review and send yourself (see "Omnisend: campaign drafts from the email sequence").
- Paying for ads: ad spend is billed by Meta or Google to the customer's own payment method. The app can launch Meta and Google Search campaigns (once the owner turns it on, after a spend confirm with the amounts) and change them; TikTok and LinkedIn stay copy-and-export. The app never estimates reach or results.
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
| Slack, for Viktor (not an AI key: see "Manus and Viktor (Slack): setup") | `SLACK_USER_TOKEN` |

**OpenRouter slots.** There are four OpenRouter cards, so different OpenRouter keys can power different things, each with its own model and effort. For example, give OpenRouter 2 a key that powers only Product research (the "Pick a product idea" page): tick just that in its Powers list, and either untick it on your other keys or move OpenRouter 2 above them.

**Powers.** Each card has a dropdown of everything AI does in the app, stacked as checkboxes:
- **Writing & research:** Strategy (keys saved before it existed power it too, until you untick it), product research, brand kit & voice, outline & chapters, product files, business model, marketplace listing, code & assets, SEO & sales pages, emails & lead magnets, social posts & campaigns, ads, illustrations and the Assistant (the chat; keys saved before it existed power it too, until you untick it).
- **Media:** photos and videos.
- **Agents:** Social posting (Facebook, Instagram, TikTok, LinkedIn and X, by Manus). It also covers Manus reading a profile's posts when you let it learn your brand voice. Deep research (Manus): for Strategy, Manus reads public pages about your market (you tick it for your Manus key). Building pages & assets and Chat with Manus: Manus builds your SEO page or an asset, and chats with you in the assistant (keys saved before they existed power them too, until you untick them; see "Manus and Viktor (Slack): setup").

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
- **Build with Manus or Viktor** (self-hosted only; set them up in Settings → AI): under Generate, **Build with Manus** or **Build with Viktor** opens a window prefilled from the box: what to build, **your website (reference)** (your own `https://` address from Settings → Brand, only to see your colors, fonts and style; leave it empty for none), **what to build and the features you want** (your words, up to 4,000 characters for Manus and 1,500 for Viktor), your images (up to 8, each with a note) and the facts they may use (your business name, what it is, where, what you sell, your booking and payment links, email, phone, hours: untick any). The server sends them on the app's fixed template, your words inside it as you wrote them, with fixed rules: use only those facts (no reviews, prices or numbers of their own), show images only as `{{img-N}}`, no outside scripts, fonts or images, and one complete HTML file. **Next** shows who does the work and what it costs (Manus: your Manus credits, shown when it's done; Viktor: your viktor.com plan, which the app can't see), and **Show the exact message** shows the text that would be sent. **Send** sends it once; nothing is ever sent again by itself. A card above Your assets follows the build (the app checks every few seconds while you watch, and every 45 s otherwise, also after a reload or on another device): **Stop** (Manus) or **Stop waiting** (Viktor), **Answer** a question, **Ask for the page as one file**, **Preview** (in a sandbox, with your images), **Use this** (a new asset with a Manus or Viktor badge and a link to the task or thread; again later, **Update** it or add another, and Undo puts the earlier code back) and **Ask for changes** (your words and new images, same confirm). Every follow-up asks first, with who and cost. When a send may have arrived ("may have been delivered"), the app checks by reading, never by sending again. Before it's kept, the page is cleaned: comments, frames, plugins, outside stylesheets and fonts, `javascript:` and `data:` addresses go; inline handlers (`onclick=`…) move into the asset's script; forms that send to another site lose their address; only your images stay. Nothing is published by itself.

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

## Links in your posts

Posts link to your published SEO page (at your own domain when you added one), else to your website. Without either, posts say "link in bio" and carry no address.

- **Where the link goes**, per network, in Social → Campaign setup → **Where the link goes** (suggested defaults per network): **In the post**, **First comment** (a reply on X) or **Bio**. Create individual post can change it for each network, and the post editor for each post. Until you choose, Instagram and TikTok say "link in bio" and the others carry the link, as before. Posts you already made keep theirs. The Strategy tab can recommend these and set them for you.
- **First comment**: the caption says the link is in the first comment, and the post keeps the comment's text (your link with a short lead-in; you can edit it). When Manus posts it right away, it adds the comment right after posting and reports it on its RESULT line. If it couldn't, the post stays posted and nothing is retried. Otherwise (you post it yourself, or Manus schedules it), the post card shows the comment with Copy.
- **Bio**: the caption says "link in bio". Keep your link in that profile's bio: the app shows it with Copy and never changes your profile.
- Links in Instagram and TikTok captions and comments can't be clicked. On X a link counts as 23 characters; a long X post is shortened at the start, never at the link.
- Facebook groups always get the link in the post text, since Manus never comments in groups.

## Posting with Manus

Manus is an AI agent with its own browser. You sign in to each network once inside Manus; after that it posts for you. This app never connects to your social accounts itself.

- **Where**: Facebook (a Page, through Meta Business Suite), Instagram (instagram.com, or Meta Business Suite to schedule), TikTok (TikTok Studio), LinkedIn (your profile or a company Page) and X.
- **How**: choose **Post on Instagram** (or any network) on a post card, in the post editor or in the calendar list, or **Post with Manus** in **Create individual post** (Social media engine) for every network you picked at once. The calendar also offers **Post N due with Manus** and **Send all to Manus**.
  - Confirm the account for each network (it remembers the last one per project, then uses your handles from Settings → Social accounts) and choose **Post now** or **Schedule** (for each post's own time: at least 30 minutes ahead, and up to 75 days for Facebook, Instagram and X, 90 for LinkedIn, 10 for TikTok).
  - Posts go to Manus one after another; each is its own Manus task and uses your Manus credits. Nothing is ever sent twice by itself.
  - To be quick, Manus goes straight to posting: it doesn't first look for an earlier copy of the post on the account. So when a try fails, sending it again on that network shows a warning: a post may already be out, and a scheduled one may already be in the network's list of scheduled posts, or out once its time has passed (the warning says which to check, or check the task in Manus). The calendar's planned bar and a window with several posts say how many failed last time.
  - Manus posts exactly that post: the text and hashtags, and the image or video as they are. It posts once, adds nothing else (except the first comment with your link, when the post has one and Manus posts it right away), never splits an X post into a thread, and stops to ask when it can't tell which account to use.
  - Instagram and TikTok need an image or a video; X warns when text is over 280 characters (each link counts as 23; longer works only on accounts that allow it).
- **Status**: the post shows posting or scheduling, **Manus needs you** (for example, to sign in the first time), posted or scheduled, or failed, with a link to the task. When Manus reports it posted, the post moves to **Posted** with its link, if Manus saw one (only links on that network's own website are kept). The app checks every 45 seconds while it's open, or press **Check now**. "Posted" is Manus's own report.
- **Facebook groups**: on a Facebook post (planned or already posted), **Post to groups** lists the groups to share it in (names or facebook.com/groups links, up to 10, remembered per project) and, optionally, the Page to post as where a group allows it. Manus opens each group you're already a member of, reads its rules (and skips groups that don't allow this kind of post), posts the same text (with your link in it) and image or video once, waits about 2 minutes between groups, and never joins groups or comments. The post shows each group's result: posted (with its link), waiting for admin approval, skipped (with the rule) or failed. Manus doesn't look for an earlier copy before posting, so sending a post to groups again leaves out the groups Manus reported as posted or waiting for approval (they stay on the post with their results; if it reported all of them, the window says sending again posts twice) and warns before you send. Manus reports the groups at the end of its run, so after a run that stopped partway (for example, out of credits) the app may not know which groups already have it: check the task in Manus, or the groups, first. Group posts happen right away; groups don't take scheduled posts from Manus.
- **Videos** (self-hosted only): the video goes to Manus first, through your server, using Manus's file upload (up to 300 MB here). Signed in, the server takes the video straight from your account's storage with a private link that lasts 10 minutes, so big videos never pass through the browser. Replit's published apps refuse uploads over about 32 MB, so without accounts keep videos under that.
- **Older workspaces**: earlier versions pretended to connect accounts and publish posts, and offered sample data and simulated buyers. When a workspace opens, posts that version marked published (without Manus) go back on the calendar as planned, its handles move to your brand's social handles, and sample posts, subscribers and sales, simulated sales (and what they added to your listings' sold counts), the social plan's invented reach estimate and the notices about them are removed. So are the pretend checkout's orders, sales and cart, the sample Marketplace listings, and the made-up ratings, reviews, "verified" badges and sold counts on listings, the email simulator's test subscribers (and its opens, clicks and "customers" on the rest), and ad campaigns' simulated launches, projections and audience sizes. Once per project, it also removes the claims older versions made up: research scores and revenue ranges, sales-page testimonials and stats, template opening hours and guarantees, value-stack dollar amounts, a made-up https://{name}.com website, and the Brain's sample "proof points"; website widgets that pretended to send forms or showed fake booked slots are flagged to regenerate. Projects made by this version are never touched. Posts Manus really posted stay posted.

## Learning your brand voice from your posts (Manus)

Each social profile (onboarding, Settings → Brand → Social profiles, and Settings → Social accounts) has a **Learn my brand voice from these posts** switch. The profiles are only links or handles: nothing is connected.

- **Turning it on** starts one Manus task. Manus opens the profile in its own browser and reads the 15 latest posts the account published (the text, and how the images and videos look; never the comments). It only reads: it never posts, likes, follows, comments or messages. It reports the tone, "we", "I" or "you", phrases it reuses, how posts open and close, emoji, hashtags, length and layout, topics, the look of its photos and videos, and 3 new example captions it writes in that voice. It runs on the Manus key's **Social posting** power (in claude.ai, the Zapier connection) and uses your Manus credits.
- **Status** under the profile: reading, **Manus needs you** (for example, to sign in to the network inside Manus the first time), learned (with a one-line summary and "What Manus learned"), or couldn't read, with the reason and a link to the task. A private profile, or one Manus can't find, fails with the reason; a Facebook or LinkedIn name that matches several Pages makes Manus ask which one. The app checks every 45 seconds while it's open, or press **Check now**. A read is never started again by itself.
- **The Brain skill**: a finished read becomes "Brand voice from your Instagram posts" (Brand voice), for that project only (the Brain says which; deleting the project deletes it). New posts, captions, emails and pages continue that voice, and photos and videos get its look as art direction. The app writes the skill from the checked report and keeps it short (about 1,500 characters, plus the examples): prices, offers, dates, hours, contact details, @mentions, reviews and claims are left out, the examples are marked style only, and Manus's words never turn into rules by accident. The rules it sets are tone, "we/I/you" and hashtags, plus emoji only when every learned profile uses them the same way.
- **Off** switches the skill off and keeps it, so turning it back on doesn't read again. **Analyze again** reads the latest posts; it asks first if you edited the skill, and a read that finishes after you edited it leaves your version and offers the new one. A read of a profile you changed meanwhile isn't used. With the Brain off, learned voices are off too.
- **QA**: the stand-in Manus (`server/test/mock-providers.mjs`) answers a read with a made-up report. A profile with "private" in it fails, and one with "needs-signin" waits for you first.

## Manus and Viktor (Slack): setup

Two agents can build your SEO page or a Code & assets asset (**Build with Manus**, **Build with Viktor**) and chat with you from the assistant (its **To:** switch). They're self-hosted only: the claude.ai Artifact has no server, so it shows no buttons for them.

- **Manus** is an AI agent with its own computer and browser, reached with your Manus API key (Settings → AI). Its Powers list has two more agent functions: **Building pages & assets** and **Chat with Manus**. Keys saved before Building pages & assets and Chat with Manus existed power them too, until you untick them. Builds and chats run without your Manus account's connected apps (Gmail, Slack and so on), a build never asks questions, and a chat may. Each request picks an agent profile (your Settings default for Social posting, unless you choose another in the build window). Manus tasks the app starts are followed for 30 days.
- **Viktor** is the AI employee from viktor.com in your Slack workspace. The app reaches it through **its own small Slack app** in your workspace: the Slack connection you set up in Claude belongs to Claude, and the deployed app can't use it.

**Connecting Viktor, once** (Settings → AI → **Viktor (Slack)**, owner only):
1. **Copy** the manifest, or press **Create it from the manifest**.
2. In Slack (api.slack.com/apps): **Create New App → From a manifest** → choose the workspace where Viktor is → paste → **Next** → **Create**.
3. In the new app: **OAuth & Permissions → Install to Workspace → Allow**. Leave the optional channel permissions out if you'll only use your DM with Viktor. A workspace that needs admin approval asks an admin first.
4. Copy the **User OAuth Token** (`xoxp-…`) from OAuth & Permissions → OAuth Tokens. Paste it into the card and press **Save**, or add the Replit Secret `SLACK_USER_TOKEN` (it wins over one saved in the app) and restart or republish. Never paste it into a chat. A Bot token (`xoxb-`) is refused (a bot can't post in your DM with Viktor), and so is a rotating one (`xoxe.`; turn token rotation off by creating the app from the manifest).
5. **Find Viktor** (the workspace's bots, Viktor first) or paste its member ID, then choose **where**: your DM with Viktor (recommended; only you see it) or a channel Viktor is in (type `/invite @Viktor` there first; everyone in the channel sees the requests, and each thread's first message mentions Viktor).
6. **Test connection**: it only reads, and never posts.

**What the token can reach, and how the app limits it.** A user token acts as you: it can read your direct messages and post wherever you can. So the token stays on the server (in `DATA_DIR/ai-providers.json`, and encrypted in Supabase with the AI keys), the browser only ever sees its last 4 characters, logs and error messages scrub Slack tokens, and every message goes to the one place you chose (never a conversation the browser names). The app reads only the threads it started (a list kept like the Manus task list, for 30 days), and has no route that posts to, or reads, anything else. Files Viktor attaches are fetched by the server with the token from Slack's own file host only (never a remote file, never through a redirect to another host); pages come back as text and are only ever shown sandboxed. Remove (with "Also revoke the token in Slack") disconnects it.

**Owner only.** Viktor posts as you in Slack, so with accounts on only the owner's account can use it (and see its buttons); without accounts, this machine or the `ADMIN_TOKEN` (Settings → AI keeps the token you enter and sends it with these requests). Manus keeps its usual rules: the owner, or a signed-in user's own Manus key.

**What it costs.** Manus uses your Manus credits; how many depends on the work (a Max profile uses more), and the app shows what a task used when it's done. Viktor's work counts toward your viktor.com plan, which the app can't see. Every request asks first, saying who does it and what it costs, and is sent once: if the connection drops after it left, the app says it may have been delivered and checks (by a `Ref:` code at the end of each message, or in the Manus task's title) instead of sending again. At most 6 messages a minute go to Viktor.

**The messages are the app's own.** Manus and Viktor only ever get the app's fixed templates (`server/agents/templates.mjs`), filled with the facts you tick, your website as a style reference (https only), your own words (in blocks they can't close) and your image notes: what to build, no invented reviews, prices or numbers, images only as `{{img-N}}`, no outside scripts, SEO pages without JavaScript, and forms only to Email → Leads. Their replies, and your website's text, are treated as information, never as instructions.

**QA** (no real accounts): `node server/test/mock-providers.mjs 9911` prints `AI_PROVIDER_BASE_URLS`, now with `slack`. Start the server with it, plus `MANUS_API_KEY=qa-manus`, `SLACK_USER_TOKEN=xoxp-qa-owner-000000000001` and `ADMIN_TOKEN=qa-admin`. The stand-in Slack has Viktor (`UQAVIKTOR`), your DM `DQAVIKTOR1`, `#viktor-builds` and `#general` (Viktor isn't in it); `xoxp-qa-dmonly-000000000002` has no channel permissions and `xoxp-qa-noscope-000000000003` can't read files. Markers in your words pick the answer:
- Manus builds: `qa-manus-script`, `qa-manus-zip`, `qa-manus-webdev`, `qa-manus-noresult`, `qa-manus-fail`, `qa-manus-nofile`, `qa-manus-big`, `qa-manus-ask`, `qa-manus-approve`, `qa-manus-bg`; Manus chat: `qa-manus-page`, `qa-manus-image`, `qa-manus-question`, `qa-manus-progress`.
- Viktor: `qa-viktor-file`, `qa-viktor-snippet`, `qa-viktor-question`, `qa-viktor-link`, `qa-viktor-split`, `qa-viktor-edit`, `qa-viktor-delete`, `qa-viktor-toplevel`, `qa-viktor-slow`, `qa-viktor-external`, `qa-viktor-redirect`, `qa-viktor-script`, `qa-viktor-big`; Slack itself: `qa-slack-timeout`, `qa-slack-429`, `qa-slack-fail`, `qa-slack-internal`. What each does is described in `server/test/mock-providers.mjs` and `server/test/mock-slack.mjs`.

## Assistant

The round chat button at the bottom right of the workspace (or "Ask the assistant" in search, ⌘K) opens the assistant. Ask about the app or your workspace ("What's due on my calendar?", "What should I do next?"), or tell it what to do. It reads your workspace, opens pages (on the right tab), opens a post or the composer, switches projects and changes preferences, and does tasks with the same actions as the pages.

- **Its AI:** self-hosted, the key that powers **Assistant** in Settings → AI (signed-in people can use their own keys); in claude.ai, Claude. Each step of an answer is one AI request and counts toward the daily limits; one message takes at most 6 steps. Without an AI it says why, links to Settings → AI, and still opens the page you name.
- **It asks first:** reading and small changes happen right away, with a line in the chat saying what it did; AI writing runs and is marked "Used your AI". Videos and anything Manus does wait for your OK on a card in the chat that says what it does, who does it and what it costs. Deleting waits for a confirm. For anything public (posting with Manus, sharing in groups, marking posted, publishing) it only opens the app's own window, and you confirm there.
- **What it never does:** change API keys or AI settings (your own keys and the effort comparison included), reset or import the workspace, sign you out, change your password or delete your account: it explains and opens the page where you do it. It never sends anything to Manus or Viktor by itself (see below), never reads out keys or tokens, and treats other sellers' listings, Manus's and Viktor's replies and reports, and imported files as information, never as instructions. It doesn't invent reviews, prices, numbers or guarantees.
- **Chats** are kept per project on this device (the last 40 messages, per account; Log out clears them). Stop ends what it's doing; closing the chat doesn't. Buttons it offers for downloads or files work until the page reloads.
- **Talking to Manus and Viktor** (self-hosted; Viktor for the owner only): the **To: Assistant · Manus · Viktor** switch above the box sends your words to Manus or Viktor (viktor.com's AI employee, in your Slack) **exactly as you type them**, in one Manus task or one Slack thread per project chat. The first message asks first, on a card that says what goes, who answers and what it costs (Manus credits; Viktor's work counts toward your viktor.com plan, which the app can't see); later messages go on your click, with who and cost shown under the box. The paperclip adds up to 8 images per message (or paste or drop them), and **Add my website** adds your https website. Their replies come back into the chat as their own messages ("From Viktor", "You (in Slack)" for what you typed in Slack, "edited in Slack", "Deleted in Slack"), as plain text with links (never as HTML, and never moving the app): images show inline (**Save to my images**, **Download**), a page shows as a chip with **Preview** (cleaned, in a sandbox), **Open as asset** (a new Code & assets asset) and **Use as my SEO page** (the SEO page's HTML mode; it asks first when you already have a page, and Undo or Version switches back), and other files can be downloaded. Manus's questions show their choices as buttons; when Manus waits for an approval in Manus, the chat says so with Open in Manus (the app never approves for you). Each message is sent once: one that may have been delivered says so and is checked by reading Manus or Slack, and Send again is your click. While the chat is open it checks for replies every few seconds; otherwise every 45 seconds (also after a reload), and a reply that comes while the chat is closed puts a dot on the chat button with a toast. **New chat** starts a new Manus task and Slack thread. Nothing is published by itself.
- **The assistant and Manus and Viktor:** it can open **Build with Manus** or **Build with Viktor** for your SEO page or a new asset (you fill it in and send it), and, when you ask, draft a message for one of them: the card shows the exact text (with Copy), and it goes, as your message, only if you press Send. It never sends one by itself, and it never sees their replies: they're left out of everything it reads (your own messages to them are shown to it as "Owner (to Viktor): …").
- **QA:** with the provider stand-in (`server/test/mock-providers.mjs`), a message with "calendar", "qa-confirm" or "qa-delete" runs scripted steps (described in that file); "Write a message to Viktor …" (or "qa-draft") drafts one on a card, and "qa-open-build" opens Build with Viktor. To: Manus takes `qa-manus-page`, `qa-manus-image`, `qa-manus-question` and `qa-manus-progress`; To: Viktor takes `qa-viktor-file`, `qa-viktor-page`, `qa-viktor-edit`, `qa-viktor-delete`, `qa-viktor-slow`, `qa-viktor-toplevel` and the Slack markers (`qa-slack-timeout`, `qa-slack-fail`…).

## Strategy: research and a plan

**Strategy** (in the sidebar under Dashboard) writes how this project gets clients and makes sales. Fill in **Your details** (goal, budget, time each week, competitors, what you've tried: all optional, your own words), then **Plan my strategy** runs six steps, each one AI request saved as soon as it's done: Research, Where to promote, Social content, Assets to create (with the SEO page's direction), Email outreach and a 4-week Plan. Before anything starts, the app says which key writes it, with which model, and what it costs; with the built-in engine (no key, or the server isn't running) it's free and starts right away, except that it asks first before it replaces anything an AI wrote.

- **Cost:** 6 requests per full run; only the first step searches the web, up to 3, 5 or 8 searches (you choose). List prices per 1,000 searches: Anthropic $10, OpenAI $10, xAI $5, Meta $2.50; OpenRouter reports the exact cost. "Refresh this section" is 1 request, "Search again" 1, "Update the plan from the research" 5. Each step is a separate generation in "Made with AI" and in the Brain's activity log.
- **Which keys search:** the research step goes to the first key that powers Strategy and can search (Anthropic, OpenAI, xAI, Meta, OpenRouter); the other steps go to the first key that powers Strategy. Google keys don't search for Strategy in v1: Google's grounding terms limit storing and reusing search results, and Strategy saves its research and builds on it. In claude.ai there's no web search, so research is Claude's general knowledge.
- **Labels and sources:** every point says what it rests on: **From the web** (with its numbered sources, each linking to the page as found, with the date), **AI's general knowledge** (no search behind it) or **Built-in guidance** (the app's starter notes). The app keeps a source only when the URL the AI cites is one the search really returned; unsourced numbers and predictions are dropped, and outreach emails and SEO guidance lose invented claims, emails, phone numbers and any link but one to your own website or published page. The plan says what to measure, never a predicted result.
- **No automatic retries:** a run stops at the first failure (daily limit, timeout, a reply that isn't valid JSON or has nothing the app can use); the steps before it stay saved and **Continue** (paid, after a confirm) picks it up. If a request couldn't reach your server, the app asks the server again before deciding, and Continue never finishes an AI's run with the built-in engine. Stop works the same way. You can use other pages while it runs; closing or reloading the tab, opening the app in another tab or logging out stops it.
- **Guide my other tabs** (Plan tab), each only after a preview: a Brain skill for this project's social posts and one for its email funnel (Brain → Skills, where you can edit, turn off or delete them; Strategy shows "Changed in your Brain" after your edits), a block in the SEO page's "Guide the AI" box (edit or delete it there), the goal, networks, post mix and videos in Social → Campaign setup, and where the page link goes on each network. The last two have **Undo**. **Build this page** opens the SEO page builder with the recommended type; nothing is written until you press Write page. "Use my Brain skills here" turns the Brain on or off for Strategy only.
- **Deep research with Manus** (optional, self-hosted only): Manus gets your niche, your business or product type and your city (nothing else), opens up to 15 public pages and reports what each says, with its link. It takes several minutes and uses Manus credits; the app checks the task every 45 seconds and never starts or retries it by itself.
- **Data:** the strategy lives in the project (synced, backed up and deleted with it). If two devices change the same project at once, the last one to save wins.
- **After updating the app, restart the AI server** (`npm run server`): an older server ignores web research, and Strategy then says the key can't search.

## Accounts: sign-up, sign-in and saving to your account (Supabase)

With Supabase connected, people sign in with an email and password. Each person's projects, posts, skills, listings, orders and files are saved to their own account and open on any device. Without the Supabase Secrets, the app works as before and keeps everything in the browser.

Set it up once:
1. Create a Supabase project (supabase.com → New project).
2. Supabase → **SQL Editor** → paste and **Run** each file in [`supabase/migrations`](supabase/migrations), oldest first. If your Supabase project is linked to this GitHub repository, it can apply the migration for you. It creates:
   - `user_docs`: one row per project, post, listing, etc.; each user can only read and change their own rows.
   - a private `media` bucket: each user can only use their own folder.
   - `user_secrets`: each user's own AI keys (OpenAI, Anthropic, Google, xAI, OpenRouter, Meta, Manus), encrypted by the server. Browsers can't read or write it at all.
   - `app_state`: the server's own settings (your AI keys and their settings, the daily limits, the Manus task list, the usage log) and each person's Omnisend connection, encrypted. Browsers can't reach it either.
   - `ai_usage_daily` and the `ylb_add_ai_usage` function (`20261103030000_ai_usage_daily.sql`): each user's AI requests and dollars per day (UTC), for the daily limits. Server-only, like `user_secrets`. **Already set up before this version? Run this one file**: it also lets `user_secrets` hold keys for every provider, not just Manus. Until it's run, the counters live in the server's memory (they reset when it restarts) and only Manus keys can be saved.
   - `published_pages` and `published_domains` (`20261103040000_published_pages.sql`): published pages and people's own domains (see "Publishing pages"). Server-only.
   - `page_leads` (`20261103050000_page_leads.sql`): what visitors send with a published page's form. Server-only.
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
  - **Daily limits:** each signed-in person (not the owner) gets, by default, 50 requests and $1 a day on your keys (writing, photos and videos), counted per UTC day. Over the limit they get "You've reached today's limit on the app's AI keys… It resets at midnight UTC" and a pointer to add their own keys. A request counts once it reaches a provider, and requests running at the same time count against each other, so parallel requests can't slip past a limit. Its cost is added when known; a video's estimated cost (price per second × length, or $0.05 a second when the price list doesn't say) counts as soon as it starts, so a video that alone would go over the dollar limit is refused, and is corrected to the real cost when the job finishes (the server checks on it even if nobody asks). A web research request (Strategy's research step) that is stopped, times out or fails after it reached the provider counts its estimate, because its searches may already be billed, and the usage log shows it with an estimated cost. One the provider turned away before starting adds no dollars. If Supabase can't be read for a moment, the last count read is used, and someone not counted yet is asked to try again in a minute. Change or turn off either limit (0 = no limit) with `PUT /api/ai/limits` (owner only). The owner is never limited.
  - **Their own keys:** anyone can add their own OpenAI, Anthropic, Google, xAI, OpenRouter, Meta or Manus key in Settings → AI. Each key is checked with the provider for free first (it lists the account's models), encrypted, and shown only by its last 4 characters. Their writing, photos and videos then run on their own key whenever it can do that kind of work (with that provider's default model and effort), never on yours and never limited; only what their keys can't do falls back to your keys, within the limits. A failing own key doesn't fall back to yours.
  - **Usage:** each person sees today's counts and the last 7 days (`GET /api/ai/my-usage`, own-key requests counted apart); the owner sees everyone's per day with their email (`GET /api/ai/usage/users?days=7`).
  - Video jobs and Manus tasks belong to whoever started them.
  - **Manus is yours alone.** It's an agent with its own browser, signed in to your accounts (Facebook, Instagram…), so only the owner can give your Manus key a task.
  - **Everyone else can use their own Manus.** Settings → AI → "Use your own Manus" links to manus.im and explains how to create an API key (Manus → Settings → Developers (API keys) → Create API Key).
    - The key is checked with Manus, encrypted on the server (AES-256-GCM, from `USER_KEYS_SECRET` if set, otherwise from the secret key) and kept in `user_secrets`.
    - The app only ever shows its last 4 characters.
    - Their Manus photos and social posts then run in their own Manus account, on their credits.
- **A separate AI server:** if the app and the AI server run at different addresses (Settings → AI → Advanced), the sign-in is only sent to that server after you press **Test connection** there. This is remembered per account on that device and forgotten at Log out, so a half-typed address, or one from an imported backup, never receives it.
- **One tab at a time:** an account works in one tab per browser. Opening it in a second tab moves it there; the first tab offers "Use it here".
- **Optional sign-in:** `SIGN_IN_REQUIRED=false` makes signing in optional. "Continue without an account" keeps work in that browser, and AI then works without signing in. Signed-out visitors get the same daily limits, counted per network address in the server's memory (behind a proxy they share one count), so signing out never lifts a limit.

## SEO page: page types, guide, edit, images, publish

Marketing → SEO page.
- **Page type**: pick a lead form page, booking page, website, landing page, showcase page or checkout page before you press **Write page**. **Page type → Change** rewrites the page for another type and keeps your metadata, testimonials and facts, prices, services, contact details and images (sections the new type doesn't use stay, hidden). Undo takes it back. The Strategy tab can open the builder with a type chosen; nothing is written until you press Write page.
- **What each type has**: a lead form page has a short pitch and a form; a booking page lists your services (with durations and prices when you set them) and Book now opens your own booking link (Calendly, Square, Acuity…), or, without one, a "Request a time" form; a website has a top menu (Home, Services, About, Contact, plus Gallery and FAQ when they have content); a showcase lists what you sell with prices or "Ask for a quote", photos and a button for each (book, buy or ask); a checkout page shows one offer and Buy now opens your own payment link (Stripe, Square, PayPal, Gumroad, Shopify…), which the builder asks for first. The app never takes payments. Links you type in the builder are for this page; otherwise your listing's link is used when it fits.
- **Forms**: published, a page's form posts to `/<name>/lead` and what people send shows in Email → Leads. In the editor's preview and in Copy/Export HTML before publishing, the form shows but can't send ("Publish this page to collect leads"); once published, the exported HTML posts to the published page.
- **Guide the AI**: what the page should stress, who it's for, how it should sound. It's saved with the project and used each time the AI writes the page (Write page, Rewrite page) or its metadata. The AI's rules come first: whatever the guidance asks, it never writes testimonials, ratings, numbers, guarantees or prices; you add your real ones on the page.
- **Images**: add up to 8 in "Guide the AI" (or paste or drop them on its text box), each with an optional note. The AI puts one beside the headline and the others in a photo gallery (added after the solution, services or About section), and writes alt text and captions from what it can see or your note. The built-in engine can't see images: it puts the first one beside the headline and the rest in the gallery. Images not on the page yet are listed with **Add to the page**; removing an image from the list takes it off the page. In Edit, each image has its alt text and a Remove button. Only image files you add are used (JPEG, PNG, WebP or GIF), never addresses.
- **Edit with AI** (above the page): say what to change, for the whole page or one section, optionally with new images. It starts from the page as it is: sections keep their ids, order and visibility, your facts stay as they are, the look (font, light or dark, corners) changes only when you ask, and if the AI can't answer nothing changes. In Sections, **Rewrite with AI** also takes an optional request.
- **Undo** takes back the last AI change (up to 15; kept while the app is open, not saved).
- **Copy HTML** and **Export HTML** put the images inside the file. The HTML source view shows them as `{{img-1}}`.
- **Public page** (beside the score): publish the page at `https://<your app>/<name>`, and on your own domain (see below). The name starts as the page's URL slug. The published page's canonical address and `og:url` are where it's published, unless you pasted a canonical address of your own; its main image is the link-preview image (`og:image`, `twitter:image`) and the schema's `image`.
- **Build with Manus or Viktor** (self-hosted only): below **Write page** ("or build it with"), and as **Rebuild with Manus / Viktor** under Rewrite page, the same window as in Code & assets builds the page for the type you pick, from your website, your words, your images and your facts (a checkout page needs your payment link first). Its fixed rules for an SEO page add: real text a search engine can read, one H1 and clear H2s, no JavaScript at all, buttons that open only your own booking or payment link, and at most one form, which the app makes post to Email → Leads. Follow it, preview it and ask for changes on its card, as for an asset. **Use as my SEO page** puts the page in **HTML mode**: it's the page that's shown, scored (from its HTML) and published, at the **same address** as before, with the app's own head (your metadata, canonical, share image, and JSON-LD from your own facts: never offers, prices or ratings from their page). It runs without scripts; its form (only name, email, phone, message and time fields; the others are taken out) posts to `/<name>/lead`. When the project had no metadata yet, it's made from the page's title and description (no AI; Regenerate in Metadata writes it with the AI). A standing note asks you to check every claim, price and testimonial before you publish: the app can't check free HTML. **Version** switches between the app's builder and their page (the builder's page is kept); **Remove** takes their page away; Undo takes back each of these. Nothing is published by itself: press Update under Public page.

## Publishing pages

Signed-in people can publish their SEO page and each artifact at a public address they name, `https://<your app>/<name>`, and also show it on a domain of their own (`https://their-domain.com/<name>`, or as that domain's home page). The server keeps a copy of each published page and its images; the live page changes only when they publish again.

Set it up once:
1. Accounts on, with the `SUPABASE_SECRET_KEY` Secret (see above).
2. Supabase → SQL Editor → run `supabase/migrations/20261103040000_published_pages.sql`. Until then, publishing says which file to run. It's safe to run again, and worth doing after updating the app: it now also makes the database refuse a page on a domain its account doesn't have (see "Own domains"), and adds the indexes the server reads recent changes with.
3. **If the app itself also runs on a custom domain** (not only its `*.replit.app` address), list that domain in the `APP_HOSTS` Secret, comma-separated (for example `app.mybiz.com,www.mybiz.com`). Without it, that domain shows "Page not found" instead of the app. When the server starts, its log says which hosts the app answers on, and when a browser opens a host that's on neither list, the log says that too (at most once every 10 minutes).

What answers where:
- **The app's own hosts**, a fixed list: `*.replit.app`, `*.replit.dev`, `*.repl.co`, `localhost`, IP addresses, the host of `ALLOWED_ORIGIN`, the hosts in `APP_HOSTS`, and names that are never a public domain (a single name like `my-machine`, `*.local`, `*.internal`, `*.home.arpa`). The app, `/api` and the published pages at `/<name>` (sandboxed, see Security) answer there. Nobody can add these as their own domain.
- **Every other host**: only the published pages of a verified domain (`/` for its home page, `/<name>`, their images, `robots.txt` and `sitemap.xml`). Any other host gets a plain "Page not found" page (503 when the server can't tell right now), whether or not publishing is on, whatever the database holds, and even when it's a name nobody could add as a domain. It never gets the app or `/api`.

Own domains:
1. The person adds the domain in Settings → Domains. The card shows the TXT record to add at their domain registrar, each part with a Copy button:
   - name `_ylb-domain.<domain>`
   - value the account's own code for that domain (`ylb-…`)
   The record shows the domain is theirs.
2. The app's owner links the domain to the deployment in Replit: Deployments → Settings → Link a domain. The person adds the records Replit shows as well (Cloudflare: DNS only, not proxied).
3. Back in Settings → Domains, **Check again**: the server looks the TXT record up in the DNS. It never asks the domain itself, which could be this same server answering. Once the record is there, the domain shows the person's pages.

Good to know:
- **The record has to stay.** The server looks at it again every 6 hours (in the background, when the domain gets a visit). Once it's gone, the domain stops showing pages until it's back and checked again. If the DNS doesn't answer, nothing changes and it tries again later.
- **A domain is whoever's TXT record it has.** If another account added it first, adding it shows a record with your own value. Once that record is in the DNS, **Check again** moves the domain to your account in one step. The other account's pages come off the domain first (its home page included) and stay published at their app address.
- **Only the owner's pages are ever on a domain.** The database refuses a page on a domain its account doesn't have, so a publish of the previous owner's that was still under way when the domain changed hands is refused, and a domain changes hands only once the previous owner's pages are off it. A publish also checks again, just before it's saved, that the domain is still the account's. And whenever the owner publishes to the domain or presses **Check again**, anything of another account's still on it comes off (for a database where the migration hasn't been run again yet).
- **Domains checked before TXT records** (the old check asked the domain itself) show "Not verified yet" until their TXT record is added and checked.
- `PAGES_DNS_SERVERS` (optional): the DNS servers the check asks, comma-separated, like `1.1.1.1,8.8.8.8` (default: the system's).

Visitors' lookups:
- **Only real names are looked up.** Each copy of the server keeps the names of the published pages and the verified domains in memory: the whole list every 10 minutes, and in between what changed, read when someone asks for a name it doesn't know (at most once a second). Any other name, or any other host, gets "Page not found" with no database lookup, so made-up names cost nothing however many addresses they come from. A page published, or a domain verified, through another copy of the server shows up within about a second. (With more than 100,000 names, they aren't kept, and each name is looked up within the limits below.)
- Published pages and domains are cached for 30 and 60 seconds. A page's HTML is kept apart from its row, up to 64 MB in all, least recently used out first; pages over 256 KB have 32 MB of their own, so a few big pages can't push the others out. When a page's row is read again, it's read without the HTML, and the HTML is read again only if the page changed. A `HEAD` request never needs the HTML.
- Lookups that miss the cache are limited per minute, per client and in all: pages to 120 per client and 1,200 in all, and to 20 MB and 200 MB of what they bring from Supabase; domains to 60 and 600; images to 240 and 1,200, and 60 MB and 300 MB. A stored image is never read past the size it was published with (the owner can replace the file in their folder, but only the file that was checked is shown).
- **A client is the address the platform's proxies saw it connect from.** Proxies add addresses at the end of `X-Forwarded-For`, after anything the client sent itself, so the server counts from the right: the address `TRUSTED_PROXY_HOPS` from the end (default 2, which is right for Replit's Autoscale: Google's front end adds the client's address, then its own). Use 1 behind a proxy that adds only the client's address, or 0 to use the connection's own address when nothing is in front of the server. The startup log says which address it uses, and the log says so when a visitor uses up its lookups; if every visitor shows up as the same address, the setting is too low.
- If Supabase fails, the last answer is used for up to twice its cache time, and never because a limit ran out (so a page taken down elsewhere stops showing).

Security: published pages are other people's HTML and scripts, served from the app's own address, where the app keeps its sign-in. So on the app's address every page is sent with a `Content-Security-Policy: sandbox` header that never allows the app's origin: the page can't read the sign-in or use the API as the visitor, and SEO pages can't run scripts at all. Images are served only when they're listed with their page and are still the exact files checked when it was published (JPEG, PNG, WebP or GIF; never SVG). Each publish stores its images in a new folder, and the page moves to them only once it's saved (a publish that fails removes them, unless the page was saved after all and its answer got lost). Nothing is stored for an account that no longer exists: once someone deletes their account, the server that deleted it stops taking their sign-in, and every copy of the server checks with Supabase that the account is still there before it stores anything. On a person's own domain, pages run unsandboxed on that domain's own origin. That's why the app never answers there, and why a domain needs its TXT record.

Names are 3 to 60 lower-case letters, numbers and hyphens, and some stay the app's own (`server/pages.mjs` `RESERVED_SLUGS`, plus every top-level name in `dist/`), including `market`, `pricing`, `plans`, `unsubscribe`, `offers`, `thank-you`, `thanks`, `download`, `store`, `listings`, `cron` and `webhooks` for routes to come. The app's short public routes `/b/…` (buy links), `/m/…` (lead magnet downloads) and `/o/…` (opt-outs) can never be a page: a name has at least 3 characters, and those prefixes are checked before any page.

API (signed in, same site only): `GET /api/pages`, `GET /api/pages/check?slug=&pageId=`, `PUT` and `DELETE /api/pages/<pageId>`, `POST /api/domains`, `POST /api/domains/<domain>/check`, `DELETE /api/domains/<domain>`, `GET /api/leads?before=&limit=&pageId=`, `DELETE /api/leads/<id>`. Public: `POST /<name>/lead`.

Lead forms: a page with a form (a lead form page, a booking page's "Request a time", a showcase's questions, a website's contact form) posts to `/<name>/lead` on the app's address or the owner's domain. Set it up once: also run `supabase/migrations/20261103050000_page_leads.sql` in Supabase → SQL Editor. Until then, forms answer that the message wasn't sent, and Email → Leads names the file.
- The server keeps the name, email, phone, preferred time and message (table `page_leads`, server-only), needs an email or a phone, refuses anything over its length limit (never cuts it), and answers with a short thank-you page (no app name, strict CSP) that links back. Only a page published with a form that posts to its own `/<name>/lead` takes leads; on a domain, only that domain's pages.
- A hidden field catches most bots, and there are limits per visitor and per page (`LEADS_PER_IP_PER_HOUR`, default 10; `LEADS_PER_PAGE_PER_HOUR`, default 30), kept in the server's memory. Behind a proxy on a private network, visitors are told apart by the address it forwards (IPv6 by its /64); otherwise they share one count, and the per-page limit is the main guard.
- Every input is bounded before it's checked, and nothing a visitor typed, nor their email or address, goes into the server's log.
- Owners see leads in Marketing Hub → Email → Leads: add one to subscribers, delete it or export a CSV. The bell says when new ones arrive.

## Omnisend: campaign drafts from the email sequence

Each signed-in person can connect their own Omnisend brand in Marketing Hub → Email → Preview & export, then press **Create Omnisend draft** on an email. The app only creates drafts: an email template and a campaign draft in their Omnisend, with the subject, preview text, body and button the preview shows. It never sends; they review and send in Omnisend. Values in [brackets] (such as [First name]) are filled in there before sending.

Set it up once (the owner):
1. Ask Omnisend for OAuth app credentials with their developer form (https://forms.gle/axz6ychcELUuPrR28; the answer takes 1–3 business days). Register this exact redirect URI: `https://yourlocalbusiness.replit.app/api/integrations/omnisend/callback`. The scopes are `campaigns.write` and `email-templates.write`.
2. Replit → Tools → **Secrets**: add `OMNISEND_CLIENT_ID` and `OMNISEND_CLIENT_SECRET`. Don't paste them anywhere else: not in the app, a chat, a file or a commit. The server keeps them, and the browser never sees them.
3. It needs accounts and `SUPABASE_SECRET_KEY` (see "Accounts"), and the `app_state` table: run `supabase/migrations/20261103010000_app_state.sql` in Supabase → SQL Editor if it isn't there yet. Each person's connection is kept there, encrypted.
4. Republish. Until then, the owner sees these steps in the Omnisend card, and everyone else sees "Omnisend isn't set up on this app yet."

How it behaves:
- **Connecting only works on the published app** (`https://yourlocalbusiness.replit.app`): Connect starts only from there, and Omnisend sends people back to that one redirect URI. The return is tied to the browser that pressed Connect by a `__Host-` cookie (Secure, HttpOnly, SameSite=Lax, 10 minutes), so a sign-in link someone else made can't attach your Omnisend to their account. The cookie and the `state` are signed with a key derived from `OMNISEND_CLIENT_SECRET`, so a callback with a made-up cookie or state is turned away without any database read (changing the secret only cancels connections started in the last 10 minutes). So on `http://localhost` (or the workspace preview) the card links to the published app instead; there, `npm test` runs the whole flow, cookie included, against the real server with a stand-in Omnisend (`server/omnisend.test.mjs`, `server/test/mock-omnisend.mjs`), and never calls Omnisend.
- Disconnect forgets the connection in the app; to revoke it completely, also remove the app in Omnisend. When Omnisend no longer accepts a connection, the card says so and offers Connect again.
- A draft that Omnisend didn't confirm (a timeout, a lost connection, an error on its side) "may have been created": check Omnisend before trying again. Nothing is ever sent twice by itself.
- Deleting an account deletes its Omnisend connection too. If the deletion itself then fails, the account keeps working and can connect Omnisend again right away. While Omnisend isn't set up (no credentials), account deletion never waits on it.
- Limits: connecting and drafts per person, the callback per address (`RATE_LIMIT_PER_MIN`).

API (signed in, same site only): `GET /api/integrations/omnisend/status`, `POST /api/integrations/omnisend/connect`, `DELETE /api/integrations/omnisend/connection`, `POST /api/integrations/omnisend/campaign-drafts`. Public: `GET /api/integrations/omnisend/callback` (Omnisend's redirect).

## Connected accounts, posting, analytics and usage

Full owner setup, every Secret and the four database migrations: [docs/integrations-setup.md](docs/integrations-setup.md) (launching and changing ads: its §3c). In short:

- **Upload-Post** (Advanced plan, billed yearly; white-label) holds customers' social accounts on its own approved platform apps: **one Upload-Post profile per business** (each project in the app connects its own Facebook Page, Instagram, TikTok, X, YouTube and LinkedIn; a profile holds one account per network), made on the first Connect for that business and named `ylb_` + the customer's opaque id + `_` + a keyed hash of the business (stored once; never an email, user id or project id), the hosted white-label connect page, posting to Facebook, Instagram, LinkedIn, TikTok, X and YouTube, post status and each business's own social stats. Owner steps: put the API key in Replit Secrets as `UPLOAD_POST_API_KEY`; add the webhook `https://yourlocalbusiness.replit.app/api/webhooks/upload-post` and copy its `whsec_…` secret into `UPLOAD_POST_WEBHOOK_SECRET`; set `MEDIA_URL_SECRET`; optionally brand the connect page (`UPLOAD_POST_BRAND_LOGO_URL`, `UPLOAD_POST_CONNECT_TITLE`, `UPLOAD_POST_CONNECT_DESCRIPTION`, `UPLOAD_POST_BACK_BUTTON_TEXT`; the back button goes to `GSC_APP_PROPERTY`'s host). Everything goes through `server/uploadpost.mjs`; a post is sent once through its business's profile (the job id as `request_id` and Idempotency-Key), and "Check again" only reads its status. Limits: 75 profiles on the plan, one per business with social accounts (add-ons: +25 for $65 a month or +50 for $115 a month, and they don't stack), at most `UPLOAD_POST_MAX_PROFILES_PER_USER` businesses per user (default 3, raise it for everyone; a profile whose delete hasn't gone through still counts), a few new profiles per user a day within `UPLOAD_POST_NEW_PROFILES_PER_DAY` for everyone, 200 calls a minute plus 2 per profile, each network's daily cap per account, and an X Links allowance (50 link posts a month) shared by all customers. Deleting a business disconnects its accounts and frees its profile (the confirm, and a backup import's confirm, say which); deleting an account deletes all of its profiles; a profile deleted by hand at Upload-Post stops holding its slot and being billed. Customers see Upload-Post's name on the hosted sign-in page and on the network's permission screen; team-level problems (key, profile cap, plan) reach them only as "temporarily unavailable" and reach you on Customer usage. Facebook groups stay with Manus.
- **Zernio** (formerly Late) is kept for ads only: customers' ad accounts on Meta, Google, LinkedIn, TikTok, Pinterest, Reddit and Microsoft (X Ads coming soon) and their ad results, plus launching and changing Meta and Google Search campaigns from the Ads planner (off until `ADS_LAUNCH_ENABLED=1` and the owner turns ads on per customer in Owner → Billing → Ad limits; every write sent once after a spend confirm, see docs §3c). Owner steps: put the API key in Replit Secrets as `ZERNIO_API_KEY`; choose a webhook secret (`ZERNIO_WEBHOOK_SECRET`); add the webhook `https://yourlocalbusiness.replit.app/api/webhooks/zernio` with that secret; optionally brand the ads connect screen (`ZERNIO_BRAND_NAME`, `ZERNIO_BRAND_LOGO_URL`, `ZERNIO_BRAND_COLOR`). Everything goes through `server/zernio.mjs`.
- **treg** stays for public data, competitor ads, Google rank, per-customer usage, caps and billing (`TREG_TOKEN`, `TREG_ADMIN_TOKEN`, `TREG_ORG_ID`), and **Search Console** on your own team connection: the app's address is one URL-prefix property (`GSC_APP_PROPERTY`), and each customer's own domain is added to your Search Console as a Domain property that you verify with a DNS TXT record.
- **Omnisend** stays for email stats and drafts (above).
- **Nango** stays in the code for future booking tools and CRMs only: off until `NANGO_SECRET_KEY` is set, nothing shown until `NANGO_INTEGRATIONS` lists one, and never used for social or ads.
- **Manus** only posts to Facebook groups.

Works immediately, before any key: manual posting (Post it yourself, then Mark as posted), Facebook groups through Manus, public social stats, competitor ads and Google rank through treg, Search Console for pages on the app's address, and per-customer usage. With `UPLOAD_POST_API_KEY`, `UPLOAD_POST_WEBHOOK_SECRET` and `MEDIA_URL_SECRET` set, customers connect their social accounts in Settings → Connected accounts → Social accounts and post from the app; with `ZERNIO_API_KEY` and `ZERNIO_WEBHOOK_SECRET`, they connect ad accounts under Ad accounts. Each side works without the other, and no network approvals are needed. Until a side's Secrets are set, the owner sees the missing names and the webhook address to register on that screen.

Tests use stand-ins only (no live calls): `node server/test/mock-uploadpost.mjs` prints a mock Upload-Post base URL (use it as `UPLOAD_POST_BASE_URL`), `node server/test/mock-zernio.mjs` a mock Zernio ads base URL (`ZERNIO_BASE_URL`), and `server/test/mock-nango.mjs`, `mock-treg.mjs`, `mock-omnisend.mjs` do the same for the others. `node server/test/mock-stripe.mjs` prints a mock Stripe API base (customers, prices by `lookup_key`, Checkout, subscriptions with quantities, the billing portal, signed webhooks with valid `Stripe-Signature` headers, and Connect accounts) for the paid plans and seller payments to come; the owner's steps before them (Stripe Sandbox key in the workspace Secrets, Google `gmail.send` and Microsoft publisher verification, the Stripe Connect platform profile) are in `docs/integrations-setup.md` §9.

## Plans and billing

Launch ($97/month), Grow ($197) and Scale ($397), yearly at ten months' price, each with one business and $97/month
per extra business; every price and limit is in `shared/plans.json`. Customers pay through Stripe Checkout and
manage their card, invoices and cancelling in the Stripe Customer Portal; adding or removing businesses and changing
plans happen in the app, each sent to Stripe once (`server/billing/stripe.mjs`). Plans gate AI credits on the app's
keys (own keys never count), video length, launching ads (Grow and up), the treg budget, businesses with social
accounts, and paid actions while a payment is overdue. Nothing is enforced until the owner turns plans on; existing
accounts then get 30 days of Grow free. The owner's account is the unlimited owner plan. Billing is off in the
claude.ai artifact build.

In the app: the public `#plans` page (monthly / annual with the saving, the three cards, a comparison table, the FAQ;
Start → create an account → Stripe Checkout → back to the app), Settings › Plan (plan, credits, businesses used of
allowed, Add a business with the price confirmed, Remove one at renewal, Manage billing in the Portal), a slot claimed
before every new business (a full plan offers Add a business; a business the account refused stays on the device
with a note), plan banners and one upgrade prompt for refused paid actions (`src/lib/plans.ts`, `src/store/billing.ts`,
`src/lib/cloud/slots.ts`, `src/pages/plans/`, `src/components/billing/`).

Owner steps (all in [docs/integrations-setup.md](docs/integrations-setup.md) §10; Stripe Sandbox first, live only
with your OK): run
`supabase/migrations/20261110000000_billing.sql`; set `STRIPE_SECRET_KEY` (restricted live key in production),
`STRIPE_WEBHOOK_SECRET` and `APP_URL`; add the webhook `https://yourlocalbusiness.replit.app/api/webhooks/stripe`; run
`npm run stripe:setup` (a dry run; then `--apply`; `--live` only with your OK); set up the Customer Portal (quantity
editing off) and Smart Retries; optionally Stripe Tax (`STRIPE_AUTOMATIC_TAX=1`); then Owner → Billing → Plans → Turn on plans. Turning plans off again is the rollback.
Tests use `server/test/mock-stripe.mjs` and `server/test/mock-supabase.mjs` only.

## Scheduled jobs

Replit Autoscale stops the app when it's idle, so nothing runs on a timer inside it. Supabase's pg_cron calls
`POST /api/cron/tick` every hour (with `Authorization: Bearer <CRON_SECRET>`), and the tick runs whatever is due:
the treg settle, Upload-Post's and Zernio's monthly metering, Upload-Post's daily check and the stuck-job sweeps
(`server/cron/`). Each job runs at most once per period behind a claim in `app_state`, a tick answers within 40 s
with a JSON summary, and a failed job waits for its next period. Owner steps: put a random `CRON_SECRET` in Replit
Secrets, store the same value as the Supabase Vault secret `cron_secret`, then run
`supabase/migrations/20261109000000_cron_tick.sql` (see `docs/integrations-setup.md` §2a). Local dev needs none of
it: without `CRON_SECRET`, outside a Replit deployment, the server ticks itself every minute.

Each business has its own time zone (Settings → Brand → Business details), the browser's by default; scheduled
features use it for the business's local time.

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
- `AI_PROVIDER_BASE_URLS`: a JSON map of provider id to base URL, for a proxy or the test mock (`slack` is Slack's Web API, for the stand-in Slack)
- `SLACK_USER_TOKEN`: the User OAuth Token of your own Slack app, so the app can talk to Viktor (see "Manus and Viktor (Slack): setup")
- `LEADS_PER_IP_PER_HOUR` (default 10) and `LEADS_PER_PAGE_PER_HOUR` (default 30): lead form limits (see "Publishing pages")
- accounts: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `ADMIN_EMAILS`, `SIGN_IN_REQUIRED` (see "Accounts")
- `APP_HOSTS`: the app's own custom domains, comma-separated. The app and `/api` answer only on the app's own hosts (see "Publishing pages")
- `PAGES_DNS_SERVERS` (optional): the DNS servers the domain check asks (see "Publishing pages")
- `TRUSTED_PROXY_HOPS` (optional, default 2): how many `X-Forwarded-For` addresses the platform's proxies add at its end, so visitors are told apart by the address they connected from (see "Publishing pages")
- `OMNISEND_CLIENT_ID` and `OMNISEND_CLIENT_SECRET`: the OAuth credentials Omnisend issues (see "Omnisend: campaign drafts from the email sequence")
- `CRON_SECRET`: the bearer for `POST /api/cron/tick`, which runs the scheduled jobs; the same value goes in the Supabase Vault secret `cron_secret` (see "Scheduled jobs"). `CRON_BUDGET_MS` (default 40000) is one tick's time budget

`GET /api/config` tells the app whether accounts are on and whether it can publish pages, and `DELETE /api/account` deletes the signed-in user, with their saved workspace, files, published pages and leads.

`GET /api/health` returns `{ ok, ai }`, where `ai` lists each key's readiness, model and effort, which keys power each function, and `ai.agents`: whether Manus can build and chat and whether Viktor is set up (with the reason when not; Viktor shows as `owner_only` to anyone but the owner).

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
- what visitors send with a page's form is a row in `page_leads` (server-only) until the owner deletes it;
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
  pages/         onboarding, dashboard, strategy, studio, marketing (seo/email/social/ads), calendar, analytics, store, brain, settings
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
npm test                    # includes the real server against the provider mock; the HTML importer's tests run in happy-dom (a dev dependency)
node server/test/mock-providers.mjs 9911   # offline QA: prints the AI_PROVIDER_BASE_URLS to start the server with
node server/test/mock-supabase.mjs 54321   # offline accounts QA: use its url and keys as SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY
```
