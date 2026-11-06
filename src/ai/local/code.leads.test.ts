// @vitest-environment happy-dom
// Widgets that send to Email → Leads: each is a real <form method="post" action="{{lead-action}}"> with named
// fields, the hidden field bots fill in and the unticked consent box, which the server's own check accepts once
// it's published. Their scripts send it with fetch (Accept: application/json) and show the answer; still the
// placeholder (the preview), they send nothing. Quizzes, calculators and checklists add an email step.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newProject } from '@/store/defaults';
import type { CodeKind, Project } from '@/lib/types';
import { resolveLeadAction } from '@/lib/leadAction';
import { generateCode, modifyCode } from './code';

function product(): Project {
  const p = newProject('product', 'new');
  p.niche = 'Personal Finance';
  p.category = 'Freelancer taxes';
  p.brand.name = 'Ledger Lane';
  return p;
}
function business(): Project {
  const p = newProject('business', 'new');
  p.niche = 'Home Cleaning';
  p.businessType = 'Home Cleaning';
  p.brand.name = 'Tidy Nest';
  return p;
}

const FORM_KINDS: [CodeKind, string, () => Project][] = [
  ['leadform', 'lead', product],
  ['booking', 'booking', business],
  ['quiz', 'quiz', product],
  ['calculator', 'calculator', product],
  ['roi', 'roi', product],
  ['checklist', 'checklist', product],
];

describe('every form widget', () => {
  it.each(FORM_KINDS)('%s is a real form that posts to Email → Leads', (kind, leadKind, make) => {
    const code = generateCode(make(), kind, '');
    expect(code.html).toMatch(/<form id="[a-z-]+" method="post" action="\{\{lead-action\}\}" novalidate>/);
    expect(code.html).toContain(`<input type="hidden" name="kind" value="${leadKind}" />`);
    expect(code.html).toMatch(/<div class="hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off" \/><\/label><\/div>/);
    // the consent box: unticked, and only "yes" counts
    expect(code.html).toContain('<input type="checkbox" name="consent" value="yes" />');
    expect(code.html).not.toMatch(/name="consent"[^>]*checked/);
    expect(code.html).toContain('Email me tips and offers from');
    expect(code.html).toMatch(/receives what you send here\./);
    expect(code.html).toMatch(/name="email" maxlength="254"/);
    expect(code.js).toContain('var FORM_ACTION = "{{lead-action}}";');
    expect(code.note).toMatch(/Once published, submissions go to Email → Leads\./);
  });

  it('an endpoint or mailto: the owner asked for wins', () => {
    const url = generateCode(product(), 'quiz', 'quiz that posts to https://hooks.example.org/q');
    expect(url.js).toContain('var FORM_ACTION = "https://hooks.example.org/q";');
    expect(url.html).toContain('action="https://hooks.example.org/q"');
    const mail = generateCode(product(), 'leadform', 'send signups to me@ledger.co');
    expect(mail.js).toContain('var FORM_ACTION = "mailto:me@ledger.co";');
  });

  it('the email step is left out when asked (a directive, or the request)', () => {
    for (const kind of ['quiz', 'calculator', 'roi', 'checklist'] as CodeKind[]) {
      expect(generateCode(product(), kind, '', { noEmailStep: true }).html).not.toContain('<form id="mail-form"');
      expect(generateCode(product(), kind, 'no email step please').html).not.toContain('<form id="mail-form"');
      expect(generateCode(product(), kind, '').html).toContain('<form id="mail-form"');
    }
  });

  it('“remove the email step” hides it in an existing widget', () => {
    const code = generateCode(product(), 'quiz', '');
    const out = modifyCode(code, 'remove the email step');
    expect(out.css).toContain('.ylb-mail { display: none !important; }');
    expect(out.applied).toContain('Email step hidden');
    expect(modifyCode(code, 'make it blue').applied).not.toContain('Email step hidden');
  });

  it('a lead form hands out the published lead magnet', () => {
    const p = product();
    p.marketing.leadMagnet = { id: 'lm', type: 'checklist', title: 'Tax checklist', subtitle: '', intro: '', sections: [], cta: '', optInHeadline: '', optInBullets: [], buttonLabel: '', createdAt: 0, delivery: { source: 'pdf', fileId: 'AbCdEfGhIjKlMnOpQrStUv', link: 'https://app.example/m/AbCdEfGhIjKlMnOpQrStUv', gate: true, publishedAt: 1 } };
    const code = generateCode(p, 'leadform', '');
    expect(code.html).toContain('<input type="hidden" name="magnet" value="AbCdEfGhIjKlMnOpQrStUv" />');
    expect(code.html).toContain('<input type="hidden" name="request" value="Tax checklist" maxlength="200" />');
    expect(generateCode(product(), 'leadform', '').html).not.toContain('name="magnet"');
  });
});

// ── the scripts, in a page ──

