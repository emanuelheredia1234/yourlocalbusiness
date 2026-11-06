// A lead magnet's download: the guide becomes a real PDF, the published download survives a rewrite of the guide,
// a changed guide is flagged, and the client for /api/lead-files reads the server's answers and refusals in plain words.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeadMagnet, Project } from './types';
import { newProject } from '@/store/defaults';
import { useStore } from '@/store/useStore';
import { buildEbookPdf } from './ebook';
import { leadMagnetEbook, leadMagnetHash } from './leadMagnetPdf';
import { applyLeadMagnet } from './emailFunnel';
import { LeadFilesError, createLeadFile, deleteLeadFile, leadFilesError, refusedFileName, toLeadFile, uploadLeadFileContent, uploadPublicImage } from './leadFiles';
import { REPUBLISH_NOTE, deliveryStale, linkDownloadOk, publishDownload } from '@/pages/marketing/email/LeadMagnetDelivery';

const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const lm = (over: Partial<LeadMagnet> = {}): LeadMagnet => ({
  id: 'lm1',
  type: 'checklist',
  title: 'Bakery checklist',
  subtitle: 'Ten things to check',
  intro: 'Start here.',
  sections: [
    { heading: 'Before you open', items: ['Clean the ovens', ''] },
    { heading: '', items: [] },
  ],
  cta: 'Book a class\nVisit the shop',
  optInHeadline: '',
  optInBullets: [],
  buttonLabel: 'Get it',
  createdAt: 0,
  ...over,
});
function project(): Project {
  const p = newProject('product', 'new');
  p.brand = { ...p.brand, name: 'Maya Bakes' };
  return p;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the PDF made from the guide', () => {
  it('maps the guide to an ebook: sections become chapters, the call to action the close', () => {
    const doc = leadMagnetEbook(lm(), project());
    expect(doc).toMatchObject({ title: 'Bakery checklist', subtitle: 'Ten things to check', author: 'Maya Bakes', formatLabel: 'Checklist', welcome: 'Start here.', conclusion: 'Book a class\nVisit the shop', nextSteps: ['Book a class', 'Visit the shop'], cover: null });
    // an empty section is left out, and so are empty items
    expect(doc.chapters).toEqual([{ title: 'Before you open', items: [{ title: 'Clean the ovens' }] }]);
  });

  it('is a real PDF', async () => {
    const { bytes, pages } = await buildEbookPdf(leadMagnetEbook(lm(), project()), { theme: 'modern', pageSize: 'letter', fillable: false });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(pages).toBeGreaterThan(1);
  });

  it('knows when the published PDF is out of date', () => {
    const p = project();
    const hash = leadMagnetHash(lm(), p);
    const published = lm({ delivery: { source: 'pdf', fileId: ID, link: `https://app.example/m/${ID}`, gate: true, hash, publishedAt: 1 } });
    expect(deliveryStale(published, p)).toBe(false);
    expect(deliveryStale({ ...published, title: 'New title' }, p)).toBe(true);
    // an upload or a link isn't made from the guide
    expect(deliveryStale({ ...published, title: 'New title', delivery: { ...published.delivery!, source: 'upload' } }, p)).toBe(false);
  });

  it('a new guide keeps the published download and its link', () => {
    const p = project();
    const delivery = { source: 'pdf' as const, fileId: ID, link: `https://app.example/m/${ID}`, gate: true, publishedAt: 1 };
    p.marketing.leadMagnet = lm({ delivery });
    useStore.setState({ projects: [p], activeProjectId: p.id });
    applyLeadMagnet(lm({ title: 'Rewritten' }), p.id);
    expect(useStore.getState().projects[0].marketing.leadMagnet).toMatchObject({ title: 'Rewritten', delivery });
  });
});

describe('a link download', () => {
  it('takes only a full http(s) address without a user name', () => {
    expect(linkDownloadOk('https://mybakery.com/video')).toBe(true);
    for (const bad of ['mybakery.com', 'javascript:alert(1)', 'https://user:pw@mybakery.com', 'https://localhost/x', 'ftp://x.com/a', `https://x.com/${'a'.repeat(2000)}`]) expect(linkDownloadOk(bad), bad).toBe(false);
  });
});

