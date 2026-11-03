import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { ProductIdea, Project } from '@/lib/types';
import { purgeResearch } from './research';

/** An idea as older versions saved it: a made-up score, revenue range and market "signals". */
function oldIdea(id: string, angle = 'Beginner foundation'): ProductIdea {
  return {
    id,
    title: 'The Freelancer Tax Tracking Spreadsheet',
    hook: 'Stop surprise tax bills.',
    audience: 'freelancers',
    pain: 'Surprise tax bills',
    solution: 'A plug-and-play spreadsheet.',
    format: 'spreadsheet',
    price: 29,
    priceModel: 'one-time',
    angle,
    features: ['Works in Google Sheets and Excel'],
    score: 87,
    revenueLow: 1240,
    revenueHigh: 3270,
    signals: ['Steady search interest for “freelancer tax tracking spreadsheet” style queries', 'Few spreadsheets target freelancers specifically'],
  } as unknown as ProductIdea;
}

function oldProject(): Project {
  const p = newProject('product', 'new');
  p.niche = 'Personal Finance';
  p.category = 'Freelancer Tax Tracking';
  p.format = 'spreadsheet';
  p.ideas = [oldIdea('idea_1'), oldIdea('idea_2', 'Underserved micro-niche')];
  p.idea = oldIdea('idea_1');
  p.studio.price = 29;
  return p;
}

describe('purgeResearch', () => {
  it('strips the invented score, revenue range and signals from ideas and the chosen idea', () => {
    const out = purgeResearch(oldProject());
    expect(out).not.toBeNull();
    for (const i of [...out!.ideas, out!.idea!]) {
      for (const k of ['score', 'revenueLow', 'revenueHigh', 'signals']) expect(i).not.toHaveProperty(k);
      expect(i.price).toBe(29);
      expect(i.title).toBe('The Freelancer Tax Tracking Spreadsheet');
      expect(i.fit.length).toBeGreaterThan(0);
      expect(i.fit.join(' ')).toContain('Freelancer Tax Tracking');
      expect(i.fit.join(' ')).not.toMatch(/search interest|competition|revenue/i);
    }
    expect(out!.ideas[1].angle).toBe('Focused micro-niche');
    expect(out!.idea!.id).toBe('idea_1');
    expect(out!.studio.price).toBe(29);
  });

  it('changes nothing the second time', () => {
    const once = purgeResearch(oldProject())!;
    expect(purgeResearch(once)).toBeNull();
  });

  it('leaves a project with no ideas, or clean ideas, alone', () => {
    expect(purgeResearch(newProject('product', 'new'))).toBeNull();
    const p = oldProject();
    p.ideas = [];
    p.idea = null;
    expect(purgeResearch(p)).toBeNull();
  });

  it('keeps reasons an idea already has', () => {
    const p = oldProject();
    p.idea = { ...oldIdea('idea_9'), fit: ['Made for freelancers.'] };
    const out = purgeResearch(p)!;
    expect(out.idea!.fit).toEqual(['Made for freelancers.']);
    expect(out.idea).not.toHaveProperty('score');
  });
});
