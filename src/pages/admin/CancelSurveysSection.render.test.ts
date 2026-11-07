// Owner → Why people cancel, drawn with fixed data: counts by reason (most first), the latest comments with where they
// came from, the trials, and the setup note when the P1c migration isn't run.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import { CancelSurveysView } from './CancelSurveysSection';

const wrap = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(TooltipProvider, null, el));

describe('Why people cancel', () => {
  it('counts by reason, comments and trials', () => {
    const html = wrap(
      createElement(CancelSurveysView, {
        error: null,
        data: {
          counts: { too_expensive: { cancelled: 3, kept: 1 }, missing_feature: { cancelled: 1, kept: 0 } },
          recent: [
            { reason: 'too_expensive', comment: 'Too much for a small shop', source: 'app', outcome: 'cancelled', offer: 'cheaper_plan', tier: 'grow', at: new Date().toISOString(), customerTag: 'cust_aaaaaaaaaaaaaaaaaaaaaaaa' },
            { reason: 'missing_feature', comment: 'Needs Etsy', source: 'portal', outcome: 'cancelled', offer: null, tier: 'launch', at: new Date().toISOString(), customerTag: null },
          ],
          trials: { trialing: 4, endedEarly: 1, duplicates: 1, list: [] },
        },
      }),
    );
    for (const t of ['It’s too expensive', 'It’s missing a feature I need', 'Too much for a small shop', 'Needs Etsy', 'Stripe billing page', 'Trials running', 'Second trials stopped']) expect(html).toContain(t);
    expect(html.indexOf('It’s too expensive')).toBeLessThan(html.indexOf('It’s missing a feature I need'));
  });

  it('Cancel answers is the total over every answer (the list shows only the latest)', () => {
    const recent = Array.from({ length: 50 }, (_, i) => ({ reason: 'other' as const, comment: null, source: 'app' as const, outcome: 'cancelled' as const, offer: null, tier: null, at: new Date(Date.now() - i * 1000).toISOString(), customerTag: null }));
    const data = { counts: { other: { cancelled: 120, kept: 3 } }, total: 123, recent, trials: { trialing: 0, endedEarly: 0, duplicates: 0, list: [] } };
    const html = wrap(createElement(CancelSurveysView, { error: null, data }));
    expect(html).toMatch(/Cancel answers<\/span><span[^>]*>123</);
    expect(html).toContain('>120<');
    // an older server (no total): the list's length
    expect(wrap(createElement(CancelSurveysView, { error: null, data: { ...data, total: undefined, partial: true } }))).toContain('the latest answers only');
  });

  it('says which migration to run when the tables are missing', () => {
    const html = wrap(createElement(CancelSurveysView, { error: null, data: { missing: 'supabase/migrations/20261114000000_trial_paywall.sql', counts: {}, recent: [], trials: { trialing: 0, endedEarly: 0, duplicates: 0, list: [] } } }));
    expect(html).toContain('20261114000000_trial_paywall.sql');
  });
});
