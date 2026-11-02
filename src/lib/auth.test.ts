import { describe, expect, it } from 'vitest';
import { isSameOriginRequest } from './auth';

describe('same-origin auth forwarding', () => {
  it('allows relative API requests and URLs on the app origin', () => {
    expect(isSameOriginRequest('/api/ai/generate', 'https://app.example')).toBe(true);
    expect(isSameOriginRequest('https://app.example/api/ai/generate', 'https://app.example')).toBe(true);
  });

  it('does not forward a session to a custom or malformed URL', () => {
    expect(isSameOriginRequest('https://other.example/api/ai/generate', 'https://app.example')).toBe(false);
    expect(isSameOriginRequest('http://[invalid', 'https://app.example')).toBe(false);
  });
});
