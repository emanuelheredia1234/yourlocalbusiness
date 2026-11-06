// Lead magnets (server/leadFiles.mjs, wired up in pages.mjs): the owner's API (create, upload typed by its bytes,
// edit, delete, cover images), and /m/<id> for visitors (the email gate, tickets, signed redirects, counts, limits,
// domains, plans), against the Supabase stand-in. Then a lead form that names a lead magnet: the download link
// after a stored sign-up, never someone else's file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createAuth } from './auth.mjs';
import { createPages } from './pages.mjs';
import { MAX_LEAD_FILE_BYTES, TICKET_TTL, checkTicket, cleanFileName, leadLinkSecret, makeTicket, normalizeLink, sniffLeadFile, sniffPublicImage } from './leadFiles.mjs';
import { createMockSupabase } from './test/mock-supabase.mjs';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32, 1)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 2)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 3)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 4)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/** Any request, with any Host header and raw body. */
function request(base, pathname, { host, method = 'GET', headers = {}, body } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const length = body === undefined ? {} : { 'content-length': Buffer.byteLength(body) };
    const req = http.request({ agent: false, host: u.hostname, port: u.port, path: pathname, method, headers: { ...(host ? { host } : {}), ...length, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** pages.mjs (with its leads and lead magnets) behind a bare server, routed like ai-server.mjs. */
async function startPages(mock, { billing = null, leadLimits, magnetLimits, linkSecret = null } = {}) {
  const auth = createAuth({ supabaseUrl: mock.url, publishableKey: mock.PUBLISHABLE });
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const readJson = (req, limit = 1e6) =>
    new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > limit) reject(Object.assign(new Error('too large'), { status: 413 }));
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'));
        } catch {
          reject(Object.assign(new Error('bad'), { status: 400 }));
        }
      });
    });
  const whoIs = async (req, res) => {
    const who = req.headers.authorization ? await auth.identify(req) : null;
    if (!who) {
      send(res, 401, { error: 'Sign in.', code: 'AUTH_REQUIRED' });
      return null;
    }
    return { who };
  };
  const pages = createPages({ supabaseUrl: mock.url, secretKey: mock.SECRET, auth, whoIs, send, readJson, billing, leadLimits, magnetLimits, linkSecret, tuning: { namesCheck: 0 } });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (!pages.isAppHost(req)) return void pages.serveDomain(req, res, url);
    if (pages.matchApi(url)) return void pages.handleApi(req, res, url);
    if (pages.matchPublicRoute(url)) return void pages.servePublicRoute(req, res, url);
    if (req.method === 'POST' && pages.matchLead(url)) return void pages.receiveLead(req, res, url).then((h) => h || (res.writeHead(405), res.end()));
    if (pages.matchPage(url) && (await pages.servePage(req, res, url))) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('the app');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    pages,
    close: () => {
      pages.close();
      return new Promise((r) => server.close(r));
    },
  };
}

