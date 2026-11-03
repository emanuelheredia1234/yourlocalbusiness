// Where the sign-in token may go: the app's own server, or a server the signed-in person chose
// (Settings → AI → Test connection). Never a half-typed address or one from an imported backup.
import { describe, expect, it } from 'vitest';
import { tokenAllowed } from './auth';

const APP = 'https://yourlocalbusiness.replit.app';

describe('the sign-in token', () => {
  it('goes to the app’s own server', () => {
    expect(tokenAllowed('/api/ai/generate', APP, null)).toBe(true);
    expect(tokenAllowed(`${APP}/api/health`, APP, null)).toBe(true);
  });

  it('never goes anywhere else on its own', () => {
    expect(tokenAllowed('https://evil.example/api/ai/generate', APP, null)).toBe(false);
    expect(tokenAllowed('//evil.example/api/ai/generate', APP, null)).toBe(false);
    expect(tokenAllowed('https://yourlocalbusiness.replit.app.evil.example/api', APP, null)).toBe(false);
    expect(tokenAllowed('http://yourlocalbusiness.replit.app/api', APP, null)).toBe(false); // not the same origin
  });

  it('goes to a server the person chose, and only that one', () => {
    const chosen = 'https://ai.myshop.example';
    expect(tokenAllowed('https://ai.myshop.example/api/ai/generate', APP, chosen)).toBe(true);
    // what the field held while typing it never counts
    expect(tokenAllowed('https://ai.myshop.exam/api/health', APP, chosen)).toBe(false);
    expect(tokenAllowed('https://ai.myshop.example.evil.example/api', APP, chosen)).toBe(false);
  });

  it('copes with nonsense without throwing', () => {
    expect(tokenAllowed('http://[broken', APP, 'https://ai.myshop.example')).toBe(false);
    expect(tokenAllowed('javascript:alert(1)', APP, 'https://ai.myshop.example')).toBe(false);
    expect(tokenAllowed('', APP, null)).toBe(true); // the app's own root (relative)
  });
});
