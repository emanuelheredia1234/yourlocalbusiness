import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { Project } from '@/lib/types';
import { TEMPLATE_PLACEHOLDERS, brainPrompt, extractFacts, newSkill, parseDirectives, templatePlaceholders, withoutTemplateLines } from './brain';
import { generateEmailSequence, generateLeadMagnet } from './local/email';
import { composePost } from './local/social';

const TEMPLATE = 'Facts you can use:\n- Founded in [Year founded].\n- [Number of customers] customers served.\n- [Average rating and where it comes from].\n- [Licences or certifications].';

function project(website = ''): Project {
  const p = newProject('product', 'new');
  p.niche = 'Personal Finance';
  p.category = 'Freelancer Tax Tracking';
  p.format = 'spreadsheet';
  p.brand = { ...p.brand, name: 'Ledgerly', websiteUrl: website };
  p.studio.price = 49;
  return p;
}

describe('Proof points template placeholders', () => {
  it('finds only the template placeholders, not other brackets', () => {
    expect(templatePlaceholders(TEMPLATE)).toEqual([...TEMPLATE_PLACEHOLDERS]);
    expect(templatePlaceholders('He said it was "the best [sic] cleaner" [1]. See [our site](https://x.test).')).toEqual([]);
  });

  it('never parses an unfilled template line as a fact', () => {
    expect(parseDirectives(TEMPLATE).facts).toBeUndefined();
    const mixed = 'Facts you can use:\n- Founded in 2009.\n- [Number of customers] customers served.\n- Fully insured.';
    expect(parseDirectives(mixed).facts).toEqual(['Founded in 2009.', 'Fully insured.']);
  });

  it('keeps unfilled lines out of the Brain prompt', () => {
    const skill = newSkill({ name: 'Proof points', category: 'knowledge', instructions: 'Facts you can use:\n- Founded in 2009.\n- [Number of customers] customers served.' });
    const prompt = brainPrompt([skill], parseDirectives(skill.instructions));
    expect(prompt).toContain('Founded in 2009.');
    for (const ph of TEMPLATE_PLACEHOLDERS) expect(prompt).not.toContain(ph);
    expect(withoutTemplateLines('a\n- [Year founded].\nb')).toBe('a\nb');
  });

  it('does not extract template lines from documents as facts', () => {
    const text = 'We have been cleaning homes since [Year founded] for families across the city. We have served 300 customers in the last two years across Austin.';
    expect(extractFacts(text)).toEqual(['We have served 300 customers in the last two years across Austin.']);
  });
});

describe('email and social copy without a website', () => {
  it('uses a placeholder link in the lead magnet CTA and no invented deadline or perks in the pitch', () => {
    const p = project();
    const lm = generateLeadMagnet(p, 'checklist');
    expect(lm.cta).toMatch(/→ \[link to your offer\]$/);
    expect(generateLeadMagnet(project('https://ledgerly.test'), 'checklist').cta).toMatch(/→ ledgerly\.test$/);
    for (let i = 0; i < 6; i++) {
      const e5 = generateEmailSequence(p, lm, {}, i)[4];
      const all = `${e5.subject}\n${e5.preview}\n${e5.body}\n${e5.purpose}`;
      expect(all).not.toMatch(/48 hours|launch bonus|instant access|lifetime updates|priority email support|quick-start session|urgency/i);
      expect(e5.body).toContain('[Anything else you include]');
    }
  });

  it('watermarks with the brand mark and never ends a sales storyboard on an empty scene', () => {
    const p = project();
    const post = composePost(p, { topic: 'Launch', postType: 'sales', platform: 'instagram', format: 'video', style: 'kinetic', watermark: true });
    expect(post.visualPrompt).toContain('watermark “Ledgerly”');
    expect(post.storyboard?.at(-1)?.text).toBe('Ledgerly');
  });
});