let supa;
let app;
let alice;
let bob;
const rowsOf = (table) => supa.tables.get(table) ?? [];
const api = (pathname, { who, method = 'GET', body, headers = {}, raw } = {}) =>
  request(app.base, pathname, {
    method,
    headers: { ...(raw === undefined ? { 'content-type': 'application/json' } : { 'content-type': 'application/octet-stream' }), ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }).then((r) => ({ ...r, json: () => JSON.parse(r.text) }));
const create = async (who, body) => (await api('/api/lead-files', { who, method: 'POST', body: { projectId: 'biz1', title: 'Free guide', brand: 'Maya’s Bakery', ...body } })).json();
const upload = (who, id, bytes, name = 'guide.pdf', base = app) => request(base.base, `/api/lead-files/${id}/content`, { method: 'PUT', headers: { authorization: `Bearer ${who.token}`, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) }, body: bytes }).then((r) => ({ ...r, json: () => JSON.parse(r.text) }));
const visit = (pathname, opts = {}) => request(opts.base ?? app.base, pathname, opts);
const form = (fields) => new URLSearchParams(fields).toString();
const postGate = (id, fields, opts = {}) => visit(`/m/${id}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(opts.headers ?? {}) }, body: form(fields), ...opts });
const downloadsOf = (id) => rowsOf('lead_files').find((r) => r.id === id)?.downloads ?? 0;
const objectsUnder = (prefix) => [...supa.objects.keys()].filter((k) => k.startsWith(prefix));

beforeAll(async () => {
  supa = await (await createMockSupabase()).start();
  app = await startPages(supa, { leadLimits: { perIp: 1000, perPage: 1000, windowMs: 3_600_000 }, magnetLimits: { perIp: 1000, perFile: 1000, windowMs: 3_600_000 } });
  alice = await supa.tokenFor('alice@magnets.test');
  bob = await supa.tokenFor('bob@magnets.test');
}, 30_000);
afterAll(async () => {
  await app?.close();
  await supa?.close();
});

describe('the owner’s downloads', () => {
  it('creates, lists, edits and deletes their own, and another account’s id is “not found”', async () => {
    const { file } = await create(alice, {});
    expect(file).toMatchObject({ projectId: 'biz1', title: 'Free guide', brand: 'Maya’s Bakery', kind: 'file', gate: true, bytes: 0, downloads: 0, coverUrl: null, link: `${app.base}/m/${file.id}` });
    expect(file.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    let r = await api('/api/lead-files?projectId=biz1', { who: alice });
    expect(r.json().files.map((f) => f.id)).toContain(file.id);
    expect((await api('/api/lead-files', { who: bob })).json().files).toEqual([]);
    // bob can't see, change, upload to or delete alice's
    expect((await api(`/api/lead-files/${file.id}`, { who: bob, method: 'PATCH', body: { title: 'Mine now' } })).status).toBe(404);
    expect((await upload(bob, file.id, PDF)).status).toBe(404);
    expect((await api(`/api/lead-files/${file.id}`, { who: bob, method: 'DELETE' })).status).toBe(200);
    expect(rowsOf('lead_files').some((x) => x.id === file.id)).toBe(true);
    r = await api(`/api/lead-files/${file.id}`, { who: alice, method: 'PATCH', body: { title: 'Bread basics', gate: false } });
    expect(r.json().file).toMatchObject({ title: 'Bread basics', gate: false });
    r = await api(`/api/lead-files/${file.id}`, { who: alice, method: 'DELETE' });
    expect(r.json()).toEqual({ ok: true });
    expect(rowsOf('lead_files').some((x) => x.id === file.id)).toBe(false);
    expect((await api(`/api/lead-files/${file.id}`, { who: alice, method: 'DELETE' })).status).toBe(200);
  });

  it('checks what it’s sent', async () => {
    const bad = [
      [{ projectId: 'a b' }, 400],
      [{ projectId: undefined }, 400],
      [{ kind: 'page' }, 400],
      [{ title: 'x'.repeat(201) }, 400],
      [{ gate: 'yes' }, 400],
      [{ kind: 'url', url: 'javascript:alert(1)' }, 400],
      [{ kind: 'url', url: 'ftp://files.example.com/x' }, 400],
      [{ kind: 'url', url: 'https://user:pw@example.com/' }, 400],
      [{ kind: 'url', url: 'https://localhost/' }, 400],
      [{ kind: 'url', url: `https://example.com/${'a'.repeat(2000)}` }, 400],
    ];
    for (const [body, status] of bad) expect((await api('/api/lead-files', { who: alice, method: 'POST', body: { projectId: 'biz1', title: 't', ...body } })).status, JSON.stringify(body).slice(0, 60)).toBe(status);
    const { file } = await create(alice, { kind: 'url', url: 'https://Example.com/Free Guide' });
    expect(file).toMatchObject({ kind: 'url', url: 'https://example.com/Free%20Guide' });
    // signed out, another site, unknown paths
    expect((await api('/api/lead-files')).status).toBe(401);
    expect((await api('/api/lead-files', { who: alice, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    for (const p of ['/api/lead-files/short', `/api/lead-files/${file.id}/x`, `/api/lead-files/${'A'.repeat(22)}/content/x`]) expect((await api(p, { who: alice, method: 'PATCH', body: {} })).status, p).toBe(404);
  });

  it('at most 20 per account', async () => {
    const carol = await supa.tokenFor('carol@magnets.test');
    for (let i = 0; i < 20; i++) expect((await api('/api/lead-files', { who: carol, method: 'POST', body: { projectId: 'c1', title: `n${i}` } })).status).toBe(200);
    const r = await api('/api/lead-files', { who: carol, method: 'POST', body: { projectId: 'c1', title: 'one more' } });
    expect(r.status).toBe(400);
    expect(r.json().code).toBe('TOO_MANY');
  });
});

