// @vitest-environment happy-dom
// Emails and lead magnets from Manus or Viktor (P5 §A9): an email becomes one sanitized custom block, its pictures
// uploaded first (a mocked upload: nothing leaves the test) and its footer removed with a note; a failed upload
// changes nothing; a lead magnet's h1/h2/li become its words, its download kept (and so out of date).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/storage', async (original) => ({ ...(await original<typeof import('@/lib/storage')>()), getBlob: vi.fn(async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })) }));

const { newProject } = await import('@/store/defaults');
const { useStore } = await import('@/store/useStore');
const { generateEmailSequence } = await import('@/ai/local/email');
const { importAgentEmailHtml } = await import('./emailImport');
const { setAgentEmail, setAgentLeadMagnet } = await import('./results');
const { undoDoc } = await import('@/lib/emailDoc');

const PAGE = `<!doctype html><html><head><title>Welcome!</title><style>.box{color:#123456} @import url(https://evil.example/x.css);</style><script>alert(1)</script></head>
<body><table role="presentation" width="600"><tr><td class="box"><h1>Welcome, {{first_name}}</h1><p onclick="x()">Thanks for joining.</p><img src="{{img-1}}" alt="Our shop"><img src="https://track.example/p.gif" alt=""><a href="{{lead_magnet_link}}">Get it</a><a href="javascript:alert(1)">bad</a></td></tr>
<tr><td><p>You get this because you signed up. <a href="https://example.com/unsub">Unsubscribe</a> [[unsubscribe_link]]</p></td></tr></table><form><input name="x"></form><object data="https://x.example/x.swf"></object></body></html>`;

const image = { key: 'img-1', note: '', media: { id: 'm1', kind: 'image' as const, name: 'shop.png', mime: 'image/png', size: 4, createdAt: 0 } };

function setup() {
  const p = newProject('business');
  p.brand.name = 'Copper & Comb';
  p.marketing.emails = generateEmailSequence(p, null);
  useStore.setState({ projects: [p], activeProjectId: p.id });
  return p;
}
const now = (id: string) => useStore.getState().projects.find((x) => x.id === id)!;

describe('an email from an agent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is cleaned for email: no scripts, forms, frames, handlers, outside pictures or footer', () => {
    const r = importAgentEmailHtml(PAGE, { target: 'email', imageKeys: ['img-1'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const bad of ['<object', '<script', 'onclick', 'javascript:', '<form', '<input', 'track.example', 'Unsubscribe', '@import']) expect(r.html + r.css, bad).not.toContain(bad);
    expect(r.html).toContain('{{img-1}}');
    expect(r.html).toContain('href="{{lead_magnet_link}}"');
    expect(r.title).toBe('Welcome!');
    expect(r.notes.join(' ')).toContain('We removed the agent’s footer');
  });

  it('becomes one custom block with its pictures uploaded first, and Undo puts the email back', async () => {
    const p = setup();
    const step = p.marketing.emails[0];
    const upload = vi.fn(async (..._a: unknown[]) => ({ url: 'https://abc.supabase.co/storage/v1/object/public/public-files/u1/e-AAAAAAAAAAAAAAAAAAAAAA.png', path: 'u1/e-AAAAAAAAAAAAAAAAAAAAAA.png' }));
    const r = await setAgentEmail(p.id, { via: 'manus', html: PAGE, images: [image], stepId: step.id, buildId: 'b1' }, { upload });
    expect(r.ok).toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][3]).toBe('email');
    const doc = now(p.id).marketing.emails[0].doc!;
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]).toMatchObject({ type: 'custom', source: 'agent' });
    const block = doc.blocks[0] as { html: string; notes?: string[] };
    expect(block.html).toContain('https://abc.supabase.co/storage/v1/object/public/public-files/u1/e-AAAAAAAAAAAAAAAAAAAAAA.png');
    expect(block.html).not.toContain('{{img-1}}');
    expect(block.notes?.join(' ')).toContain('footer');
    expect(undoDoc(p.id, step.id)).toBe(true);
    expect(now(p.id).marketing.emails[0].doc).toBeUndefined();
  });

  it('changes nothing when a picture can’t be uploaded', async () => {
    const p = setup();
    const step = p.marketing.emails[1];
    const upload = vi.fn(async (..._a: unknown[]) => {
      throw new Error('Storage is full.');
    });
    const r = await setAgentEmail(p.id, { via: 'viktor', html: PAGE, images: [image], stepId: step.id }, { upload });
    expect(r).toEqual({ ok: false, message: expect.stringContaining('nothing was changed') });
    expect(now(p.id).marketing.emails[1]).toEqual(step);
  });

  it('refuses an email too big for one block, saying what to ask for', () => {
    const big = `<html><body>${'<p>Lots of words here.</p>'.repeat(2000)}</body></html>`;
    const r = importAgentEmailHtml(big, { target: 'email', imageKeys: [] });
    expect(r).toMatchObject({ ok: false, reason: 'too_big', message: expect.stringContaining('Ask for a simpler email') });
  });
});

describe('a lead magnet from an agent', () => {
  it('reads h1, subtitle, h2 sections and the cta, keeps the download, and marks it the agent’s design', () => {
    const p = setup();
    p.marketing.leadMagnet = { id: 'lm1', type: 'checklist', title: 'Old', subtitle: '', intro: '', sections: [], cta: '', optInHeadline: 'Get my list', optInBullets: ['a', 'b', 'c'], buttonLabel: 'Send it', createdAt: 0, delivery: { source: 'pdf', fileId: 'AbCdEfGhIjKlMnOpQrStUv', link: 'https://app.example/m/AbCdEfGhIjKlMnOpQrStUv', gate: true, publishedAt: 1, hash: 'old' } };
    useStore.setState({ projects: [p], activeProjectId: p.id });
    const html = `<html><body><h1>Home haircut checklist</h1><p class="subtitle">Everything before you start</p><p>Read this first.</p><h2>Tools</h2><ul><li>Sharp scissors</li><li>A comb</li></ul><h2>Steps</h2><p>Wet the hair.</p><p>Cut slowly.</p><p class="cta">Book a pro cut</p><script>x</script></body></html>`;
    const r = setAgentLeadMagnet(p.id, { via: 'manus', html, images: [], kind: 'checklist', buildId: 'b2' });
    expect(r.ok).toBe(true);
    const lm = now(p.id).marketing.leadMagnet!;
    expect(lm).toMatchObject({ title: 'Home haircut checklist', subtitle: 'Everything before you start', intro: 'Read this first.', cta: 'Book a pro cut', optInHeadline: 'Get my list', buttonLabel: 'Send it' });
    expect(lm.sections).toEqual([
      { heading: 'Tools', items: ['Sharp scissors', 'A comb'] },
      { heading: 'Steps', items: ['Wet the hair.', 'Cut slowly.'] },
    ]);
    expect(lm.delivery?.hash).toBe('old');
    expect(lm.design).toMatchObject({ source: 'agent', via: 'manus', buildId: 'b2' });
  });
});
