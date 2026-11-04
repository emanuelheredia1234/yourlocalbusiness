// "Export plan": the whole strategy as a Markdown file, every point with its label (web with its source
// numbers, general knowledge, built-in), the plan's steps ticked or not, and the sources with their dates.
// Plain Markdown, no HTML: angle brackets in any text are escaped.
import type { Project } from '@/lib/types';
import type { Backed, StrategyState } from '@/lib/strategyTypes';
import { ASSET_LABEL, CHANNEL_LABEL, CTA_LABEL, GOAL_LABEL, LEAD_MAGNET_LABEL, MIX_WORD, PURPOSE_LABEL, TOPIC_LABEL, WHERE_LABEL, actionDone, type ActionCtx } from '@/lib/strategy';
import { FINDING_TOPICS, POST_TYPE_IDS } from '@/lib/strategyNormalize';
import { PAGE_TYPE_LABEL } from '@/lib/pageTypes';
import { LINK_PLACEMENT_LABEL } from '@/lib/pageLink';
import { slugify } from '@/lib/utils';
import { PLATFORMS } from '@/ai/knowledge';

const esc = (t: string) => t.replace(/</g, '&lt;').replace(/\r/g, '');
const day = (at: number) => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const net = (n: string) => (n === 'x' ? 'X' : PLATFORMS[n as keyof typeof PLATFORMS]?.label ?? n);
const POST_TYPE = { educational: 'How-to', tip: 'Tip', question: 'Question', sales: 'Sales', bts: 'Behind the scenes' } as const;

/** "(web: [1], [2])", "(general knowledge)" or "(built-in)". */
export function basisLabel(b: Backed): string {
  if (b.basis === 'web' && b.sources?.length) return `(web: ${b.sources.map((n) => `[${n}]`).join(', ')})`;
  return b.basis === 'builtin' ? '(built-in)' : '(general knowledge)';
}

/** The file's name: strategy-{brand}-{yyyy-mm-dd}.md */
export function exportName(p: Project, now = new Date()): string {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `strategy-${slugify(p.brand.name || 'my-project') || 'my-project'}-${d}.md`;
}

