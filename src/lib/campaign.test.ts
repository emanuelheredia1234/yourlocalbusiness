// Video days (P1b): which posting days get AI videos, and how many. Older setups (one "videos per day") are read as
// that count on each posting day and saved that way once; the plan, the batch, the cadence and the checks use them.
import { beforeEach, describe, expect, it } from 'vitest';
import type { CampaignConfig, Project } from '@/lib/types';
import { newProject } from '@/store/defaults';
import { useStore } from '@/store/useStore';
import { addDays, weekdayIndex } from '@/lib/utils';
import { defaultCampaign, fitSlotsToVideoDays, generateCampaignPlan, generateContentBatch } from '@/ai/local/social';
import { cadence, campaignProblem, patchCampaign, setVideoDay, videoDaysWarning } from '@/ai/socialPlan';
import { cleanWorkspace } from '@/store/cleanup';
import { fillVideoDays, hasVideoDays, videoDaysOf, videoDaysPatch, videosPerWeek, withVideoDays } from './campaign';

const MON_FRI = [true, true, true, true, true, false, false];
const cfg = (over: Partial<CampaignConfig> = {}): CampaignConfig => ({ ...defaultCampaign(), startDate: '2026-11-09', ...over });
/** An older setup: videosPerDay and no videoDays. */
const legacy = (videosPerDay: number, over: Partial<CampaignConfig> = {}): CampaignConfig => {
  const { videoDays: _gone, ...rest } = cfg(over);
  return { ...rest, videosPerDay } as CampaignConfig;
};

describe('videoDaysOf', () => {
  it('reads the chosen days, only on posting days and within the posts of the day', () => {
    expect(videoDaysOf(cfg({ videoDays: [1, 0, 0, 2, 0, 0, 0] }))).toEqual([1, 0, 0, 2, 0, 0, 0]);
    // Saturday isn't a posting day; Thursday can't have 4 of 2
    expect(videoDaysOf(cfg({ videoDays: [1, 0, 0, 4, 0, 1, 0] }))).toEqual([1, 0, 0, 2, 0, 0, 0]);
    expect(videosPerWeek(cfg({ videoDays: [1, 0, 0, 2, 0, 0, 0] }))).toBe(3);
  });

  it('migrates an older setup: its videos per day on each posting day', () => {
    expect(videoDaysOf(legacy(1))).toEqual([1, 1, 1, 1, 1, 0, 0]);
    expect(videoDaysOf(legacy(5, { postsPerDay: 2 }))).toEqual([2, 2, 2, 2, 2, 0, 0]);
    expect(videoDaysOf(legacy(0))).toEqual([0, 0, 0, 0, 0, 0, 0]);
    const filled = withVideoDays(legacy(1, { days: [true, false, true, false, false, false, true] }));
    expect(filled.videoDays).toEqual([1, 0, 1, 0, 0, 0, 1]);
    expect('videosPerDay' in filled).toBe(false);
    expect(hasVideoDays(legacy(1))).toBe(false);
  });

  it('keeps video days consistent when the posting days or posts per day change (a new posting day starts with none)', () => {
    const c = cfg({ days: MON_FRI, videoDays: [1, 1, 0, 0, 0, 0, 0] });
    expect(videoDaysPatch(c, { days: [false, true, true, false, false, false, true] }).videoDays).toEqual([0, 1, 0, 0, 0, 0, 0]);
    expect(videoDaysPatch(cfg({ videoDays: [2, 2, 0, 0, 0, 0, 0] }), { postsPerDay: 1 }).videoDays).toEqual([1, 1, 0, 0, 0, 0, 0]);
    expect(videoDaysPatch(c, { videoDays: [0, 0, 0, 0, 1, 1, 0] }).videoDays).toEqual([0, 0, 0, 0, 1, 0, 0]);
  });

  it('fills older businesses once (the same array when nothing changed)', () => {
    const a = newProject('business');
    const b = newProject('business');
    b.marketing.campaign = legacy(1);
    const list = [a, b];
    const out = fillVideoDays(list);
    expect(out).not.toBe(list);
    expect(out[0]).toBe(a);
    expect(out[1].marketing.campaign.videoDays).toEqual([1, 1, 1, 1, 1, 0, 0]);
    expect(fillVideoDays(out)).toBe(out);
  });
});

