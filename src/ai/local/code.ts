import type { BrandColors, CodeKind, Directives, Project } from '@/lib/types';
import { addDays, escapeHtml, fmtDate, hashStr, readableOn, todayStr, toDateStr, lighten, darken } from '@/lib/utils';
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

export function detectKind(prompt: string, project: Project): CodeKind {
  const p = prompt.toLowerCase();
  const tests: [RegExp, CodeKind][] = [
    [/\broi\b|return on|savings calc|how much (?:time|money)/, 'roi'],
    [/spreadsheet|google sheets?|excel|formula|apps ?script/, 'spreadsheet'],
    [/calculat|estimat|cost of|compute/, 'calculator'],
    [/countdown|timer|deadline|launch clock/, 'countdown'],
    [/quiz|assessment|score yourself|personality test/, 'quiz'],
    [/testimonial|review|carousel|slider/, 'testimonials'],
    [/book|appointment|schedul|reserv/, 'booking'],
    [/pricing|plans|tiers|packages/, 'pricing'],
    [/faq|questions|accordion/, 'faq'],
    [/checklist|to-?do|habit tracker|task list/, 'checklist'],
    [/hero|landing|header|above the fold|homepage/, 'hero'],
    [/form|opt-?in|sign ?up|subscribe|lead|waitlist|email capture|newsletter/, 'leadform'],
  ];
  for (const [re, kind] of tests) if (re.test(p)) return kind;
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
}

function calcSpec(kind: CalcKind | 'roi', f: Facts): CalcSpec {
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
      const svc = f.business?.services ?? [];
      return {
        title: 'Instant Quote Estimator',
        sub: `Get a ballpark price from ${f.brand} in seconds.`,
        fields: [
          {
            id: 'service',
            label: 'Service',
            type: 'select',
            value: String(Math.round(((svc[1]?.price[0] ?? 150) + (svc[1]?.price[1] ?? 250)) / 2)),
            options: svc.filter((s) => s.price[1] > 0).map((s) => [String(Math.round((s.price[0] + s.price[1]) / 2)), s.name] as [string, string]),
          },
          { id: 'size', label: 'Home size', type: 'select', value: '1', options: [['0.85', 'Under 1,200 sq ft'], ['1', '1,200–2,400 sq ft'], ['1.3', '2,400–3,500 sq ft'], ['1.6', '3,500+ sq ft']] },
          { id: 'freq', label: 'How often', type: 'select', value: '1', options: [['1', 'One time'], ['0.9', 'Monthly'], ['0.85', 'Every 2 weeks']] },
        ],
        outputs: [
          { id: 'o1', label: 'Estimated price' },
          { id: 'o2', label: 'Price range' },
          { id: 'o3', label: 'Next available' },
        ],
        compute: `var p=v('service')*v('size')*v('freq');set('o1',fmt$(p));set('o2',fmt$(p*.9)+' – '+fmt$(p*1.15));var d=new Date();d.setDate(d.getDate()+2);set('o3',d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}));`,
        note: 'Final price confirmed after a quick walkthrough.',
      };
    }
    case 'roi':
    default:
      return {
        title: f.track === 'business' ? 'Savings Calculator' : 'ROI Calculator',
        sub: `What ${f.productShort} is worth to your business.`,
        fields: [
          { id: 'hours', label: 'Hours saved per week', type: 'number', value: 6 },
          { id: 'value', label: 'Value of an hour', type: 'number', value: 75, prefix: '$' },
          { id: 'team', label: 'People on the team', type: 'number', value: 3 },
          { id: 'cost', label: `Monthly cost of ${f.productShort}`, type: 'number', value: Math.max(9, f.price), prefix: '$' },
        ],
        outputs: [
          { id: 'o1', label: 'Monthly value created' },
          { id: 'o2', label: 'Annual ROI' },
          { id: 'o3', label: 'Pays for itself in' },
        ],
        compute: `var monthly=v('hours')*v('value')*v('team')*4.33;var roi=v('cost')>0?(monthly-v('cost'))/v('cost')*100:0;var days=monthly>0?v('cost')/(monthly/30):0;
set('o1',fmt$(monthly));set('o2',fmtN(roi)+'%');set('o3',fmtN(Math.max(1,days))+' days');`,
        note: 'Projections based on your inputs.',
      };
  }
}