export function strategyMarkdown(p: Project, s: StrategyState, ctx: ActionCtx): string {
  const L: string[] = [];
  const add = (...lines: string[]) => L.push(...lines);
  const pt = (text: string, b: Backed) => `- ${esc(text)} ${basisLabel(b)}`;
  const brand = p.brand.name || 'your project';
  add(`# Strategy for ${esc(brand)}`, '', `Written with Yourlocalbusiness on ${day(ctx.now)}. Findings marked “general knowledge” are not from a search; “built-in” notes are the app’s starter guidance.`, '');

  if (s.plan) {
    const pl = s.plan;
    add(`## ${p.track === 'business' ? 'Your plan to win clients' : 'Your plan to make sales'}`, '', esc(pl.summary), '');
    for (const w of pl.weeks) {
      add(`### Week ${w.week}: ${esc(w.focus)}`, '');
      if (w.goal) add(esc(w.goal), '');
      for (const a of pl.actions.filter((x) => x.week === w.week)) add(`- [${actionDone(a, p, s, ctx).done ? 'x' : ' '}] ${esc(a.title)} ${basisLabel(a)}${a.detail ? `: ${esc(a.detail)}` : ''}`);
      add('');
    }
    if (pl.habits.length) add('### Keep doing', '', ...pl.habits.map((h) => `- ${esc(h)}`), '');
    if (pl.measure.length) add('### What to measure', '', ...pl.measure.map((m) => `- ${esc(m.what)} · ${WHERE_LABEL[m.where]}${m.why ? `: ${esc(m.why)}` : ''}`), '', 'No predictions: these are what to watch.', '');
  }

  if (s.research) {
    const r = s.research;
    add('## Research', '', r.mode === 'web' ? `Searched the web on ${day(r.at)} (${r.searches} search${r.searches === 1 ? '' : 'es'}).` : r.mode === 'builtin' ? 'No research yet: built-in starter notes.' : 'From the AI’s general knowledge (no web search).', '');
    if (r.summary) add(esc(r.summary), '');
    for (const t of FINDING_TOPICS) {
      const list = r.findings.filter((f) => f.topic === t);
      if (list.length) add(`### ${TOPIC_LABEL[t]}`, '', ...list.map((f) => pt(f.text, f)), '');
    }
    if (r.checks.length) add('### Check it yourself', '', ...r.checks.map((c) => `- ${esc(c)} (built-in)`), '');
  }
  if (s.manus?.state === 'done' && s.manus.findings?.length) add('### Findings Manus read', '', 'Manus reports what each page says; the app can’t check it.', '', ...s.manus.findings.map((f) => pt(f.text, f)), '');

  if (s.promote) {
    const pr = s.promote;
    add('## Where to promote', '', `**Your angle:** ${esc(pr.positioning.line)} ${basisLabel(pr.positioning)}`, '');
    if (pr.positioning.who) add(`Who: ${esc(pr.positioning.who)}`, '');
    for (const [prio, title] of [[1, 'Start here'], [2, 'Next'], [3, 'Later']] as const) {
      const list = pr.channels.filter((c) => c.priority === prio);
      if (!list.length) continue;
      add(`### ${title}`, '');
      for (const c of list) {
        add(`- **${esc(c.name)}** (${CHANNEL_LABEL[c.channelType]}): ${esc(c.why)} ${basisLabel(c)}`);
        for (const h of c.how) add(`  - ${esc(h)}`);
      }
      add('');
    }
    add('### Where the link goes', '', ...Object.entries(pr.links).map(([n, l]) => `- ${net(n)}: ${LINK_PLACEMENT_LABEL[l!.placement]}. ${esc(l!.why)} ${basisLabel(l!)}`), '');
    add('### The page to build first', '', `- ${PAGE_TYPE_LABEL[pr.page.pageType]}: ${esc(pr.page.why)} ${basisLabel(pr.page)}`);
    if (pr.page.secondType) add(`- Second choice: ${PAGE_TYPE_LABEL[pr.page.secondType]}: ${esc(pr.page.secondWhy ?? '')}`);
    add('');
  }

  if (s.content) {
    const c = s.content;
    add('## Social content', '');
    if (c.pillars.length) add('### Content pillars', '', ...c.pillars.flatMap((x) => [`- **${esc(x.name)}**${x.why ? `: ${esc(x.why)}` : ''}`, ...x.ideas.map((i) => `  - ${esc(i)}`)]), '');
    if (c.formats.length) add('### What gets attention on each network', '', ...c.formats.map((f) => pt(`${net(f.platform)}: ${f.what}${f.why ? `. ${f.why}` : ''}`, f)), '');
    const camp = c.campaign;
    add('### Campaign', '', `- Goal: ${GOAL_LABEL[camp.goal]}`, `- Networks: ${camp.platforms.map(net).join(', ')}`, `- Post mix: ${POST_TYPE_IDS.map((t) => `${POST_TYPE[t]}: ${MIX_WORD[camp.postMix[t]]}`).join(', ')}`, `- Videos: ${camp.videoShare}`, camp.why ? `- ${esc(camp.why)} ${basisLabel(camp)}` : `- ${basisLabel(camp)}`, '');
    if (c.ideas.length) add('### Post ideas', '', ...c.ideas.map((i) => `- ${esc(i.headline)} (${POST_TYPE[i.postType]}${i.platform ? `, ${net(i.platform)}` : ''})`), '');
  }

  if (s.assets) {
    const a = s.assets;
    add('## Assets to create', '', ...a.assets.flatMap((x) => [`- **${ASSET_LABEL[x.kind]}: ${esc(x.title)}**${x.why ? ` ${esc(x.why)}` : ''} ${basisLabel(x)}`, ...(x.prompt ? [`  - Suggested request: ${esc(x.prompt)}`] : [])]), '');
    const seo = a.seo;
    add('## SEO page', '');
    if (seo.audience) add(`- Who it’s for: ${esc(seo.audience)}`);
    if (seo.angle) add(`- Angle: ${esc(seo.angle)}`);
    if (seo.objections.length) add(`- Questions to answer: ${seo.objections.map(esc).join('; ')}`);
    if (seo.keywords.length) add(`- Search terms to work in (ideas to check, not search data): ${seo.keywords.map(esc).join(', ')}`);
    add(`- Call to action: ${CTA_LABEL[seo.cta]} ${basisLabel(seo)}`, '');
  }

  if (s.outreach) {
    const o = s.outreach;
    add('## Email outreach', '', 'Emails you send yourself, from your own email. Fill in the [brackets] before you send.', '');
    if (o.email.idea) add(`- Lead magnet: ${LEAD_MAGNET_LABEL[o.email.leadMagnetType]}: ${esc(o.email.idea)} ${basisLabel(o.email)}`);
    if (o.email.welcomeAngle) add(`- Welcome emails: ${esc(o.email.welcomeAngle)}`);
    add('');
    for (const t of o.templates) {
      add(`### To: ${esc(t.who || 'someone who can send you clients')} (${PURPOSE_LABEL[t.purpose]})`, '', `Subject: ${esc(t.subject)}`, '', ...esc(t.body).split('\n').map((l) => (l ? `> ${l}` : '>')), '');
      if (t.followUp) add(`If there’s no reply after a few days: ${esc(t.followUp)}`, '');
    }
  }

  const sources = [...s.sources].sort((a, b) => a.n - b.n);
  if (sources.length) {
    add('## Sources', '');
    for (const x of sources) add(`[${x.n}] ${esc(x.title)} — ${esc(x.url)} (found ${day(x.at || ctx.now)}${x.pageAge ? `, page date ${esc(x.pageAge)}` : ''}${x.via === 'manus' ? ', via Manus' : ''})`);
    add('', 'Links open the original pages. The app shows them as found and doesn’t vouch for them.');
  }
  return `${L.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
