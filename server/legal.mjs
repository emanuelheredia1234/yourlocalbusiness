// Public Privacy Policy and Terms of Service. These are real HTML documents, not the app shell:
// Google’s OAuth review fetches the URL and must see the text in the response. No sign-in.
//
//   GET /privacy                 the privacy policy
//   GET /terms                   the terms of service
//   GET /privacy-policy          301 → /privacy
//   GET /terms-of-service        301 → /terms
//   the same paths with a trailing slash also redirect to the canonical path
//
// Served only on the app’s own host (ai-server.mjs calls this before the SPA fallback). A customer’s
// own domain never gets these pages.

export const LEGAL_ORIGIN = 'https://yourlocalbusiness.replit.app';
export const PRIVACY_PATH = '/privacy';
export const TERMS_PATH = '/terms';
export const PRIVACY_URL = `${LEGAL_ORIGIN}${PRIVACY_PATH}`;
export const TERMS_URL = `${LEGAL_ORIGIN}${TERMS_PATH}`;
export const LEGAL_UPDATED = 'November 6, 2026';
export const LEGAL_UPDATED_ISO = '2026-11-06';
export const OPERATOR_NAME = 'Hector Heredia';
export const OPERATOR_EMAIL = 'hectorheredia242@gmail.com';

const ALIASES = Object.freeze({
  '/privacy-policy': PRIVACY_PATH,
  '/terms-of-service': TERMS_PATH,
  '/privacy/': PRIVACY_PATH,
  '/terms/': TERMS_PATH,
  '/privacy-policy/': PRIVACY_PATH,
  '/terms-of-service/': TERMS_PATH,
});

// content-security-policy is required, not decorative: the dev server (vite.config.ts) only keeps a
// response from the app server when it carries a CSP. Without it, /privacy would fall through to the SPA shell.
const COMMON_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
});

/** Which legal response a path is, or null. { redirect } or { doc: 'privacy'|'terms' }. */
export function classifyLegal(pathname) {
  const path = String(pathname || '');
  if (ALIASES[path]) return { redirect: ALIASES[path] };
  if (path === PRIVACY_PATH) return { doc: 'privacy' };
  if (path === TERMS_PATH) return { doc: 'terms' };
  return null;
}

