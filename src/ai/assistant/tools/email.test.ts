// The email studio's assistant tools (P5 §A8), run as a turn runs them: reading a design, AI design behind a
// confirm card (the built-in engine here: no request leaves the test), blocks added, changed, moved and removed
// through normalizeDoc, custom HTML refused, edit_email on a designed email, themes, and the HTML download.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '@/store/useStore';
import { answerCard, pressButton } from '@/store/assistant';
import { generateEmailSequence } from '@/ai/local/email';
import { fakeHost, runTool, seedWorkspace, testChat } from '../testing';
import { registry } from '.';

const saved = vi.hoisted(() => ({ files: [] as { name: string; data: string }[] }));
vi.mock('@/components/ui/download', () => ({ download: vi.fn(async (name: string, data: string | Blob) => (saved.files.push({ name, data: typeof data === 'string' ? data : '[blob]' }), true)) }));

const tick = () => new Promise((r) => setTimeout(r, 0));
const project = () => useStore.getState().projects.find((p) => p.id === useStore.getState().activeProjectId)!;
const email = (n: number) => project().marketing.emails[n - 1];

let host: ReturnType<typeof fakeHost>;
beforeEach(() => {
  const p = seedWorkspace();
  useStore.setState((s) => ({ projects: s.projects.map((x) => (x.id === p.id ? { ...x, marketing: { ...x.marketing, emails: generateEmailSequence(x, null) } } : x)) }));
  host = fakeHost();
  saved.files = [];
});
afterEach(() => host.restore());

describe('reading and editing blocks', () => {
  it('get_email_design lists the blocks of a plain email without writing anything', async () => {
    const r = await runTool('get_email_design', { email: '1' });
    expect(r).toMatchObject({ ok: true, result: { email: 1, designed: false, theme: { id: 'brand' }, blocks: [{ type: 'text' }, { type: 'button' }] } });
    expect(email(1).doc).toBeUndefined();
  });

  it('adds, changes, moves and removes blocks, checked like the studio checks them', async () => {
    const add = await runTool('add_email_block', { email: '2', type: 'heading', fields: { text: 'A quick win', level: 1 } });
    expect(add.ok).toBe(true);
    const id = email(2).doc!.blocks[2].id;
    expect(email(2).doc!.blocks[2]).toMatchObject({ type: 'heading', text: 'A quick win', level: 1 });
    expect((await runTool('edit_email_block', { email: '2', blockId: id, fields: { text: 'Your quick win' } })).ok).toBe(true);
    expect(email(2).doc!.blocks[2]).toMatchObject({ text: 'Your quick win' });
    expect((await runTool('move_email_block', { email: '2', blockId: id, dir: 'up' })).ok).toBe(true);
    expect(email(2).doc!.blocks[1].id).toBe(id);
    expect((await runTool('remove_email_block', { email: '2', blockId: id })).ok).toBe(true);
    expect(email(2).doc!.blocks.some((b) => b.id === id)).toBe(false);
    // a value the email can't take is refused in plain words
    const bad = await runTool('add_email_block', { email: '2', type: 'image', fields: { src: 'http://insecure.example/x.png', alt: 'x' } });
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('https') });
  });

  it('never writes custom HTML: it’s pasted and cleaned in the studio', async () => {
    const r = await runTool('add_email_block', { email: '1', type: 'custom', fields: { text: '<script>x</script>' } });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('Paste custom HTML in the email studio') });
    useStore.setState((s) => ({ projects: s.projects.map((x) => ({ ...x, marketing: { ...x.marketing, emails: x.marketing.emails.map((e, i) => (i === 0 ? { ...e, doc: { v: 1, theme: { id: 'brand' }, blocks: [{ id: 'b_cccccccccc', type: 'custom', html: '<p>Mine</p>', source: 'owner' }] } } : e)) } })) }));
    expect(await runTool('edit_email_block', { email: '1', blockId: 'b_cccccccccc', fields: { text: 'x' } })).toMatchObject({ ok: false, error: expect.stringContaining('Paste custom HTML') });
  });

  it('edit_email: a designed email takes new words only while it’s still the plain shape', async () => {
    await runTool('set_email_theme', { theme: 'warm', scope: 'email', email: '3' });
    expect(email(3).doc?.theme).toEqual({ id: 'warm' });
    expect((await runTool('edit_email', { id: '3', body: 'New words.' })).ok).toBe(true);
    expect(email(3).doc!.blocks[0]).toMatchObject({ type: 'text', text: 'New words.' });
    expect(email(3).doc!.theme).toEqual({ id: 'warm' });
    await runTool('add_email_block', { email: '3', type: 'divider' });
    expect(await runTool('edit_email', { id: '3', body: 'Other words.' })).toMatchObject({ ok: false, error: expect.stringContaining('This email uses blocks: use edit_email_block') });
    // the subject isn't in the blocks
    expect((await runTool('edit_email', { id: '3', subject: 'Hello' })).ok).toBe(true);
  });

  it('set_email_theme for all emails sets the default and every designed email', async () => {
    await runTool('add_email_block', { email: '1', type: 'divider' });
    expect((await runTool('set_email_theme', { theme: 'bold', scope: 'all' })).ok).toBe(true);
    expect(project().marketing.emailTheme).toEqual({ id: 'bold' });
    expect(email(1).doc!.theme).toEqual({ id: 'bold' });
  });
});

describe('AI design', () => {
  it('asks on a card first (AI credits); no means nothing changes, yes designs it', async () => {
    let run = runTool('design_email', { email: '5' });
    await tick();
    let card = testChat().find((m) => m.role === 'card' && m.card?.state === 'pending')!;
    expect(card.card).toMatchObject({ title: 'Design this email with AI?', cost: expect.stringMatching(/1 AI request/) });
    answerCard(card.id, false);
    expect(await run).toMatchObject({ ok: false, status: 'declined' });
    expect(email(5).doc).toBeUndefined();
    run = runTool('design_email', { email: '5' });
    await tick();
    card = testChat().find((m) => m.role === 'card' && m.card?.state === 'pending')!;
    answerCard(card.id, true);
    expect(await run).toMatchObject({ ok: true, result: { designed: [5] } });
    expect(email(5).doc!.blocks.length).toBeGreaterThan(1);
    expect(email(5).doc!.blocks.some((b) => b.type === 'custom')).toBe(false);
  });

  it('“all” confirms once for every email', async () => {
    const run = runTool('design_email', { email: 'all' });
    await tick();
    const card = testChat().find((m) => m.role === 'card' && m.card?.state === 'pending')!;
    expect(card.card).toMatchObject({ title: 'Design all 5 emails with AI?', cost: expect.stringMatching(/5 AI requests/) });
    answerCard(card.id, false);
    await run;
  });
});

describe('export and agents', () => {
  it('export_email_html gives a download with the email tool’s unsubscribe tag', async () => {
    const r = await runTool('export_email_html', { email: '1', esp: 'mailchimp' });
    expect(r).toMatchObject({ ok: true, result: { tool: 'Mailchimp' } });
    const msg = testChat().filter((m) => m.role === 'activity' && m.buttons?.length).at(-1)!;
    await pressButton(msg.buttons![0].id);
    expect(saved.files[0]?.data).toContain('*|UNSUB|*');
  });

  it('has the build tools for an email and the lead magnet (they open the window; the owner sends)', () => {
    expect(registry.get('build_email_with_agent')?.class).toBe('Pub');
    expect(registry.get('build_lead_magnet_with_agent')?.class).toBe('Pub');
  });
});
