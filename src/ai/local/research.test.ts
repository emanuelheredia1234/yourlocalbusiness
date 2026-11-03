import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { ProductIdea } from '@/lib/types';
import { productIdeasTask, type TaskEnv } from '../tasks';
import { fitReasons, generateProductIdeas } from './research';

const input = { niche: 'Personal Finance', category: 'Freelancer Tax Tracking', format: 'spreadsheet' as const, count: 3 };

describe('product ideas', () => {
  it('are suggestions with reasons from the owner’s inputs, not scores or forecasts', () => {
    const ideas = generateProductIdeas(input);
    expect(ideas).toHaveLength(3);
    for (const i of ideas) {
      for (const k of ['score', 'revenueLow', 'revenueHigh', 'signals']) expect(i).not.toHaveProperty(k);
      expect(i.price).toBeGreaterThan(0);
      expect(i.fit.some((r) => r.includes('Freelancer Tax Tracking'))).toBe(true);
      expect(i.angle).not.toMatch(/underserved/i);
    }
  });

  it('gives the same suggested price every time for the same inputs', () => {
    const a = generateProductIdeas(input);
    const b = generateProductIdeas({ ...input, variation: 3 });
    const priceOf = (xs: ProductIdea[], angle: string) => xs.find((x) => x.angle === angle)?.price;
    for (const x of a) if (priceOf(b, x.angle) !== undefined) expect(priceOf(b, x.angle)).toBe(x.price);
  });

  it('explains the fit from the angle, audience, problem and format', () => {
    const r = fitReasons({ niche: 'Fitness', category: 'Postpartum Mobility', format: 'course', audience: 'new moms', pain: 'Back pain after birth', angle: 'Beginner foundation' });
    expect(r).toEqual([
      'Starts from the basics, for new moms who are new to this.',
      'Made for new moms, around one problem: back pain after birth.',
      'A course on “Postpartum Mobility”: the topic and format you chose.',
    ]);
    // an angle we don't know (from an AI) just skips the angle reason
    expect(fitReasons({ niche: 'Fitness', category: '', format: 'course', audience: '', pain: '', angle: 'Something else' })).toEqual(['Made for your buyers.', 'A course on “Fitness”: the topic and format you chose.']);
  });

  it('drops invented numbers from an AI answer and keeps or fills in the reasons', () => {
    const base = generateProductIdeas(input);
    const raw = [
      { title: 'Tax Buckets', audience: 'Etsy sellers', pain: 'Surprise tax bills', price: 31.4, angle: 'Beginner foundation', score: 94, revenueLow: 2000, revenueHigh: 9000, signals: ['High search volume'] },
      { title: 'Quarterly Estimates Kit', fit: ['Fits freelancers you already serve.', 42, ''] },
    ];
    const env: TaskEnv = { project: newProject('product', 'new'), directives: {}, brainPrompt: '', variation: 0 };
    const out = productIdeasTask.claude!.merge(raw, base, input, env);
    expect(out).toHaveLength(2);
    for (const i of out) for (const k of ['score', 'revenueLow', 'revenueHigh', 'signals']) expect(i).not.toHaveProperty(k);
    expect(out[0].price).toBe(31);
    expect(out[0].fit[0]).toBe('Starts from the basics, for Etsy sellers who are new to this.');
    expect(out[1].fit).toEqual(['Fits freelancers you already serve.']);
    const prompt = productIdeasTask.claude!.prompt(input, env, base);
    expect(prompt).not.toMatch(/"score"|revenueLow|"signals"|winning|high-converting/i);
    expect(prompt).toContain('no market data');
  });
});
