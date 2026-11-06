import type { BrandColors, CodeKind, Directives, Project, PromptImage, ServicePackage } from '@/lib/types';
import { escapeHtml, hashStr, readableOn, todayStr, toDateStr, lighten, darken, listJoin, truncate } from '@/lib/utils';
import { imageKeyNumber, imageTokens, resolveImageTokens } from '@/lib/promptImages';
import { LEAD_ACTION, previewLeadAction, resolveLeadAction } from '@/lib/leadAction';
import type { CalcKind } from '../knowledge';
import { buildFacts, verbOutcome, Voice, type Facts } from '../text';

// Closing tags are assembled at runtime so this bundle never contains a literal
// script terminator when it is inlined into a single HTML file.
const LT = String.fromCharCode(60);
export const SCRIPT_OPEN = LT + 'script>';
export const SCRIPT_CLOSE = LT + '/script>';

export interface CodeResult {
  name: string;
  kind: CodeKind;
  html: string;
  css: string;
  js: string;
  script?: string;
  note?: string;
}

export const CODE_KINDS: { id: CodeKind; label: string; desc: string; icon: string; business?: boolean }[] = [
  { id: 'calculator', label: 'Interactive calculator', desc: 'Niche-specific calculator that captures attention and leads', icon: 'calculator' },
  { id: 'leadform', label: 'Lead capture form', desc: 'Opt-in form with validation and success state', icon: 'mail' },
  { id: 'pricing', label: 'Pricing table', desc: 'Tiered plans with a highlighted favorite', icon: 'tag' },
  { id: 'hero', label: 'Landing hero section', desc: 'Headline, CTA and product preview', icon: 'layout-template' },
  { id: 'countdown', label: 'Launch countdown', desc: 'Urgency timer for launches and promos', icon: 'clock' },
  { id: 'quiz', label: 'Quiz / assessment', desc: 'Scored quiz that recommends your offer', icon: 'list-checks' },
  { id: 'checklist', label: 'Interactive checklist', desc: 'Progress-tracking checklist that remembers ticks', icon: 'list-checks' },
  { id: 'testimonials', label: 'Testimonial carousel', desc: 'Auto-rotating reviews slider', icon: 'message-square-quote' },
  { id: 'booking', label: 'Booking widget', desc: 'Pick a service, date and time', icon: 'calendar-check', business: true },
  { id: 'spreadsheet', label: 'Spreadsheet + Apps Script', desc: 'Formulas, tabs and automation script', icon: 'table-2' },
  { id: 'faq', label: 'FAQ accordion', desc: 'Objection-busting FAQ block', icon: 'circle-help' },
  { id: 'roi', label: 'ROI / savings calculator', desc: 'Shows the money or time your offer saves', icon: 'trending-up' },
];

// Words that name a kind of widget. Whole words where a part would mislead: "ebook", "bookkeeping" and
// "Facebook" aren't bookings, "preview" isn't a review, "information" isn't a form.
const KIND_WORDS: [RegExp, CodeKind][] = [
  [/\broi\b|return on|savings calc|how much (?:time|money)/, 'roi'],
  [/spreadsheet|google sheets?|excel|formula|apps ?script/, 'spreadsheet'],
  [/calculat|estimat|cost of|compute/, 'calculator'],
  [/countdown|timer|deadline|launch clock/, 'countdown'],
  [/quiz|assessment|score yourself|personality test/, 'quiz'],
  [/testimonial|\breviews?\b|carousel|slider/, 'testimonials'],
  [/\bbook(?:ings?|s|ed)?\b|appointment|schedul|reserv/, 'booking'],
  [/pricing|\bplans\b|\btiers\b|\bpackages\b/, 'pricing'],
  [/\bfaqs?\b|\bquestions\b|accordion/, 'faq'],
  [/checklist|to-?do|habit tracker|task list/, 'checklist'],
  [/\bhero\b|landing|\bheader\b|above the fold|homepage/, 'hero'],
  [/\bforms?\b|opt-?in|sign ?up|subscribe|\bleads?\b|waitlist|email capture|newsletter/, 'leadform'],
];

/**
 * The kind of widget a request names, or null when it names none. When it names several, the first one
 * wins: people say what it is first ("a FAQ that answers pricing questions" is a FAQ, not a pricing table).
 */
export function matchKind(prompt: string): CodeKind | null {
  const p = prompt.toLowerCase();
  let best: { at: number; kind: CodeKind } | null = null;
  for (const [re, kind] of KIND_WORDS) {
    const m = re.exec(p);
    if (m && (!best || m.index < best.at)) best = { at: m.index, kind };
  }
  return best?.kind ?? null;
}

export function detectKind(prompt: string, project: Project): CodeKind {
  const named = matchKind(prompt);
  if (named) return named;
  if (project.track === 'business') return 'booking';
  if (project.format === 'spreadsheet') return 'spreadsheet';
  return 'calculator';
}

// ───────────── shared styling ─────────────

function baseCss(c: BrandColors): string {
  const brandInk = readableOn(c.primary);
  return `:root {
  --brand: ${c.primary};
  --brand-dark: ${darken(c.primary, 0.22)};
  --brand-soft: ${lighten(c.primary, 0.88)};
  --brand-ink: ${brandInk};
  --accent: ${c.accent};
  --bg: ${c.paper};
  --card: #ffffff;
  --ink: ${c.ink};
  --muted: #5d6b64;
  --line: #e2e7e3;
  --radius: 14px;
  --scale: 1;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; padding: 24px; background: var(--bg); color: var(--ink); font-family: var(--font); font-size: calc(15px * var(--scale)); line-height: 1.5; }
.ylb { max-width: 760px; margin: 0 auto; }
.ylb-card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 24px; box-shadow: 0 10px 30px -18px rgba(0,0,0,.25); }
.ylb h2 { margin: 0 0 6px; font-size: 1.5em; line-height: 1.2; letter-spacing: -0.01em; }
.ylb .sub { margin: 0 0 18px; color: var(--muted); }
.ylb label { display: block; font-weight: 600; font-size: .85em; margin-bottom: 6px; }
.ylb input, .ylb select, .ylb textarea { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: calc(var(--radius) * .6); font: inherit; color: var(--ink); background: #fff; }
.ylb input:focus, .ylb select:focus, .ylb textarea:focus { outline: 2px solid var(--brand); outline-offset: 1px; border-color: transparent; }
.ylb .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 18px; border: 0; border-radius: calc(var(--radius) * .6); background: var(--brand); color: var(--brand-ink); font: inherit; font-weight: 700; cursor: pointer; text-decoration: none; transition: transform .15s ease, background .15s ease; }
.ylb .btn:hover { background: var(--brand-dark); transform: translateY(-1px); }
.ylb .btn.ghost { background: transparent; color: var(--ink); border: 1px solid var(--line); }
.ylb .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.ylb .muted { color: var(--muted); }
.ylb .pill { display: inline-block; padding: 4px 10px; border-radius: 999px; background: var(--brand-soft); color: var(--brand-dark); font-size: .75em; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
`;
}

const money = `function fmt$(n){return (isFinite(n)?n:0).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});}
function fmtN(n,d){return (isFinite(n)?n:0).toLocaleString('en-US',{maximumFractionDigits:d==null?0:d});}`;

/** The owner's website, or '#' until they add one (never a domain made up from the brand name). */
const linkTo = (f: Facts) => escapeHtml(f.url || '#');
/** An HTML comment flagging a '#' button link, or '' when the owner has a website. */
const linkTodo = (f: Facts, indent = '') => (f.url ? '' : `${indent}<!-- TODO: no website set yet. Replace "#" with your booking or checkout link (or add your website in Brand settings and generate again). -->\n`);

// ───────────── owner settings for widgets ─────────────

/** What a widget needs from the owner. Nothing here is ever made up: empty means "not set yet". */
export interface WidgetSettings {
  /** where forms send: the owner's form endpoint URL or a mailto: address; '' = not connected */
  action: string;
  /** where `action` came from, for the note shown after generating */
  actionFrom: 'prompt' | 'listing' | '';
  /** when the owner's offer ends, local time "YYYY-MM-DDTHH:MM"; '' = not set */
  endDate: string;
  /** the owner's opening hours as typed in the listing */
  hours: string;
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\b\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*(?:[:.]\d|%|am\b|pm\b))(?:,?\s+(\d{4})\b)?/i;
const pad2 = (n: number) => String(n).padStart(2, '0');
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * An end date the owner wrote explicitly in the request ("ends 2026-12-01", "until Dec 1", "December 1, 2026"), or ''.
 * Only a real month name (whole word) followed by a valid day counts: "marketing 3" or "decide 2" are not dates.
 */
export function parseEndDate(prompt: string, today = todayStr()): string {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b(?:[ T](\d{1,2}):(\d{2})\b)?/.exec(prompt);
  if (iso) {
    const [, y, mo, d, h, mi] = iso;
    const [yn, mn, dn] = [Number(y), Number(mo), Number(d)];
    if (mn < 1 || mn > 12 || dn < 1 || dn > daysIn(yn, mn)) return '';
    if (h && (Number(h) > 23 || Number(mi) > 59)) return '';
    return `${y}-${mo}-${d}T${h ? `${pad2(Number(h))}:${mi}` : '23:59'}`;
  }
  const named = MONTH_RE.exec(prompt);
  if (!named) return '';
  const word = named[1].toLowerCase();
  const month = MONTH_NAMES.findIndex((m) => m.startsWith(word.slice(0, 3))) + 1;
  const day = Number(named[2]);
  let year = named[3] ? Number(named[3]) : Number(today.slice(0, 4));
  if (day < 1 || day > daysIn(named[3] ? year : 2024, month)) return '';
  if (!named[3] && `${year}-${pad2(month)}-${pad2(day)}` < today) year += 1;
  if (day > daysIn(year, month)) return ''; // Feb 29 rolled into a non-leap year
  return `${year}-${pad2(month)}-${pad2(day)}T23:59`;
}

/** Words that say "send the form here", right before the URL or address they apply to. */
const ACTION_CUE = String.raw`(?:\b(?:form\s+)?action|\bendpoint|\bwebhook(?:\s+url)?|\b(?:post|submit|send|deliver|forward)(?:s|ed|ing)?(?:\s+(?:it|them|the\s+form|the\s+data|form\s+data|entries|submissions?|signups?|sign-ups|leads?|requests?|bookings?|responses?))?\s+(?:to|at))\s*[:=]?\s*`;

/**
 * Where forms should send. A URL is only used when the request says it is the target ("post to https://…",
 * "form action https://…", "endpoint https://…"); a URL merely mentioned is not. Same for an email address
 * ("mailto:…", "send signups to me@…"). Otherwise the listing's contact email, or not connected.
 */
