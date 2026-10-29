// The built-in workbook design (no Claude): each outline section that holds data becomes a tab
// laid out from a matching template; the dashboard summarizes them.

import type { OutlineSection, Project } from '@/lib/types';
import { buildFacts } from '../text';
import type { BreakdownSpec, MetricSpec, SheetSpec, WorkbookSpec } from '../workbook';

type Kind = 'ledger' | 'budget' | 'tax' | 'content' | 'pipeline' | 'goals' | 'inventory' | 'invoices' | 'checklist';

const MATCH: [Kind, RegExp][] = [
  ['tax', /\btax(es)?\b|set[- ]?aside|quarterly|estimated/i],
  ['invoices', /\binvoice|billing|payments? due|accounts receivable/i],
  ['budget', /\bbudget|allowance|monthly plan|savings|spending plan/i],
  ['ledger', /transaction|expense|income|receipt|ledger|bookkeep|cash ?flow|spending|payment|profit/i],
  ['content', /content|\bposts?\b|social|editorial|calendar|schedule|instagram|tiktok|youtube|newsletter/i],
  ['pipeline', /client|lead|crm|pipeline|prospect|deal|\bsales\b|customer|outreach/i],
  ['inventory', /inventory|stock|sku|product list|supplies|orders?\b/i],
  ['goals', /goal|habit|okr|progress|milestone|tracker|routine|workout|study/i],
];

// sections the app builds itself (Start here, Dashboard) or that only summarize other tabs
const SKIP = /^(start here|instructions?|how to use|dashboard|settings|read ?me|welcome)\b|\b(summary|overview|report|annual|insights)\b/i;

/** What a niche usually needs, most useful first. */
const NICHE_KINDS: [RegExp, Kind[]][] = [
  [/tax|financ|money|budget|bookkeep|account|invest|debt|saving|income/i, ['ledger', 'tax', 'budget']],
  [/social|content|instagram|tiktok|youtube|marketing|creator|newsletter|blog/i, ['content', 'pipeline']],
  [/client|coach|consult|agency|freelanc|service|sales|real estate|photograph/i, ['pipeline', 'invoices']],
  [/shop|store|ecommerce|etsy|craft|inventory|resell|bakery|candle/i, ['inventory', 'ledger']],
  [/fitness|workout|health|habit|diet|meal|wellness|study|learn|language|productiv/i, ['goals', 'checklist']],
];

function nicheKinds(text: string): Kind[] {
  return NICHE_KINDS.find(([re]) => re.test(text))?.[1] ?? ['goals', 'checklist'];
}

function kindFor(sec: OutlineSection, niche: Kind[]): Kind {
  const text = `${sec.summary ?? ''} ${sec.items.map((i) => `${i.title} ${i.detail ?? ''}`).join(' ')}`;
  const byTitle = MATCH.find(([, re]) => re.test(sec.title))?.[0];
  if (byTitle) return byTitle;
  // a generic "… Log" or "… Tracker" is whatever the niche tracks
  if (/\b(log|tracker|list|planner|sheet|database)\b/i.test(sec.title)) return niche[0];
  return MATCH.find(([, re]) => re.test(text))?.[0] ?? 'checklist';
}

/** Sheet names: at most 28 characters, cut at a word. */
function shortName(t: string): string {
  // "Title: subtitle" and "Title – subtitle" keep the title; "Set-Aside" stays whole
  const clean = t.replace(/\s*(:|\s[\u2013\u2014-]\s).*$/, '').replace(/\s+/g, ' ').trim() || t.trim();
  if (clean.length <= 28) return clean;
  const cut = clean.slice(0, 28);
  return cut.slice(0, cut.lastIndexOf(' ') > 12 ? cut.lastIndexOf(' ') : 28).replace(/[\s,.&]+$/, '');
}

const KIND_NAME: Record<Kind, string> = { ledger: 'Transactions', budget: 'Monthly Budget', tax: 'Tax Set-Aside', content: 'Content Calendar', pipeline: 'Clients & Leads', goals: 'Goals', inventory: 'Inventory', invoices: 'Invoices', checklist: 'Checklist' };

const day = (n: number) => {
  const d = new Date(Date.UTC(2026, 9, 1 + n));
  return d.toISOString().slice(0, 10);
};

