// "Guide my other tabs": the two project-bound Brain skills (notes only, never rules or art direction),
// their states, the SEO page's guidance block, the campaign patch with its undo, and the link settings.
import { beforeEach, describe, expect, it } from 'vitest';
import type { CampaignConfig, Project, Skill } from './types';
import { brainPrompt, effectiveDirectives, newSkill, parseDirectives, resolveBrain, visualBrief } from '@/ai/brain';
import { CLAIMS, EMAIL_RE, NUMBER_CLAIM, PHONE_RE, URL_RE } from './strategyNormalize';
import { readStrategy } from './strategy';
import { useStore } from '@/store/useStore';
import { defaultSettings } from '@/store/defaults';
import { qaProject, qaSavedStrategy } from '@/test/strategyQa';
import {
  SEO_BLOCK_HEADER,
  SKILL_HEADER,
  applyCampaign,
  applyLinks,
  applySeo,
  applySkill,
  campaignPatch,
  cleanNotes,
  emailNotes,
  linksPatch,
  makesStrategyRule,
  seoBlock,
  skillState,
  socialNotes,
  strategyFingerprint,
  strategySkill,
  strategySkillId,
  undoCampaign,
  undoLinks,
  withSeoBlock,
} from './strategyApply';

const p = qaProject('p1');
const s = qaSavedStrategy(p);
const asSkill = (area: 'social' | 'email', id = strategySkillId('p1', area)): Skill => ({ ...newSkill(strategySkill(p, area, s)), id });

describe('the skills', () => {
  it('carry notes, never rules or art direction', () => {
    for (const area of ['social', 'email'] as const) {
      const k = asSkill(area);
      expect(Object.values(parseDirectives(k.instructions)).filter((v) => v !== undefined && !(Array.isArray(v) && !v.length))).toEqual([]);
      expect(makesStrategyRule(SKILL_HEADER[area])).toBe(false);
      // the notes sit in the document excerpt, which the Brain only quotes as reference: whatever words
      // they hold ("friendly", "short"), adding the skill sets no rule
      expect(effectiveDirectives(k)).toEqual({});
      expect(resolveBrain([k], area, true, 'p1').directives).toEqual({});
      // (the same words as instructions would: "friendly" and "short" are in the social notes)
      if (area === 'social') expect(effectiveDirectives({ ...k, instructions: `${k.instructions}\n${k.doc!.excerpt}`, doc: undefined })).toMatchObject({ tone: 'friendly', length: 'short' });
      expect(visualBrief([k], 'social', true, 600, 'p1').text).toBe('');
      expect(visualBrief([k], 'studio', true, 600, 'p1').text).toBe('');
      expect(k.directives).toEqual({});
      expect(k.id.length).toBeLessThanOrEqual(80);
      expect(k).toMatchObject({ scope: [area], projectId: 'p1', libraryId: `strategy-${area}-p1`, category: area });
    }
    expect(strategySkillId('p'.repeat(200), 'social').length).toBe(80);
  });

  it('reach the Brain prompt only for their own area and project, when on', () => {
    const k = asSkill('social');
    expect(brainPrompt([k], {})).toContain(k.doc!.excerpt);
    expect(k.doc!.excerpt).toContain('Who to talk to: QA: busy families nearby.');
    expect(resolveBrain([k], 'social', true, 'p1').skills).toEqual([k]);
    for (const [scope, pid] of [['strategy', 'p1'], ['email', 'p1'], ['social', 'p2']] as const) expect(resolveBrain([k], scope, true, pid).skills).toEqual([]);
    expect(resolveBrain([{ ...k, enabled: false }], 'social', true, 'p1').skills).toEqual([]);
  });

  it('notes hold no links, emails, phones, claims or unsourced numbers', () => {
    const dirty = { ...s, promote: { ...s.promote!, positioning: { ...s.promote!.positioning, who: 'busy families (call 512 555 0100 or see https://x.example)', line: 'Trusted by 500 families, 73% of them' } } };
    const notes = cleanNotes([...socialNotes(dirty), ...emailNotes(dirty)], { nums: new Set(), text: '' }, 1500);
    expect(notes).not.toMatch(URL_RE);
    expect(notes).not.toMatch(EMAIL_RE);
    expect(notes).not.toMatch(PHONE_RE);
    expect(notes).not.toMatch(CLAIMS);
    expect(notes).not.toMatch(NUMBER_CLAIM);
    // never findings or source titles
    expect(notes).not.toContain('map listings');
    expect(notes).not.toContain('QA stand-in source');
    expect(cleanNotes(['a'.repeat(40), 'b'.repeat(40)], { nums: new Set(), text: '' }, 60)).toBe('a'.repeat(40));
  });

  it('the fingerprint sees the owner’s edits to the instructions or the scope', () => {
    const k = asSkill('social');
    const f = strategyFingerprint(k);
    expect(strategyFingerprint({ ...k, instructions: `${k.instructions} More.` })).not.toBe(f);
    expect(strategyFingerprint({ ...k, scope: ['social', 'email'] })).not.toBe(f);
    expect(strategyFingerprint({ ...k, enabled: false } as Skill)).toBe(f);
  });

  it('skillState: none, on, off, edited, missing, and a copy', () => {
    const k = asSkill('social');
    const applied = { ...s, applied: { social: { at: 1, from: s.content!.at, skillId: k.id, written: strategyFingerprint(k) } } };
    expect(skillState('p1', 'social', s, [k]).state).toBe('none');
    expect(skillState('p1', 'social', applied, [k])).toMatchObject({ state: 'on', update: false, copy: false });
    expect(skillState('p1', 'social', { ...applied, applied: { social: { ...applied.applied.social, from: 0 } } }, [k]).update).toBe(true);
    expect(skillState('p1', 'social', applied, [{ ...k, enabled: false }]).state).toBe('off');
    expect(skillState('p1', 'social', applied, [{ ...k, instructions: 'Mine now.' }]).state).toBe('edited');
    expect(skillState('p1', 'social', applied, []).state).toBe('missing');
    expect(skillState('p1', 'social', applied, [k, { ...k, id: 'skill_copy' }]).copy).toBe(true);
  });
});

