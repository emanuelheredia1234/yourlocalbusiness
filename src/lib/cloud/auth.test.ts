import { describe, expect, it } from 'vitest';
import { isSameOriginAuthTarget } from './auth';

describe('Supabase bearer target validation', () => {
  it('allows relative and absolute requests to the app origin', () => {
    expect(isSameOriginAuthTarget('/api/ai/generate', 'https://app.example')).toBe(true);
    expect(isSameOriginAuthTarget('https://app.example/api/ai/generate', 'https://app.example')).toBe(true);
  });

  it('rejects unrelated or malformed server URLs', () => {
    expect(isSameOriginAuthTarget('https://other.example/api/ai/generate', 'https://app.example')).toBe(false);
    expect(isSameOriginAuthTarget('http://[invalid', 'https://app.example')).toBe(false);
  });
});
