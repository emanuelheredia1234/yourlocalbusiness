import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import { BUSINESS_TYPES, GENERIC_BUSINESS, NICHES } from '../knowledge';
import { generateBusinessModel } from './studio';
import { buildFacts } from '../text';

/** Offers, service standards and targets the operating-model data used to state as fact. */
const OFFERS =
  /\bfree\b|instant|2-hour|48 and 2|20-minute|eco-friendly|body composition|under \d|\d\.\d\+|within \d|same[- ]day|24\/7|guarantee|warranty and|stocked|flat-rate|pro-grade|secure client portal|commercial mowers|auto-scheduled|satellite/i;
/** Niche wishes that read as a service standard if they ever end up in a headline. */
const STANDARDS =
  /on-time|tidy|trusted|you can trust|quick turnaround|transparent pricing|fixed pricing|fair pricing|first time|on call|stress-free|a budget that holds|for years|packed dining room|in \d+ (minutes|hours?)|\d+-minute|\d+ hours? a week|5-star|above 100%|every week|in weeks/i;

const TYPES = [...BUSINESS_TYPES, GENERIC_BUSINESS];

describe('operating-model data states no invented offers or standards', () => {
  it('bookingFlow, tools and kpis are neutral for every business type', () => {
    for (const bt of TYPES) {
      for (const s of [...bt.bookingFlow, ...bt.tools, ...bt.kpis]) {
        // placeholder text in [brackets] is a question for the owner, not a claim
        expect(s.replace(/\[[^\]]*\]/g, ''), `${bt.id}: ${s}`).not.toMatch(OFFERS);
        expect(s.trim().length).toBeGreaterThan(1);
        // brackets stay balanced so placeholders render as one unit
        expect((s.match(/\[/g) ?? []).length, s).toBe((s.match(/\]/g) ?? []).length);
      }
    }
  });

  it('KPIs carry no invented targets', () => {
    for (const bt of TYPES) for (const k of bt.kpis) expect(k, `${bt.id}: ${k}`).not.toMatch(/\d+(\.\d+)?\s*(%|\+)|\bunder\b|\babove\b|\bover \d/i);
  });

  it('niche wishes read as what customers want, not as promises', () => {
    for (const n of NICHES) for (const d of n.desires) expect(d, `${n.id}: ${d}`).not.toMatch(STANDARDS);
  });

  it('the generated plan never contains the removed phrases, across types and variations', () => {
    const removed =
      /2-hour arrival|instant price estimate|reminder texts 48|free 20-minute fit call|free assessment|free intro session|free local pickup|digital invoice, warranty|eco-friendly supply|body composition scanner|re-clean rate under|review rating 4\.8/i;
    for (const bt of BUSINESS_TYPES) {
      const p = newProject('business', 'new');
      p.niche = bt.label;
      p.businessType = bt.label;
      p.category = bt.label;
      p.location = { city: 'Austin', region: 'TX' };
      p.brand.name = 'Summit Co';
      expect(buildFacts(p).business?.id).toBeDefined();
      for (let v = 0; v < 4; v++) {
        const bm = generateBusinessModel(p, {}, v);
        const items = bm.operating.flatMap((b) => b.items);
        expect(items.length).toBeGreaterThan(0);
        for (const it of items) {
          expect(it, `${bt.id}: ${it}`).not.toMatch(removed);
          expect(it.trim()).not.toBe('');
        }
      }
    }
  });
});
