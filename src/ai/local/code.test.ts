import { afterEach, describe, expect, it, vi } from 'vitest';
import { newProject } from '@/store/defaults';
import type { Project } from '@/lib/types';
import { generateCode, parseEndDate, parseHours, widgetSettings } from './code';
import { codeEditTask, codeTask } from '../tasks';
import { resolveLeadAction } from '@/lib/leadAction';
import { hasLeadForm } from '../../../server/leads.mjs';

function business(): Project {
  const p = newProject('business', 'new');
  p.niche = 'Home Cleaning';
  p.category = 'House cleaning';
  p.businessType = 'Home Cleaning';
  p.brand.name = 'Tidy Nest';
  p.location = { city: 'Austin', region: 'TX' };
  return p;
}

function product(): Project {
  const p = newProject('product', 'new');
  p.niche = 'Personal Finance';
  p.category = 'Freelancer taxes';
  p.brand.name = 'Ledger Lane';
  return p;
}

const all = (c: { html: string; css: string; js: string }) => `${c.html}\n${c.css}\n${c.js}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('widget code makes no claims for the owner', () => {
  it('lead form in the claude.ai build: not connected until the owner sets an action, and no delivery claim', () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    const code = generateCode(product(), 'leadform', '');
    expect(code.js).toContain('var FORM_ACTION = "";');
    expect(code.js).toContain('Not connected');
    expect(code.html).toContain('Not connected: submissions are not sent');
    expect(all(code)).not.toMatch(/Check your inbox|We just sent|Unsubscribe anytime/);
    expect(code.note).toMatch(/Not connected/);
  });

  it('lead form posts to an endpoint or mailto the owner gave', () => {
    expect(generateCode(product(), 'leadform', 'opt-in form posting to https://formspree.io/f/abc123').js).toContain('var FORM_ACTION = "https://formspree.io/f/abc123";');
    expect(generateCode(product(), 'leadform', 'send signups to me@ledger.co').js).toContain('var FORM_ACTION = "mailto:me@ledger.co";');
    const p = product();
    p.studio.listing.contactEmail = 'hello@ledger.co';
    // with publishing, Email → Leads; the listing's email only in the claude.ai build
    expect(generateCode(p, 'leadform', '').js).toContain('var FORM_ACTION = "{{lead-action}}";');
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    const code = generateCode(p, 'leadform', '');
    expect(code.js).toContain('var FORM_ACTION = "mailto:hello@ledger.co";');
    expect(code.note).toMatch(/listing/);
    expect(code.html).toContain('action="mailto:hello@ledger.co"');
  });

  it('booking: no randomly taken slots, no "you are booked", times only from the owner hours', () => {
    const p = business();
    const req = generateCode(p, 'booking', '');
    expect(req.html).toContain('Book with');
    expect(all(req)).not.toMatch(/seeded|disabled=|You’re booked|confirmation is on its way/);
    expect(req.html).toContain('id="pref-day"'); // no hours: a request form
    expect(req.js).not.toContain('</' + 'script');
    p.studio.listing.hours = 'Mon–Fri 9am–5pm, Sat 10am–2pm, Sun closed';
    const slots = generateCode(p, 'booking', '');
    expect(slots.html).toContain('id="days"');
    expect(slots.js).toContain('"1":["9:00 AM"');
    expect(slots.js).not.toContain('"0":');
  });

  it('booking lists only the owner packages, never template services or prices', () => {
    const p = business();
    expect(generateCode(p, 'booking', '').html).toContain('id="svc-text"');
    p.studio.packages = [{ id: 'a', name: 'Deep clean', price: 180, description: '', includes: [], duration: '' } as unknown as Project['studio']['packages'][number]];
    const code = generateCode(p, 'booking', '');
    expect(code.html).toContain('Deep clean');
    expect(code.html).toContain('$180');
  });

  it('hero has no star row or "Loved by"', () => {
    const code = generateCode(product(), 'hero', '');
    expect(code.html).not.toMatch(/★|Loved by|Satisfaction promise|Cancel anytime/);
  });

  it('countdown needs an owner end date and never picks one', () => {
    const off = generateCode(product(), 'countdown', '');
    expect(off.js).toContain('var END_DATE = "";');
    expect(all(off)).not.toMatch(/price goes up|launch pricing/i);
    const on = generateCode(product(), 'countdown', 'countdown, offer ends 2026-12-01');
    expect(on.js).toContain('var END_DATE = "2026-12-01T23:59";');
  });

  it('testimonials: placeholders, or what the owner entered', () => {
    const p = product();
    const ph = generateCode(p, 'testimonials', '');
    expect(ph.html).toContain('[Customer quote]');
    expect(ph.html).not.toMatch(/Jordan|Priya|Marcus|★/);
    p.marketing.salesPage = {
      sections: [
        {
          id: 's',
          type: 'proof',
          visible: true,
          data: {
            heading: '',
            stats: [],
            testimonials: [
              { quote: 'Saved my quarter.', name: 'Ana R.', role: 'Designer', rating: 0 },
              { quote: 'AI wrote this one.', name: 'Made Up', role: '', rating: 5, needsReview: true },
            ],
          },
        },
      ],
      theme: { font: 'sans', mode: 'light', radius: 'soft' },
      updatedAt: 0,
    } as unknown as Project['marketing']['salesPage'];
    const own = generateCode(p, 'testimonials', '');
    expect(own.html).toContain('Saved my quarter.');
    expect(own.html).not.toContain('Made Up');
    expect(own.html).not.toContain('[Customer quote]');
  });

  it('quote calculator shows no invented "next available" date', () => {
    const code = generateCode(business(), 'calculator', 'instant quote calculator');
    expect(all(code)).not.toMatch(/Next available/);
  });

  it('pricing has no invented tiers, features or discounts', () => {
    const code = generateCode(product(), 'pricing', '');
    expect(code.html).not.toMatch(/Lifetime updates|save 20%|VIP|Priority support|Pay once, keep forever/);
  });

  it('links never point at a domain made up from the brand name', () => {
    for (const kind of ['calculator', 'hero', 'pricing', 'countdown'] as const) {
      const code = generateCode(product(), kind, '');
      expect(code.html).not.toMatch(/ledgerlane\.com|yourbrand\.com/i);
      expect(code.html).toContain('href="#"');
    }
  });
});

describe('owner settings parsing', () => {
  it('reads common opening-hours formats', () => {
    const h = parseHours('Mon-Fri 9-5; Saturday 10:00–14:00')!;
    expect(h[1]).toEqual(['9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM']);
    expect(h[6]).toEqual(['10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM']);
    expect(h[0]).toBeUndefined();
    expect(parseHours('Weekdays 8am-12pm')![3]).toHaveLength(4);
    expect(parseHours('By appointment')).toBeNull();
    expect(parseHours('9am-5pm')).toBeNull(); // no days given: don't guess them
    expect(parseHours('')).toBeNull();
  });

  it('reads an end date only when the owner wrote one', () => {
    expect(parseEndDate('no date here')).toBe('');
    expect(parseEndDate('ends Dec 1', '2026-11-03')).toBe('2026-12-01T23:59');
    expect(parseEndDate('until March 5th', '2026-11-03')).toBe('2027-03-05T23:59');
    expect(parseEndDate('closes 2026-12-24 18:00')).toBe('2026-12-24T18:00');
  });

  it('never reads ordinary words as a month and day', () => {
    for (const text of ['marketing 3 ways', 'decide 2 options', 'octopus 12 legs', 'a junky 4 step plan', 'make it 3 columns', 'augment 5 fields', 'top 10 tips'])
      expect(parseEndDate(text, '2026-11-03'), text).toBe('');
    expect(parseEndDate('countdown until December 1, 2026', '2026-11-03')).toBe('2026-12-01T23:59');
    expect(parseEndDate('sale ends Sept 30', '2026-11-03')).toBe('2027-09-30T23:59');
    expect(parseEndDate('ends Feb 30')).toBe('');
    expect(parseEndDate('ends 2026-13-01')).toBe('');
    expect(parseEndDate('ends Dec 3pm')).toBe('');
  });

  it('uses a URL as the form target only when the request says so', () => {
    const p = business();
    // otherwise Email → Leads
    expect(widgetSettings(p, 'like the one on https://competitor.com/contact').action).toBe('{{lead-action}}');
    expect(widgetSettings(p, 'see https://example.org for inspiration and add a lead form').action).toBe('{{lead-action}}');
    expect(widgetSettings(p, 'my email is me@x.co, add it to the footer')).toMatchObject({ action: '{{lead-action}}', actionFrom: 'leads' });
    expect(widgetSettings(p, 'form action https://hooks.example.org/a').action).toBe('https://hooks.example.org/a');
    expect(widgetSettings(p, 'endpoint: https://api.example.org/f').action).toBe('https://api.example.org/f');
    expect(widgetSettings(p, 'submit signups to https://x.example.org/s').action).toBe('https://x.example.org/s');
    expect(widgetSettings(p, 'use mailto:me@x.co').action).toBe('mailto:me@x.co');
  });

  it('keeps every opening hour, including long days', () => {
    const h = parseHours('Mon-Sun 6am-10pm')!;
    expect(h[1]).toHaveLength(16);
    expect(h[1][0]).toBe('6:00 AM');
    expect(h[1][15]).toBe('9:00 PM');
  });

  it('collects the form action, end date and hours', () => {
    const p = business();
    p.studio.listing.hours = 'Daily 8am-4pm';
    expect(widgetSettings(p, 'post to https://example.org/hook.')).toEqual({ action: 'https://example.org/hook', actionFrom: 'prompt', endDate: '', hours: 'Daily 8am-4pm' });
  });
});

describe('more widget honesty', () => {
  it('quote calculator uses only the owner packages and prices, else placeholders', () => {
    const ph = generateCode(business(), 'calculator', 'instant quote calculator');
    expect(ph.html).toContain('[Service 1]');
    expect(all(ph)).not.toMatch(/Standard clean|Deep clean|sq ft|Every 2 weeks|Monthly/);
    expect(ph.js).toContain('[Price on request]');
    expect(ph.note).toMatch(/placeholders/);
    const p = business();
    p.studio.packages = [
      { id: 'a', name: 'Move-out clean', price: 240, priceModel: 'fixed', description: '', includes: [] },
      { id: 'b', name: 'Window wash', price: 0, priceModel: 'fixed', description: '', includes: [] },
    ] as unknown as Project['studio']['packages'];
    const own = generateCode(p, 'calculator', 'instant quote calculator');
    expect(own.html).toContain('<option value="240" selected>Move-out clean</option>');
    expect(own.html).toContain('Window wash [set a price]');
    expect(own.html).not.toContain('[Service 1]');
  });

  it('countdown with a price makes no "until the timer runs out" claim', () => {
    const p = product();
    p.studio.price = 49;
    const code = generateCode(p, 'countdown', '');
    expect(code.html).not.toMatch(/until the timer runs out/);
    expect(code.html).toContain('$49');
  });

  it('FAQ answers are placeholders or the owner answers, never templated claims', () => {
    const p = business();
    const code = generateCode(p, 'faq', '');
    expect(code.html).toContain('[Your answer]');
    expect(code.html).not.toMatch(/built for exactly this|Totally fair|Good question/);
    expect(code.html).not.toMatch(/Book online at\s+or/);
    expect(code.html).toContain('[How customers book');
    p.brand.websiteUrl = 'https://tidynest.example';
    expect(generateCode(p, 'faq', '').html).toContain('Book online at tidynest.example');
    p.marketing.salesPage = {
      sections: [{ id: 'f', type: 'faq', visible: true, data: { heading: '', items: [{ q: 'Do you bring supplies?', a: 'Yes, all of them.' }] } }],
      theme: { font: 'sans', mode: 'light', radius: 'soft' },
      updatedAt: 0,
    } as unknown as Project['marketing']['salesPage'];
    const own = generateCode(p, 'faq', '');
    expect(own.html).toContain('Yes, all of them.');
    expect(own.html).not.toContain('[Your answer]');
  });

  it('buttons with no website use "#" with a TODO, never an empty href', () => {
    for (const kind of ['calculator', 'hero', 'pricing', 'countdown', 'quiz'] as const) {
      const code = generateCode(product(), kind, '');
      expect(all(code), kind).not.toMatch(/href=""|href=''/);
      expect(all(code), kind).toMatch(/TODO: no website set yet/);
    }
    const p = product();
    p.brand.websiteUrl = 'https://ledger.example';
    expect(generateCode(p, 'hero', '').html).not.toMatch(/TODO: no website/);
  });

  it('spreadsheet preview rows are labelled as examples', () => {
    const code = generateCode(product(), 'spreadsheet', '');
    expect(code.html).toMatch(/Example rows/);
    expect(code.html).not.toContain('Client payment');
    expect(code.html).toContain('Example: payment');
  });

  it('Claude prompts for new and edited widgets carry the honesty rules', () => {
    const env = { project: business(), directives: {}, brainPrompt: '', variation: 0 };
    const gen = codeTask.claude!.prompt({ kind: 'faq', prompt: '' }, env, codeTask.local({ kind: 'faq', prompt: '' }, env));
    const code = { html: '<p>x</p>', css: '', js: '' };
    const edit = codeEditTask.claude!.prompt({ code, instruction: 'make it more convincing' }, env, codeEditTask.local({ code, instruction: '' }, env));
    for (const prompt of [gen, edit]) {
      expect(prompt).toMatch(/Never invent reviews, star ratings/);
      expect(prompt).toMatch(/customer counts/);
      expect(prompt).toMatch(/deadlines/);
      expect(prompt).toMatch(/never claim anything was sent, delivered/);
    }
  });
});

describe('generated script', () => {
  it('parses for every kind', () => {
    const p = business();
    p.studio.listing.hours = 'Mon-Fri 9am-5pm';
    for (const kind of ['calculator', 'leadform', 'pricing', 'hero', 'countdown', 'quiz', 'checklist', 'testimonials', 'booking', 'spreadsheet', 'faq', 'roi'] as const) {
      const code = generateCode(p, kind, '');
      expect(() => new Function(code.js), kind).not.toThrow();
    }
  });
});

describe('form widgets, published', () => {
  it('pass the server’s own check for a lead form', () => {
    for (const kind of ['leadform', 'booking', 'quiz', 'calculator', 'roi', 'checklist'] as const) {
      const code = generateCode(kind === 'booking' ? business() : product(), kind, '');
      expect(hasLeadForm(resolveLeadAction(code.html, '/my-widget/lead'), 'my-widget')).toBe(true);
      expect(hasLeadForm(code.html, 'my-widget')).toBe(false);
    }
  });
});