describe('uploads, typed by their bytes', () => {
  it('stores a PDF in its own version, forces its extension, and removes the version before', async () => {
    const { file } = await create(alice, {});
    let r = await upload(alice, file.id, PDF, 'My Guide (final).exe');
    expect(r.status).toBe(200);
    expect(r.json().file).toMatchObject({ kind: 'file', fileName: 'My Guide final.pdf', mime: 'application/pdf', bytes: PDF.length });
    const first = objectsUnder(`lead-files/${alice.user.id}/${file.id}/`);
    expect(first).toHaveLength(1);
    expect(supa.objects.get(first[0]).type).toBe('application/pdf');
    r = await upload(alice, file.id, ZIP, 'Workbook.xlsx');
    expect(r.json().file).toMatchObject({ fileName: 'Workbook.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const second = objectsUnder(`lead-files/${alice.user.id}/${file.id}/`);
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
    for (const [bytes, name, mime] of [
      [ZIP, 'pack.zip', 'application/zip'],
      [ZIP, 'book.epub', 'application/epub+zip'],
      [ZIP, 'notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      [MP3, 'talk.mp3', 'audio/mpeg'],
      [MP4, 'clip.mov', 'video/mp4'],
      [PNG, 'chart.png', 'image/png'],
    ]) {
      r = await upload(alice, file.id, bytes, name);
      expect(r.status, name).toBe(200);
      expect(r.json().file.mime, name).toBe(mime);
    }
    expect(cleanFileName('clip.mov', 'mp4')).toBe('clip.mp4');
  });

  it('refuses SVG, HTML, text and GIF downloads, whatever the name says', async () => {
    const { file } = await create(alice, {});
    const cases = [
      [SVG, 'guide.pdf'],
      [Buffer.from('<?xml version="1.0"?><svg/>'), 'x.png'],
      [Buffer.from('﻿  <html><body>hi</body></html>'), 'x.pdf'],
      [Buffer.from('\n\n <script>alert(1)</script>'), 'x.pdf'],
      [Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.from('<svg onload=alert(1)>')]), 'x.pdf'],
      [Buffer.from('just some text, nothing else'), 'x.txt'],
      [GIF, 'x.gif'],
    ];
    for (const [bytes, name] of cases) {
      const r = await upload(alice, file.id, bytes, name);
      expect(r.status, name).toBe(415);
      expect(r.json().code, name).toBe('FILE_TYPE');
    }
    expect(objectsUnder(`lead-files/${alice.user.id}/${file.id}/`)).toEqual([]);
  });

  it('413 over 25 MB, and over the account’s 200 MB', async () => {
    const { file } = await create(alice, {});
    // too big by its declared size: refused before it's read
    const r = await request(app.base, `/api/lead-files/${file.id}/content`, { method: 'PUT', headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/octet-stream', 'content-length': String(MAX_LEAD_FILE_BYTES + 1) } });
    expect(r.status).toBe(413);
    expect(JSON.parse(r.text).code).toBe('TOO_LARGE');
    // the account already has 199.9 MB in other downloads
    const dan = await supa.tokenFor('dan@magnets.test');
    const { file: big } = await create(dan, {});
    for (let i = 0; i < 8; i++) rowsOf('lead_files').push({ id: `D${String(i).padStart(21, '0')}`, user_id: dan.user.id, project_id: 'biz1', kind: 'file', bytes: 25 * 1024 * 1024 - 1000, gate: true, downloads: 0 });
    const q = await upload(dan, big.id, Buffer.concat([PDF, Buffer.alloc(9000)]));
    expect(q.status).toBe(413);
    expect(q.json().code).toBe('QUOTA');
  });
});

describe('public images', () => {
  it('only JPEG, PNG, WebP and GIF; a cover replaces the one before', async () => {
    const { file } = await create(alice, {});
    const put = (bytes, q = '') => request(app.base, `/api/public-images${q}`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/octet-stream' }, body: bytes }).then((r) => ({ ...r, json: () => JSON.parse(r.text) }));
    for (const bad of [SVG, Buffer.from('<?xml version="1.0"?><svg/>'), PDF, Buffer.from('hello world, hello')]) expect((await put(bad)).status).toBe(415);
    let r = await put(GIF);
    expect(r.status).toBe(200);
    expect(r.json().path).toMatch(new RegExp(`^${alice.user.id}/[A-Za-z0-9_-]{22}\\.gif$`));
    // the public address, readable without a key
    const pub = await fetch(r.json().url);
    expect(pub.status).toBe(200);
    r = await put(PNG, `?leadFile=${file.id}`);
    const first = r.json().path;
    expect(rowsOf('lead_files').find((x) => x.id === file.id).cover_path).toBe(first);
    r = await put(PNG, `?leadFile=${file.id}`);
    expect(supa.objects.has(`public-files/${first}`)).toBe(false);
    expect((await api(`/api/lead-files?projectId=biz1`, { who: alice })).json().files.find((f) => f.id === file.id).coverUrl).toContain(r.json().path);
    // bob can't put a cover on alice's file
    const b = await request(app.base, `/api/public-images?leadFile=${file.id}`, { method: 'POST', headers: { authorization: `Bearer ${bob.token}`, 'content-type': 'application/octet-stream' }, body: PNG });
    expect(b.status).toBe(404);
    // deleting the download takes its cover
    await api(`/api/lead-files/${file.id}`, { who: alice, method: 'DELETE' });
    expect(supa.objects.has(`public-files/${r.json().path}`)).toBe(false);
  });
});

describe('/m/<id> for visitors', () => {
  let gated;
  let open;
  let link;
  beforeAll(async () => {
    gated = (await create(alice, { title: 'Bread <basics>' })).file;
    await upload(alice, gated.id, PDF, 'bread.pdf');
    open = (await create(alice, { gate: false })).file;
    await upload(alice, open.id, PDF, 'open.pdf');
    link = (await create(alice, { kind: 'url', url: 'https://example.com/free', gate: false })).file;
  });

  it('without a gate: a 302 to a signed link, counted once per GET (not HEAD, not a prefetch)', async () => {
    const before = downloadsOf(open.id);
    const r = await visit(`/m/${open.id}`);
    expect(r.status).toBe(302);
    expect(r.headers).toMatchObject({ 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
    expect(r.headers.location).toMatch(new RegExp(`^${supa.url}/storage/v1/object/sign/lead-files/.+\\?token=.+&download=open\\.pdf$`));
    expect(downloadsOf(open.id)).toBe(before + 1);
    // the signed link gives the file
    const file = await fetch(r.headers.location);
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF)).toBe(true);
    expect((await visit(`/m/${open.id}`, { method: 'HEAD' })).status).toBe(302);
    expect((await visit(`/m/${open.id}`, { headers: { 'sec-purpose': 'prefetch' } })).status).toBe(302);
    expect((await visit(`/m/${open.id}`, { headers: { purpose: 'prefetch' } })).status).toBe(302);
    expect(downloadsOf(open.id)).toBe(before + 1);
    expect(rowsOf('lead_files').find((x) => x.id === open.id).last_download_at).toEqual(expect.any(String));
  });

  it('an outside link on the app’s host is a page that names where it goes, never a redirect', async () => {
    const before = downloadsOf(link.id);
    const r = await visit(`/m/${link.id}`);
    expect(r.status).toBe(200);
    expect(r.headers.location).toBeUndefined();
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(r.text).not.toContain('<script');
    expect(r.text).toContain('<strong>example.com</strong>');
    expect(r.text).toContain('<a href="https://example.com/free" rel="noopener noreferrer">Continue to example.com</a>');
    expect(downloadsOf(link.id)).toBe(before + 1);
    expect((await visit(`/m/${link.id}`, { method: 'HEAD' })).status).toBe(200);
    expect(downloadsOf(link.id)).toBe(before + 1);
    // behind its gate too: the sign-up, then the same page (no 303 to the outside site)
    const gatedLink = (await create(alice, { kind: 'url', url: 'https://evil.example/login', title: 'Sign in' })).file;
    const g = await postGate(gatedLink.id, { email: 'ann@example.com' });
    expect(g.status).toBe(200);
    expect(g.headers.location).toBeUndefined();
    expect(g.text).toContain('Continue to evil.example');
    expect(rowsOf('page_leads').at(-1)).toMatchObject({ page_id: `magnet:${gatedLink.id}`, email: 'ann@example.com' });
  });

  it('with a gate: a page with no script, then a sign-up kept as a magnet lead and the file', async () => {
    let r = await visit(`/m/${gated.id}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toBe(`default-src 'none'; style-src 'unsafe-inline'; img-src ${new URL(supa.url).origin}; sandbox allow-forms allow-downloads`);
    expect(r.text).not.toContain('<script');
    expect(r.text).toContain('Bread &lt;basics&gt;');
    expect(r.text).toContain(`<form method="post" action="/m/${gated.id}">`);
    expect(r.text).toContain('name="consent" value="yes"');
    expect(r.text).not.toMatch(/name="consent"[^>]*checked/);
    expect(r.text).toContain('Email me tips and offers from Maya’s Bakery. I can unsubscribe at any time.');
    expect(r.text).toContain('Maya’s Bakery receives your name and email and sends you the download.');
    expect(r.text.toLowerCase()).not.toContain('yourlocalbusiness');
    const before = downloadsOf(gated.id);
    r = await postGate(gated.id, { name: 'Ann', email: 'ann@example.com', consent: 'yes' });
    expect(r.status).toBe(303);
    expect(r.headers.location).toContain('/storage/v1/object/sign/lead-files/');
    expect(downloadsOf(gated.id)).toBe(before);
    const lead = rowsOf('page_leads').at(-1);
    expect(lead).toMatchObject({ user_id: alice.user.id, project_id: 'biz1', page_id: `magnet:${gated.id}`, slug: '', source: 'magnet', kind: 'magnet', consent: true, payload: { request: 'Bread <basics>', magnet: gated.id }, name: 'Ann', email: 'ann@example.com' });
    // an email is needed; a phone alone isn't asked
    r = await postGate(gated.id, { phone: '+1 512 555 0100' });
    expect(r.status).toBe(400);
    expect(r.text).toContain('add your email');
    // the hidden field: back to the gate, nothing kept, no file
    const leads = rowsOf('page_leads').length;
    r = await postGate(gated.id, { email: 'bot@example.com', website: 'x' });
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe(`/m/${gated.id}`);
    expect(rowsOf('page_leads').length).toBe(leads);
    // without a gate there's nothing to post
    expect((await postGate(open.id, { email: 'ann@example.com' })).status).toBe(405);
    expect((await visit(`/m/${gated.id}`, { method: 'PUT' })).status).toBe(405);
    expect((await visit(`/m/${gated.id}`, { method: 'OPTIONS' })).status).toBe(405);
  });

  it('when the sign-up can’t be kept, no file', async () => {
    supa.behavior.fail = (method, pathname) => (method === 'POST' && pathname === '/rest/v1/page_leads' ? { status: 500, body: { code: 'XX000', message: 'down' } } : null);
    try {
      const r = await postGate(gated.id, { email: 'ann@example.com' });
      expect(r.status).toBe(503);
      expect(r.headers.location).toBeUndefined();
      expect(r.text).toContain('nothing was downloaded');
    } finally {
      supa.behavior.fail = null;
    }
  });

  it('a ticket skips the gate: valid, expired, another file’s, made up', async () => {
    const secret = leadLinkSecret({ SUPABASE_SECRET_KEY: supa.SECRET });
    expect((await visit(`/m/${gated.id}?k=${makeTicket(secret, gated.id)}`)).status).toBe(302);
    expect((await visit(`/m/${gated.id}?k=${makeTicket(secret, gated.id, Date.now() - TICKET_TTL - 5000)}`)).status).toBe(200);
    expect((await visit(`/m/${gated.id}?k=${makeTicket(secret, open.id)}`)).status).toBe(200);
    expect((await visit(`/m/${gated.id}?k=${makeTicket(Buffer.from('another secret, 32 bytes long....'), gated.id)}`)).status).toBe(200);
    for (const k of ['', 'x', 'zzzzzzzzzzzz.abc', `${'a'.repeat(100)}.b`]) expect((await visit(`/m/${gated.id}?k=${encodeURIComponent(k)}`)).status, k).toBe(200);
  });

  it('missing, malformed and empty are all “not found”', async () => {
    const empty = (await create(alice, {})).file;
    for (const p of [`/m/${'Z'.repeat(22)}`, `/m/${empty.id}`, '/m/short', `/m/${gated.id}/x`, `/m/${gated.id}x`]) {
      const r = await visit(p);
      expect(r.status, p).toBe(404);
      expect(r.text, p).toContain('Page not found');
    }
  });

  it('a lead form that names the owner’s lead magnet links to it after a stored sign-up; another account’s is ignored', async () => {
    const slug = 'alice-magnet-page';
    const html = `<!doctype html><form method="post" action="/${slug}/lead"><input name="email"><input type="hidden" name="magnet" value="${gated.id}"><input name="website"></form>`;
    expect((await api(`/api/pages/${encodeURIComponent('artifact:mag1')}`, { who: alice, method: 'PUT', body: { kind: 'artifact', slug, title: 'Get the guide', html, images: [], projectId: 'biz1' } })).status).toBe(200);
    let r = await visit(`/${slug}/lead`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ email: 'ann@example.com', magnet: gated.id }) });
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox allow-downloads");
    const href = /href="(\/m\/[^"]+)" download>Download Bread &lt;basics&gt;</.exec(r.text)?.[1];
    expect(href).toBeTruthy();
    expect(rowsOf('page_leads').at(-1).payload).toMatchObject({ magnet: gated.id });
    expect((await visit(href.replace(/&amp;/g, '&'))).status).toBe(302);
    // JSON for a widget
    r = await visit(`/${slug}/lead`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form({ email: 'ann@example.com', magnet: gated.id }) });
    expect(JSON.parse(r.text)).toMatchObject({ ok: true, download: expect.stringMatching(new RegExp(`^/m/${gated.id}\\?k=`)) });
    // bob's file named on alice's page: kept as a plain lead, no link, no word about it
    const bobs = (await create(bob, {})).file;
    await upload(bob, bobs.id, PDF);
    r = await visit(`/${slug}/lead`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form({ email: 'ann@example.com', magnet: bobs.id }) });
    expect(JSON.parse(r.text)).toEqual({ ok: true, title: 'Thank you', text: 'Your message was sent.' });
    expect(rowsOf('page_leads').at(-1).payload).toEqual({});
    // a bot (the hidden field) gets no link either
    r = await visit(`/${slug}/lead`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ email: 'bot@example.com', magnet: gated.id, website: 'x' }) });
    expect(r.text).not.toContain('/m/');
    // a phone alone doesn't get past the gate: "add your email", nothing kept, no ticket
    const leads = rowsOf('page_leads').length;
    r = await visit(`/${slug}/lead`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form({ phone: '5555555555', magnet: gated.id }) });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text)).toEqual({ ok: false, title: 'Add your email', text: 'Go back and add your email, then send it again.' });
    expect(rowsOf('page_leads').length).toBe(leads);
    // a phone alone with another account's (or no) download is a plain lead, as before
    r = await visit(`/${slug}/lead`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form({ phone: '5555555555', magnet: bobs.id }) });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).download).toBeUndefined();
  });

  it('made-up download ids from one visitor don’t use up the lookups everyone else’s sign-ups need', async () => {
    const slug = 'alice-budget-page';
    const fresh = (await create(alice, { title: 'Fresh guide' })).file;
    await upload(alice, fresh.id, PDF);
    const html = `<!doctype html><form method="post" action="/${slug}/lead"><input name="email"><input type="hidden" name="magnet" value="${fresh.id}"><input name="website"></form>`;
    expect((await api(`/api/pages/${encodeURIComponent('artifact:budget1')}`, { who: alice, method: 'PUT', body: { kind: 'artifact', slug, title: 'Budget', html, images: [], projectId: 'biz1' } })).status).toBe(200);
    const post = (fields, ip) => visit(`/${slug}/lead`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-forwarded-for': ip }, body: form(fields) });
    const made = (i) => `x${String(i).padStart(21, '0')}`;
    for (let i = 0; i < 65; i++) expect((await post({ email: 'bot@example.com', magnet: made(i) }, '198.51.100.66')).status).toBe(200);
    // a real visitor still gets the download they signed up for
    const r = await post({ email: 'ann@example.com', magnet: fresh.id }, '198.51.100.67');
    expect(JSON.parse(r.text).download).toMatch(new RegExp(`^/m/${fresh.id}\\?k=`));
    expect(rowsOf('page_leads').at(-1).payload).toMatchObject({ magnet: fresh.id });
  });

  it('on a domain, only its owner’s files', async () => {
    supa.tables.set('published_domains', [...rowsOf('published_domains'), { domain: 'shop.example.com', user_id: alice.user.id, token: `ylb-${'0a'.repeat(20)}`, verified_at: new Date().toISOString(), created_at: new Date().toISOString() }]);
    const bobs = (await create(bob, { gate: false })).file;
    await upload(bob, bobs.id, PDF);
    expect((await visit(`/m/${open.id}`, { host: 'shop.example.com' })).status).toBe(302);
    // an outside link: a redirect on the owner's own verified domain
    const away = await visit(`/m/${link.id}`, { host: 'shop.example.com' });
    expect(away.status).toBe(302);
    expect(away.headers.location).toBe('https://example.com/free');
    const r = await visit(`/m/${bobs.id}`, { host: 'shop.example.com' });
    expect(r.status).toBe(404);
    expect(r.text.toLowerCase()).not.toContain('yourlocalbusiness');
    expect((await visit(`/m/${gated.id}`, { host: 'shop.example.com' })).status).toBe(200);
    expect((await postGate(gated.id, { email: 'cy@example.com' }, { host: 'shop.example.com' })).status).toBe(303);
    // other short routes there are "not found"
    expect((await visit('/b/abc', { host: 'shop.example.com' })).status).toBe(404);
  });
});

describe('limits and plans', () => {
  it('per visitor and per file, 429 with retry-after', async () => {
    const s = await startPages(supa, { magnetLimits: { perIp: 2, perFile: 1000, windowMs: 3_600_000 } });
    try {
      const { file } = await create(alice, { gate: false });
      await upload(alice, file.id, PDF);
      expect((await visit(`/m/${file.id}`, { base: s.base })).status).toBe(302);
      expect((await visit(`/m/${file.id}`, { base: s.base })).status).toBe(302);
      const r = await visit(`/m/${file.id}`, { base: s.base });
      expect(r.status).toBe(429);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(60);
      // another visitor (behind the proxy) still gets it
      expect((await visit(`/m/${file.id}`, { base: s.base, headers: { 'x-forwarded-for': '203.0.113.9' } })).status).toBe(302);
    } finally {
      await s.close();
    }
    const t = await startPages(supa, { magnetLimits: { perIp: 1000, perFile: 2, windowMs: 3_600_000 } });
    try {
      const { file } = await create(alice, { gate: false });
      await upload(alice, file.id, PDF);
      for (const ip of ['203.0.113.1', '203.0.113.2']) expect((await visit(`/m/${file.id}`, { base: t.base, headers: { 'x-forwarded-for': ip } })).status).toBe(302);
      expect((await visit(`/m/${file.id}`, { base: t.base, headers: { 'x-forwarded-for': '203.0.113.3' } })).status).toBe(429);
    } finally {
      await t.close();
    }
  });

  it('the gate’s sign-ups have their own count per file, not a page form’s', async () => {
    const s = await startPages(supa, { leadLimits: { perIp: 1000, perPage: 2, windowMs: 3_600_000 }, magnetLimits: { perIp: 1000, perFile: 1000, signupsPerFile: 4, windowMs: 3_600_000 } });
    try {
      const { file } = await create(alice, {});
      await upload(alice, file.id, PDF);
      // more than a page form's 2 an hour: a link in an email reaches many people at once
      for (let i = 1; i <= 4; i++) expect((await postGate(file.id, { email: `s${i}@example.com` }, { base: s.base, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `203.0.113.${40 + i}` } })).status).toBe(303);
      const r = await postGate(file.id, { email: 's5@example.com' }, { base: s.base, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.50' } });
      expect(r.status).toBe(429);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(60);
    } finally {
      await s.close();
    }
  });

  it('410 once the owner’s plan ended more than 30 days ago; writes need an active plan', async () => {
    const ended = new Date(Date.now() - 86_400_000).toISOString();
    const billing = {
      pagesServeUntil: async (uid) => (uid === alice.user.id ? ended : null),
      requireActive: async (who) => {
        if (who.id === alice.user.id) throw Object.assign(new Error('Choose a plan to publish.'), { status: 402, code: 'PLAN_REQUIRED', extra: { need: 'launch' } });
      },
    };
    const s = await startPages(supa, { billing });
    try {
      const { file } = await create(bob, { gate: false });
      const theirs = rowsOf('lead_files').find((x) => x.user_id === alice.user.id && x.object_path);
      expect((await visit(`/m/${theirs.id}`, { base: s.base })).status).toBe(410);
      const r = await request(s.base, '/api/lead-files', { method: 'POST', headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'biz1', title: 'x' }) });
      expect(r.status).toBe(402);
      expect(JSON.parse(r.text)).toMatchObject({ code: 'PLAN_REQUIRED', need: 'launch' });
      // unpublishing never needs a plan
      expect((await request(s.base, `/api/lead-files/${theirs.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${alice.token}` } })).status).toBe(200);
      expect(file.id).toBeTruthy();
    } finally {
      await s.close();
    }
  });
});

describe('without the setup', () => {
  it('before the migration: no lead magnets, and the API names the file to run', async () => {
    const bare = await (await createMockSupabase({ missingTables: ['lead_files'], missingBuckets: ['lead-files', 'public-files'] })).start();
    const s = await startPages(bare);
    try {
      const erin = await bare.tokenFor('erin@magnets.test');
      expect((await visit(`/m/${'A'.repeat(22)}`, { base: s.base })).status).toBe(404);
      const r = await request(s.base, '/api/lead-files', { headers: { authorization: `Bearer ${erin.token}` } });
      expect(r.status).toBe(503);
      expect(JSON.parse(r.text)).toEqual({ error: 'Run supabase/migrations/20261112000000_leads_p2.sql in Supabase → SQL Editor.', code: 'LEAD_FILES_TABLE' });
    } finally {
      await s.close();
      await bare.close();
    }
  });
});

describe('the parts on their own', () => {
  it('types files by their bytes', () => {
    expect(sniffLeadFile(PDF)).toEqual({ ext: 'pdf', mime: 'application/pdf' });
    expect(sniffLeadFile(ZIP, 'pptx')?.ext).toBe('pptx');
    expect(sniffLeadFile(ZIP, 'svg')?.ext).toBe('zip');
    expect(sniffLeadFile(GIF)).toBeNull();
    expect(sniffLeadFile(SVG)).toBeNull();
    expect(sniffLeadFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))?.ext).toBe('jpg');
    expect(sniffLeadFile(Buffer.from([0xff, 0xfb, 0x90, 0x00]))?.ext).toBe('mp3');
    expect(sniffPublicImage(GIF)?.ext).toBe('gif');
    expect(sniffPublicImage(SVG)).toBeNull();
    expect(sniffPublicImage(PDF)).toBeNull();
  });

  it('cleans file names and links', () => {
    expect(cleanFileName('../../etc/passwd', 'pdf')).toBe('etcpasswd.pdf');
    expect(cleanFileName('', 'pdf')).toBe('download.pdf');
    expect(cleanFileName('Résumé guide.PDF', 'pdf')).toBe('Resume guide.pdf');
    expect(cleanFileName(`${'a'.repeat(300)}.pdf`, 'pdf')).toHaveLength(100);
    expect(cleanFileName('evil.svg', 'png')).toBe('evil.png');
    expect(normalizeLink('https://example.com/a b')).toBe('https://example.com/a%20b');
    for (const bad of ['', 'example.com', 'data:text/html,x', 'https://a:b@example.com', 'http://intranet/', 7]) expect(normalizeLink(bad), String(bad)).toBeNull();
  });

  it('tickets: signed, short-lived, one file each', () => {
    const secret = leadLinkSecret({ LEAD_LINK_SECRET: 'a-long-enough-secret' });
    expect(secret.toString()).toBe('a-long-enough-secret');
    // too short: derived from the Supabase key instead
    expect(leadLinkSecret({ LEAD_LINK_SECRET: 'short', SUPABASE_SECRET_KEY: 'sb_secret_x' })).toHaveLength(32);
    expect(leadLinkSecret({})).toBeNull();
    const id = 'A'.repeat(22);
    const now = Date.now();
    const k = makeTicket(secret, id, now);
    expect(checkTicket(secret, id, k, now)).toBe(true);
    expect(checkTicket(secret, id, k, now + TICKET_TTL + 2000)).toBe(false);
    expect(checkTicket(secret, 'B'.repeat(22), k, now)).toBe(false);
    expect(checkTicket(null, id, k, now)).toBe(false);
    // one that claims to last a day
    const far = Math.floor((now + 86_400_000) / 1000).toString(36);
    expect(checkTicket(secret, id, `${far}.${k.split('.')[1]}`, now)).toBe(false);
  });
});
