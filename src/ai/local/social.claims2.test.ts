import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { PostPlatform, PostType, Project, StyleId, Tone } from '@/lib/types';
import { generateBusinessModel, generateListing } from './studio';
import { composePost, defaultCampaign, generateCampaignPlan, offerKeyMessage, suggestTopics } from './social';
import { generateProductIdeas } from './research';
import { buildFacts, genericNiche, Voice } from '../text';

/** Result promises, owner actions, invented services and owner beliefs the copy used to state as fact. */
const CLAIMS =
  /you[’']ll |for two weeks|removes [^.|]* before it starts|fixes it|helps [^.|]* (get|save|build|make) |imagine next month|without [^.|]* again|never worry|runs itself|we checked|i read every one|i[’']ll send|will send you|book a consultation|strategy call|start the program|get the framework|don[’']t share this often|love most|deserves our best|every [^.|]* we talk to|is common and fixable|simple system|built to help|save hours|5 hours|costs less than|can help|easy fix|cheaper than|quality comes from|need a system|why so many [^.|]* stay stuck|the lesson:/i;

function business(type = 'Home Cleaning', category = 'Eco-friendly house cleaning'): Project {
  const p = newProject('business', 'new');
  p.niche = type;
  p.category = category;
  p.businessType = type;
  p.location = { city: 'Austin', region: 'TX' };
  p.brand.name = 'Summit Co';
  const bm = generateBusinessModel(p);
  p.studio.packages = bm.packages;
  p.studio.price = bm.price;
  p.studio.listing = generateListing(p);
  return p;
}

function product(): Project {
  const p = newProject('product', 'new');
  p.niche = 'Personal Finance';
  p.category = 'Freelancer Tax Tracking';
  p.format = 'spreadsheet';
  p.idea = generateProductIdeas({ niche: p.niche, category: p.category, format: 'spreadsheet', count: 1 })[0];
  p.studio.price = p.idea.price;
  p.brand.name = 'Ledger Lane';
  return p;
}

function generic(): Project {
  const p = newProject('product', 'new');
  p.niche = 'Underwater basket weaving';
  p.category = 'Basket weaving';
  p.format = 'ebook';
  p.brand.name = 'Reed & Co';
  return p;
}

const projects = () => [business(), business('Auto repair', 'Brake repair'), business('Accounting', 'Bookkeeping'), product(), generic()];
const TYPES: PostType[] = ['educational', 'tip', 'question', 'sales', 'bts'];
const PLATFORMS: PostPlatform[] = ['instagram', 'facebook', 'linkedin', 'x', 'tiktok'];
const TONES: Tone[] = ['friendly', 'professional', 'bold', 'playful', 'luxury', 'empathetic', 'witty', 'authoritative'];

describe('social posts state no results, owner actions or invented facts', () => {
  it('composes captions, headlines and storyboards without claims across variations', () => {
    for (const p of projects()) {
      const f = buildFacts(p);
      for (const postType of TYPES) {
        for (let seed = 0; seed < 24; seed++) {
          const platform = PLATFORMS[seed % PLATFORMS.length];
          const format = seed % 3 === 0 ? 'video' : 'image';
          const style = (format === 'video' ? 'kinetic' : 'minimal') as StyleId;
          const d = { tone: TONES[seed % TONES.length], length: (['short', 'medium', 'long'] as const)[seed % 3], framework: (['PAS', 'AIDA', 'BAB'] as const)[seed % 3] };
          const c = composePost(p, { topic: `Topic ${seed}`, postType, platform, format, style }, d, seed);
          const text = [c.headline, c.caption, c.visualPrompt, ...(c.storyboard ?? []).map((s) => s.text)].join(' | ');
          expect(text, text).not.toMatch(CLAIMS);
          expect(c.caption.trim().length).toBeGreaterThan(10);
          expect(c.caption).not.toMatch(/undefined|\bnull\b|\.\.(?!\.)/);
          // niche wishes ("a mechanic you can trust", "quick turnarounds") are never stated, only asked
          for (const w of f.wishes) {
            const i = c.caption.toLowerCase().indexOf(w.toLowerCase());
            if (i >= 0) expect(c.caption.slice(i + w.length, i + w.length + 1)).toBe('?');
          }
        }
      }
    }
  });

  it('varies captions', () => {
    const p = business();
    const caps = new Set(Array.from({ length: 12 }, (_, s) => composePost(p, { topic: 'Spring clean', postType: 'sales', platform: 'facebook', format: 'image', style: 'minimal' }, {}, s).caption));
    expect(caps.size).toBeGreaterThan(3);
  });

  it('plans key messages and topics without promises', () => {
    for (const p of projects()) {
      for (let variation = 0; variation < 3; variation++) {
        const plan = generateCampaignPlan(p, defaultCampaign(), {}, variation);
        const text = [plan.strategy, ...plan.weeks.map((w) => `${w.goal} ${w.keyMessage}`), ...plan.days.flatMap((d) => d.slots.map((s) => s.topic))].join(' | ');
        expect(text).not.toMatch(CLAIMS);
      }
      expect(suggestTopics(p).join(' | ')).not.toMatch(CLAIMS);
    }
    expect(offerKeyMessage('Summit Co')).toBe('Summit Co: what it is, who it’s for, and what it costs.');
  });
});

describe('hooks and calls to action promise nothing the owner did not say', () => {
  it('writes hooks and CTAs without claims for every tone and style', () => {
    for (const p of projects()) {
      const f = buildFacts(p);
      for (const tone of TONES) {
        for (const hookStyle of ['question', 'stat', 'contrarian', 'story', 'pov'] as const) {
          for (let seed = 0; seed < 20; seed++) {
            const v = Voice.create(f, { tone, hookStyle }, `${tone}|${hookStyle}|${seed}`);
            const out = [
              v.hook('educational'),
              ...(['link', 'buy', 'book', 'comment', 'reply', 'optin', 'save', 'share'] as const).map((k) => v.cta(k, seed % 2 ? 'facebook' : 'instagram')),
            ].join(' | ');
            expect(out, out).not.toMatch(CLAIMS);
          }
        }
      }
    }
  });

  it('keeps generic outcomes free of time promises', () => {
    expect(genericNiche('Underwater basket weaving', 'Basket weaving').outcomes.join(' ')).not.toMatch(/hours|every week|\bdays?\b/i);
  });
});

describe('niche desires never become statements about the business', () => {
  it('describes what is offered from the owner’s topic, and keeps niche wishes apart', () => {
    for (const p of projects()) {
      const f = buildFacts(p);
      expect(f.desire.toLowerCase()).toContain(f.topicLower);
      for (const d of f.desires) {
        expect(f.niche.desires).not.toContain(d);
        expect(d).toContain(f.topicLower);
      }
      expect(f.wishes).toEqual(f.niche.desires);
    }
    expect(buildFacts(business()).desires.join(' ')).not.toMatch(/on-time|tidy|trusted|fair pricing|first time/i);
    expect(buildFacts(business('Auto repair', 'Brake repair')).desires.join(' ')).not.toMatch(/trust|quick|transparent/i);
  });
});
