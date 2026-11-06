// A lead magnet's download: the guide becomes a real PDF, the published download survives a rewrite of the guide,
// a changed guide is flagged, and the client for /api/lead-files reads the server's answers and refusals in plain words.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeadMagnet, Project } from './types';
import { newProject } from '@/store/defaults';
import { useStore } from '@/store/useStore';
import { buildEbookPdf } from './ebook';
import { leadMagnetEbook, leadMagnetHash } from './leadMagnetPdf';
import { applyLeadMagnet } from './emailFunnel';
import { LeadFilesError, createLeadFile, deleteLeadFile, domainLinkOf, leadFilesError, refusedFileName, toLeadFile, uploadLeadFileContent, uploadPublicImage } from './leadFiles';
import { deliveryStale, linkDownloadOk } from '@/pages/marketing/email/LeadMagnetDelivery';

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

  it('the domain link is the SEO page’s domain, when it has one', () => {
    expect(domainLinkOf(ID, { domain: 'mybakery.com', domainUrl: 'https://mybakery.com/' })).toBe(`https://mybakery.com/m/${ID}`);
    expect(domainLinkOf(ID, { domainUrl: 'https://mybakery.com/' })).toBeUndefined();
    expect(domainLinkOf(ID, undefined)).toBeUndefined();
  });
});