interface Built {
  sheet: SheetSpec;
  metrics: MetricSpec[];
  breakdowns: BreakdownSpec[];
}

function template(kind: Kind, name: string, sec: OutlineSection | null, f: ReturnType<typeof buildFacts>): Built {
  const term = (i: number) => f.terms[i % f.terms.length] ?? f.topicLower;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  switch (kind) {
    case 'ledger': {
      const cats = ['Income', 'Software', 'Supplies', 'Marketing', 'Travel', 'Fees', 'Other'];
      return {
        sheet: {
          name,
          purpose: sec?.summary || 'Every payment in and out, one row each.',
          columns: [
            { name: 'Date', type: 'date' },
            { name: 'Description', type: 'text' },
            { name: 'Category', type: 'choice', options: cats },
            { name: 'Type', type: 'choice', options: ['Income', 'Expense'] },
            { name: 'Amount', type: 'currency' },
            { name: 'Signed amount', type: 'formula', formula: 'IF([Type]="Expense",-[Amount],[Amount])', format: 'currency' },
            { name: 'Notes', type: 'longtext' },
          ],
          rows: [
            { Date: day(0), Description: `${cap(term(0))} client payment`, Category: 'Income', Type: 'Income', Amount: 950 },
            { Date: day(2), Description: 'Software subscription', Category: 'Software', Type: 'Expense', Amount: 29 },
            { Date: day(5), Description: `${cap(term(1))} supplies`, Category: 'Supplies', Type: 'Expense', Amount: 64.5 },
            { Date: day(9), Description: 'Repeat client payment', Category: 'Income', Type: 'Income', Amount: 600 },
            { Date: day(14), Description: 'Promoted post', Category: 'Marketing', Type: 'Expense', Amount: 40 },
            { Date: day(20), Description: 'Payment processing fees', Category: 'Fees', Type: 'Expense', Amount: 18.75, Notes: 'Sample row: replace with your own' },
          ],
        },
        metrics: [
          { label: 'Money in', op: 'sumif', sheet: name, column: 'Amount', whereColumn: 'Type', equals: 'Income' },
          { label: 'Money out', op: 'sumif', sheet: name, column: 'Amount', whereColumn: 'Type', equals: 'Expense' },
          { label: 'Net', op: 'sum', sheet: name, column: 'Signed amount' },
          { label: 'Entries logged', op: 'count', sheet: name, column: 'Description' },
        ],
        breakdowns: [{ title: 'Totals by category', sheet: name, byColumn: 'Category', valueColumn: 'Amount', op: 'sum' }],
      };
    }
    case 'budget':
      return {
        sheet: {
          name,
          purpose: sec?.summary || 'Plan each category for the month, then compare with what you actually spent.',
          columns: [
            { name: 'Category', type: 'text' },
            { name: 'Planned', type: 'currency' },
            { name: 'Actual', type: 'currency' },
            { name: 'Difference', type: 'formula', formula: '[Planned]-[Actual]', format: 'currency' },
            { name: '% used', type: 'formula', formula: 'IF([Planned]=0,0,[Actual]/[Planned])', format: 'percent' },
          ],
          rows: [
            { Category: 'Rent & utilities', Planned: 1400, Actual: 1385 },
            { Category: 'Groceries', Planned: 450, Actual: 512 },
            { Category: 'Transport', Planned: 180, Actual: 140 },
            { Category: cap(term(0)), Planned: 120, Actual: 95 },
            { Category: 'Savings', Planned: 300, Actual: 300 },
            { Category: 'Fun money', Planned: 150, Actual: 168 },
          ],
        },
        metrics: [
          { label: 'Planned this month', op: 'sum', sheet: name, column: 'Planned' },
          { label: 'Actually spent', op: 'sum', sheet: name, column: 'Actual' },
          { label: 'Left over', op: 'sum', sheet: name, column: 'Difference' },
        ],
        breakdowns: [],
      };
    case 'tax':
      return {
        sheet: {
          name,
          purpose: sec?.summary || 'How much of each month’s income to keep aside for taxes.',
          columns: [
            { name: 'Month', type: 'text' },
            { name: 'Income', type: 'currency' },
            { name: 'Tax rate', type: 'percent' },
            { name: 'Set aside', type: 'formula', formula: 'ROUND([Income]*[Tax rate],2)', format: 'currency' },
            { name: 'Moved to savings', type: 'yesno' },
          ],
          rows: ['January', 'February', 'March', 'April'].map((m, i) => ({ Month: m, Income: [3200, 2800, 3650, 3100][i], 'Tax rate': 0.25, 'Moved to savings': i < 2 ? 'Yes' : 'No' })),
        },
        metrics: [
          { label: 'Income so far', op: 'sum', sheet: name, column: 'Income' },
          { label: 'Set aside for taxes', op: 'sum', sheet: name, column: 'Set aside' },
          { label: 'Months moved to savings', op: 'countif', sheet: name, column: 'Moved to savings', equals: 'Yes' },
        ],
        breakdowns: [],
      };
    case 'invoices':
      return {
        sheet: {
          name,
          purpose: sec?.summary || 'Who owes you what, and when it’s due.',
          columns: [
            { name: 'Invoice #', type: 'text' },
            { name: 'Client', type: 'text' },
            { name: 'Sent', type: 'date' },
            { name: 'Due', type: 'date' },
            { name: 'Amount', type: 'currency' },
            { name: 'Status', type: 'choice', options: ['Draft', 'Sent', 'Paid', 'Overdue'] },
            { name: 'Days to due', type: 'formula', formula: 'IF([Status]="Paid","",[Due]-TODAY())', format: 'number' },
          ],
          rows: [
            { 'Invoice #': 'INV-001', Client: 'Bloom Bakery', Sent: day(1), Due: day(15), Amount: 1200, Status: 'Paid' },
            { 'Invoice #': 'INV-002', Client: 'Northside Gym', Sent: day(6), Due: day(20), Amount: 850, Status: 'Sent' },
            { 'Invoice #': 'INV-003', Client: 'Rivera Studio', Sent: day(10), Due: day(24), Amount: 430, Status: 'Draft' },
          ],
        },
        metrics: [
          { label: 'Invoiced', op: 'sum', sheet: name, column: 'Amount' },
          { label: 'Paid', op: 'sumif', sheet: name, column: 'Amount', whereColumn: 'Status', equals: 'Paid' },
          { label: 'Overdue invoices', op: 'countif', sheet: name, column: 'Status', equals: 'Overdue' },
        ],
        breakdowns: [{ title: 'Invoices by status', sheet: name, byColumn: 'Status', op: 'count' }],
      };
    case 'content':
      return {
        sheet: {
          name,
          purpose: sec?.summary || 'Plan, write and publish your posts in one place.',
          columns: [
            { name: 'Date', type: 'date' },
            { name: 'Platform', type: 'choice', options: ['Instagram', 'TikTok', 'Facebook', 'LinkedIn', 'YouTube', 'Email'] },
            { name: 'Topic', type: 'text' },
            { name: 'Format', type: 'choice', options: ['Post', 'Carousel', 'Reel', 'Story', 'Video', 'Newsletter'] },
            { name: 'Status', type: 'choice', options: ['Idea', 'Drafting', 'Scheduled', 'Posted'] },
            { name: 'Notes', type: 'longtext' },
          ],
          rows: [
            { Date: day(1), Platform: 'Instagram', Topic: `3 ${term(0)} mistakes to avoid`, Format: 'Carousel', Status: 'Posted' },
            { Date: day(3), Platform: 'TikTok', Topic: `A day of ${term(1)}`, Format: 'Reel', Status: 'Scheduled' },
            { Date: day(5), Platform: 'Email', Topic: `Your ${f.topicLower} checklist`, Format: 'Newsletter', Status: 'Drafting' },
            { Date: day(8), Platform: 'LinkedIn', Topic: `What I learned about ${term(2)}`, Format: 'Post', Status: 'Idea' },
          ],
        },
        metrics: [
          { label: 'Pieces planned', op: 'count', sheet: name, column: 'Topic' },
          { label: 'Posted', op: 'countif', sheet: name, column: 'Status', equals: 'Posted' },
          { label: 'Scheduled', op: 'countif', sheet: name, column: 'Status', equals: 'Scheduled' },
        ],
        breakdowns: [{ title: 'Pieces by platform', sheet: name, byColumn: 'Platform', op: 'count' }],
      };
    case 'pipeline':
      return {
        sheet: {
          name,
          purpose: sec?.summary || 'Every lead and client, and the next step with each.',
          columns: [
            { name: 'Name', type: 'text' },
            { name: 'Source', type: 'choice', options: ['Referral', 'Instagram', 'Website', 'Google', 'Event', 'Other'] },
            { name: 'Stage', type: 'choice', options: ['Lead', 'Contacted', 'Proposal', 'Won', 'Lost'] },
            { name: 'Value', type: 'currency' },
            { name: 'Next step', type: 'text' },
            { name: 'Follow up on', type: 'date' },
          ],
          rows: [
            { Name: 'Sample client A', Source: 'Referral', Stage: 'Proposal', Value: 1500, 'Next step': 'Send revised quote', 'Follow up on': day(4) },
            { Name: 'Sample client B', Source: 'Instagram', Stage: 'Contacted', Value: 600, 'Next step': 'Book a discovery call', 'Follow up on': day(6) },
            { Name: 'Sample client C', Source: 'Website', Stage: 'Won', Value: 2200, 'Next step': 'Kick-off meeting', 'Follow up on': day(9) },
            { Name: 'Sample client D', Source: 'Event', Stage: 'Lead', Value: 400, 'Next step': 'Intro email', 'Follow up on': day(12) },
          ],
        },
        metrics: [
          { label: 'Pipeline value', op: 'sum', sheet: name, column: 'Value' },
          { label: 'Won value', op: 'sumif', sheet: name, column: 'Value', whereColumn: 'Stage', equals: 'Won' },
          { label: 'Deals won', op: 'countif', sheet: name, column: 'Stage', equals: 'Won' },
        ],
        breakdowns: [{ title: 'Value by stage', sheet: name, byColumn: 'Stage', valueColumn: 'Value', op: 'sum' }],
      };
    case 'inventory':
      return {
        sheet: {
          name,
          purpose: sec?.summary || 'What you have, what it’s worth and what to reorder.',
          columns: [
            { name: 'Item', type: 'text' },
            { name: 'SKU', type: 'text' },
            { name: 'In stock', type: 'number' },
            { name: 'Reorder at', type: 'number' },
            { name: 'Unit cost', type: 'currency' },
            { name: 'Stock value', type: 'formula', formula: '[In stock]*[Unit cost]', format: 'currency' },
            { name: 'Reorder?', type: 'formula', formula: 'IF([In stock]<=[Reorder at],"Reorder","OK")', format: 'text' },
          ],
          rows: [
            { Item: `${cap(term(0))} kit`, SKU: 'KIT-01', 'In stock': 24, 'Reorder at': 10, 'Unit cost': 12.5 },
            { Item: `${cap(term(1))} refill`, SKU: 'REF-02', 'In stock': 6, 'Reorder at': 8, 'Unit cost': 4.2 },
            { Item: 'Gift box', SKU: 'BOX-03', 'In stock': 40, 'Reorder at': 15, 'Unit cost': 1.8 },
          ],
        },
        metrics: [
          { label: 'Stock value', op: 'sum', sheet: name, column: 'Stock value' },
          { label: 'Items to reorder', op: 'countif', sheet: name, column: 'Reorder?', equals: 'Reorder' },
        ],
        breakdowns: [],
      };
    case 'goals':
      return {
        sheet: {
          name,
          purpose: sec?.summary || 'Your goals, your progress and what’s done.',
          columns: [
            { name: 'Goal', type: 'text' },
            { name: 'Target', type: 'number' },
            { name: 'Progress', type: 'number' },
            { name: '% complete', type: 'formula', formula: 'IF([Target]=0,0,MIN(1,[Progress]/[Target]))', format: 'percent' },
            { name: 'Due', type: 'date' },
            { name: 'Status', type: 'choice', options: ['Not started', 'In progress', 'Done'] },
          ],
          rows: [
            { Goal: `${cap(f.outcomes[0] ?? 'Reach your first milestone')}`, Target: 10, Progress: 4, Due: day(30), Status: 'In progress' },
            { Goal: `Practice ${term(0)} weekly`, Target: 12, Progress: 12, Due: day(60), Status: 'Done' },
            { Goal: `Learn ${term(1)}`, Target: 5, Progress: 0, Due: day(45), Status: 'Not started' },
          ],
        },
        metrics: [
          { label: 'Goals', op: 'count', sheet: name, column: 'Goal' },
          { label: 'Done', op: 'countif', sheet: name, column: 'Status', equals: 'Done' },
          { label: 'Average progress', op: 'average', sheet: name, column: '% complete', format: 'percent' },
        ],
        breakdowns: [{ title: 'Goals by status', sheet: name, byColumn: 'Status', op: 'count' }],
      };
    default: {
      const items = sec?.items.length ? sec.items : [{ id: 'x', title: 'First step' }];
      return {
        sheet: {
          name,
          purpose: sec?.summary || 'Work through each step and tick it off.',
          columns: [
            { name: 'Step', type: 'text' },
            { name: 'Details', type: 'longtext' },
            { name: 'Status', type: 'choice', options: ['To do', 'In progress', 'Done'] },
            { name: 'Due', type: 'date' },
            { name: 'Notes', type: 'longtext' },
          ],
          rows: items.slice(0, 20).map((it, i) => ({ Step: it.title, Details: it.detail ?? it.meta ?? '', Status: 'To do', Due: day(7 * (i + 1)) })),
        },
        metrics: [
          { label: 'Steps', op: 'count', sheet: name, column: 'Step' },
          { label: 'Done', op: 'countif', sheet: name, column: 'Status', equals: 'Done' },
        ],
        breakdowns: [],
      };
    }
  }
}

