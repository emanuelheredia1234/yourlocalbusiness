// R1 and §10.2 as a source scan: nothing in server/ads/ (or the app's src/lib/ads/) retries, backs off, loops a
// write on a timer or sends a write from a catch, and the audit log has no update or delete path.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as audit from './audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const sources = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(mjs|ts|tsx)$/.test(f) && !/\.test\./.test(f) && !/test-(helpers|fixtures)/.test(f)).map((f) => [path.join(dir, f), fs.readFileSync(path.join(dir, f), 'utf8')]) : []);
const files = [...sources(here), ...sources(path.join(root, 'src/lib/ads'))];
const code = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
const WRITE = /\b(createAd|setCampaignSpendCap|setCampaignStatus|setAdSetStatus|setAdStatus|setAdSetBudget|setCampaignBudget|setAdSetEndDate|setMetaCreative|setSearchAdText)\(/;

describe('no automatic retries', () => {
  it('has no retry or backoff helpers, and never asks the client to retry', () => {
    expect(files.length).toBeGreaterThan(10);
    for (const [f, src] of files) {
      const c = code(src);
      expect(c, f).not.toMatch(/\bretry\w*\s*\(|\bbackoff|\bwithRetry|maxRetries|attempts\s*[<>]=?/i);
      if (!f.endsWith('zernioAds.mjs')) expect(c, f).not.toMatch(/retry429/);
    }
    // the module passes retry429 for reads only
    const z = code(fs.readFileSync(path.join(here, 'zernioAds.mjs'), 'utf8'));
    expect(z.match(/retry429: true/g)).toHaveLength(1);
    expect(z).toMatch(/client\.call\('GET', path, \{ query, retry429: true \}\)/);
  });

  it('never calls a write from a catch, a timer or a while loop', () => {
    for (const [f, src] of files) {
      const c = code(src);
      for (const m of c.matchAll(/catch\s*(\([^)]*\))?\s*\{/g)) {
        const block = c.slice(m.index, m.index + 600).split(/\n\s*\}\s*(finally|\n)/)[0];
        expect(WRITE.test(block), `${f}: a write inside a catch`).toBe(false);
      }
      expect(c, f).not.toMatch(/setInterval\([^)]*\b(createAd|set[A-Z]\w+)\b/);
      expect(c, f).not.toMatch(/while\s*\([^)]*\)\s*\{[^}]*\b(createAd|setCampaign|setAdSet|setAd|setMeta|setSearch)\w*\(/);
    }
  });

  it('runs each step of a change once, in a for loop that stops at the first step that isn’t ok', () => {
    const w = code(fs.readFileSync(path.join(here, 'writes.mjs'), 'utf8'));
    expect(w).toMatch(/if \(r\.outcome === 'ok'\) \{[\s\S]*?continue;[\s\S]*?\}\s*if \(r\.outcome === 'unknown'\) \{[\s\S]*?return await finishWith\('unknown'/);
  });
});

describe('the audit log is append-only', () => {
  it('exports no update or delete, and nothing in server/ads/ updates or deletes ad_audit', () => {
    expect(Object.keys(audit)).toEqual(['createAudit']);
    const a = audit.createAudit({ db: { insert: async () => {}, select: async () => [] } });
    expect(Object.keys(a).sort()).toEqual(['append', 'list']);
    for (const [f, src] of files) expect(code(src), f).not.toMatch(/\.(update|delete|upsert)\(\s*'ad_audit'/);
  });
});