function calculatorCode(kind: CalcKind | 'roi', f: Facts, c: BrandColors, titleOverride?: string): CodeResult {
  const s = calcSpec(kind, f);
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
    <a class="btn" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">Get the full ${escapeHtml(f.track === 'business' ? 'quote' : f.formatNoun.toLowerCase())} →</a>
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
  return { name: title, kind: kind === 'roi' ? 'roi' : 'calculator', html, css, js };
}

// ───────────── other widgets ─────────────

function leadFormCode(f: Facts, c: BrandColors, v: Voice): CodeResult {
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
      <span class="pill">Free download</span>
      <h2>${escapeHtml(lm)}</h2>
      <p class="sub">For ${escapeHtml(f.audience)} who want to ${escapeHtml(verbOutcome(f.outcomes[0]))}.</p>
      <ul class="ticks">
${bullets.map((b) => `        <li>${escapeHtml(b)}</li>`).join('\n')}
      </ul>
      <form id="optin" novalidate>
        <input id="fname" name="fname" placeholder="First name" autocomplete="given-name" />
        <input id="email" name="email" type="email" placeholder="you@email.com" autocomplete="email" required />
        <button class="btn" type="submit">Send me the free guide</button>
        <p class="error" id="err" role="alert"></p>
      </form>
      <div class="success" id="ok" hidden>
        <h3>Check your inbox 🎉</h3>
        <p class="muted">We just sent <b>${escapeHtml(lm)}</b> to <span id="ok-email"></span>.</p>
      </div>
      <p class="fine muted">No spam. Unsubscribe anytime.</p>
    </div>
  </div>
</div>`;
  const css =
    baseCss(c) +
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
.fine { font-size: .75em; margin: 10px 0 0; }
`;
  const js = `var form=document.getElementById('optin');
form.addEventListener('submit',function(e){e.preventDefault();
  var email=document.getElementById('email').value.trim();
  var err=document.getElementById('err');
  if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(email)){err.textContent='Please enter a valid email address.';return;}
  err.textContent='';
  form.hidden=true;document.getElementById('ok').hidden=false;document.getElementById('ok-email').textContent=email;
  // Connect your email platform here, e.g. fetch('/api/subscribe',{method:'POST',body:JSON.stringify({email:email})})
});`;
  return { name: `${lm} opt-in form`, kind: 'leadform', html, css, js };
}

function pricingCode(f: Facts, c: BrandColors, project: Project): CodeResult {
  const monthly = project.studio.priceModel === 'monthly' || project.format === 'software' || project.format === 'membership';
  const tiers = project.track === 'business' && project.studio.packages.length
    ? project.studio.packages.map((p) => ({ name: p.name, price: p.price, desc: p.description, features: p.includes.slice(0, 5), popular: !!p.popular }))
    : [
        { name: 'Starter', price: Math.max(5, Math.round(f.price * 0.6)), desc: `The ${f.formatNoun.toLowerCase()} on its own.`, features: [f.product, 'Instant access', 'Email support'], popular: false },
        { name: 'Complete', price: f.price, desc: 'Everything you need to get results.', features: [f.product, 'All bonuses', 'Templates & worksheets', 'Lifetime updates'], popular: true },
        { name: 'VIP', price: Math.round(f.price * 2.4), desc: 'Hands-on help to go faster.', features: ['Everything in Complete', '1:1 kickoff call', 'Priority support', 'Private community'], popular: false },
      ];
  const html = `<div class="ylb wide">
  <div class="head">
    <span class="pill">Pricing</span>
    <h2>Simple, honest pricing</h2>
    <p class="sub">Pick the plan that fits. ${monthly ? 'Cancel anytime.' : 'Pay once, keep forever.'}</p>
${monthly ? `    <div class="toggle" role="group" aria-label="Billing period"><button class="on" data-period="m" type="button">Monthly</button><button data-period="y" type="button">Yearly <i>save 20%</i></button></div>` : ''}
  </div>
  <div class="tiers">
${tiers
  .map(
    (t) => `    <div class="tier${t.popular ? ' popular' : ''}">
      ${t.popular ? '<span class="badge">Most popular</span>' : ''}
      <h3>${escapeHtml(t.name)}</h3>
      <p class="muted">${escapeHtml(t.desc)}</p>
      <p class="price"><b data-m="${t.price}" data-y="${Math.round(t.price * 12 * 0.8)}">$${t.price}</b><span class="per">${monthly ? '/mo' : ''}</span></p>
      <ul>
${t.features.map((x) => `        <li>${escapeHtml(x)}</li>`).join('\n')}
      </ul>
      <a class="btn${t.popular ? '' : ' ghost'}" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">Choose ${escapeHtml(t.name)}</a>
    </div>`,
  )
  .join('\n')}
  </div>
</div>`;
  const css =
    baseCss(c) +
    `.ylb.wide { max-width: 980px; }
.head { text-align: center; margin-bottom: 22px; }
.toggle { display: inline-flex; padding: 4px; border-radius: 999px; background: var(--card); border: 1px solid var(--line); }
.toggle button { border: 0; background: transparent; padding: 8px 14px; border-radius: 999px; font: inherit; font-weight: 600; cursor: pointer; color: var(--muted); }
.toggle button.on { background: var(--brand); color: var(--brand-ink); }
.toggle i { font-style: normal; font-size: .75em; color: var(--accent); }
.tiers { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); align-items: stretch; }
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
  const js = monthly
    ? `document.querySelectorAll('.toggle button').forEach(function(b){b.addEventListener('click',function(){
  document.querySelectorAll('.toggle button').forEach(function(x){x.classList.toggle('on',x===b);});
  var y=b.dataset.period==='y';
  document.querySelectorAll('.price b').forEach(function(el){el.textContent='$'+(y?el.dataset.y:el.dataset.m);});
  document.querySelectorAll('.per').forEach(function(el){el.textContent=y?'/yr':'/mo';});
});});`
    : `// Static pricing: no script needed. Link each button to your checkout.`;
  return { name: 'Pricing table', kind: 'pricing', html, css, js };
}

