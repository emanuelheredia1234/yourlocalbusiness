// Manus only posts in Facebook groups now. These read the source itself: no words say Manus posts on a Page or
// profile (outside the groups flow and the read-only "Sent with Manus earlier" label), the old posting module is
// gone with no importer left, and the assistant has no Manus posting tools.
import { describe, expect, it } from 'vitest';
const PHRASES = /post with manus|manus posts|posted by manus|manus adds the first comment|tell manus which account/i;

// every source file's text (Vite reads them; tests are left out, since they quote the phrases)
const RAW = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const sources = Object.entries(RAW).map(([path, text]) => ({ path: path.replace(/^\//, ''), text }));

describe('Manus posts only in Facebook groups', () => {
  it('no source says Manus posts on Pages or profiles (the groups flow and the legacy label aside)', () => {
    const hits = sources
      .flatMap((f) => f.text.split('\n').map((line: string, i: number) => ({ at: `${f.path}:${i + 1}`, line })))
      .filter(({ line }) => PHRASES.test(line) && !/group/i.test(line) && !/with Manus earlier/i.test(line));
    expect(hits).toEqual([]);
  });

  it('the old posting module is gone, and nothing imports it', () => {
    expect(sources.some((f) => f.path === 'src/ai/manusPost.ts')).toBe(false);
    expect(sources.length).toBeGreaterThan(100);
    for (const f of sources) expect(f.text, f.path).not.toMatch(/from ['"](@\/ai\/|\.\/)manusPost['"]/);
    // the posting window and its watcher are gone; what remains of ManusPost only forwards the readiness helpers
    for (const f of sources) expect(f.text, f.path).not.toMatch(/\b(ManusPostHost|ManusPostButton|useManusPostWatcher|useManusPost|startManusPost|refreshPostFromManus)\b/);
  });

  it('the assistant has no Manus posting or checking tools', () => {
    const assistant = sources.filter((f) => f.path.startsWith('src/ai/assistant/'));
    for (const f of assistant) expect(f.text, f.path).not.toMatch(/['"](post_with_manus|check_manus)['"]/);
    expect(assistant.some((f) => /name: 'post_to_groups'/.test(f.text))).toBe(true);
    expect(assistant.some((f) => /name: 'open_post_now'/.test(f.text))).toBe(true);
  });
});