function formAction(project: Project, prompt: string): Pick<WidgetSettings, 'action' | 'actionFrom'> {
  const url = new RegExp(`${ACTION_CUE}(https://[^\\s"'<>]+)`, 'i').exec(prompt)?.[1]?.replace(/[.,;)]+$/, '');
  if (url) return { action: url, actionFrom: 'prompt' };
  const email =
    /\bmailto:([^\s@"'<>?]+@[^\s@"'<>?]+\.[a-z]{2,})\b/i.exec(prompt)?.[1] ??
    new RegExp(`${ACTION_CUE}([^\\s@"'<>]+@[^\\s@"'<>]+\\.[a-z]{2,})\\b`, 'i').exec(prompt)?.[1];
  if (email) return { action: `mailto:${email}`, actionFrom: 'prompt' };
  const listed = project.studio.listing?.contactEmail?.trim();
  if (listed && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(listed)) return { action: `mailto:${listed}`, actionFrom: 'listing' };
  return { action: '', actionFrom: '' };
}

export function widgetSettings(project: Project, prompt = ''): WidgetSettings {
  return { ...formAction(project, prompt), endDate: parseEndDate(prompt), hours: project.studio.listing?.hours?.trim() ?? '' };
}

const DAY_KEYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const HOURS_TOKEN =
  /\b(daily|every ?day|7 days(?: a week)?)\b|\b(weekdays?)\b|\b(weekends?)\b|\b(mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday|rs|r|s)?\b\.?(?:\s*(?:-|–|—|to|through|thru)\s*(mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday|rs|r|s)?\b\.?)?|\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:-|–|—|to)\s*(\d{1,2})(?!\d)(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?|\b(closed)\b/gi;

const to24 = (h: number, ap: string | undefined) => {
  const a = ap?.toLowerCase().replace(/\./g, '');
  if (a === 'pm' && h < 12) return h + 12;
  if (a === 'am' && h === 12) return 0;
  return h;
};
const timeLabel = (mins: number) => {
  const h = Math.floor(mins / 60);
  return `${((h + 11) % 12) + 1}:${pad2(mins % 60)} ${h < 12 ? 'AM' : 'PM'}`;
};

/**
 * Bookable start times per weekday (0 = Sunday), one an hour across the whole opening range, read from the owner's opening hours such as
 * "Mon–Fri 9am–5pm, Sat 10am–2pm". Null when the hours are missing or can't be read: the widget then
 * asks for a preferred day and time instead of showing slots.
 */
export function parseHours(text: string): Record<number, string[]> | null {
  const out: Record<number, string[]> = {};
  let pending: number[] = [];
  for (const m of (text || '').matchAll(HOURS_TOKEN)) {
    if (m[1]) pending = [0, 1, 2, 3, 4, 5, 6];
    else if (m[2]) pending = [1, 2, 3, 4, 5];
    else if (m[3]) pending = [0, 6];
    else if (m[4]) {
      const a = DAY_KEYS[m[4].toLowerCase()];
      if (m[5]) {
        const b = DAY_KEYS[m[5].toLowerCase()];
        const span: number[] = [];
        for (let d = a; span.length < 7; d = (d + 1) % 7) {
          span.push(d);
          if (d === b) break;
        }
        pending = [...pending, ...span];
      } else pending = [...pending, a];
    } else if (m[12]) pending = [];
    else if (m[6]) {
      if (!pending.length) continue;
      const [sh, eh, sap, eap] = [Number(m[6]), Number(m[9]), m[8], m[11]];
      let end24 = eap ? to24(eh, eap) : eh;
      let start24: number;
      if (sap) start24 = to24(sh, sap);
      else if (eap) {
        // "9-5pm" means 9 AM; "1-5pm" means 1 PM
        const same = to24(sh, eap);
        start24 = same <= end24 ? same : to24(sh, 'am');
      } else start24 = sh;
      if (!eap && end24 <= start24) end24 += 12;
      const start = start24 * 60 + Number(m[7] ?? 0);
      const end = end24 * 60 + Number(m[10] ?? 0);
      if (end > 24 * 60 || end - start < 60) {
        pending = [];
        continue;
      }
      const slots: string[] = [];
      // every hour the business is open, start to last full hour; nothing is dropped (24 slots at most)
      for (let t = start; t + 60 <= end; t += 60) slots.push(timeLabel(t));
      for (const d of pending) out[d] = slots;
      pending = [];
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Shared form sending. FORM_ACTION sits at the top of the script so the owner can see and change it.
 * With no action set, nothing is sent and the widget says so ("Not connected: submissions are not sent").
 */
function formJs(action: string): string {
  return `// Where submissions go. Set FORM_ACTION to your own form endpoint (for example a Formspree, Basin or
// Google Apps Script web app URL) or to "mailto:you@yourbusiness.com".
// TODO: until it is set, this form sends nothing and shows "Not connected: submissions are not sent".
var FORM_ACTION = ${JSON.stringify(action)};
var notice = document.getElementById('ylb-notice');
if (notice) notice.hidden = !!FORM_ACTION;
function ylbSend(fields, subject) {
  if (!FORM_ACTION) return Promise.resolve('none');
  if (/^mailto:/i.test(FORM_ACTION)) {
    var body = Object.keys(fields).map(function (k) { return k + ': ' + fields[k]; }).join('\\n');
    window.location.href = FORM_ACTION + (FORM_ACTION.indexOf('?') < 0 ? '?' : '&') + 'subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    return Promise.resolve('mail');
  }
  var data = new FormData();
  Object.keys(fields).forEach(function (k) { data.append(k, fields[k]); });
  return fetch(FORM_ACTION, { method: 'POST', body: data, headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? 'sent' : 'error'; }, function () { return 'error'; });
}
var YLB_MESSAGES = {
  sent: 'Thanks, your details were sent.',
  mail: 'Your email app should open with your details. Send that email to finish.',
  none: 'This form is not connected yet, so nothing was sent.',
  error: 'Something went wrong and nothing was sent. Please try again.'
};`;
}

const NOTICE_HTML = `<p class="ylb-notice" id="ylb-notice" hidden>Not connected: submissions are not sent</p>`;
const NOTICE_CSS = `.ylb-notice { margin: 0 0 14px; padding: 8px 12px; border-radius: calc(var(--radius) * .6); background: #fff4e5; color: #8a4b00; font-size: .85em; font-weight: 600; }
`;

/** The note shown in the Code tab after generating a form widget. */
function formNote(s: WidgetSettings): string {
  if (!s.action) return 'Not connected yet: set FORM_ACTION at the top of the JS to your form endpoint or a mailto: address. Until then nothing is sent.';
  if (s.actionFrom === 'listing') return `Submissions open an email to ${s.action.slice(7)} (your listing's contact email). Change FORM_ACTION in the JS to use a form endpoint.`;
  return `Submissions go to ${s.action.replace(/^mailto:/, '')}. Change FORM_ACTION in the JS to send them elsewhere.`;
}

// ───────────── calculators ─────────────

interface CalcField {
  id: string;
  label: string;
  type: 'number' | 'select';
  value: number | string;
  prefix?: string;
  suffix?: string;
  step?: number;
  options?: [string, string][];
}
interface CalcSpec {
  title: string;
  sub: string;
  fields: CalcField[];
  outputs: { id: string; label: string }[];
  compute: string;
  note: string;
  /** shown to the owner in the Code tab, not in the widget */
  ownerNote?: string;
}

function calcSpec(kind: CalcKind | 'roi', f: Facts, packages: ServicePackage[] = []): CalcSpec {
  switch (kind) {
    case 'tax':
      return {
        title: 'Quarterly Tax Set-Aside Calculator',
        sub: `How much should you move into your tax account from every payment?`,
        fields: [
          { id: 'income', label: 'Average monthly income', type: 'number', value: 6500, prefix: '$' },
          { id: 'expenses', label: 'Monthly business expenses', type: 'number', value: 1200, prefix: '$' },
          { id: 'rate', label: 'Estimated combined tax rate', type: 'number', value: 28, suffix: '%' },
        ],
        outputs: [
          { id: 'o1', label: 'Set aside each month' },
          { id: 'o2', label: 'Quarterly estimated payment' },
          { id: 'o3', label: 'Save this % of every payment' },
        ],
        compute: `var profit=Math.max(0,v('income')-v('expenses'));var monthly=profit*v('rate')/100;
set('o1',fmt$(monthly));set('o2',fmt$(monthly*3));set('o3',fmtN(v('income')>0?monthly/v('income')*100:0,1)+'%');`,
        note: 'Estimates only. Confirm rates with a tax professional.',
      };
    case 'macro':
      return {
        title: 'Daily Protein & Calorie Calculator',
        sub: 'A starting point for your training days.',
        fields: [
          { id: 'weight', label: 'Body weight', type: 'number', value: 160, suffix: 'lb' },
          { id: 'activity', label: 'Activity level', type: 'select', value: '14', options: [['12', 'Mostly sitting'], ['14', 'Active 3x per week'], ['16', 'Active 5x per week'], ['18', 'Athlete']] },
          { id: 'goal', label: 'Goal', type: 'select', value: '0', options: [['-350', 'Lose fat'], ['0', 'Maintain'], ['250', 'Build muscle']] },
        ],
        outputs: [
          { id: 'o1', label: 'Calories per day' },
          { id: 'o2', label: 'Protein target' },
          { id: 'o3', label: 'Carbs / fat split' },
        ],
        compute: `var cal=v('weight')*v('activity')+v('goal');var p=v('weight')*0.8;var fat=cal*0.28/9;var carbs=(cal-p*4-fat*9)/4;
set('o1',fmtN(cal));set('o2',fmtN(p)+' g');set('o3',fmtN(Math.max(0,carbs))+' g / '+fmtN(fat)+' g');`,
        note: 'General guidance, not medical advice.',
      };
    case 'mortgage':
      return {
        title: 'Mortgage Payment Calculator',
        sub: 'Know your real monthly number before you tour.',
        fields: [
          { id: 'price', label: 'Home price', type: 'number', value: 425000, prefix: '$', step: 1000 },
          { id: 'down', label: 'Down payment', type: 'number', value: 10, suffix: '%' },
          { id: 'rate', label: 'Interest rate', type: 'number', value: 6.4, suffix: '%', step: 0.1 },
          { id: 'years', label: 'Loan term', type: 'select', value: '30', options: [['30', '30 years'], ['20', '20 years'], ['15', '15 years']] },
        ],
        outputs: [
          { id: 'o1', label: 'Monthly principal & interest' },
          { id: 'o2', label: 'Loan amount' },
          { id: 'o3', label: 'Total interest paid' },
        ],
        compute: `var loan=v('price')*(1-v('down')/100);var r=v('rate')/100/12;var n=v('years')*12;var pmt=r>0?loan*r/(1-Math.pow(1+r,-n)):loan/n;
set('o1',fmt$(pmt));set('o2',fmt$(loan));set('o3',fmt$(pmt*n-loan));`,
        note: 'Excludes taxes, insurance and HOA.',
      };
    case 'time':
    case 'habit':
      return {
        title: kind === 'habit' ? 'Habit Progress Calculator' : 'Time Savings Calculator',
        sub: kind === 'habit' ? 'Small daily minutes add up fast.' : `See how much time a better ${f.topicLower} system gives back.`,
        fields: [
          { id: 'tasks', label: kind === 'habit' ? 'Minutes per session' : 'Repeat tasks per week', type: 'number', value: kind === 'habit' ? 10 : 12 },
          { id: 'mins', label: kind === 'habit' ? 'Sessions per week' : 'Minutes per task', type: 'number', value: kind === 'habit' ? 5 : 20 },
          { id: 'saved', label: kind === 'habit' ? 'Weeks' : 'Time saved with the system', type: 'number', value: kind === 'habit' ? 12 : 40, suffix: kind === 'habit' ? '' : '%' },
        ],
        outputs:
          kind === 'habit'
            ? [
                { id: 'o1', label: 'Total practice time' },
                { id: 'o2', label: 'Sessions completed' },
                { id: 'o3', label: 'Equivalent full days' },
              ]
            : [
                { id: 'o1', label: 'Hours saved per month' },
                { id: 'o2', label: 'Hours saved per year' },
                { id: 'o3', label: 'Workdays reclaimed per year' },
              ],
        compute:
          kind === 'habit'
            ? `var total=v('tasks')*v('mins')*v('saved');set('o1',fmtN(total/60,1)+' hrs');set('o2',fmtN(v('mins')*v('saved')));set('o3',fmtN(total/60/8,1));`
            : `var weekly=v('tasks')*v('mins')*v('saved')/100/60;set('o1',fmtN(weekly*4.33,1)+' hrs');set('o2',fmtN(weekly*52)+' hrs');set('o3',fmtN(weekly*52/8,1));`,
        note: 'Based on the numbers you enter.',
      };
    case 'grade':
      return {
        title: 'Final Exam Score Calculator',
        sub: 'What do you need on the final to hit your goal?',
        fields: [
          { id: 'current', label: 'Current grade', type: 'number', value: 82, suffix: '%' },
          { id: 'target', label: 'Target grade', type: 'number', value: 90, suffix: '%' },
          { id: 'weight', label: 'Final exam weight', type: 'number', value: 25, suffix: '%' },
        ],
        outputs: [
          { id: 'o1', label: 'Score needed on final' },
          { id: 'o2', label: 'Difficulty' },
          { id: 'o3', label: 'Study plan' },
        ],
        compute: `var w=v('weight')/100;var need=w>0?(v('target')-v('current')*(1-w))/w:0;set('o1',fmtN(need,1)+'%');
set('o2',need>100?'Out of reach':need>92?'Stretch goal':need>80?'Achievable':'Comfortable');set('o3',need>92?'5 sessions / week':need>80?'3 sessions / week':'2 sessions / week');`,
        note: 'Assumes a weighted average grading scheme.',
      };
    case 'recipe':
    case 'food-cost':
      return kind === 'food-cost'
        ? {
            title: 'Menu Item Pricing Calculator',
            sub: 'Price dishes for a healthy food cost.',
            fields: [
              { id: 'cost', label: 'Ingredient cost per plate', type: 'number', value: 4.2, prefix: '$', step: 0.1 },
              { id: 'target', label: 'Target food cost', type: 'number', value: 30, suffix: '%' },
              { id: 'covers', label: 'Plates sold per week', type: 'number', value: 120 },
            ],
            outputs: [
              { id: 'o1', label: 'Recommended menu price' },
              { id: 'o2', label: 'Gross profit per plate' },
              { id: 'o3', label: 'Weekly gross profit' },
            ],
            compute: `var price=v('cost')/(v('target')/100||1);price=Math.ceil(price*2)/2-0.01;set('o1','$'+price.toFixed(2));set('o2','$'+(price-v('cost')).toFixed(2));set('o3',fmt$((price-v('cost'))*v('covers')));`,
            note: 'Round to your menu’s price endings.',
          }
        : {
            title: 'Meal Prep Savings Calculator',
            sub: 'Cook at home and watch the savings stack up.',
            fields: [
              { id: 'people', label: 'People in household', type: 'number', value: 3 },
              { id: 'meals', label: 'Takeout meals per week', type: 'number', value: 5 },
              { id: 'takeout', label: 'Avg takeout cost per person', type: 'number', value: 16, prefix: '$' },
              { id: 'home', label: 'Avg home-cooked cost per person', type: 'number', value: 4.5, prefix: '$', step: 0.5 },
            ],
            outputs: [
              { id: 'o1', label: 'Weekly savings' },
              { id: 'o2', label: 'Monthly savings' },
              { id: 'o3', label: 'Yearly savings' },
            ],
            compute: `var s=(v('takeout')-v('home'))*v('people')*v('meals');set('o1',fmt$(s));set('o2',fmt$(s*4.33));set('o3',fmt$(s*52));`,
            note: 'Your grocery prices may vary.',
          };
    case 'routine':
      return {
        title: 'Cost-Per-Use Calculator',
        sub: 'Is that product actually worth it?',
        fields: [
          { id: 'price', label: 'Product price', type: 'number', value: 38, prefix: '$' },
          { id: 'size', label: 'Bottle size', type: 'number', value: 50, suffix: 'ml' },
          { id: 'use', label: 'Amount per use', type: 'number', value: 0.8, suffix: 'ml', step: 0.1 },
          { id: 'freq', label: 'Uses per day', type: 'number', value: 2 },
        ],
        outputs: [
          { id: 'o1', label: 'Cost per use' },
          { id: 'o2', label: 'Uses per bottle' },
          { id: 'o3', label: 'Lasts about' },
        ],
        compute: `var uses=v('use')>0?v('size')/v('use'):0;set('o1','$'+(uses?v('price')/uses:0).toFixed(2));set('o2',fmtN(uses));set('o3',fmtN(v('freq')?uses/v('freq'):0)+' days');`,
        note: 'Helpful when comparing products.',
      };
    case 'budget':
      return {
        title: '50/30/20 Budget Calculator',
        sub: 'A simple split for your monthly take-home pay.',
        fields: [{ id: 'pay', label: 'Monthly take-home pay', type: 'number', value: 4800, prefix: '$' }],
        outputs: [
          { id: 'o1', label: 'Needs (50%)' },
          { id: 'o2', label: 'Wants (30%)' },
          { id: 'o3', label: 'Savings & goals (20%)' },
        ],
        compute: `set('o1',fmt$(v('pay')*.5));set('o2',fmt$(v('pay')*.3));set('o3',fmt$(v('pay')*.2));`,
        note: 'Adjust the split to fit your goals.',
      };
    case 'pricing':
      return {
        title: 'Freelance Rate Calculator',
        sub: 'Charge what you need to hit your income goal.',
        fields: [
          { id: 'goal', label: 'Annual income goal', type: 'number', value: 90000, prefix: '$', step: 1000 },
          { id: 'hours', label: 'Billable hours per week', type: 'number', value: 25 },
          { id: 'weeks', label: 'Weeks off per year', type: 'number', value: 6 },
          { id: 'costs', label: 'Annual business costs', type: 'number', value: 8000, prefix: '$', step: 500 },
        ],
        outputs: [
          { id: 'o1', label: 'Minimum hourly rate' },
          { id: 'o2', label: 'Day rate (6 hrs)' },
          { id: 'o3', label: 'Monthly revenue target' },
        ],
        compute: `var billable=v('hours')*Math.max(1,52-v('weeks'));var hr=(v('goal')+v('costs'))/Math.max(1,billable);set('o1',fmt$(hr));set('o2',fmt$(hr*6));set('o3',fmt$((v('goal')+v('costs'))/12));`,
        note: 'Add a buffer for taxes and slow months.',
      };
    case 'salary':
      return {
        title: 'Offer Negotiation Calculator',
        sub: 'See what a counter-offer is worth over time.',
        fields: [
          { id: 'offer', label: 'Base salary offer', type: 'number', value: 82000, prefix: '$', step: 1000 },
          { id: 'ask', label: 'Counter-offer increase', type: 'number', value: 8, suffix: '%' },
          { id: 'raise', label: 'Average annual raise', type: 'number', value: 3, suffix: '%' },
        ],
        outputs: [
          { id: 'o1', label: 'Counter-offer' },
          { id: 'o2', label: 'Extra in year one' },
          { id: 'o3', label: 'Extra over 5 years' },
        ],
        compute: `var c=v('offer')*(1+v('ask')/100);var diff=c-v('offer');var five=0;for(var i=0;i<5;i++){five+=diff*Math.pow(1+v('raise')/100,i);}set('o1',fmt$(c));set('o2',fmt$(diff));set('o3',fmt$(five));`,
        note: 'Raises compound on your base, so the first number matters.',
      };
    case 'margin':
      return {
        title: 'Product Price & Margin Calculator',
        sub: 'Price every product for profit after fees.',
        fields: [
          { id: 'cogs', label: 'Cost to make', type: 'number', value: 9, prefix: '$', step: 0.5 },
          { id: 'ship', label: 'Packaging + shipping', type: 'number', value: 4.5, prefix: '$', step: 0.5 },
          { id: 'fee', label: 'Platform + payment fees', type: 'number', value: 9.5, suffix: '%', step: 0.5 },
          { id: 'margin', label: 'Target profit margin', type: 'number', value: 55, suffix: '%' },
        ],
        outputs: [
          { id: 'o1', label: 'Recommended price' },
          { id: 'o2', label: 'Profit per sale' },
          { id: 'o3', label: 'Break-even price' },
        ],
        compute: `var cost=v('cogs')+v('ship');var denom=1-v('fee')/100-v('margin')/100;var price=denom>0?cost/denom:cost*3;price=Math.ceil(price)-0.01;var profit=price*(1-v('fee')/100)-cost;
set('o1','$'+price.toFixed(2));set('o2','$'+profit.toFixed(2));set('o3','$'+(cost/(1-v('fee')/100)).toFixed(2));`,
        note: 'Check fees for your platform.',
      };
    case 'quote': {
      // only the owner's own packages and prices; no service list or price ranges from a business-type template
      const own = packages.slice(0, 8);
      const options: [string, string][] = own.length
        ? own.map((p) => [String(p.price > 0 ? p.price : 0), p.price > 0 ? p.name : `${p.name} [set a price]`])
        : [
            ['0', '[Service 1]'],
            ['0', '[Service 2]'],
            ['0', '[Service 3]'],
          ];
      const missing = !own.length || own.some((p) => !(p.price > 0));
      return {
        title: 'Quote Estimator',
        sub: `Get a rough price from ${f.brand}.`,
        fields: [
          { id: 'service', label: 'Service', type: 'select', value: options[0][0], options },
          { id: 'qty', label: 'How many', type: 'number', value: 1 },
        ],
        outputs: [{ id: 'o1', label: 'Estimated price' }],
        compute: `var p=v('service')*Math.max(0,v('qty'));set('o1',v('service')>0?fmt$(p):'[Price on request]');`,
        note: 'A rough estimate, not a quote.',
        ownerNote: missing
          ? own.length
            ? 'Some of your packages have no price yet, so they show “[Price on request]”. Add prices in Studio → Packages and generate again, or edit the option values in the HTML.'
            : 'No packages with prices yet, so the services are [bracketed] placeholders. Add your packages and prices in Studio → Packages and generate again, or replace each option’s label and value (the price) in the HTML.'
          : undefined,
      };
    }
    case 'roi':
    default:
      return {
        title: f.track === 'business' ? 'Value Estimator' : 'ROI Calculator',
        sub: `Enter your own numbers to estimate what ${f.productShort} could be worth to you.`,
        fields: [
          { id: 'hours', label: 'Hours per week (your estimate)', type: 'number', value: 0 },
          { id: 'value', label: 'Value of an hour', type: 'number', value: 0, prefix: '$' },
          { id: 'team', label: 'People', type: 'number', value: 1 },
          { id: 'cost', label: `Monthly cost of ${f.productShort}`, type: 'number', value: Math.max(0, f.price || 0), prefix: '$' },
        ],
        outputs: [
          { id: 'o1', label: 'Monthly value created' },
          { id: 'o2', label: 'Annual ROI' },
          { id: 'o3', label: 'Pays for itself in' },
        ],
        compute: `var monthly=v('hours')*v('value')*v('team')*4.33;var roi=v('cost')>0?(monthly-v('cost'))/v('cost')*100:0;var days=monthly>0?v('cost')/(monthly/30):0;
set('o1',fmt$(monthly));set('o2',fmtN(roi)+'%');set('o3',fmtN(Math.max(1,days))+' days');`,
        note: 'An estimate from the numbers you enter, not a promise of results.',
        // Hours saved and what an hour is worth are the visitor's (or owner's) numbers, not a template's.
        ownerNote: 'The hours and hourly value start at 0 so visitors enter their own numbers. Add example defaults in the HTML only if they come from your own customers.',
      };
  }
}

function calculatorCode(kind: CalcKind | 'roi', f: Facts, c: BrandColors, titleOverride?: string, packages: ServicePackage[] = []): CodeResult {
  const s = calcSpec(kind, f, packages);
  const title = titleOverride || s.title;
  const field = (fl: CalcField) => {
    const input =
      fl.type === 'select'
        ? `<select id="${fl.id}">${(fl.options ?? []).map(([val, label]) => `<option value="${escapeHtml(val)}"${val === String(fl.value) ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>`
        : `<input id="${fl.id}" type="number" inputmode="decimal" value="${fl.value}" step="${fl.step ?? 1}" />`;
    const wrapped = fl.prefix || fl.suffix ? `<div class="affix">${fl.prefix ? `<span>${fl.prefix}</span>` : ''}${input}${fl.suffix ? `<span>${fl.suffix}</span>` : ''}</div>` : input;
    return `      <div>\n        <label for="${fl.id}">${escapeHtml(fl.label)}</label>\n        ${wrapped}\n      </div>`;
  };
  const html = `<div class="ylb">
  <div class="ylb-card calc">
    <span class="pill">${escapeHtml(f.brand)}</span>
    <h2>${escapeHtml(title)}</h2>
    <p class="sub">${escapeHtml(s.sub)}</p>
    <form class="grid" id="calc-form" onsubmit="return false">
${s.fields.map(field).join('\n')}
    </form>
    <div class="results">
${s.outputs.map((o, i) => `      <div class="result${i === 0 ? ' main' : ''}"><span>${escapeHtml(o.label)}</span><strong id="${o.id}">–</strong></div>`).join('\n')}
    </div>
    <p class="note muted">${escapeHtml(s.note)}</p>
${linkTodo(f, '    ')}    <a class="btn" href="${linkTo(f)}" target="_blank" rel="noopener">Get the full ${escapeHtml(f.track === 'business' ? 'quote' : f.formatNoun.toLowerCase())} →</a>
  </div>
</div>`;
  const css =
    baseCss(c) +
    `.affix { display: flex; align-items: center; border: 1px solid var(--line); border-radius: calc(var(--radius) * .6); background: #fff; }
.affix:focus-within { outline: 2px solid var(--brand); outline-offset: 1px; }
.affix span { padding: 0 10px; color: var(--muted); font-weight: 600; font-size: .9em; }
.affix input, .affix select { border: 0; outline: none !important; }
.results { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); margin: 20px 0 12px; }
.result { padding: 14px 16px; border-radius: calc(var(--radius) * .7); background: var(--brand-soft); }
.result span { display: block; font-size: .78em; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.result strong { display: block; margin-top: 4px; font-size: 1.45em; font-variant-numeric: tabular-nums; }
.result.main { background: var(--brand); color: var(--brand-ink); }
.result.main span { color: inherit; opacity: .85; }
.note { font-size: .8em; margin: 0 0 16px; }
`;
  const js = `${money}
function v(id){var el=document.getElementById(id);return parseFloat(el&&el.value)||0;}
function set(id,val){var el=document.getElementById(id);if(el)el.textContent=val;}
function calc(){${s.compute}}
document.getElementById('calc-form').addEventListener('input',calc);
calc();`;
  return { name: title, kind: kind === 'roi' ? 'roi' : 'calculator', html, css, js, ...(s.ownerNote ? { note: s.ownerNote } : {}) };
}

// ───────────── other widgets ─────────────

function leadFormCode(f: Facts, c: BrandColors, v: Voice, s: WidgetSettings): CodeResult {
  const lm = f.leadMagnet || `The ${f.topic} Starter Checklist`;
  const bullets = [
    `${v.pick(['Skip', 'Avoid', 'Stop'])} ${f.mistakes[0]}`,
    `${f.quickWins[0].charAt(0).toUpperCase() + f.quickWins[0].slice(1)}`,
    `A simple plan to ${verbOutcome(f.outcomes[0])}`,
  ];
  const html = `<div class="ylb">
  <div class="ylb-card optin">
    <div class="cover" aria-hidden="true"><span>FREE</span><b>${escapeHtml(lm)}</b><em>${escapeHtml(f.brand)}</em></div>
    <div>
      ${NOTICE_HTML}
      <span class="pill">Free download</span>
      <h2>${escapeHtml(lm)}</h2>
      <p class="sub">For ${escapeHtml(f.audience)} who want to ${escapeHtml(verbOutcome(f.outcomes[0]))}.</p>
      <ul class="ticks">
${bullets.map((b) => `        <li>${escapeHtml(b)}</li>`).join('\n')}
      </ul>
      <form id="optin" novalidate>
        <input id="fname" name="fname" placeholder="First name" autocomplete="given-name" />
        <input id="email" name="email" type="email" placeholder="you@email.com" autocomplete="email" required />
        <button class="btn" type="submit">Get the free guide</button>
        <p class="error" id="err" role="alert"></p>
      </form>
      <div class="success" id="ok" hidden>
        <h3>Thanks</h3>
        <p class="muted" id="ok-text"></p>
      </div>
    </div>
  </div>
</div>`;
  const css =
    baseCss(c) +
    NOTICE_CSS +
    `.optin { display: grid; gap: 24px; grid-template-columns: 200px 1fr; align-items: center; }
@media (max-width: 560px) { .optin { grid-template-columns: 1fr; } }
.cover { aspect-ratio: 3/4; border-radius: calc(var(--radius) * .8); background: linear-gradient(150deg, var(--brand), var(--brand-dark)); color: var(--brand-ink); padding: 18px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 20px 40px -20px var(--brand); transform: rotate(-3deg); }
.cover span { align-self: flex-start; background: var(--accent); color: #111; font-weight: 800; font-size: .7em; padding: 3px 8px; border-radius: 6px; letter-spacing: .08em; }
.cover b { font-size: 1.15em; line-height: 1.2; }
.cover em { margin-top: auto; font-style: normal; opacity: .8; font-size: .8em; }
.ticks { padding: 0; margin: 0 0 16px; list-style: none; display: grid; gap: 6px; }
.ticks li::before { content: "✓"; color: var(--brand); font-weight: 800; margin-right: 8px; }
#optin { display: grid; gap: 10px; }
.error { color: #c0392b; font-size: .85em; min-height: 1em; margin: 0; }
.success h3 { margin: 0 0 4px; }
`;
  const js = `${formJs(s.action)}
var form=document.getElementById('optin');
form.addEventListener('submit',function(e){e.preventDefault();
  var email=document.getElementById('email').value.trim();
  var err=document.getElementById('err');
  if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(email)){err.textContent='Please enter a valid email address.';return;}
  err.textContent='';
  ylbSend({name:document.getElementById('fname').value.trim(),email:email,request:${JSON.stringify(lm)}},${JSON.stringify(`Request: ${lm}`)}).then(function(status){
    if(status==='none'||status==='error'){err.textContent=YLB_MESSAGES[status];return;}
    form.hidden=true;document.getElementById('ok').hidden=false;document.getElementById('ok-text').textContent=YLB_MESSAGES[status];
  });
});`;
  return { name: `${lm} opt-in form`, kind: 'leadform', html, css, js, note: formNote(s) };
}

function pricingCode(f: Facts, c: BrandColors, project: Project): CodeResult {
  const monthly = project.studio.priceModel === 'monthly' || project.format === 'software' || project.format === 'membership';
  const ownerPrice = project.studio.price > 0 ? project.studio.price : 0;
  // the owner's packages, or their product at their price; no invented tiers, features or discounts
  const tiers = project.studio.packages.length
    ? project.studio.packages.map((p) => ({ name: p.name, price: p.price > 0 ? `$${p.price}` : '[Price]', desc: p.description, features: p.includes.slice(0, 5), popular: !!p.popular }))
    : [{ name: f.productShort, price: ownerPrice ? `$${ownerPrice}` : '[Price]', desc: f.product === f.productShort ? '' : f.product, features: ['[What’s included]'], popular: false }];
  const html = `<div class="ylb wide">
  <div class="head">
    <span class="pill">Pricing</span>
    <h2>${escapeHtml(tiers.length > 1 ? 'Choose a plan' : `${f.productShort}`)}</h2>
  </div>
  <div class="tiers${tiers.length === 1 ? ' one' : ''}">
${tiers
  .map(
    (t) => `    <div class="tier${t.popular ? ' popular' : ''}">
      ${t.popular ? '<span class="badge">Most popular</span>' : ''}
      <h3>${escapeHtml(t.name)}</h3>
      ${t.desc ? `<p class="muted">${escapeHtml(t.desc)}</p>` : ''}
      <p class="price"><b>${escapeHtml(t.price)}</b><span class="per">${monthly ? '/mo' : ''}</span></p>
      <ul>
${t.features.map((x) => `        <li>${escapeHtml(x)}</li>`).join('\n')}
      </ul>
${linkTodo(f, '      ')}      <a class="btn${t.popular || tiers.length === 1 ? '' : ' ghost'}" href="${linkTo(f)}" target="_blank" rel="noopener">Choose ${escapeHtml(t.name)}</a>
    </div>`,
  )
  .join('\n')}
  </div>
</div>`;
  const css =
    baseCss(c) +
    `.ylb.wide { max-width: 980px; }
.head { text-align: center; margin-bottom: 22px; }
.tiers { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); align-items: stretch; }
.tiers.one { max-width: 380px; margin: 0 auto; }
.tier { position: relative; display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 22px; }
.tier.popular { border: 2px solid var(--brand); box-shadow: 0 18px 40px -24px var(--brand); }
.tier h3 { margin: 0; font-size: 1.15em; }
.tier .muted { margin: 4px 0 12px; font-size: .9em; }
.price { margin: 0 0 14px; }
.price b { font-size: 2.2em; letter-spacing: -0.02em; }
.per { color: var(--muted); margin-left: 2px; }
.tier ul { list-style: none; padding: 0; margin: 0 0 18px; display: grid; gap: 8px; flex: 1; }
.tier li::before { content: "✓"; color: var(--brand); font-weight: 800; margin-right: 8px; }
.badge { position: absolute; top: -12px; left: 22px; background: var(--accent); color: #111; font-size: .72em; font-weight: 800; padding: 4px 10px; border-radius: 999px; }
`;
  const js = `// Static pricing: no script needed. Link each button to your checkout.`;
  const placeholders = tiers.some((t) => t.price === '[Price]' || t.features.includes('[What’s included]'));
  return { name: 'Pricing table', kind: 'pricing', html, css, js, ...(placeholders ? { note: 'Replace the [bracketed] placeholders with your own price and what’s included.' } : {}) };
}

function heroCode(f: Facts, c: BrandColors): CodeResult {
  // the owner's tagline, else the outcome as a question (never stated as a result the owner hasn't promised)
  const headline = f.tagline || `Want to ${verbOutcome(f.outcomes[0])}?`;
  const what = f.track === 'business' ? `${f.topicLower} service` : f.formatNoun.replace(/^[A-Z](?![A-Z])/, (x) => x.toLowerCase());
  const html = `<section class="hero">
  <div class="ylb wide">
    <div class="copy">
      <span class="pill">${escapeHtml(f.local && f.city ? `Serving ${f.city}` : `For ${f.audience}`)}</span>
      <h1>${escapeHtml(headline)}</h1>
      <p class="lead">${escapeHtml(f.pitch || `${f.track === 'business' ? f.brand : f.productShort} is ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what} for ${f.audience}.`)}</p>
      <div class="ctas">
${linkTodo(f, '        ')}        <a class="btn" href="${linkTo(f)}" target="_blank" rel="noopener">${escapeHtml(f.track === 'business' ? 'Book now' : `Get ${f.productShort}`)} →</a>
        <a class="btn ghost" href="#how">See how it works</a>
      </div>
    </div>
    <div class="visual" aria-hidden="true">
      <div class="window">
        <div class="bar"><i></i><i></i><i></i></div>
        <div class="body">
          <b>${escapeHtml(f.productShort)}</b>
          <div class="row"><span>${escapeHtml(f.terms[0])}</span><em style="width:82%"></em></div>
          <div class="row"><span>${escapeHtml(f.terms[1] ?? 'progress')}</span><em style="width:64%"></em></div>
          <div class="row"><span>${escapeHtml(f.terms[2] ?? 'results')}</span><em style="width:91%"></em></div>
        </div>
      </div>
    </div>
  </div>
</section>`;
  const css =
    baseCss(c) +
    `body { padding: 0; }
.hero { padding: 56px 24px; background: radial-gradient(1200px 400px at 85% -10%, var(--brand-soft), transparent), var(--bg); }
.ylb.wide { max-width: 1040px; display: grid; gap: 40px; grid-template-columns: 1.1fr .9fr; align-items: center; }
@media (max-width: 760px) { .ylb.wide { grid-template-columns: 1fr; } }
h1 { font-size: clamp(2em, 5vw, 3.2em); line-height: 1.05; letter-spacing: -0.03em; margin: 14px 0; }
.lead { font-size: 1.12em; color: var(--muted); margin: 0 0 22px; max-width: 34em; }
.ctas { display: flex; gap: 10px; flex-wrap: wrap; }
.window { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 30px 60px -30px rgba(0,0,0,.35); overflow: hidden; transform: rotate(1.5deg); }
.bar { display: flex; gap: 6px; padding: 10px 12px; background: var(--brand); }
.bar i { width: 10px; height: 10px; border-radius: 50%; background: rgba(255,255,255,.6); }
.body { padding: 22px; display: grid; gap: 14px; }
.body b { font-size: 1.1em; }
.row span { display: block; font-size: .8em; color: var(--muted); text-transform: capitalize; margin-bottom: 4px; }
.row em { display: block; height: 10px; border-radius: 999px; background: linear-gradient(90deg, var(--brand), var(--accent)); }
`;
  const js = `document.querySelectorAll('.row em').forEach(function(el,i){var w=el.style.width;el.style.width='0';el.style.transition='width .9s cubic-bezier(.2,.8,.2,1) '+(i*0.15)+'s';requestAnimationFrame(function(){requestAnimationFrame(function(){el.style.width=w;});});});`;
  return { name: 'Landing hero section', kind: 'hero', html, css, js };
}

function countdownCode(f: Facts, c: BrandColors, project: Project, s: WidgetSettings): CodeResult {
  const ownerPrice = project.studio.price > 0 ? `$${project.studio.price}` : '';
  const html = `<div class="ylb">
  <div class="ylb-card countdown">
    <span class="pill">Offer</span>
    <h2>${escapeHtml(f.productShort)}: offer ends in</h2>
    <p class="sub">${ownerPrice ? `Price: <b>${escapeHtml(ownerPrice)}</b>. ` : ''}[What the offer is]</p>
    <p class="ylb-notice" id="no-date" hidden>No end date set: the timer is off.</p>
    <div class="clock" id="clock" aria-live="polite">
      <div><b id="d">0</b><span>days</span></div>
      <div><b id="h">00</b><span>hours</span></div>
      <div><b id="m">00</b><span>min</span></div>
      <div><b id="s">00</b><span>sec</span></div>
    </div>
    <p class="muted" id="ended" hidden>This offer has ended.</p>
${linkTodo(f, '    ')}    <a class="btn" href="${linkTo(f)}" target="_blank" rel="noopener">Get ${escapeHtml(f.productShort)} →</a>
  </div>
</div>`;
  const css =
    baseCss(c) +
    NOTICE_CSS +
    `.countdown { text-align: center; }
.clock { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 20px auto 22px; max-width: 460px; }
.clock div { background: var(--ink); color: #fff; border-radius: calc(var(--radius) * .7); padding: 14px 6px; }
.clock b { display: block; font-size: 2em; font-variant-numeric: tabular-nums; line-height: 1; }
.clock span { font-size: .72em; text-transform: uppercase; letter-spacing: .08em; opacity: .7; }
`;
  const js = `// When your offer really ends, in your local time, e.g. "2026-12-01T23:59".
// TODO: until it is set, the timer stays off.
var END_DATE = ${JSON.stringify(s.endDate)};
var deadline = END_DATE ? new Date(END_DATE).getTime() : NaN;
function pad(n){return String(n).padStart(2,'0');}
function tick(){var ms=Math.max(0,deadline-Date.now());var s=Math.floor(ms/1000);
  document.getElementById('d').textContent=Math.floor(s/86400);
  document.getElementById('h').textContent=pad(Math.floor(s%86400/3600));
  document.getElementById('m').textContent=pad(Math.floor(s%3600/60));
  document.getElementById('s').textContent=pad(s%60);
  if(ms===0){document.getElementById('ended').hidden=false;clearInterval(timer);}}
var timer;
if(!isFinite(deadline)){document.getElementById('no-date').hidden=false;document.getElementById('clock').hidden=true;}
else{tick();timer=setInterval(tick,1000);}`;
  const note = [
    s.endDate
      ? `Counts down to ${s.endDate.replace('T', ' ')} (from your request). Change END_DATE in the JS if that's wrong.`
      : 'No end date yet: set END_DATE at the top of the JS (or say "ends 2026-12-01" when you generate). The timer stays off until then.',
    'Replace “[What the offer is]” with your real offer.',
  ].join(' ');
  return { name: 'Offer countdown', kind: 'countdown', html, css, js, note };
}

function quizCode(f: Facts, c: BrandColors): CodeResult {
  const qs = [
    { q: `How often do you ${f.quickWins[0].replace(/^(open|set|add|try|start|use|pick|write|plan|swap|rewrite|post|give|practice|check|change|book|get|reply)\b/i, (m) => m.toLowerCase())}?`, a: ['Never', 'Sometimes', 'Every week'] },
    { q: `Do you find yourself ${f.mistakes[0]}?`, a: ['All the time', 'Occasionally', 'Rarely'] },
    { q: `How confident are you with ${f.terms[0]}?`, a: ['Not at all', 'Somewhat', 'Very'] },
    { q: `How much does ${f.pain} affect you?`, a: ['A lot', 'A little', 'Not really'] },
    { q: `Do you have a system for ${f.topicLower}?`, a: ['No system', 'Something loose', 'A clear system'] },
  ];
  const html = `<div class="ylb">
  <div class="ylb-card quiz">
    <span class="pill">2-minute quiz</span>
    <h2>What’s your ${escapeHtml(f.topic)} score?</h2>
    <p class="sub">Answer 5 quick questions and get a personalized next step.</p>
    <div id="q"></div>
    <div class="progress"><i id="bar"></i></div>
    <div id="result" hidden></div>
  </div>
</div>`;
  const css =
    baseCss(c) +
    `.question { font-weight: 700; font-size: 1.1em; margin: 6px 0 14px; }
.answers { display: grid; gap: 8px; }
.answers button { text-align: left; padding: 12px 14px; border: 1px solid var(--line); border-radius: calc(var(--radius) * .6); background: #fff; font: inherit; cursor: pointer; transition: border-color .15s, background .15s; }
.answers button:hover { border-color: var(--brand); background: var(--brand-soft); }
.progress { height: 6px; background: var(--brand-soft); border-radius: 999px; margin-top: 18px; overflow: hidden; }
.progress i { display: block; height: 100%; width: 0; background: var(--brand); transition: width .3s ease; }
.score { font-size: 3em; font-weight: 800; letter-spacing: -0.03em; color: var(--brand); margin: 0; }
`;
  const js = `var QS=${JSON.stringify(qs)};
var RESULTS=[
 {min:0,title:'Just getting started',text:${JSON.stringify(`You are early in your ${f.topicLower} journey. Start with the basics and one quick win: ${f.quickWins[0]}.`)}},
 {min:5,title:'Building momentum',text:${JSON.stringify(`You have some of the basics in place. Have a question about ${f.topicLower}? Ask ${f.brand}.`)}},
 {min:8,title:'Nearly there',text:${JSON.stringify(`You have most of the basics in place. See what ${f.brand} offers below.`)}}
];
var i=0,score=0;
function render(){var box=document.getElementById('q');document.getElementById('bar').style.width=(i/QS.length*100)+'%';
 if(i>=QS.length){box.hidden=true;var r=RESULTS.filter(function(x){return score>=x.min;}).pop();var out=document.getElementById('result');out.hidden=false;
  out.innerHTML='<p class="score">'+Math.round(score/10*100)+'</p><h3>'+r.title+'</h3><p class="muted">'+r.text+'</p><a class="btn" target="_blank" rel="noopener" href=${JSON.stringify(f.url || '#')}>Get your plan →</a>';return;}${f.url ? '' : ' // TODO: no website set yet. Replace "#" above with your link.'}
 var q=QS[i];box.innerHTML='<p class="muted">Question '+(i+1)+' of '+QS.length+'</p><p class="question">'+q.q+'</p><div class="answers">'+q.a.map(function(a,k){return '<button type="button" data-k="'+k+'">'+a+'</button>';}).join('')+'</div>';
 box.querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){score+=Number(b.dataset.k);i++;render();});});}
render();`;
  return { name: `${f.topic} quiz`, kind: 'quiz', html, css, js };
}

function checklistCode(f: Facts, c: BrandColors): CodeResult {
  const items = [...f.quickWins, ...f.mistakes.map((m) => `Stop ${m}`)].slice(0, 8);
  const html = `<div class="ylb">
  <div class="ylb-card">
    <span class="pill">${escapeHtml(f.brand)}</span>
    <h2>${escapeHtml(f.topic)} Starter Checklist</h2>
    <p class="sub"><b id="done">0</b> of ${items.length} done</p>
    <div class="progress"><i id="bar"></i></div>
    <ul class="list" id="list">
${items.map((it, i) => `      <li><label><input type="checkbox" data-i="${i}" /> <span>${escapeHtml(it.charAt(0).toUpperCase() + it.slice(1))}</span></label></li>`).join('\n')}
    </ul>
    <button class="btn ghost" id="reset" type="button">Reset</button>
  </div>
</div>`;
  const css =
    baseCss(c) +
    `.progress { height: 8px; background: var(--brand-soft); border-radius: 999px; overflow: hidden; margin-bottom: 14px; }
.progress i { display: block; height: 100%; width: 0; background: var(--brand); transition: width .3s ease; }
.list { list-style: none; padding: 0; margin: 0 0 16px; display: grid; gap: 6px; }
.list label { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--line); border-radius: calc(var(--radius) * .6); cursor: pointer; font-weight: 500; }
.list input { width: 18px; height: 18px; margin-top: 2px; accent-color: var(--brand); flex: none; }
.list input:checked + span { text-decoration: line-through; color: var(--muted); }
`;
  const js = `var KEY='ylb-checklist-${hashStr(f.topic)}';
var boxes=[].slice.call(document.querySelectorAll('#list input'));
function load(){try{return JSON.parse(localStorage.getItem(KEY)||'[]');}catch(e){return [];}}
function save(v){try{localStorage.setItem(KEY,JSON.stringify(v));}catch(e){}}
function update(){var done=boxes.filter(function(b){return b.checked;}).length;document.getElementById('done').textContent=done;document.getElementById('bar').style.width=(done/boxes.length*100)+'%';save(boxes.map(function(b){return b.checked;}));}
var saved=load();boxes.forEach(function(b,i){b.checked=!!saved[i];b.addEventListener('change',update);});
document.getElementById('reset').addEventListener('click',function(){boxes.forEach(function(b){b.checked=false;});update();});
update();`;
  return { name: `${f.topic} checklist`, kind: 'checklist', html, css, js };
}

/** Testimonials the owner entered on their sales page (never ones an older version wrote that still await review). */
export function ownerTestimonials(project: Project): { quote: string; name: string; role: string }[] {
  const sections = project.marketing?.salesPage?.sections ?? [];
  return sections
    .flatMap((s) => (s.type === 'proof' ? s.data.testimonials ?? [] : []))
    .filter((t) => !t.needsReview && t.quote?.trim())
    .map((t) => ({ quote: t.quote.trim(), name: t.name?.trim() ?? '', role: t.role?.trim() ?? '' }));
}

const PLACEHOLDER_QUOTES = [1, 2, 3].map(() => ({ quote: '[Customer quote]', name: '[Customer name]', role: '[Who they are]' }));

function testimonialsCode(c: BrandColors, project: Project): CodeResult {
  const own = ownerTestimonials(project);
  const quotes = own.length ? own : PLACEHOLDER_QUOTES;
  const html = `<div class="ylb">
  <div class="ylb-card carousel" aria-roledescription="carousel">
    <span class="pill">${own.length ? 'What customers say' : 'Placeholders: replace with real customer quotes'}</span>
    <div class="slides" id="slides">
${quotes
  .map((t, i) => {
    const who = [t.name ? `<b>${escapeHtml(t.name)}</b>` : '', t.role ? `<span class="muted">${escapeHtml(t.role)}</span>` : ''].filter(Boolean).join(' · ');
    return `      <figure class="slide${i === 0 ? ' on' : ''}"><blockquote>“${escapeHtml(t.quote)}”</blockquote>${who ? `<figcaption>${who}</figcaption>` : ''}</figure>`;
  })
  .join('\n')}
    </div>
    <div class="nav"><button type="button" id="prev" aria-label="Previous">←</button><div class="dots" id="dots"></div><button type="button" id="next" aria-label="Next">→</button></div>
  </div>
</div>`;
  const css =
    baseCss(c) +
    `.slides { position: relative; min-height: 150px; margin-top: 12px; }
.slide { position: absolute; inset: 0; margin: 0; opacity: 0; transform: translateY(8px); transition: opacity .4s ease, transform .4s ease; }
.slide.on { opacity: 1; transform: none; position: relative; }
blockquote { margin: 0 0 12px; font-size: 1.25em; line-height: 1.4; font-weight: 600; }
.nav { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
.nav button { width: 38px; height: 38px; border-radius: 50%; border: 1px solid var(--line); background: #fff; cursor: pointer; font: inherit; }
.dots { display: flex; gap: 6px; }
.dots i { width: 8px; height: 8px; border-radius: 50%; background: var(--line); cursor: pointer; }
.dots i.on { background: var(--brand); }
`;
  const js = `var slides=[].slice.call(document.querySelectorAll('.slide'));var dots=document.getElementById('dots');var cur=0;
slides.forEach(function(_,i){var d=document.createElement('i');d.addEventListener('click',function(){go(i);});dots.appendChild(d);});
function go(i){cur=(i+slides.length)%slides.length;slides.forEach(function(s,k){s.classList.toggle('on',k===cur);});[].slice.call(dots.children).forEach(function(d,k){d.classList.toggle('on',k===cur);});}
document.getElementById('prev').onclick=function(){go(cur-1);};document.getElementById('next').onclick=function(){go(cur+1);};
go(0);setInterval(function(){go(cur+1);},6000);`;
  const note = own.length
    ? `Uses the ${own.length} testimonial${own.length === 1 ? '' : 's'} from your sales page.`
    : 'Shows placeholders. Replace each [bracketed] line with a real customer quote before you publish, or add testimonials to your sales page and generate again.';
  return { name: 'Testimonial carousel', kind: 'testimonials', html, css, js, note };
}

function bookingCode(f: Facts, c: BrandColors, project: Project, s: WidgetSettings): CodeResult {
  // only the owner's own packages: no service list or prices taken from a business-type template
  const services = project.studio.packages.slice(0, 4).map((p) => ({ name: p.name, price: p.price }));
  const hours = parseHours(s.hours);
  const serviceField = services.length
    ? `      <fieldset><legend>1. Service</legend>
        <div class="opts">
${services.map((sv, i) => `          <label class="opt"><input type="radio" name="svc" value="${escapeHtml(sv.name)}"${i === 0 ? ' checked' : ''} /><span><b>${escapeHtml(sv.name)}</b>${sv.price > 0 ? `<em>$${sv.price}</em>` : ''}</span></label>`).join('\n')}
        </div>
      </fieldset>`
    : `      <fieldset><legend>1. What do you need?</legend>
        <input id="svc-text" placeholder="Tell us what you’d like booked" />
      </fieldset>`;
  const whenField = hours
    ? `      <fieldset><legend>2. Day</legend><div class="days" id="days"></div></fieldset>
      <fieldset><legend>3. Time</legend><div class="times" id="times"></div></fieldset>`
    : `      <fieldset><legend>2. When suits you?</legend>
        <div class="grid"><input id="pref-day" type="date" aria-label="Preferred day" /><input id="pref-time" placeholder="Preferred time, e.g. weekday mornings" aria-label="Preferred time" /></div>
      </fieldset>`;
  const html = `<div class="ylb">
  <div class="ylb-card booking">
    ${NOTICE_HTML}
    <span class="pill">${escapeHtml(f.city ? `${f.city} · ` : '')}Booking request</span>
    <h2>Book with ${escapeHtml(f.brand)}</h2>
    <p class="sub">Send a request${hours ? ' for a time within our opening hours' : ''}. It isn’t booked until ${escapeHtml(f.brand)} confirms it.</p>
    <form id="book" novalidate>
${serviceField}
${whenField}
      <fieldset><legend>${hours ? '4' : '3'}. Your details</legend>
        <div class="grid"><input id="name" placeholder="Full name" autocomplete="name" /><input id="email" type="email" placeholder="Email" autocomplete="email" /></div>
      </fieldset>
      <p class="error" id="err" role="alert"></p>
      <button class="btn" type="submit">Send booking request</button>
    </form>
    <div id="done" hidden></div>
  </div>
</div>`;
  const css =
    baseCss(c) +
    NOTICE_CSS +
    `fieldset { border: 0; padding: 0; margin: 0 0 16px; }
legend { font-weight: 700; margin-bottom: 8px; }
.opts { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.opt input { position: absolute; opacity: 0; }
.opt span { display: flex; justify-content: space-between; gap: 8px; padding: 12px 14px; border: 1px solid var(--line); border-radius: calc(var(--radius) * .6); cursor: pointer; }
.opt input:checked + span { border: 2px solid var(--brand); background: var(--brand-soft); }
.opt em { font-style: normal; font-weight: 700; }
.days, .times { display: flex; gap: 8px; flex-wrap: wrap; }
.days button, .times button { padding: 8px 12px; border: 1px solid var(--line); border-radius: 999px; background: #fff; font: inherit; cursor: pointer; }
.days button.on, .times button.on { background: var(--brand); color: var(--brand-ink); border-color: var(--brand); }
.error { color: #c0392b; font-size: .85em; min-height: 1em; }
.confirm { text-align: center; padding: 10px 0; }
`;
  const pick = hours
    ? `// Start times come from your opening hours (0 = Sunday). They are not live availability.
var HOURS=${JSON.stringify(hours)};
var DAYS=[];(function(){var d=new Date();for(var i=1;i<=21&&DAYS.length<10;i++){var x=new Date(d.getFullYear(),d.getMonth(),d.getDate()+i);if(HOURS[x.getDay()]&&HOURS[x.getDay()].length){DAYS.push({iso:x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0'),dow:x.getDay(),label:x.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})});}}})();
var state={day:null,time:null};
function renderDays(){var el=document.getElementById('days');el.innerHTML='';DAYS.forEach(function(d){var b=document.createElement('button');b.type='button';b.textContent=d.label;b.className=state.day&&state.day.iso===d.iso?'on':'';b.onclick=function(){state.day=d;state.time=null;renderDays();renderTimes();};el.appendChild(b);});}
function renderTimes(){var el=document.getElementById('times');el.innerHTML='';if(!state.day){el.innerHTML='<span class="muted">Choose a day first.</span>';return;}
 HOURS[state.day.dow].forEach(function(t){var b=document.createElement('button');b.type='button';b.textContent=t;b.className=state.time===t?'on':'';b.onclick=function(){state.time=t;renderTimes();};el.appendChild(b);});}
function when(){return state.day&&state.time?state.day.label+' at '+state.time:'';}
renderDays();renderTimes();`
    : `function when(){var d=document.getElementById('pref-day').value;var t=document.getElementById('pref-time').value.trim();return [d,t].filter(Boolean).join(', ');}`;
  const js = `${formJs(s.action)}
${pick}
document.getElementById('book').addEventListener('submit',function(e){e.preventDefault();var form=this;var err=document.getElementById('err');
 var svcEl=document.querySelector('input[name=svc]:checked');var svcText=document.getElementById('svc-text');var svc=svcEl?svcEl.value:(svcText?svcText.value.trim():'');
 var name=document.getElementById('name').value.trim();var email=document.getElementById('email').value.trim();
 if(!when()){err.textContent=${JSON.stringify(hours ? 'Pick a day and time.' : 'Tell us when suits you.')};return;}
 if(!name||!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(email)){err.textContent='Add your name and a valid email.';return;}
 err.textContent='';
 ylbSend({service:svc,when:when(),name:name,email:email},'Booking request: '+(svc||'appointment')).then(function(status){
  if(status==='none'||status==='error'){err.textContent=YLB_MESSAGES[status];return;}
  form.hidden=true;var done=document.getElementById('done');done.hidden=false;
  done.innerHTML='<div class="confirm"><h3>Request ready</h3><p class="muted"></p><p class="muted"></p></div>';
  var ps=done.querySelectorAll('p');ps[0].textContent=[svc,when()].filter(Boolean).join(' · ');ps[1].textContent=YLB_MESSAGES[status]+' This is a request, not a confirmed booking.';
 });
});`;
  const notes = [formNote(s), hours ? 'Times come from your listing hours.' : 'No opening hours I could read in your listing, so visitors suggest a day and time.'];
  return { name: 'Booking widget', kind: 'booking', html, css, js, note: notes.join(' ') };
}

/** FAQ items the owner has on their sales page (question and answer both filled in). */
export function ownerFaq(project: Project): { q: string; a: string }[] {
  const sections = project.marketing?.salesPage?.sections ?? [];
  return sections
    .flatMap((s) => (s.type === 'faq' ? s.data.items ?? [] : []))
    .filter((it) => it.q?.trim() && it.a?.trim())
    .map((it) => ({ q: it.q.trim(), a: it.a.trim() }));
}

function faqCode(f: Facts, c: BrandColors, project: Project): CodeResult {
  // the owner's own Q&A, or common questions with "[Your answer]": never an answer that asserts things about the business
  const own = ownerFaq(project);
  const site = f.urlDisplay.trim();
  const items = own.length
    ? own.slice(0, 8)
    : [
        ...f.objections.slice(0, 4).map((o) => ({ q: o.endsWith('?') ? o : `What if ${o.charAt(0).toLowerCase() + o.slice(1)}?`, a: '[Your answer]' })),
        f.track === 'business'
          ? { q: 'How do I book?', a: site ? `Book online at ${site}. [Other ways to book, e.g. phone or email]` : '[How customers book: your website, phone or email]' }
          : { q: 'How do I get access?', a: '[What happens after checkout and how customers get access]' },
      ];
  const html = `<div class="ylb">
  <div class="ylb-card">
    <span class="pill">FAQ</span>
    <h2>Questions, answered</h2>
    <div class="faq">
${items.map((it, i) => `      <details${i === 0 ? ' open' : ''}><summary>${escapeHtml(it.q)}</summary><p>${escapeHtml(it.a)}</p></details>`).join('\n')}
    </div>
  </div>
</div>`;
  const css =
    baseCss(c) +
    `.faq { display: grid; gap: 8px; margin-top: 14px; }
details { border: 1px solid var(--line); border-radius: calc(var(--radius) * .6); padding: 0 16px; background: #fff; }
summary { cursor: pointer; padding: 14px 0; font-weight: 700; list-style: none; display: flex; justify-content: space-between; gap: 12px; }
summary::after { content: "+"; color: var(--brand); font-weight: 800; transition: transform .2s ease; }
details[open] summary::after { transform: rotate(45deg); }
details p { margin: 0 0 14px; color: var(--muted); }
`;
  const js = `// Only one item open at a time
document.querySelectorAll('details').forEach(function(d){d.addEventListener('toggle',function(){if(d.open){document.querySelectorAll('details').forEach(function(o){if(o!==d)o.open=false;});}});});`;
  const note = own.length
    ? `Uses the ${own.length} question${own.length === 1 ? '' : 's'} from your sales page FAQ.`
    : 'Replace each [bracketed] answer with your own before you publish, or add an FAQ to your sales page and generate again.';
  return { name: 'FAQ accordion', kind: 'faq', html, css, js, note };
}

function spreadsheetCode(f: Facts, c: BrandColors): CodeResult {
  const cats = ['Income', ...f.terms.slice(0, 3).map((t) => t.replace(/\b\w/g, (m) => m.toUpperCase())), 'Other'];
  const rows: [string, string, string, number, string][] = [];
  const base = new Date();
  for (let i = 0; i < 8; i++) {
    const d = new Date(base.getTime() - i * 3 * 86400000);
    rows.push([toDateStr(d), i === 0 ? 'Example: payment' : `Example: ${cats[(i % (cats.length - 1)) + 1].toLowerCase()} entry`, cats[i === 0 ? 0 : (i % (cats.length - 1)) + 1], i === 0 ? 2400 : Math.round(40 + ((i * 53) % 260)), i % 3 === 0 ? 'Done' : 'Open']);
  }
  const html = `<div class="sheet">
  <div class="toolbar"><b>${escapeHtml(f.topic)} Tracker</b><span class="muted">Google Sheets · Excel</span></div>
  <div class="tabs"><span class="on">Log</span><span>Dashboard</span><span>Monthly Summary</span><span>Settings</span></div>
  <p class="example-note">Example rows: made-up sample data to show the layout. Delete them and enter your own.</p>
  <div class="table-wrap">
    <table>
      <thead><tr><th></th><th>A · Date</th><th>B · Description</th><th>C · Category</th><th>D · Amount</th><th>E · Status</th></tr></thead>
      <tbody>
${rows.map((r, i) => `        <tr class="example"><td class="rn">${i + 2}</td><td>${r[0]}</td><td>${escapeHtml(r[1])}</td><td><span class="tag">${escapeHtml(r[2])}</span></td><td class="num">$${r[3].toLocaleString('en-US')}</td><td>${r[4]}</td></tr>`).join('\n')}
        <tr class="total"><td class="rn">10</td><td colspan="3">Total of example rows (=SUM(D2:D9))</td><td class="num" id="sum"></td><td></td></tr>
      </tbody>
    </table>
  </div>
  <div class="formulas">
    <p><b>Dashboard!B2</b> <code>=SUMIFS(Log!D:D, Log!C:C, "Income")</code></p>
    <p><b>Dashboard!B3</b> <code>=SUMIFS(Log!D:D, Log!C:C, "&lt;&gt;Income")</code></p>
    <p><b>Summary!B2</b> <code>=QUERY(Log!A:E, "select C, sum(D) where A is not null group by C label sum(D) 'Total'", 1)</code></p>
    <p><b>Log!F2</b> <code>=IF(AND(E2="Open", A2&lt;TODAY()-14), "⚠ Overdue", "")</code></p>
  </div>
</div>`;
  const css = `:root { --brand: ${c.primary}; --brand-soft: ${lighten(c.primary, 0.88)}; --ink: ${c.ink}; --line: #dfe5e1; --muted: #5d6b64; }
* { box-sizing: border-box; }
body { margin: 0; padding: 20px; background: #f6f8f6; color: var(--ink); font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.sheet { max-width: 900px; margin: 0 auto; background: #fff; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.toolbar { display: flex; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--line); }
.muted { color: var(--muted); }
.tabs { display: flex; gap: 2px; background: #eef2ef; padding: 6px 8px 0; }
.tabs span { padding: 6px 12px; border-radius: 6px 6px 0 0; color: var(--muted); }
.tabs .on { background: #fff; color: var(--ink); font-weight: 600; box-shadow: inset 0 2px 0 var(--brand); }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 640px; }
th, td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; white-space: nowrap; }
th { background: #f3f6f4; font-weight: 600; color: var(--muted); font-size: 12px; }
.rn { background: #f3f6f4; color: var(--muted); width: 36px; text-align: center; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.tag { display: inline-block; padding: 1px 8px; border-radius: 999px; background: var(--brand-soft); color: var(--brand); font-weight: 600; font-size: 12px; }
.total td { font-weight: 700; background: #fbfcfb; }
.example-note { margin: 0; padding: 8px 14px; background: #fff8e6; color: #7a5200; font-size: 12px; font-weight: 600; border-bottom: 1px solid var(--line); }
.example td:not(.rn) { color: var(--muted); font-style: italic; }
.formulas { padding: 12px 14px; border-top: 1px solid var(--line); background: #fbfcfb; }
.formulas p { margin: 4px 0; }
code { background: #eef2ef; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
`;
  const js = `// Live total, mirroring =SUM(D2:D9)
var total=[].slice.call(document.querySelectorAll('tbody tr:not(.total) td.num')).reduce(function(s,td){return s+Number(td.textContent.replace(/[^0-9.-]/g,''));},0);
document.getElementById('sum').textContent='$'+total.toLocaleString('en-US');`;
  const script = `/**
 * ${f.topic} Tracker — Google Apps Script
 * Extensions → Apps Script → paste → Save → reload the sheet.
 */
const CATEGORIES = ${JSON.stringify(cats)};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('${f.brand.replace(/'/g, '')}')
    .addItem('Build monthly summary', 'buildMonthlySummary')
    .addItem('Flag overdue items', 'flagOverdue')
    .addToUi();
}

/** Auto-fill today's date and default status when a new row is started. */
function onEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== 'Log' || e.range.getRow() < 2) return;
  const row = e.range.getRow();
  if (!sheet.getRange(row, 1).getValue()) sheet.getRange(row, 1).setValue(new Date());
  if (!sheet.getRange(row, 5).getValue()) sheet.getRange(row, 5).setValue('Open');
}

/** Totals by category for the current month. */
function buildMonthlySummary() {
  const ss = SpreadsheetApp.getActive();
  const rows = ss.getSheetByName('Log').getDataRange().getValues().slice(1);
  const now = new Date();
  const totals = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  rows.forEach(([date, , category, amount]) => {
    const d = new Date(date);
    if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
      totals[category] = (totals[category] || 0) + Number(amount || 0);
    }
  });
  const out = ss.getSheetByName('Monthly Summary') || ss.insertSheet('Monthly Summary');
  out.clear();
  out.appendRow(['Category', 'Total this month']);
  Object.entries(totals).forEach(([k, v]) => out.appendRow([k, v]));
  out.getRange('B:B').setNumberFormat('$#,##0.00');
}

/** Highlight open items older than 14 days. */
function flagOverdue() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('Log');
  const rows = sheet.getDataRange().getValues();
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  rows.slice(1).forEach(([date, , , , status], i) => {
    const late = status === 'Open' && new Date(date).getTime() < cutoff;
    sheet.getRange(i + 2, 1, 1, 5).setBackground(late ? '#FDECEA' : null);
  });
}
`;
  return { name: `${f.topic} Tracker (spreadsheet)`, kind: 'spreadsheet', html, css, js, script, note: 'The preview rows are labelled examples, not your data. Start your sheet with your own entries.' };
}

// ───────────── the owner's images ─────────────
// The code refers to the owner's images only as {{img-N}} tokens; each place that shows it fills in the
// address (see buildDocument). Without an AI, an image goes where the template has a natural spot.

type Code = { html: string; css: string; js: string };

/** Where an image went: in place of the hero's sample window, the lead form's cover, as a sheet's logo, or at the top. */
export type ImageSpot = 'hero' | 'cover' | 'logo' | 'top';

const IMAGE_CSS: Record<ImageSpot, string> = {
  hero: '.hero-img { display: block; width: 100%; height: auto; max-height: 520px; object-fit: cover; border-radius: var(--radius); box-shadow: 0 30px 60px -30px rgba(0,0,0,.35); }\n',
  cover: '.cover-img { display: block; width: 100%; aspect-ratio: 3 / 4; object-fit: cover; border-radius: calc(var(--radius) * .8); box-shadow: 0 20px 40px -20px rgba(0,0,0,.35); }\n',
  logo: '.sheet-logo { height: 28px; width: auto; max-width: 120px; object-fit: contain; vertical-align: middle; margin-right: 8px; }\n',
  top: '.ylb-photo { display: block; width: 100%; height: auto; max-height: 280px; object-fit: cover; border-radius: calc(var(--radius) * .7); margin: 0 0 16px; }\n',
};

const SPOT_LABEL: Record<ImageSpot, string> = { hero: 'in place of the sample window', cover: 'as the cover', logo: 'next to the title', top: 'at the top' };

/** The CSS rule an image spot needs ('' when the code already has it). */
function spotCss(css: string, spot: ImageSpot): string {
  const rule = IMAGE_CSS[spot];
  return css.includes(rule.slice(0, rule.indexOf('{'))) ? '' : rule;
}

/**
 * An <img> for one of the owner's images. Its alt text is the owner's note; without one it's left empty
 * (nothing is made up about what the picture shows) with a TODO saying so.
 */
function imgTag(img: PromptImage, cls: string): string {
  const note = img.note?.trim().replace(/\s+/g, ' ') ?? '';
  const todo = note ? '' : `<!-- TODO: describe image ${imageKeyNumber(img.key)} in alt="" (what it shows), or leave it empty if it's only decoration. -->`;
  return `${todo}<img class="${cls}" src="{{${img.key}}}" alt="${escapeHtml(truncate(note, 140))}" />`;
}

/** [start, end) of the <div> that opens at `start`, nested divs included; null when it never closes. */
function divSpan(html: string, start: number): [number, number] | null {
  const tags = /<(\/?)div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 0;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return [start, m.index + m[0].length];
  }
  return null;
}

/**
 * Put one of the owner's images where the widget has a natural spot: in place of the hero's sample
 * window or the lead form's cover, as the logo of a sheet, else at the top (before its first label pill,
 * or at the very start). Returns the new HTML, the spot, and the CSS rule the spot needs ('' if present).
 */
export function placeImage(code: Pick<Code, 'html' | 'css'>, img: PromptImage): { html: string; spot: ImageSpot; css: string } {
  let html = code.html;
  let spot: ImageSpot = 'top';
  const swap = (at: number, cls: string) => {
    const span = at >= 0 ? divSpan(html, at) : null;
    if (!span) return false;
    html = html.slice(0, span[0]) + imgTag(img, cls) + html.slice(span[1]);
    return true;
  };
  if (swap(html.search(/<div class="window"[\s>]/), 'hero-img')) {
    spot = 'hero';
    // the sample window was decoration; the owner's picture is content
    html = html.replace(/(<div class="visual") aria-hidden="true"/, '$1');
  } else if (swap(html.search(/<div class="cover"[\s>]/), 'cover-img')) spot = 'cover';
  else if (html.includes('<div class="toolbar"><b>')) {
    html = html.replace('<div class="toolbar"><b>', `<div class="toolbar"><b>${imgTag(img, 'sheet-logo')}`);
    spot = 'logo';
  } else {
    const pill = html.indexOf('<span class="pill">');
    const tag = imgTag(img, 'ylb-photo');
    if (pill >= 0) {
      const indent = /[ \t]*$/.exec(html.slice(0, pill))?.[0] ?? '';
      html = `${html.slice(0, pill)}${tag}\n${indent}${html.slice(pill)}`;
    } else html = `${tag}\n${html}`;
  }
  return { html, spot, css: spotCss(code.css, spot) };
}

const keyRe = (keys: string[]) => keys.map((k) => String(imageKeyNumber(k))).filter((n) => n !== '0').join('|');

/**
 * The code without these images: their <img> (and <source>) tags go, CSS backgrounds that use them
 * become `none`, and any other use of their token is blanked. Nothing else changes.
 */
export function removeImages<T extends Code>(code: T, keys: string[]): T {
  const nums = keyRe(keys);
  if (!nums) return code;
  const token = `\\{\\{\\s*img-(?:${nums})\\s*\\}\\}`;
  const tag = new RegExp(`(?:<!-- TODO: describe image (?:${nums}) [^>]*?-->\\s*)?<(?:img|source)\\b[^>]*?${token}[^>]*>\\s*`, 'gi');
  const url = new RegExp(`url\\(\\s*(["']?)${token}\\1\\s*\\)`, 'gi');
  const any = new RegExp(token, 'gi');
  const clean = (s: string) => s.replace(url, 'none').replace(any, '');
  return { ...code, html: clean(code.html.replace(tag, '')), css: clean(code.css), js: code.js.replace(any, '') };
}

/** Images by number, for the owner: "image 2", "images 1 and 3". */
const imageNames = (keys: string[]) => `${keys.length === 1 ? 'image' : 'images'} ${listJoin(keys.map((k) => String(imageKeyNumber(k))))}`;

// ───────────── entry points ─────────────

export function generateCode(project: Project, kind: CodeKind, prompt: string, d: Directives = {}, variation = 0, images: PromptImage[] = []): CodeResult {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|code|${kind}|${variation}|${prompt}`));
  const colors = project.brand.colors;
  const settings = widgetSettings(project, prompt);
  const titleFromPrompt = (() => {
    const m = /(?:called|named|titled)\s+["“]?([^"”\n.]+)["”]?/i.exec(prompt);
    return m ? m[1].trim() : undefined;
  })();
  let res: CodeResult;
  switch (kind) {
    case 'calculator':
      res = calculatorCode(f.niche.calc, f, colors, titleFromPrompt, project.studio.packages);
      break;
    case 'roi':
      res = calculatorCode('roi', f, colors, titleFromPrompt);
      break;
    case 'leadform':
      res = leadFormCode(f, colors, v, settings);
      break;
    case 'pricing':
      res = pricingCode(f, colors, project);
      break;
    case 'hero':
      res = heroCode(f, colors);
      break;
    case 'countdown':
      res = countdownCode(f, colors, project, settings);
      break;
    case 'quiz':
      res = quizCode(f, colors);
      break;
    case 'checklist':
      res = checklistCode(f, colors);
      break;
    case 'testimonials':
      res = testimonialsCode(colors, project);
      break;
    case 'booking':
      res = bookingCode(f, colors, project, settings);
      break;
    case 'faq':
      res = faqCode(f, colors, project);
      break;
    case 'spreadsheet':
    default:
      res = spreadsheetCode(f, colors);
  }
  if (titleFromPrompt) res.name = titleFromPrompt;
  // the template can't tell what the pictures show, so only the first goes in, where it fits best; the
  // Code tab says which others aren't used yet
  const first = images.find((i) => i.media.kind === 'image');
  if (first) {
    const placed = placeImage(res, first);
    res = { ...res, html: placed.html, css: res.css + placed.css };
  }
  return res;
}

const COLOR_WORDS: Record<string, string> = {
  red: '#DC2626',
  blue: '#2563EB',
  green: '#15803D',
  purple: '#7C3AED',
  orange: '#EA580C',
  pink: '#DB2777',
  teal: '#0D9488',
  black: '#111111',
  gold: '#B7791F',
  yellow: '#EAB308',
  navy: '#1E3A8A',
  brown: '#7C4A2D',
};

/** A request about the owner's pictures ("put image 2 at the top"); "logo colors" is about colors. */
const IMAGE_WORDS = /\b(?:images?|photos?|pictures?|pics?|logo)\b(?!\s*colou?rs?)|\bimg-\d+\b|\{\{\s*img-\d+\s*\}\}/;
const PICTURE = String.raw`(?:images?|photos?|pictures?|pics?|logo|img-\d+|\{\{\s*img-\d+\s*\}\})\b(?!\s*colou?rs?)`;
/**
 * Adding or taking out a picture: the verb acts on the picture itself, a few words at most before it
 * ("put the shop photo at the top", "remove image 2"), so "use my accent color for the image border",
 * "add a drop shadow to image 1" or "remove the shadow from the photo" aren't about adding or removing one.
 */
const ADD_PICTURE = new RegExp(String.raw`\b(?:add|use|put|place|show|insert|include|display)\b(?:\s+[\w’'-]+){0,3}?\s+${PICTURE}`);
const REMOVE_PICTURE = new RegExp(String.raw`\b(?:remove|delete|drop(?!\s*-?shadows?)|take out|get rid of)\b(?:\s+[\w’'-]+){0,2}?\s+${PICTURE}`);
/** Images the request names by number: "image 2", "photo #3", "img-4", "{{img-5}}". */
const NAMED_IMAGE = /\b(?:images?|photos?|pictures?|pics?|img)[\s#-]*(\d{1,2})\b|\{\{\s*img-(\d{1,2})\s*\}\}/gi;

/**
 * The built-in editor's part for the owner's images: add one where the widget has a natural spot (the
 * one named, else the first not used yet), or take one out (the one named, or the only one shown).
 */
function editImages(code: Code, instruction: string, images: PromptImage[]): { code: Code; css: string; applied: string[]; notes: string[] } {
  const ins = instruction.toLowerCase();
  const out = { code, css: '', applied: [] as string[], notes: [] as string[] };
  if (!IMAGE_WORDS.test(ins)) return out;
  const named = [...new Set([...instruction.matchAll(NAMED_IMAGE)].map((m) => `img-${Number(m[1] ?? m[2])}`))];
  const own = images.filter((i) => i.media.kind === 'image');
  const used = imageTokens(`${code.html}\n${code.css}\n${code.js}`);
  if (REMOVE_PICTURE.test(ins)) {
    const gone = named.length ? named.filter((k) => used.includes(k)) : used.length === 1 ? used : [];
    if (gone.length) {
      out.code = removeImages(code, gone);
      out.applied.push(`Took out ${imageNames(gone)}`);
    } else out.notes.push(!used.length ? 'It doesn’t show any of your images.' : named.length ? `It doesn’t show ${imageNames(named)}.` : 'Say which image to take out, e.g. “remove image 2”.');
    return out;
  }
  if (!ADD_PICTURE.test(ins)) return out;
  if (!own.length) {
    out.notes.push('Add the image first (Add images, or paste it into the box), then ask again.');
    return out;
  }
  const wanted = named.find((k) => !used.includes(k));
  const unused = own.filter((i) => !used.includes(i.key));
  // "this photo" or "the new photo" is the one just added: the last not shown yet
  const pick = named.length ? own.find((i) => i.key === wanted) : /\b(?:this|new|newest|latest|last)\b/.test(ins) ? unused[unused.length - 1] : unused[0];
  if (!pick) {
    const missing = named.filter((k) => !own.some((i) => i.key === k));
    out.notes.push(missing.length ? `There’s no ${imageNames(missing)} in this asset.` : named.length ? `It already shows ${imageNames(named)}.` : 'All your images are in it already. Add another one, or say which to use, e.g. “use image 2”.');
    return out;
  }
  const placed = placeImage(code, pick);
  out.code = { ...code, html: placed.html };
  out.css = placed.css;
  out.applied.push(`Added image ${imageKeyNumber(pick.key)} ${SPOT_LABEL[placed.spot]}`);
  return out;
}

/** Built-in editor for code: understands common design requests, and adding or taking out the owner's images. */
export function modifyCode(code: Code, instruction: string, images: PromptImage[] = []): Code & { applied: string[]; notes: string[] } {
  const ins = instruction.toLowerCase();
  const pictures = editImages(code, instruction, images);
  code = pictures.code;
  const applied: string[] = [...pictures.applied];
  // "make image 1 bigger" is about the picture, which this editor can't resize: not the text size
  const aboutText = !IMAGE_WORDS.test(ins) || /\b(?:text|font|type|words?|letters?)\b/.test(ins);
  let css = code.css.replace(/\n\/\* ylb-overrides \*\/[\s\S]*$/, '');
  const prior = /\/\* ylb-overrides \*\/\n:root \{([^}]*)\}/.exec(code.css)?.[1] ?? '';
  const vars = new Map<string, string>();
  prior
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const [k, ...rest] = pair.split(':');
      vars.set(k.trim(), rest.join(':').trim());
    });
  // a rule an added image needs goes with the other additions, which later edits keep
  let extra = pictures.css;
  if (/\bdark\b/.test(ins)) {
    vars.set('--bg', '#0f1412');
    vars.set('--card', '#18201c');
    vars.set('--ink', '#e8efe9');
    vars.set('--muted', '#9fb0a6');
    vars.set('--line', '#2a3530');
    applied.push('Dark theme');
  }
  if (/\blight\b/.test(ins)) {
    ['--bg', '--card', '--ink', '--muted', '--line'].forEach((k) => vars.delete(k));
    applied.push('Light theme');
  }
  // whole words: "background" and "around" aren't asking for rounder corners
  if (/\bround|\bpill|\bsoft(?:er)?\b/.test(ins)) {
    vars.set('--radius', '22px');
    applied.push('Rounder corners');
  }
  if (/square|sharp|boxy/.test(ins)) {
    vars.set('--radius', '4px');
    applied.push('Sharper corners');
  }
  if (aboutText && /bigger|larger|increase (?:the )?(?:font|text)|more readable/.test(ins)) {
    vars.set('--scale', '1.12');
    applied.push('Larger text');
  }
  if (aboutText && /smaller|compact|tighter/.test(ins)) {
    vars.set('--scale', '0.92');
    applied.push('Compact text');
  }
  const hex = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/i.exec(instruction)?.[0];
  const word = Object.keys(COLOR_WORDS).find((w) => new RegExp(`\\b${w}\\b`).test(ins));
  if ((hex || word) && /colou?r|brand|button|accent|theme|make it/.test(ins)) {
    const color = hex ?? COLOR_WORDS[word!];
    if (/accent/.test(ins)) {
      vars.set('--accent', color);
      applied.push(`Accent color ${color}`);
    } else {
      vars.set('--brand', color);
      vars.set('--brand-dark', darken(color, 0.2));
      vars.set('--brand-soft', lighten(color, 0.88));
      vars.set('--brand-ink', readableOn(color));
      applied.push(`Brand color ${color}`);
    }
  }
  if (/serif/.test(ins) && !/sans/.test(ins)) {
    vars.set('--font', 'Georgia, "Times New Roman", serif');
    applied.push('Serif font');
  } else if (/mono/.test(ins)) {
    vars.set('--font', 'ui-monospace, SFMono-Regular, Menlo, monospace');
    applied.push('Monospace font');
  } else if (/\bsans\b/.test(ins)) {
    vars.delete('--font');
    applied.push('Sans-serif font');
  }
  if (/center|centre/.test(ins)) {
    extra += '.ylb, .ylb-card { text-align: center; }\n';
    applied.push('Centered layout');
  }
  // "remove the shadow" or "no shadows" asks for less, not more ("pop-up" isn't "make it pop")
  if (/\bflat\b|\b(?:no|without|remove|delete|get rid of)\b(?:\s+[\w’'-]+){0,2}?\s+shadows?\b/.test(ins)) {
    extra += '.ylb-card, .tier, .window { box-shadow: none !important; }\n';
    applied.push('Flat style');
  } else if (/shadow|depth|\bpop\b(?!-)/.test(ins)) {
    extra += '.ylb-card, .tier, .window { box-shadow: 0 28px 60px -24px rgba(0,0,0,.45) !important; }\n';
    applied.push('Stronger shadows');
  }
  const priorExtra = /\/\* ylb-extra \*\/\n([\s\S]*)$/.exec(code.css)?.[1] ?? '';
  const block = vars.size ? `\n/* ylb-overrides */\n:root {${[...vars.entries()].map(([k, val]) => ` ${k}: ${val};`).join('')} }\n` : '';
  const extraBlock = extra || priorExtra ? `/* ylb-extra */\n${priorExtra}${extra}` : '';
  css = css.replace(/\n?\/\* ylb-extra \*\/[\s\S]*$/, '') + block + extraBlock;
  return { html: code.html, css, js: code.js, applied, notes: pictures.notes };
}

/**
 * In-memory localStorage and sessionStorage for a page that has no storage of its own. Published
 * artifacts (and the live preview) run in a sandbox without their own origin, where even reading
 * localStorage throws, so code that saves something (a checklist's ticks) would stop with an error.
 * With this it works while the page is open. Where storage works (the owner's own site) it changes nothing.
 */
export const STORAGE_SHIM = `(function () {
  function memory() {
    var data = {};
    return {
      get length() { return Object.keys(data).length; },
      key: function (i) { var keys = Object.keys(data); return i < keys.length ? keys[i] : null; },
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[String(k)] = String(v); },
      removeItem: function (k) { delete data[String(k)]; },
      clear: function () { data = {}; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try { var s = window[name]; if (s) { s.getItem('ylb'); return; } } catch (e) {}
    try { Object.defineProperty(window, name, { value: memory(), configurable: true }); } catch (e) {}
  });
})();`;

export interface DocumentOptions {
  /**
   * key → address of each image the code uses as {{img-N}} (data URLs for the preview and downloads).
   * A key it doesn't have shows nothing. Without it the tokens stay as they are, for publishing to fill in.
   */
  images?: Record<string, string>;
  /** start with STORAGE_SHIM (published pages and the preview run in a sandbox without storage) */
  storageShim?: boolean;
  /**
   * Where its forms send. An address replaces every {{lead-action}} (a copy of a published asset); LEAD_ACTION
   * keeps the token for publishing to fill in. Unset (the preview, a copy of an unpublished asset): a form's
   * action="{{lead-action}}" becomes action="#", and the script still sees the token, so it sends nothing.
   */
  leadAction?: string;
}

/** Full standalone document for preview, export and publishing. */
export function buildDocument(code: { html: string; css: string; js: string }, title = 'Widget', opts: DocumentOptions = {}): string {
  const images = (text: string) => (opts.images ? resolveImageTokens(text, opts.images) : text);
  const lead = opts.leadAction;
  const fill = (text: string) => (lead === undefined || lead === LEAD_ACTION ? images(text) : resolveLeadAction(images(text), lead));
  const fillHtml = (text: string) => (lead === undefined ? previewLeadAction(fill(text)) : fill(text));
  // in <head>, so it runs before any script in the page
  const shim = opts.storageShim ? `${SCRIPT_OPEN}\n${STORAGE_SHIM}\n${SCRIPT_CLOSE}\n` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
${shim}<style>
${fill(code.css)}
</style>
</head>
<body>
${fillHtml(code.html)}
${SCRIPT_OPEN}
${fill(code.js)}
${SCRIPT_CLOSE}
</body>
</html>`;
}

export function codeKindLabel(kind: CodeKind): string {
  return CODE_KINDS.find((k) => k.id === kind)?.label ?? kind;
}
