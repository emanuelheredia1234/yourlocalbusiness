// "Export plan": the Markdown file holds no HTML and no link but the sources' own, whatever the AI, a web
// page's title or a stored strategy wrote.
import { describe, expect, it } from 'vitest';
import type { StrategyState } from '@/lib/strategyTypes';
import { readStrategy } from '@/lib/strategy';
import { qaProject, qaSavedStrategy } from '@/test/strategyQa';
import { strategyMarkdown } from './exportMarkdown';

const p = qaProject();
const ctx = { posts: [], ads: [], myListings: [], now: Date.UTC(2026, 10, 5) };
const exported = (s: StrategyState) => strategyMarkdown(p, readStrategy({ ...p, strategy: s }), ctx);

describe('the exported plan', () => {
  it('writes no link the source check never saw', () => {
    const s = qaSavedStrategy(p);
    const md = exported({
      ...s,
      // a page's title and date are its own words, as found
      sources: s.sources.map((x) => (x.n === 1 ? { ...x, title: '[Top tips](https://evil.example) at www.evil.example/x', pageAge: 'Oct 1 <b>evil.example/date</b>' } : x)),
      research: {
        ...s.research!,
        findings: [...s.research!.findings, { topic: 'other', text: 'Join the [local group](//evil.example/x) or book at evil.example/book or hxxps://evil.example.', basis: 'ai' }],
        checks: ['Read https://evil.example/tips first.'],
      },
    });
    expect(md).not.toMatch(/evil/);
    // no Markdown link or image from any text, and no HTML
    expect(md).not.toMatch(/\]\(|<[a-z]/i);
    expect(md).toContain('- Join the local group or book at or. (general knowledge)');
    expect(md).toContain('[1] Top tips at — https://example.com/qa-research/where-buyers-look (found');
    expect(md).toContain(', page date Oct 1 &lt;b>&lt;/b>)');
    expect(md).toContain('- Read first. (built-in)');
    // the sources' own addresses stay, as links
    expect(md).toContain('— https://example.org/qa-research/content-that-works?utm_source=qa (found');
  });

  it('escapes the brackets in any text, so placeholders stay text', () => {
    const md = exported(qaSavedStrategy(p));
    expect(md).toContain('> Hi \\[Name\\],');
    expect(md).toContain('> \\[Your name\\]');
  });

  it('writes a source’s address so Markdown reads no other link into it', () => {
    const s = qaSavedStrategy(p);
    const md = exported({ ...s, sources: s.sources.map((x) => (x.n === 2 ? { ...x, url: 'https://example.org/a[b](https://example.net/c)' } : x)) });
    expect(md).toContain('— https://example.org/a%5Bb%5D(https://example.net/c) (found');
    // a title that's nothing but a link shows the page's domain
    const bare = exported({ ...s, sources: s.sources.map((x) => (x.n === 1 ? { ...x, title: 'https://evil.example/a' } : x)) });
    expect(bare).toContain('[1] example.com — https://example.com/qa-research/where-buyers-look (found');
  });
});