describe('the SEO page’s guidance', () => {
  const block = seoBlock(s, p);

  it('the block: the strategy’s direction, the claim gone, no empty lines', () => {
    expect(block).toBe(['From your Strategy (edit freely):', "- Who it's for: QA: busy families nearby", '- Questions to answer: QA: Is it safe for pets?', '- Search terms to work in: qa house cleaning austin', '- Call to action: Book a time'].join('\n'));
  });

  it('appends, replaces its own block, sees the owner’s edits, stays within 2,000 characters', () => {
    expect(withSeoBlock('', block)).toEqual({ mode: 'append', text: block, block });
    const appended = withSeoBlock('Keep it warm.', block);
    expect(appended).toMatchObject({ mode: 'append', text: `Keep it warm.\n\n${block}` });
    const newer = block.replace('Book a time', 'Get in touch');
    expect(withSeoBlock(appended.text, newer, block)).toMatchObject({ mode: 'replace', text: `Keep it warm.\n\n${newer}` });
    const edited = appended.text.replace('busy families', 'young families');
    expect(withSeoBlock(edited, newer, block).mode).toBe('edited');
    const long = 'x'.repeat(1900);
    const fit = withSeoBlock(long, block);
    expect(fit.text.length).toBeLessThanOrEqual(2000);
    expect(fit.block.startsWith('From your Strategy (edit freely):')).toBe(true);
    expect(fit.block.split('\n').length).toBeLessThan(block.split('\n').length);
    expect(withSeoBlock('x'.repeat(1990), block).mode).toBe('full');
  });

  it('writes the AI’s "$&", "$\'" and "$$" as they are, so the next apply still finds its block', () => {
    const prev = `${SEO_BLOCK_HEADER}\n- Angle: old`;
    const guide = `My own notes.\n\n${prev}`;
    const odd = `${SEO_BLOCK_HEADER}\n- Search terms to work in: salon $' deals, cuts $& more, $$5 off`;
    const r = withSeoBlock(guide, odd, prev);
    expect(r).toEqual({ mode: 'replace', text: `My own notes.\n\n${odd}`, block: odd });
    expect(withSeoBlock(r.text, block, r.block)).toEqual({ mode: 'replace', text: `My own notes.\n\n${block}`, block });
  });
});

