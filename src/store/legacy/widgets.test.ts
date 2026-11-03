import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { CodeAsset, CodeKind, Project } from '@/lib/types';
import { generateCode } from '@/ai/local/code';
import { purgeCodeAssets } from './widgets';

const asset = (id: string, kind: CodeKind, html: string, js = ''): CodeAsset => ({ id, name: id, kind, prompt: '', html, css: '', js, createdAt: 1, updatedAt: 1 });

/** Code assets as older versions saved them. */
function oldProject(): Project {
  const p = newProject('business', 'new');
  p.brand.name = 'Tidy Nest';
  p.studio.codeAssets = [
    asset('book', 'booking', '<h2>Book with Tidy Nest</h2>', "function seeded(s){} b.disabled=(seeded(state.day+t)%4)===0; done.innerHTML='You’re booked'"),
    asset('lead', 'leadform', '<h3>Check your inbox 🎉</h3><p>We just sent</p>', "form.hidden=true;"),
    asset('count', 'countdown', '<h2>launch pricing ends soon</h2>', 'var deadline=new Date("2025-01-01T23:59:00.000Z").getTime();'),
    asset('quotes', 'testimonials', '<span class="pill">Example reviews · replace with real customer quotes</span><b>Jordan M.</b>'),
    asset('hero', 'hero', '<p class="trust">★★★★★ Loved by busy parents · Instant access</p>'),
    asset('calc', 'calculator', '<span>Next available</span>'),
    asset('quiz', 'quiz', '<h2>Quiz</h2>'),
  ];
  return p;
}

describe('purgeCodeAssets', () => {
  it('flags the widgets that made claims, without touching their code', () => {
    const before = oldProject();
    const out = purgeCodeAssets(before)!;
    expect(out).not.toBeNull();
    const byId = Object.fromEntries(out.studio.codeAssets.map((a) => [a.id, a]));
    for (const id of ['book', 'lead', 'count', 'quotes', 'hero', 'calc']) expect(byId[id].outdated).toBe(true);
    expect(byId.quiz.outdated).toBeUndefined();
    out.studio.codeAssets.forEach((a, i) => {
      const b = before.studio.codeAssets[i];
      expect([a.html, a.css, a.js, a.updatedAt]).toEqual([b.html, b.css, b.js, b.updatedAt]);
    });
  });

  it('changes nothing the second time, or once the owner dismissed or regenerated', () => {
    const once = purgeCodeAssets(oldProject())!;
    expect(purgeCodeAssets(once)).toBeNull();
    const dismissed = { ...once, studio: { ...once.studio, codeAssets: once.studio.codeAssets.map((a) => ({ ...a, outdated: false })) } };
    expect(purgeCodeAssets(dismissed)).toBeNull();
  });

  it('leaves widgets made by the current version alone', () => {
    const p = newProject('business', 'new');
    p.brand.name = 'Tidy Nest';
    const now = (['booking', 'leadform', 'countdown', 'testimonials', 'hero', 'calculator', 'pricing', 'faq'] as const).map((k, i) => {
      const c = generateCode(p, k, '');
      return asset(`n${i}`, k, c.html, c.js);
    });
    p.studio.codeAssets = now;
    expect(purgeCodeAssets(p)).toBeNull();
  });

  it('returns null for a project with no code assets', () => {
    expect(purgeCodeAssets(newProject('product', 'new'))).toBeNull();
  });
});