type Sent = { url: string; init: RequestInit };
let sent: Sent[] = [];
let reply: () => Response = () => new Response(JSON.stringify({ ok: true, title: 'Thank you', text: 'Your message was sent.' }), { status: 200, headers: { 'content-type': 'application/json' } });

function mount(code: { html: string; js: string }, action: string | null) {
  const fill = (t: string) => (action === null ? t : resolveLeadAction(t, action));
  document.body.innerHTML = fill(code.html);
  new Function(fill(code.js))();
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const submit = (id: string) => (document.getElementById(id) as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
const body = (s: Sent) => new URLSearchParams(String(s.init.body));

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), init });
      return reply();
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('widget scripts', () => {
  it('a quiz sends its result, score and answers with the email', async () => {
    mount(generateCode(product(), 'quiz', ''), '/tax-quiz/lead');
    expect((document.getElementById('ylb-mail') as HTMLElement).hidden).toBe(true);
    for (let i = 0; i < 5; i++) (document.querySelector('#q .answers button[data-k="2"]') as HTMLButtonElement).click();
    expect((document.getElementById('ylb-mail') as HTMLElement).hidden).toBe(false);
    (document.querySelector('#mail-form input[name=email]') as HTMLInputElement).value = 'ana@example.com';
    (document.querySelector('#mail-form input[name=consent]') as HTMLInputElement).checked = true;
    submit('mail-form');
    await flush();
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('/tax-quiz/lead');
    expect(new Headers(sent[0].init.headers).get('accept')).toBe('application/json');
    const b = body(sent[0]);
    expect(b.get('kind')).toBe('quiz');
    expect(b.get('email')).toBe('ana@example.com');
    expect(b.get('consent')).toBe('yes');
    expect(b.get('result')).toBe('Nearly there');
    expect(b.get('score')).toBe('100');
    expect(b.get('answers')!.split('\n')).toHaveLength(5);
    expect(b.get('answers')).toMatch(/^Q1: /);
    expect(b.get('website')).toBe('');
    // never says an email went to the visitor
    expect(document.getElementById('mail-ok')!.textContent).toBe('Thanks. Ledger Lane has your result and your email.');
  });

  it('still the placeholder (the preview): sends nothing and says so', async () => {
    mount(generateCode(product(), 'leadform', ''), null);
    (document.getElementById('email') as HTMLInputElement).value = 'ana@example.com';
    submit('optin');
    await flush();
    expect(sent).toHaveLength(0);
    expect(document.getElementById('err')!.textContent).toBe('This is a preview. Published, this form sends to your Leads.');
  });

  it('a lead form shows the download the server gives after the sign-up', async () => {
    reply = () => new Response(JSON.stringify({ ok: true, title: 'Thank you', text: 'Your message was sent.', download: '/m/AbCdEfGhIjKlMnOpQrStUv?k=abc.def' }), { status: 200 });
    mount(generateCode(product(), 'leadform', ''), 'https://app.example/guide/lead');
    (document.getElementById('email') as HTMLInputElement).value = 'ana@example.com';
    submit('optin');
    await flush();
    await flush();
    expect(body(sent[0]).get('kind')).toBe('lead');
    const dl = document.getElementById('dl') as HTMLAnchorElement;
    expect(dl.hidden).toBe(false);
    expect(dl.getAttribute('href')).toBe('https://app.example/m/AbCdEfGhIjKlMnOpQrStUv?k=abc.def');
  });

  it('a refusal shows the server’s words, and nothing claims it was sent', async () => {
    reply = () => new Response(JSON.stringify({ ok: false, title: 'Please wait a little', text: 'Too many messages were sent from here just now. Try again later.' }), { status: 429 });
    mount(generateCode(product(), 'calculator', ''), '/calc/lead');
    (document.querySelector('#mail-form input[name=email]') as HTMLInputElement).value = 'ana@example.com';
    submit('mail-form');
    await flush();
    await flush();
    expect(body(sent[0]).get('kind')).toBe('calculator');
    expect(body(sent[0]).get('inputs')).toMatch(/: /);
    expect(body(sent[0]).get('outputs')).toMatch(/: /);
    expect(document.getElementById('mail-err')!.textContent).toBe('Too many messages were sent from here just now. Try again later.');
    expect((document.getElementById('mail-ok') as HTMLElement).hidden).toBe(true);
  });

  it('a booking sends its service and time', async () => {
    mount(generateCode(business(), 'booking', ''), '/book/lead');
    (document.getElementById('svc-text') as HTMLInputElement).value = 'Deep clean';
    (document.getElementById('pref-day') as HTMLInputElement).value = '2026-12-01';
    (document.getElementById('name') as HTMLInputElement).value = 'Ana';
    (document.getElementById('email') as HTMLInputElement).value = 'ana@example.com';
    submit('book');
    await flush();
    await flush();
    const b = body(sent[0]);
    expect(b.get('kind')).toBe('booking');
    expect(b.get('service')).toBe('Deep clean');
    expect(b.get('time')).toBe('2026-12-01');
  });
});