describe('campaign settings', () => {
  const cur: CampaignConfig = { ...p.marketing.campaign, postsPerDay: 2, videosPerDay: 0, videoStyles: [], platforms: ['instagram'], goal: 'sales' };

  it('takes only known values, keeps days, times, watermark, start date and posts per day', () => {
    const r = campaignPatch(cur, { ...s.content!.campaign, platforms: ['instagram', 'facebook', 'myspace' as never], postMix: { educational: 9, tip: -1, question: 1.6, sales: 0, bts: 2 } as never, videoShare: 'most' });
    if (!r.ok) throw new Error(r.problem);
    expect(r.next).toMatchObject({ goal: 'leads', platforms: ['instagram', 'facebook'], postTypes: { educational: 3, tip: 0, question: 2, sales: 0, bts: 2 }, videosPerDay: 2, videoStyles: ['ugc'] });
    for (const k of ['days', 'times', 'watermark', 'startDate', 'postsPerDay', 'imageStyles'] as const) expect(r.next[k]).toEqual(cur[k]);
    expect(r.lines[0]).toBe('Goal: Get leads (was: Make sales)');
    expect(r.lines[1]).toBe('Networks: Instagram, Facebook (was: Instagram)');
    expect(campaignPatch({ ...cur, videosPerDay: 1 }, { ...s.content!.campaign, videoShare: 'some' }).ok && campaignPatch({ ...cur, videosPerDay: 1 }, { ...s.content!.campaign, videoShare: 'some' })).toMatchObject({ next: { videosPerDay: 1 } });
  });

  it('refuses settings that can’t make a plan', () => {
    const r = campaignPatch({ ...cur, days: [false, false, false, false, false, false, false] }, s.content!.campaign);
    expect(r).toEqual({ ok: false, problem: 'Pick at least one posting day.' });
  });
});

describe('the writers', () => {
  beforeEach(() => {
    useStore.setState({ projects: [{ ...p, strategy: s }], activeProjectId: 'p1', skills: [], settings: defaultSettings() });
  });
  const proj = (): Project => useStore.getState().projects[0];

  it('add the skill once, then update it in place (on or off as the owner left it)', () => {
    expect(applySkill('p1', 'social')).toBe(true);
    const k = useStore.getState().skills[0];
    expect(k).toMatchObject({ id: 'skill_strategy_p1_social', enabled: true, scope: ['social'] });
    expect(readStrategy(proj()).applied.social).toMatchObject({ skillId: k.id, written: strategyFingerprint(k) });
    useStore.getState().updateSkill(k.id, { enabled: false });
    applySkill('p1', 'social');
    expect(useStore.getState().skills).toHaveLength(1);
    expect(useStore.getState().skills[0].enabled).toBe(false);
  });

  it('the campaign: applied, then put back with Undo', () => {
    const before = proj().marketing.campaign;
    expect(applyCampaign('p1')).toEqual({ ok: true });
    expect(proj().marketing.campaign.goal).toBe('leads');
    expect(undoCampaign('p1')).toBe(true);
    expect(proj().marketing.campaign).toEqual(before);
    expect(readStrategy(proj()).applied.campaign).toBeUndefined();
  });

  it('the links: only real networks and placements, and Undo', () => {
    expect(linksPatch({ x: 'post' }, { instagram: { placement: 'bio' }, facebook: { placement: 'sidebar' as never }, myspace: { placement: 'bio' } } as never)).toEqual({ x: 'post', instagram: 'bio' });
    expect(applyLinks('p1')).toBe(true);
    expect(proj().marketing.linkPlacement).toEqual({ instagram: 'bio', facebook: 'comment' });
    expect(undoLinks('p1')).toBe(true);
    expect(proj().marketing.linkPlacement).toBeUndefined();
  });

  it('the SEO block: written once, replaced in place the next time', () => {
    expect(applySeo('p1')).toBe('append');
    const first = proj().marketing.seoGuide;
    expect(first).toContain('From your Strategy (edit freely):');
    expect(applySeo('p1')).toBe('replace');
    expect(proj().marketing.seoGuide).toBe(first);
    useStore.getState().updateProject('p1', (x) => ({ ...x, marketing: { ...x.marketing, seoGuide: (x.marketing.seoGuide ?? '').replace('busy families', 'young families') } }));
    expect(applySeo('p1')).toBe('edited');
    expect(applySeo('p1', true)).toBe('append');
  });
});