describe('the setup, the plan and the batch use the video days', () => {
  beforeEach(() => {
    const p = newProject('business');
    p.id = 'p_vd';
    p.marketing.campaign = legacy(1);
    useStore.setState({ projects: [p], activeProjectId: 'p_vd' });
  });
  const campaign = () => useStore.getState().projects[0].marketing.campaign;

  it('cleanWorkspace migrates the setup lazily; patchCampaign and setVideoDay keep it consistent', () => {
    cleanWorkspace();
    expect(campaign().videoDays).toEqual([1, 1, 1, 1, 1, 0, 0]);
    expect('videosPerDay' in campaign()).toBe(false);
    setVideoDay(1, 0);
    setVideoDay(3, 2);
    setVideoDay(5, 1); // Saturday isn't a posting day
    expect(campaign().videoDays).toEqual([1, 0, 1, 2, 1, 0, 0]);
    patchCampaign({ days: [true, false, true, true, true, true, false] });
    expect(campaign().videoDays).toEqual([1, 0, 1, 2, 1, 0, 0]);
    patchCampaign({ postsPerDay: 1 });
    expect(campaign().videoDays).toEqual([1, 0, 1, 1, 1, 0, 0]);
  });

  it('cadence counts the week’s videos from the chosen days', () => {
    const c = cadence(cfg({ videoDays: [1, 0, 0, 2, 0, 0, 0] }));
    expect(c).toMatchObject({ days: 5, perWeek: 10, videos: 3, images: 7, videoDayCount: 2 });
    expect(cadence(legacy(1)).videos).toBe(5);
  });

  it('campaignProblem stops the plan over the weekly limit only while plans are on; otherwise a warning', () => {
    const c = cfg({ videoDays: [1, 1, 1, 1, 1, 0, 0] });
    const launch = { perWeek: 3, enforced: true, planName: 'Launch' };
    expect(campaignProblem(c, launch)).toBe('You chose 5 videos a week; Launch makes 3 AI videos a week for each business. Choose fewer video days, or upgrade.');
    expect(campaignProblem(cfg({ videoDays: [1, 0, 1, 0, 1, 0, 0] }), launch)).toBeNull();
    expect(campaignProblem(c, { ...launch, enforced: false })).toBeNull();
    expect(videoDaysWarning(c, { ...launch, enforced: false })).toMatch(/You chose 5 videos a week/);
    expect(videoDaysWarning(c, launch)).toBeNull();
    expect(campaignProblem(c, { perWeek: null, enforced: true, planName: 'Scale' })).toBeNull();
    expect(campaignProblem(c)).toBeNull();
    expect(campaignProblem(cfg({ videoDays: [1, 0, 0, 0, 0, 0, 0], videoStyles: [] }))).toBe('Choose at least one video style, or turn the video days off.');
  });

  it('the 30-day plan puts videos on the chosen days only', () => {
    const p = useStore.getState().projects[0];
    const config = cfg({ videoDays: [1, 0, 0, 2, 0, 0, 0] });
    const plan = generateCampaignPlan(p, config);
    for (const d of plan.days) {
      const want = [1, 0, 0, 2, 0, 0, 0][weekdayIndex(d.date)];
      expect(d.slots.filter((s) => s.format === 'video').length).toBe(d.posting ? want : 0);
    }
    expect(plan.summary.videos).toBeGreaterThan(0);
    // an older setup makes the same plan as its migrated one
    const a = generateCampaignPlan(p, legacy(1, { startDate: '2026-11-09' }));
    const b = generateCampaignPlan(p, withVideoDays(legacy(1, { startDate: '2026-11-09' })) as CampaignConfig);
    expect(a.days.map((d) => d.slots.map((s) => s.format))).toEqual(b.days.map((d) => d.slots.map((s) => s.format)));
  });

  it('the batch moves videos to the days chosen now (a plan made before the change)', () => {
    const p: Project = useStore.getState().projects[0];
    const before = cfg({ videoDays: [1, 1, 1, 1, 1, 0, 0] });
    const plan = generateCampaignPlan(p, before);
    const now = cfg({ videoDays: [0, 0, 2, 0, 0, 0, 0] });
    const posts = generateContentBatch(p, plan, now, {}, 0, 7);
    for (let i = 0; i < 7; i++) {
      const date = addDays(plan.startDate, i);
      const day = posts.filter((x) => x.scheduledAt.startsWith(date));
      expect(day.filter((x) => x.format === 'video').length).toBe(day.length ? [0, 0, 2, 0, 0, 0, 0][weekdayIndex(date)] : 0);
    }
    // converted slots take a style of their kind
    const slots = fitSlotsToVideoDays(plan.days[0], now);
    expect(slots.every((s) => s.format === 'image')).toBe(true);
    expect(slots.every((s) => now.imageStyles.includes(s.style as never) || !['ugc', 'kinetic'].includes(s.style))).toBe(true);
  });
});
