// Settings › Payments › Product files: name, size, how many offers deliver each, Delete; the server's IN_USE refusal
// reads in plain words; archived offers don't count as uses.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import type { LeadFile } from '@/lib/leadFiles';
import { leadFilesError, toLeadFile } from '@/lib/leadFiles';
import { ProductFilesView, fileUses } from './ProductFilesCard';

const FILE: LeadFile = { id: 'FFFFFFFFFFFFFFFFFFFFFF', projectId: 'p1', title: 'Spring guide', brand: '', kind: 'file', fileName: 'guide.pdf', mime: 'application/pdf', bytes: 2_500_000, url: '', gate: false, purpose: 'product', coverUrl: null, downloads: 0, lastDownloadAt: null, createdAt: null, updatedAt: null, link: '' };
const wrap = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(TooltipProvider, null, el));

describe('Product files', () => {
  it('name, size, used by N offers, Delete', () => {
    const html = wrap(createElement(ProductFilesView, { files: [FILE, { ...FILE, id: 'GGGGGGGGGGGGGGGGGGGGGG', title: 'Workbook', fileName: 'workbook.pdf' }], uses: { [FILE.id]: 2 }, error: '', busy: '', onDelete: () => {} }));
    expect(html).toContain('Spring guide');
    expect(html).toContain('guide.pdf');
    expect(html).toMatch(/2\.[0-9] MB|2 MB|2\.4 MB/);
    expect(html).toContain('used by 2 offers');
    expect(html).toContain('not used by an offer');
    expect(html).toContain('Delete');
  });

  it('uses: Stripe offers that deliver the file, not archived ones', () => {
    expect(
      fileUses([
        { provider: 'stripe', status: 'active', delivery: { kind: 'file', fileId: 'A' } },
        { provider: 'stripe', status: 'paused', delivery: { kind: 'file', fileId: 'A' } },
        { provider: 'stripe', status: 'archived', delivery: { kind: 'file', fileId: 'A' } },
        { provider: 'stripe', status: 'active', delivery: { kind: 'none' } },
      ]),
    ).toEqual({ A: 2 });
  });

  it('a product file has no public /m/ link; deleting one in use is refused in plain words', () => {
    expect(toLeadFile({ ...FILE, link: `https://app.test/m/${FILE.id}` })?.link).toBe('');
    expect(toLeadFile({ ...FILE, purpose: 'magnet', link: `https://app.test/m/${FILE.id}` })?.link).toBe(`https://app.test/m/${FILE.id}`);
    // the server's own sentence (already ours) says which offer to change
    expect(leadFilesError(409, { code: 'IN_USE', error: 'A buy link delivers this file. Change or archive that offer first.' }).message).toBe('A buy link delivers this file. Change or archive that offer first.');
  });
});
