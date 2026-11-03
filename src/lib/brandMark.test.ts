import { describe, expect, it } from 'vitest';
import { brandHandle, brandMark, websiteHost } from './brandMark';

const brand = (patch: Partial<{ websiteUrl: string; socials: Record<string, string>; name: string }> = {}) => ({ websiteUrl: '', socials: {}, name: 'Sparkle Co', ...patch });

describe('brandMark', () => {
  it('shows the owner’s website when there is one', () => {
    expect(websiteHost(brand({ websiteUrl: 'https://www.sparkle-cleaning.net/' }))).toBe('sparkle-cleaning.net');
    expect(brandMark(brand({ websiteUrl: 'https://sparkle-cleaning.net', socials: { instagram: '@sparkle' } }))).toBe('sparkle-cleaning.net');
  });

  it('falls back to the owner’s @handle, then the brand name, never a made-up domain', () => {
    expect(brandMark(brand({ socials: { instagram: 'https://instagram.com/sparkle.co/' } }))).toBe('@sparkle.co');
    expect(brandMark(brand({ socials: { tiktok: 'tiktok.com/@sparkleclean' } }))).toBe('@sparkleclean');
    expect(brandMark(brand())).toBe('Sparkle Co');
    expect(brandMark(brand({ name: '' }))).toBe('');
  });

  it('ignores social entries that are not handles', () => {
    expect(brandHandle(brand({ socials: { facebook: 'facebook.com/SparkleCo' } }))).toBe('');
    expect(brandHandle(brand({ socials: { instagram: 'my insta' } }))).toBe('');
  });
});
