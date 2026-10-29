import { describe, expect, it } from 'vitest';
import { newSkill, SKILL_LIBRARY, skillFromLibrary, visualBrief } from './brain';
import { postPhotoPrompt, withArtDirection } from './image';
import { newProject } from '@/store/defaults';

const lib = (id: string) => skillFromLibrary(SKILL_LIBRARY.find((s) => s.libraryId === id)!);

describe('Brain art direction for photos and videos', () => {
  it('uses visual-style skills in full and only the picture sentences of other skills', () => {
    const rules = newSkill({ name: 'House rules', category: 'rules', scope: ['all'], priority: 3, instructions: 'Always show people of different ages and backgrounds. Write in short sentences. Never show alcohol or cigarettes. Put our logo in every image.' });
    const b = visualBrief([lib('authentic-imagery'), rules, lib('inclusive-language')], 'social');
    // higher priority first; text rules (writing, logos, alt text) never reach an image model
    expect(b.text.startsWith('Always show people of different ages and backgrounds. Never show alcohol or cigarettes.')).toBe(true);
    expect(b.text).toContain('Prefer natural daylight, candid moments and genuine expressions.');
    expect(b.text).not.toMatch(/Write in short|logo|alt text|Avoid words/i);
    expect(b.skills.map((s) => s.name)).toEqual(['House rules', 'Authentic, real-life imagery']);
  });

  it('respects scope, the Use Brain switch and the length cap', () => {
    const emailOnly = newSkill({ name: 'Email visuals', category: 'visual', scope: ['email'], instructions: 'Use warm photos of the team in every newsletter.' });
    expect(visualBrief([emailOnly], 'social').text).toBe('');
    expect(visualBrief([lib('authentic-imagery')], 'social', false)).toEqual({ text: '', skills: [] });
    const long = Array.from({ length: 8 }, (_, i) => newSkill({ name: `V${i}`, category: 'visual', scope: ['all'], instructions: 'Show a calm, sunlit room with plants and soft linen textures in the background of every scene.' }));
    const b = visualBrief(long, 'studio');
    expect(b.text.length).toBeLessThanOrEqual(600);
    expect(b.text.endsWith('.')).toBe(true);
  });

  it('adds the direction before the no-text rule', () => {
    const p = newProject('business', 'new');
    const prompt = postPhotoPrompt(p, 'A cleaner wiping a kitchen counter.', 'minimal');
    const out = withArtDirection(prompt, visualBrief([lib('clean-product-visuals')], 'social'));
    expect(out).toMatch(/Art direction: Keep compositions simple.*No text, letters, words, numbers, logos or watermarks anywhere in the image\.$/);
    expect(withArtDirection(prompt, { text: '', skills: [] })).toBe(prompt);
  });
});
