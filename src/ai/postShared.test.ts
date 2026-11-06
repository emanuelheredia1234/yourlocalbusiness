// The network helpers every way of posting shares (moved out of the old Manus posting module).
import { describe, expect, it } from 'vitest';
import { NETWORKS, networkLabel, postBlocker, postText, scheduleWindowError, suggestedAccount, textWarning } from './postShared';
import { safeStorage } from '@/lib/storage';

describe('the networks', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');

  it('only schedules inside each network’s window', () => {
    expect(scheduleWindowError('facebook', '2026-10-28T12:10:00Z', now)).toMatch(/30 minutes/);
    expect(scheduleWindowError('facebook', '2027-02-01T12:00:00Z', now)).toMatch(/Facebook schedules posts up to 75 days/);
    expect(scheduleWindowError('facebook', '2026-10-29T09:00:00Z', now)).toBeNull();
    // TikTok only schedules 10 days ahead; LinkedIn three months
    expect(scheduleWindowError('tiktok', '2026-11-10T12:00:00Z', now)).toMatch(/TikTok schedules posts up to 10 days/);
    expect(scheduleWindowError('tiktok', '2026-11-05T12:00:00Z', now)).toBeNull();
    expect(scheduleWindowError('linkedin', '2027-01-20T12:00:00Z', now)).toBeNull();
    expect(scheduleWindowError('x', 'not a date', now)).toMatch(/Pick a date/);
  });

  it('knows what each network needs before a post goes out', () => {
    const video = { kind: 'video', id: 'm', name: 'v.mp4' } as never;
    const image = { kind: 'image', id: 'm', name: 'i.png' } as never;
    expect(postBlocker({ platform: 'instagram', format: 'image', media: undefined })).toMatch(/Instagram needs an image or a video/);
    expect(postBlocker({ platform: 'tiktok', format: 'image', media: undefined })).toMatch(/TikTok needs/);
    expect(postBlocker({ platform: 'linkedin', format: 'image', media: undefined })).toBeNull();
    expect(postBlocker({ platform: 'facebook', format: 'video', media: undefined })).toMatch(/storyboard can’t be posted/);
    // only the Manus groups flow in claude.ai can't take a video
    expect(postBlocker({ platform: 'facebook', format: 'video', media: video }, { viaServer: false })).toMatch(/self-hosted/);
    expect(postBlocker({ platform: 'facebook', format: 'video', media: video })).toBeNull();
    expect(postBlocker({ platform: 'x', format: 'image', media: image }, { viaServer: false })).toBeNull();
    expect(textWarning({ platform: 'x', caption: 'a'.repeat(270), hashtags: ['#one', '#two'] })).toMatch(/X takes 280 characters on most accounts, and this post has 283/);
    expect(textWarning({ platform: 'x', caption: 'short', hashtags: [] })).toBeNull();
    expect(textWarning({ platform: 'linkedin', caption: 'a'.repeat(900), hashtags: [] })).toBeNull();
  });

  it('suggests the account last used for the project, then the brand’s handle', () => {
    const brand = { name: 'Sumari Tax Co', socials: { instagram: '@sumari.tax' } };
    expect(suggestedAccount('proj_a', 'instagram', brand)).toBe('@sumari.tax');
    expect(suggestedAccount('proj_a', 'facebook', brand)).toBe('Sumari Tax Co');
    expect(suggestedAccount('proj_a', 'x', brand)).toBe('');
    safeStorage.setItem('ylb-post-account:proj_a:instagram', '@sumari');
    expect(suggestedAccount('proj_a', 'instagram', brand)).toBe('@sumari');
    expect(suggestedAccount('proj_b', 'instagram', brand)).toBe('@sumari.tax');
    safeStorage.removeItem('ylb-post-account:proj_a:instagram');
  });

  it('counts an X post the way X does: every link is 23', () => {
    expect(textWarning({ platform: 'x', caption: `${'a'.repeat(250)} https://example.com/${'x'.repeat(60)}`, hashtags: [] })).toBeNull();
    expect(textWarning({ platform: 'x', caption: `${'a'.repeat(260)} https://example.com/${'x'.repeat(60)}`, hashtags: [] })).toMatch(/this post has 284/);
  });

  it('writes the post text and the network names', () => {
    expect(postText({ caption: ' Line one ', hashtags: ['#a', '', '#b'] })).toBe('Line one\n\n#a #b');
    expect(postText({ caption: 'Only', hashtags: [] })).toBe('Only');
    expect(networkLabel('x')).toBe('X');
    expect(networkLabel('facebook')).toBe('Facebook');
    for (const n of Object.values(NETWORKS)) expect(n.home).toMatch(/^https:\/\//);
  });
});
