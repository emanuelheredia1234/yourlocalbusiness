// Manus only posts in Facebook groups now. These read the source itself: no words say Manus posts on a Page or
// profile (outside the groups flow and the read-only "Sent with Manus earlier" label), the old posting module is
// gone with no importer left, and the assistant has no Manus posting tools.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const SRC = join(ROOT, 'src');
const PHRASES = /post with manus|manus posts|posted by manus|manus adds the first comment|tell manus which account/i;
/**
 * Settings › Social accounts is Connected accounts' (WP5's) to rewrite; its old line goes with that change.
 * Remove this entry once it's merged.
 */
const PENDING_ELSEWHERE = new Set(['src/pages/settings/Settings.tsx']);

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const sources = files(SRC).map((p) => ({ path: relative(ROOT, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }));

describe('Manus posts only in Facebook groups', () => {
  it('no source says Manus posts on Pages or profiles (the groups flow and the legacy label aside)', () => {
    const hits = sources
      .filter((f) => !PENDING_ELSEWHERE.has(f.path))
      .flatMap((f) => f.text.split('\n').map((line, i) => ({ at: `${f.path}:${i + 1}`, line })))
      .filter(({ line }) => PHRASES.test(line) && !/group/i.test(line) && !/with Manus earlier/i.test(line));
    expect(hits).toEqual([]);
  });

  it('the old posting module is gone, and nothing imports it', () => {
    expect(existsSync(join(SRC, 'ai', 'manusPost.ts'))).toBe(false);
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