describe('the lead files client', () => {
  it('reads only well-formed answers', () => {
    expect(toLeadFile({ id: 'short' })).toBeNull();
    expect(toLeadFile({ id: ID, kind: 'url', url: 'javascript:x', coverUrl: 'data:x', link: 'https://app.example/m/other', downloads: -3, bytes: 'x' })).toMatchObject({ id: ID, kind: 'url', url: '', coverUrl: null, link: '', downloads: 0, bytes: 0, gate: true });
    expect(toLeadFile({ id: ID, kind: 'file', link: `https://app.example/m/${ID}`, gate: false, downloads: 4 })).toMatchObject({ link: `https://app.example/m/${ID}`, gate: false, downloads: 4 });
  });

  it('says every refusal in plain words', () => {
    const cases: [number, string, string][] = [
      [400, 'TOO_MANY', 'TOO_MANY'],
      [415, 'FILE_TYPE', 'FILE_TYPE'],
      [413, 'QUOTA', 'QUOTA'],
      [413, '', 'TOO_LARGE'],
      [402, 'PLAN_REQUIRED', 'UPGRADE'],
      [429, '', 'RATE_LIMIT'],
    ];
    for (const [status, code, want] of cases) {
      const e = leadFilesError(status, { code, error: 'raw' });
      expect(e.code, `${status} ${code}`).toBe(want);
      expect(e.message).not.toBe('raw');
    }
    expect(leadFilesError(500, { error: 'Oops' }).message).toBe('Oops');
    expect(leadFilesError(402, null).message).toMatch(/Settings › Plan/);
  });

  it('refuses SVG, HTML and oversize files before sending them', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(refusedFileName('logo.svg')).toBe(true);
    expect(refusedFileName('page.HTML')).toBe(true);
    expect(refusedFileName('guide.pdf')).toBe(false);
    await expect(uploadLeadFileContent(ID, new Blob(['<svg/>']), 'x.svg')).rejects.toMatchObject({ code: 'FILE_TYPE' });
    await expect(uploadLeadFileContent(ID, { size: 26 * 1024 * 1024 } as Blob, 'big.pdf')).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(uploadPublicImage(new Blob(['<svg/>']), 'cover.svg')).rejects.toMatchObject({ code: 'FILE_TYPE' });
    await expect(uploadLeadFileContent('../x', new Blob(['%PDF-']), 'a.pdf')).rejects.toBeInstanceOf(LeadFilesError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends raw bytes with the file’s name, JSON for the rest; a download already gone counts as unpublished', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let reply = () => new Response(JSON.stringify({ file: { id: ID, kind: 'file', link: `https://app.example/m/${ID}` } }), { status: 200 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return reply();
      }),
    );
    await createLeadFile({ projectId: 'p1', title: 'Guide', kind: 'file', gate: true });
    expect(calls[0].url).toBe('/api/lead-files');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ projectId: 'p1', title: 'Guide', kind: 'file', gate: true });
    await uploadLeadFileContent(ID, new Blob(['%PDF-1.7']), 'My guide (final).pdf');
    expect(calls[1].url).toBe(`/api/lead-files/${ID}/content`);
    expect(calls[1].init.method).toBe('PUT');
    expect(new Headers(calls[1].init.headers).get('x-file-name')).toBe('My guide final.pdf');
    reply = () => new Response(JSON.stringify({ error: 'gone', code: 'NOT_FOUND' }), { status: 404 });
    await expect(deleteLeadFile(ID)).resolves.toBeUndefined();
  });
});

describe('publishing the download', () => {
  type Call = { method: string; url: string };
  function server(answers: Record<string, () => Response>) {
    const calls: Call[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const method = init?.method ?? 'GET';
        const path = String(url).split('?')[0];
        calls.push({ method, url: String(url) });
        const answer = answers[`${method} ${path}`] ?? answers[`${method} *`];
        return answer ? answer() : new Response(JSON.stringify({ error: 'nope' }), { status: 500 });
      }),
    );
    return calls;
  }
  const row = (over: object = {}) => new Response(JSON.stringify({ file: { id: ID, kind: 'url', url: 'https://maya.example/video', gate: true, link: `https://app.example/m/${ID}`, ...over } }), { status: 200 });
  const cover = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'cover.png', { type: 'image/png' });

  it('a cover that doesn’t upload leaves the new download published and saved, and says so', async () => {
    const calls = server({ 'POST /api/lead-files': () => row(), 'POST /api/public-images': () => new Response(JSON.stringify({ error: 'Storage is down.' }), { status: 503 }) });
    const saved: unknown[] = [];
    const out = await publishDownload(project(), lm(), { source: 'url', url: 'https://maya.example/video', file: null, cover: cover(), gate: true }, (d) => saved.push(d));
    expect(saved).toHaveLength(1);
    expect(out.delivery).toMatchObject({ source: 'url', fileId: ID, link: `https://app.example/m/${ID}`, url: 'https://maya.example/video' });
    expect(out.delivery).not.toHaveProperty('domainLink');
    expect(out.isNew).toBe(true);
    expect(out.coverError).toMatch(/^The download is published, but its cover image didn’t upload\./);
    // never taken down
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(REPUBLISH_NOTE).toContain('again');
  });

  it('an update whose cover fails still saves what was published (so “the guide changed” clears)', async () => {
    const calls = server({ [`PATCH /api/lead-files/${ID}`]: () => row(), 'POST /api/public-images': () => new Response('{}', { status: 500 }) });
    const before = lm({ delivery: { source: 'url', fileId: ID, link: `https://app.example/m/${ID}`, url: 'https://maya.example/old', gate: true, hash: 'old', publishedAt: 1 } });
    const saved: { hash?: string }[] = [];
    const out = await publishDownload(project(), before, { source: 'url', url: 'https://maya.example/video', file: null, cover: cover(), gate: true }, (d) => saved.push(d));
    expect(out.isNew).toBe(false);
    expect(saved[0].hash).not.toBe('old');
    expect(out.coverError).not.toBe('');
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'POST']);
  });

  it('a new download whose file doesn’t upload is taken down again, and nothing is saved', async () => {
    const calls = server({ 'POST /api/lead-files': () => row({ kind: 'file', url: '' }), [`PUT /api/lead-files/${ID}/content`]: () => new Response(JSON.stringify({ error: 'Too big.', code: 'TOO_LARGE' }), { status: 413 }), [`DELETE /api/lead-files/${ID}`]: () => new Response('{"ok":true}', { status: 200 }) });
    const saved: unknown[] = [];
    const file = new File(['%PDF-1.7'], 'guide.pdf', { type: 'application/pdf' });
    await expect(publishDownload(project(), lm(), { source: 'upload', url: '', file, cover: null, gate: true }, (d) => saved.push(d))).rejects.toThrow();
    expect(saved).toHaveLength(0);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' });
  });
});