export function localWorkbook(project: Project): WorkbookSpec {
  const f = buildFacts(project);
  const title = project.idea?.title || project.studio.listing.title || `${f.topic} ${f.formatNoun || 'Tracker'}`;
  const niche = nicheKinds(`${project.niche} ${project.category} ${title}`);
  const used = new Set<Kind>();
  const parts: Built[] = [];
  const add = (kind: Kind, name: string, sec: OutlineSection | null) => {
    used.add(kind);
    parts.push(template(kind, name, sec, f));
  };
  if (project.format === 'spreadsheet' || project.format === 'template') {
    for (const sec of project.studio.outline.filter((x) => !SKIP.test(x.title.trim()))) {
      const kind = kindFor(sec, niche);
      // one tab per kind (checklists can repeat)
      if (kind !== 'checklist' && used.has(kind)) continue;
      add(kind, shortName(sec.title), sec);
      if (parts.length >= 4) break;
    }
  } else if (project.studio.outline.length) {
    // a companion workbook for a guide, course or ebook: every step in one action plan
    const steps = project.studio.outline.flatMap((sec) => sec.items.map((it) => ({ ...it, chapter: sec.title })));
    const plan = template('checklist', 'Action Plan', { id: 'plan', title: 'Action Plan', summary: 'Every step from the product, in order. Tick them off as you go.', items: steps }, f);
    plan.sheet.columns.splice(1, 0, { name: 'Chapter', type: 'text' });
    plan.sheet.rows = steps.slice(0, 30).map((st, i) => ({ Step: st.title, Chapter: shortName(st.chapter), Details: st.detail ?? st.meta ?? '', Status: 'To do', Due: day(3 * (i + 1)) }));
    used.add('checklist');
    parts.push(plan);
  }
  // top up with what this niche usually tracks
  for (const kind of niche) {
    if (parts.length >= 3) break;
    if (!used.has(kind)) add(kind, KIND_NAME[kind], null);
  }
  if (!parts.length) add('goals', 'Goals', null);
  return {
    title,
    subtitle: project.idea?.hook || project.brand.valueProp || `Everything for ${f.topicLower}, in one workbook.`,
    instructions: [
      'Start on the first tab: replace the example rows with your own.',
      'Use the dropdowns so totals and the dashboard stay accurate.',
      'Grey columns calculate themselves: no need to type in them.',
      'Check the Dashboard tab for your totals: it updates automatically.',
      'Using Google Sheets? Upload this file to Google Drive and open it with Google Sheets.',
    ],
    sheets: parts.map((p) => p.sheet),
    metrics: parts.flatMap((p) => p.metrics).slice(0, 8),
    breakdowns: parts.flatMap((p) => p.breakdowns).slice(0, 2),
  };
}