function heroCode(f: Facts, c: BrandColors, v: Voice): CodeResult {
  const headline = f.tagline || `${verbOutcome(f.outcomes[0]).replace(/^./, (x) => x.toUpperCase())}.`;
  const html = `<section class="hero">
  <div class="ylb wide">
    <div class="copy">
      <span class="pill">${escapeHtml(f.local && f.city ? `Proudly serving ${f.city}` : `For ${f.audience}`)}</span>
      <h1>${escapeHtml(headline)}</h1>
      <p class="lead">${escapeHtml(f.pitch || `${f.brand} helps ${f.audience} ${verbOutcome(f.outcomes[0])}, without ${f.pain}.`)}</p>
      <div class="ctas">
        <a class="btn" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">${escapeHtml(f.track === 'business' ? 'Book now' : `Get ${f.productShort}`)} →</a>
        <a class="btn ghost" href="#how">See how it works</a>
      </div>
      <p class="trust muted">★★★★★ Loved by ${escapeHtml(f.audience)} · ${escapeHtml(v.pick(['Instant access', 'Cancel anytime', 'Satisfaction promise']))}</p>
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
.trust { margin-top: 18px; font-size: .9em; }
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

function countdownCode(f: Facts, c: BrandColors): CodeResult {
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + 7);
  deadline.setHours(23, 59, 0, 0);
  const html = `<div class="ylb">
  <div class="ylb-card countdown">
    <span class="pill">Launch offer</span>
    <h2>${escapeHtml(f.productShort)} launch pricing ends soon</h2>
    <p class="sub">Get it for <b>${escapeHtml(f.priceStr)}</b> before the price goes up.</p>
    <div class="clock" id="clock" aria-live="polite">
      <div><b id="d">0</b><span>days</span></div>
      <div><b id="h">0</b><span>hours</span></div>
      <div><b id="m">0</b><span>min</span></div>
      <div><b id="s">0</b><span>sec</span></div>
    </div>
    <a class="btn" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">Lock in launch pricing →</a>
  </div>
</div>`;
  const css =
    baseCss(c) +
    `.countdown { text-align: center; }
.clock { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 20px auto 22px; max-width: 460px; }
.clock div { background: var(--ink); color: #fff; border-radius: calc(var(--radius) * .7); padding: 14px 6px; }
.clock b { display: block; font-size: 2em; font-variant-numeric: tabular-nums; line-height: 1; }
.clock span { font-size: .72em; text-transform: uppercase; letter-spacing: .08em; opacity: .7; }
`;
  const js = `var deadline=new Date(${JSON.stringify(deadline.toISOString())}).getTime();
function pad(n){return String(n).padStart(2,'0');}
function tick(){var ms=Math.max(0,deadline-Date.now());var s=Math.floor(ms/1000);
  document.getElementById('d').textContent=Math.floor(s/86400);
  document.getElementById('h').textContent=pad(Math.floor(s%86400/3600));
  document.getElementById('m').textContent=pad(Math.floor(s%3600/60));
  document.getElementById('s').textContent=pad(s%60);}
tick();setInterval(tick,1000);`;
  return { name: 'Launch countdown', kind: 'countdown', html, css, js };
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
 {min:5,title:'Building momentum',text:${JSON.stringify(`You have the foundations. A clear system will help you ${verbOutcome(f.outcomes[0])}.`)}},
 {min:8,title:'Nearly there',text:${JSON.stringify(`You are ahead of most ${f.audience}. Fine-tune your routine to ${verbOutcome(f.outcomes[1] ?? f.outcomes[0])}.`)}}
];
var i=0,score=0;
function render(){var box=document.getElementById('q');document.getElementById('bar').style.width=(i/QS.length*100)+'%';
 if(i>=QS.length){box.hidden=true;var r=RESULTS.filter(function(x){return score>=x.min;}).pop();var out=document.getElementById('result');out.hidden=false;
  out.innerHTML='<p class="score">'+Math.round(score/10*100)+'</p><h3>'+r.title+'</h3><p class="muted">'+r.text+'</p><a class="btn" target="_blank" rel="noopener" href=${JSON.stringify(f.url)}>Get your plan →</a>';return;}
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

function testimonialsCode(f: Facts, c: BrandColors): CodeResult {
  const quotes = [
    { q: `I finally stopped ${f.mistakes[0]}. Within a few weeks I could ${verbOutcome(f.outcomes[0])}.`, n: 'Jordan M.', r: f.audience },
    { q: `Clear, practical and easy to follow. ${f.brand} saved me hours every single week.`, n: 'Priya S.', r: f.audience },
    { q: `I was skeptical, but ${f.pain} is no longer a problem for me. Worth every penny.`, n: 'Marcus L.', r: f.audience },
  ];
  const html = `<div class="ylb">
  <div class="ylb-card carousel" aria-roledescription="carousel">
    <span class="pill">Example reviews · replace with real customer quotes</span>
    <div class="slides" id="slides">
${quotes.map((t, i) => `      <figure class="slide${i === 0 ? ' on' : ''}"><blockquote>“${escapeHtml(t.q)}”</blockquote><figcaption><b>${escapeHtml(t.n)}</b> · <span class="muted">${escapeHtml(t.r)}</span></figcaption></figure>`).join('\n')}
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
  return { name: 'Testimonial carousel', kind: 'testimonials', html, css, js };
}

function bookingCode(f: Facts, c: BrandColors, project: Project): CodeResult {
  const services = (project.studio.packages.length
    ? project.studio.packages.map((p) => ({ name: p.name, price: p.price }))
    : (f.business?.services ?? []).filter((s) => s.price[1] > 0).map((s) => ({ name: s.name, price: Math.round((s.price[0] + s.price[1]) / 2) }))
  ).slice(0, 4);
  const days: { iso: string; label: string }[] = [];
  for (let i = 1; i <= 10; i++) {
    const ds = addDays(todayStr(), i);
    days.push({ iso: ds, label: fmtDate(ds, { weekday: 'short', month: 'short', day: 'numeric' }) });
  }
  const html = `<div class="ylb">
  <div class="ylb-card booking">
    <span class="pill">${escapeHtml(f.city ? `${f.city} · ` : '')}Online booking</span>
    <h2>Book with ${escapeHtml(f.brand)}</h2>
    <p class="sub">Pick a service and a time. You’ll get a confirmation right away.</p>
    <form id="book" novalidate>
      <fieldset><legend>1. Service</legend>
        <div class="opts">
${services.map((s, i) => `          <label class="opt"><input type="radio" name="svc" value="${escapeHtml(s.name)}" data-price="${s.price}"${i === 0 ? ' checked' : ''} /><span><b>${escapeHtml(s.name)}</b><em>$${s.price}</em></span></label>`).join('\n')}
        </div>
      </fieldset>
      <fieldset><legend>2. Day</legend><div class="days" id="days"></div></fieldset>
      <fieldset><legend>3. Time</legend><div class="times" id="times"></div></fieldset>
      <fieldset><legend>4. Your details</legend>
        <div class="grid"><input id="name" placeholder="Full name" autocomplete="name" /><input id="email" type="email" placeholder="Email" autocomplete="email" /></div>
      </fieldset>
      <p class="error" id="err" role="alert"></p>
      <button class="btn" type="submit">Confirm booking</button>
    </form>
    <div id="done" hidden></div>
  </div>
</div>`;
  const css =
    baseCss(c) +
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
.times button:disabled { opacity: .35; text-decoration: line-through; cursor: not-allowed; }
.error { color: #c0392b; font-size: .85em; min-height: 1em; }
.confirm { text-align: center; padding: 10px 0; }
.confirm .big { font-size: 2.6em; margin: 0; }
`;
  const js = `var DAYS=${JSON.stringify(days)};
var TIMES=['9:00 AM','10:30 AM','12:00 PM','1:30 PM','3:00 PM','4:30 PM'];
var state={day:null,time:null};
function seeded(s){var h=0;for(var i=0;i<s.length;i++){h=(h*31+s.charCodeAt(i))|0;}return Math.abs(h);}
function renderDays(){var el=document.getElementById('days');el.innerHTML='';DAYS.forEach(function(d){var b=document.createElement('button');b.type='button';b.textContent=d.label;b.className=state.day===d.iso?'on':'';b.onclick=function(){state.day=d.iso;state.time=null;renderDays();renderTimes();};el.appendChild(b);});}
function renderTimes(){var el=document.getElementById('times');el.innerHTML='';if(!state.day){el.innerHTML='<span class="muted">Choose a day first.</span>';return;}
 TIMES.forEach(function(t,i){var b=document.createElement('button');b.type='button';b.textContent=t;b.disabled=(seeded(state.day+t)%4)===0;b.className=state.time===t?'on':'';b.onclick=function(){state.time=t;renderTimes();};el.appendChild(b);});}
document.getElementById('book').addEventListener('submit',function(e){e.preventDefault();var err=document.getElementById('err');
 var svc=document.querySelector('input[name=svc]:checked');var name=document.getElementById('name').value.trim();var email=document.getElementById('email').value.trim();
 if(!state.day||!state.time){err.textContent='Pick a day and time.';return;}
 if(!name||!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(email)){err.textContent='Add your name and a valid email.';return;}
 var d=DAYS.filter(function(x){return x.iso===state.day;})[0];
 this.hidden=true;var done=document.getElementById('done');done.hidden=false;
 done.innerHTML='<div class="confirm"><p class="big">✓</p><h3>You’re booked, '+name.split(' ')[0]+'!</h3><p class="muted">'+svc.value+' · '+d.label+' at '+state.time+'</p><p class="muted">A confirmation is on its way to '+email+'.</p></div>';
 // Send to your calendar or CRM here.
});
renderDays();renderTimes();`;
  return { name: 'Booking widget', kind: 'booking', html, css, js };
}

function faqCode(f: Facts, c: BrandColors, v: Voice): CodeResult {
  const items = [
    ...f.objections.slice(0, 4).map((o) => ({
      q: o.endsWith('?') ? o : `What if ${o.charAt(0).toLowerCase() + o.slice(1)}?`,
      a: `${v.pick(['Totally fair.', 'We hear this a lot.', 'Good question.'])} ${f.brand} is built for exactly this: ${v.pick(f.quickWins)}, and ${verbOutcome(v.pick(f.outcomes))} without ${f.pain}.`,
    })),
    { q: f.track === 'business' ? 'How do I book?' : 'How do I get access?', a: f.track === 'business' ? `Book online at ${f.urlDisplay} or message us. We confirm within one business day.` : `Instant access after checkout. You’ll get an email with everything you need.` },
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
  return { name: 'FAQ accordion', kind: 'faq', html, css, js };
}

function spreadsheetCode(f: Facts, c: BrandColors): CodeResult {
  const cats = ['Income', ...f.terms.slice(0, 3).map((t) => t.replace(/\b\w/g, (m) => m.toUpperCase())), 'Other'];
  const rows: [string, string, string, number, string][] = [];
  const base = new Date();
  for (let i = 0; i < 8; i++) {
    const d = new Date(base.getTime() - i * 3 * 86400000);
    rows.push([toDateStr(d), i === 0 ? 'Client payment' : `${cats[(i % (cats.length - 1)) + 1]} entry`, cats[i === 0 ? 0 : (i % (cats.length - 1)) + 1], i === 0 ? 2400 : Math.round(40 + ((i * 53) % 260)), i % 3 === 0 ? 'Done' : 'Open']);
  }
  const html = `<div class="sheet">
  <div class="toolbar"><b>${escapeHtml(f.topic)} Tracker</b><span class="muted">Google Sheets · Excel</span></div>
  <div class="tabs"><span class="on">Log</span><span>Dashboard</span><span>Monthly Summary</span><span>Settings</span></div>
  <div class="table-wrap">
    <table>
      <thead><tr><th></th><th>A · Date</th><th>B · Description</th><th>C · Category</th><th>D · Amount</th><th>E · Status</th></tr></thead>
      <tbody>
${rows.map((r, i) => `        <tr><td class="rn">${i + 2}</td><td>${r[0]}</td><td>${escapeHtml(r[1])}</td><td><span class="tag">${escapeHtml(r[2])}</span></td><td class="num">$${r[3].toLocaleString('en-US')}</td><td>${r[4]}</td></tr>`).join('\n')}
        <tr class="total"><td class="rn">10</td><td colspan="3">Total (=SUM(D2:D9))</td><td class="num" id="sum"></td><td></td></tr>
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
  return { name: `${f.topic} Tracker (spreadsheet)`, kind: 'spreadsheet', html, css, js, script };
}

// ───────────── entry points ─────────────

export function generateCode(project: Project, kind: CodeKind, prompt: string, d: Directives = {}, variation = 0): CodeResult {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|code|${kind}|${variation}|${prompt}`));
  const colors = project.brand.colors;
  const titleFromPrompt = (() => {
    const m = /(?:called|named|titled)\s+["“]?([^"”\n.]+)["”]?/i.exec(prompt);
    return m ? m[1].trim() : undefined;
  })();
  let res: CodeResult;
  switch (kind) {
    case 'calculator':
      res = calculatorCode(f.niche.calc, f, colors, titleFromPrompt);
      break;
    case 'roi':
      res = calculatorCode('roi', f, colors, titleFromPrompt);
      break;
    case 'leadform':
      res = leadFormCode(f, colors, v);
      break;
    case 'pricing':
      res = pricingCode(f, colors, project);
      break;
    case 'hero':
      res = heroCode(f, colors, v);
      break;
    case 'countdown':
      res = countdownCode(f, colors);
      break;
    case 'quiz':
      res = quizCode(f, colors);
      break;
    case 'checklist':
      res = checklistCode(f, colors);
      break;
    case 'testimonials':
      res = testimonialsCode(f, colors);
      break;
    case 'booking':
      res = bookingCode(f, colors, project);
      break;
    case 'faq':
      res = faqCode(f, colors, v);
      break;
    case 'spreadsheet':
    default:
      res = spreadsheetCode(f, colors);
  }
  if (titleFromPrompt) res.name = titleFromPrompt;
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

/** Built-in editor for code: understands common design requests. */
export function modifyCode(code: { html: string; css: string; js: string }, instruction: string): { html: string; css: string; js: string; applied: string[] } {
  const ins = instruction.toLowerCase();
  const applied: string[] = [];
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
  let extra = '';
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
  if (/round|pill|soft/.test(ins)) {
    vars.set('--radius', '22px');
    applied.push('Rounder corners');
  }
  if (/square|sharp|boxy/.test(ins)) {
    vars.set('--radius', '4px');
    applied.push('Sharper corners');
  }
  if (/bigger|larger|increase (?:the )?(?:font|text)|more readable/.test(ins)) {
    vars.set('--scale', '1.12');
    applied.push('Larger text');
  }
  if (/smaller|compact|tighter/.test(ins)) {
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
  if (/shadow|depth|pop/.test(ins)) {
    extra += '.ylb-card, .tier, .window { box-shadow: 0 28px 60px -24px rgba(0,0,0,.45) !important; }\n';
    applied.push('Stronger shadows');
  }
  if (/flat|no shadow/.test(ins)) {
    extra += '.ylb-card, .tier, .window { box-shadow: none !important; }\n';
    applied.push('Flat style');
  }
  const priorExtra = /\/\* ylb-extra \*\/\n([\s\S]*)$/.exec(code.css)?.[1] ?? '';
  const block = vars.size ? `\n/* ylb-overrides */\n:root {${[...vars.entries()].map(([k, val]) => ` ${k}: ${val};`).join('')} }\n` : '';
  const extraBlock = extra || priorExtra ? `/* ylb-extra */\n${priorExtra}${extra}` : '';
  css = css.replace(/\n?\/\* ylb-extra \*\/[\s\S]*$/, '') + block + extraBlock;
  return { html: code.html, css, js: code.js, applied };
}

/** Full standalone document for preview/export. */
export function buildDocument(code: { html: string; css: string; js: string }, title = 'Widget'): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
${code.css}
</style>
</head>
<body>
${code.html}
${SCRIPT_OPEN}
${code.js}
${SCRIPT_CLOSE}
</body>
</html>`;
}

export function codeKindLabel(kind: CodeKind): string {
  return CODE_KINDS.find((k) => k.id === kind)?.label ?? kind;
}