function esc(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const css = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #F3F3F6; color: #0F0F12; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 16.5px; line-height: 1.6; }
  a { color: #5A3AF7; }
  a:hover { color: #4D27DE; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 28px 20px 72px; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 12px 24px; margin-bottom: 20px; }
  .brand { color: #0F0F12; font-weight: 650; letter-spacing: -0.03em; text-decoration: none; font-size: 1.05rem; }
  nav { display: flex; gap: 16px; font-size: 0.92rem; }
  nav a[aria-current="page"] { color: #0F0F12; text-decoration: none; font-weight: 650; }
  article { background: #fff; border: 1px solid #E6E6E9; border-radius: 16px; padding: 32px 28px 12px; }
  h1 { font-size: 2rem; line-height: 1.15; letter-spacing: -0.035em; margin: 0 0 8px; }
  h2 { font-size: 1.15rem; line-height: 1.3; letter-spacing: -0.02em; margin: 1.7em 0 0.35em; }
  p, li { color: #3F3F46; }
  .meta { color: #6B6B73; margin: 0 0 1.2em; }
  ul { padding-left: 1.2em; }
  li { margin: 0.25em 0; }
  footer { margin-top: 22px; color: #6B6B73; font-size: 0.92rem; }
  @media (max-width: 640px) { article { padding: 24px 18px 8px; } h1 { font-size: 1.7rem; } }
`;

function layout({ doc, title, description, body }) {
  const path = doc === 'privacy' ? PRIVACY_PATH : TERMS_PATH;
  const url = `${LEGAL_ORIGIN}${path}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — Your Local Business</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${esc(url)}">
  <meta name="robots" content="index, follow">
  <style>${css}</style>
</head>
<body>
  <div class="wrap">
    <header>
      <a class="brand" href="/">Your Local Business</a>
      <nav aria-label="Legal">
        <a href="${PRIVACY_PATH}"${doc === 'privacy' ? ' aria-current="page"' : ''}>Privacy</a>
        <a href="${TERMS_PATH}"${doc === 'terms' ? ' aria-current="page"' : ''}>Terms</a>
      </nav>
    </header>
    <article>
      <h1>${esc(title)}</h1>
      <p class="meta">Last updated <time datetime="${LEGAL_UPDATED_ISO}">${esc(LEGAL_UPDATED)}</time></p>
      ${body}
    </article>
    <footer>
      <p>${esc(OPERATOR_NAME)} · <a href="mailto:${esc(OPERATOR_EMAIL)}">${esc(OPERATOR_EMAIL)}</a> · <a href="${LEGAL_ORIGIN}/">${esc(LEGAL_ORIGIN.replace(/^https:\/\//, ''))}</a></p>
    </footer>
  </div>
</body>
</html>
`;
}

function privacyBody() {
  return `
<p>This policy explains what Your Local Business does with information when you use the service at <a href="${LEGAL_ORIGIN}/">${esc(LEGAL_ORIGIN.replace(/^https:\/\//, ''))}</a>. Your Local Business is operated by ${esc(OPERATOR_NAME)}. The product is a workspace for local businesses: accounts, business profiles, pages, marketing drafts, and connections to services you choose (such as Gmail, email tools, social networks, and ad accounts).</p>
<p>The interface sometimes shows the name as one word, “Yourlocalbusiness.” It is the same service.</p>

<h2>Who this covers</h2>
<p>This policy covers people who create an account, and the businesses they add. It also covers anyone who emails us. It does not change the privacy terms of Google, Stripe, or any other service you connect. Those services have their own policies.</p>

<h2>Children</h2>
<p>Your Local Business is not for children under 13, and we do not knowingly collect personal information from them. If you believe a child under 13 has given us information, email <a href="mailto:${esc(OPERATOR_EMAIL)}">${esc(OPERATOR_EMAIL)}</a> and we will delete it.</p>

<h2>Information you give us</h2>
<ul>
  <li><strong>Account.</strong> An email address and a password. Sign-in is handled by our database host (Supabase). We do not keep a copy of your password in the product’s own documents. You may also set a name and other profile details.</li>
  <li><strong>Business content.</strong> What you type or upload for a business: names, brand details, offers, posts, pages, images, and similar material. That content is stored so the workspace can show it back to you and, when you ask, publish or send it.</li>
  <li><strong>Messages to us.</strong> If you email the operator, we keep that correspondence so we can reply.</li>
</ul>

<h2>Accounts you connect</h2>
<p>You can connect services so the product can act for that business. Each connection is stored for your account only, separate from other customers. The tokens and credentials needed to act for you are kept on the server in encrypted storage. The app does not show those secrets back to the browser.</p>
<ul>
  <li><strong>Gmail.</strong> If you connect Gmail, Google asks you to allow sending mail (<code>gmail.send</code>) and to share the mailbox address (OpenID and the email identity scope). We store the access token, the refresh token, when the access token expires, the granted scopes, and the mailbox address. We use them only to send mail you later start from the product, and to show you which mailbox is connected. We do not ask to read your inbox.</li>
  <li><strong>Omnisend.</strong> If you connect Omnisend, we store that connection so the product can create email drafts in your Omnisend account and read email statistics. The product does not send those campaigns for you.</li>
  <li><strong>Social accounts.</strong> Facebook, Instagram, LinkedIn, TikTok, X, and YouTube connections go through Upload-Post (TONVI TECH SL, Spain). Upload-Post holds the network login. We store which accounts are connected to which business so we can post after you confirm, and so we can show that business’s own stats.</li>
  <li><strong>Ad accounts.</strong> Meta, Google, LinkedIn, TikTok, Pinterest, Reddit, and Microsoft ad connections go through Zernio. We use them to read results and, when you confirm, to launch or change campaigns on your own ad account. Ad spend is billed by the ad network to you, not by us.</li>
  <li><strong>Other tools.</strong> A booking tool or CRM is connected only if the operator turns that option on. Gmail does not go through that option.</li>
</ul>
<p>You can disconnect a service in Settings → Connected accounts. Disconnecting deletes the tokens we hold and, where the provider allows it, asks the provider to revoke the grant. Deleting your account does the same.</p>

<h2>Payments</h2>
<p>Paid plans are processed by Stripe. Stripe collects your card. <strong>We do not store full card numbers.</strong> We keep what we need to run the plan: the plan name, status, renewal, business slots, and Stripe’s customer and subscription identifiers. For the free trial (one per person and card) we keep keyed hashes of the email address and the card’s fingerprint, never the address or the card. Receipts stay with Stripe.</p>

<h2>Usage and billing records</h2>
<p>We keep records of plan limits and of usage that the product meters (for example analytics calls, posts, and similar counts), tied to an opaque customer tag rather than putting your email in every row. Those records are how the product applies caps and how the operator can bill. They are not sold.</p>

<h2>What is sent when you use a feature</h2>
<ul>
  <li><strong>AI tools.</strong> Text, images, or other material you submit to a writing, image, video, or assistant feature is sent to the model provider configured for that feature, so it can return a result. Which provider is in use depends on the keys turned on for the app.</li>
  <li><strong>Posting and ads.</strong> When you confirm a post or an ad change, the content you confirmed is sent to the network, through the connector named above.</li>
  <li><strong>Pages and analytics.</strong> A page you publish is served to its visitors. To show rank, Maps, or Search Console numbers, we may send a page address or a public social handle to the data service the app uses for that lookup.</li>
</ul>

<h2>Why we use this information</h2>
<ul>
  <li>To run your account and show you your businesses.</li>
  <li>To do the thing you asked: draft, publish, connect, post, or prepare a send.</li>
  <li>To take payment, apply plan limits, and keep billing records.</li>
  <li>To protect the service: sign-in, rate limits, and checks that a connection you started is finished in the same browser.</li>
  <li>To answer you when you write to us.</li>
</ul>
<p>We do not sell personal information. We do not use your connected mailbox, social accounts, or ad accounts to advertise our own service to your customers.</p>

<h2>How long we keep it</h2>
<p>We keep account and business information while the account is active. Connected-account tokens are deleted when you disconnect that service or delete the account. On deletion we also delete the profile and the content stored for the account.</p>
<p>A few narrow leftovers can remain. Usage rows may keep the opaque customer tag, without your email, so a past invoice can still be matched. Stripe may keep its own receipts under Stripe’s terms. If you started a free trial, its record keeps a keyed hash of the email address and of the card you used (neither can be turned back into the address or the card), so the same email or card can’t start a second free trial. A Gmail or Omnisend grant is revoked at the provider when that call succeeds; if the provider is unreachable, the tokens are still deleted here, and you can also remove the app in the provider’s own settings.</p>

<h2>Who else receives information</h2>
<p>We use these providers to run the service. They receive only what that part of the product needs:</p>
<ul>
  <li><strong>Supabase</strong> — sign-in and the database, including encrypted storage of connection tokens.</li>
  <li><strong>Replit</strong> — hosting the application.</li>
  <li><strong>Stripe</strong> — payments. Stripe handles the card.</li>
  <li><strong>Google</strong> — only if you connect Gmail, or a Google ad account. Gmail access is the send scope and the mailbox address, not your inbox.</li>
  <li><strong>Upload-Post (TONVI TECH SL, Spain)</strong> — social account connections and posting.</li>
  <li><strong>Zernio</strong> — ad account connections and ad results.</li>
  <li><strong>Omnisend</strong> — only if you connect it.</li>
  <li><strong>The model provider turned on for an AI feature</strong> — the material you submit to that feature.</li>
</ul>
<p>We may also disclose information if the law requires it, or to prevent abuse of the service. We do not give customer lists to advertisers.</p>

<h2>Cookies and sign-in storage</h2>
<p>Signing in does not set an advertising cookie. The sign-in session is stored in this browser (local storage used by Supabase Auth) so you stay signed in. You can clear it by signing out or by clearing site data.</p>
<p>While you connect Gmail or Omnisend, the server sets a short-lived cookie on this host only (<code>__Host-ylb_gmail</code> or <code>__Host-ylb_omnisend</code>). It ties the provider’s return to the browser that started the connection. It lasts about ten minutes, is not readable by page scripts, and is removed when the connection finishes. It is not used to track you across other sites.</p>

<h2>Your choices</h2>
<ul>
  <li><strong>Access and correct.</strong> You can see and edit your businesses in the product. For a copy of the account data we hold, email us.</li>
  <li><strong>Disconnect.</strong> Settings → Connected accounts removes a Gmail, Omnisend, social, or ad connection and the tokens we stored for it.</li>
  <li><strong>Delete.</strong> Settings → Account deletes the account and the content and tokens we hold, aside from the leftovers described above.</li>
  <li><strong>Email.</strong> If you cannot sign in, email <a href="mailto:${esc(OPERATOR_EMAIL)}">${esc(OPERATOR_EMAIL)}</a> from the address on the account and say what you want done.</li>
</ul>
<p>If the law where you live gives you extra rights, write to that address and we will respond. There is no separate data-protection officer. ${esc(OPERATOR_NAME)} is the contact.</p>

<h2>Changes</h2>
<p>If this policy changes, the date at the top of this page changes. The page at <a href="${PRIVACY_URL}">${esc(PRIVACY_URL)}</a> is the current version.</p>

<h2>Contact</h2>
<p>${esc(OPERATOR_NAME)}<br><a href="mailto:${esc(OPERATOR_EMAIL)}">${esc(OPERATOR_EMAIL)}</a><br>Washington, USA. There is no street address on file; email is the way to reach the operator.</p>
`;
}

function termsBody() {
  return `
<p>These terms are the agreement between you and ${esc(OPERATOR_NAME)}, who operates Your Local Business at <a href="${LEGAL_ORIGIN}/">${esc(LEGAL_ORIGIN.replace(/^https:\/\//, ''))}</a>. By creating an account or using the service, you agree to them. If you do not agree, do not use the service.</p>
<p>The interface sometimes shows the name as one word, “Yourlocalbusiness.” It is the same service. The <a href="${PRIVACY_PATH}">privacy policy</a> explains what information the service handles.</p>

<h2>The service</h2>
<p>Your Local Business is a multi-customer workspace for local businesses. It holds business profiles, marketing drafts, pages, and connections you choose to add. Features can change. A feature that is off, or that is not set up yet, is not a promise that it will ship on a date.</p>

<h2>Accounts</h2>
<p>You must give an email address you control and keep your password to yourself. You are responsible for activity under your account. One person may run more than one business on the account. You may not share the account in a way that lets someone else act as you without your control, and you may not try to open or use another customer’s account or tokens.</p>
<p>The service is not for children under 13. Do not create an account for a child under 13.</p>

<h2>Your content</h2>
<p>You keep ownership of the text, images, and other material you submit. You give the service permission to host, display, and transmit that material only so it can do what you ask: show it in your workspace, publish a page, post after you confirm, or prepare a message you start.</p>
<p>You are responsible for your content. That includes having the rights to use it, and having permission to contact the people you email or message. You are also responsible for following the rules of any provider you connect, including Google and Gmail.</p>

<h2>Acceptable use</h2>
<p>Do not use the service to break the law, to harm someone, or to break a provider’s rules. In particular:</p>
<ul>
  <li>Do not send spam, or mail or messages people did not ask for, including through a connected Gmail account.</li>
  <li>Do not use a connected social or ad account in a way that violates that network’s policies.</li>
  <li>Do not upload malware, try to break into the service, or overload it on purpose.</li>
  <li>Do not misrepresent who you are, or who a message is from, beyond the mailbox or page you actually connected.</li>
</ul>
<p>We may suspend or close an account that breaks these rules.</p>

<h2>Connected services, including Gmail</h2>
<p>Connecting a service authorizes Your Local Business to use that connection for the feature you turn on, within the permission you granted.</p>
<ul>
  <li><strong>Gmail.</strong> Connecting Gmail authorizes the service to send mail from that mailbox when you use outreach, under Google’s <code>gmail.send</code> scope, and to store the mailbox address so you can see what is connected. You are responsible for every message sent from that mailbox and for complying with Google’s and Gmail’s rules. Do not use the connection to send spam. You can disconnect Gmail at any time, and you can also remove the app in your Google Account.</li>
  <li><strong>Social and ads.</strong> The service posts or changes an ad only after you confirm. You are responsible for the content and for the spend an ad network bills to your own ad account.</li>
  <li><strong>Omnisend and other tools.</strong> Drafts and reads follow the access you granted. You review and send in the provider when the product does not send for you.</li>
</ul>
<p>We can stop using a connection if the provider revokes it, if the token no longer works, or if we believe it is being used to break these terms.</p>

<h2>Plans and payment</h2>
<p>If you buy a plan, you pay through Stripe, on the prices shown at checkout. We do not store your full card number. Fees the ad networks charge, and fees a connected tool charges you directly, are between you and that company. Taxes may be added where Stripe Tax is on and the law requires them.</p>
<p>You can cancel as the billing screen describes. Except where the law requires a refund, fees already paid for a period are kept through the end of that period.</p>

<h2>The service is provided as is</h2>
<p>The service is provided “as is” and “as available.” We do not promise that it will be uninterrupted, error-free, or fit for a particular business result. Drafts, analytics, and AI output can be wrong. You decide what to publish and what to send. Networks and providers (Google, Stripe, and the others named in the privacy policy) can change or refuse a request. We are not responsible for their outages or their decisions.</p>

<h2>Limits on our liability</h2>
<p>To the extent the law allows, ${esc(OPERATOR_NAME)} and Your Local Business are not liable for indirect, incidental, special, or consequential damages, or for lost profits, lost data, or lost goodwill. We are not liable for what a third party does with a post, an ad, or an email you asked the service to send, or for a provider revoking a connection.</p>
<p>If we are liable for a claim anyway, the total liability for that claim is limited to the amount you paid us for the service in the three months before the claim, or 100 US dollars if you paid nothing in that period. This limit does not apply where the law does not allow it, including liability that cannot legally be limited.</p>

<h2>Ending the service</h2>
<p>You may stop using the service and delete your account at any time. We may suspend or end access if you break these terms, if we must do so to comply with the law, or if we discontinue the service. The sections that should survive ending (your content responsibilities, acceptable use for past acts, disclaimers, liability limits, and the governing law) still apply.</p>

<h2>Changes</h2>
<p>We may update these terms. The date at the top will change, and the current version will be at <a href="${TERMS_URL}">${esc(TERMS_URL)}</a>. If you keep using the service after the update, the new terms apply. If you do not agree, stop using the service and delete the account.</p>

<h2>Law</h2>
<p>These terms are governed by the laws of the State of Washington, USA, without regard to conflict-of-law rules. The operator is in Washington (Pacific time). Courts in Washington may hear a dispute that is not required to go somewhere else. Nothing here takes away a right the law of your place does not let a contract waive.</p>

<h2>Contact</h2>
<p>Questions about these terms: ${esc(OPERATOR_NAME)}, <a href="mailto:${esc(OPERATOR_EMAIL)}">${esc(OPERATOR_EMAIL)}</a>. Email is the contact method. There is no separate company address on file.</p>
`;
}

/** The full HTML document for a legal page. */
export function legalHtml(doc) {
  if (doc === 'privacy') {
    return layout({
      doc,
      title: 'Privacy Policy',
      description: 'What Your Local Business collects, why, how long it is kept, and how to disconnect or delete it.',
      body: privacyBody(),
    });
  }
  return layout({
    doc: 'terms',
    title: 'Terms of Service',
    description: 'The terms for using Your Local Business, including acceptable use, Gmail and other connections, and liability.',
    body: termsBody(),
  });
}

/**
 * Answer a legal URL. Returns true when this path is one of the legal paths (including aliases).
 * GET and HEAD only; anything else is 405.
 */
export function serveLegal(req, res, url) {
  const hit = classifyLegal(url?.pathname);
  if (!hit) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...COMMON_HEADERS, allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : 'Method not allowed');
    return true;
  }
  if (hit.redirect) {
    res.writeHead(301, { ...COMMON_HEADERS, location: hit.redirect, 'cache-control': 'public, max-age=86400', 'content-length': 0 });
    res.end();
    return true;
  }
  const html = legalHtml(hit.doc);
  const bytes = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    ...COMMON_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'public, max-age=300',
  });
  res.end(req.method === 'HEAD' ? undefined : bytes);
  return true;
}
