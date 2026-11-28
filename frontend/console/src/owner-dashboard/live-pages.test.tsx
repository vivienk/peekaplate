import {
  OwnerReportSummarySchema,
  ProductionBatchSummarySchema,
} from '@peekaplate/contracts/owner-report';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Actions, Overview, Report } from './pages';

const noop = () => {};
const common = {
  go: noop,
  acts: {},
  setAct: noop,
  sim: { scn: 'A' as const },
  openDish: noop,
  openInsight: noop,
  editDish: noop,
};
const identity = { restaurantName: 'Actual Kitchen' };
const noSamples = (html: string) => {
  expect(html).not.toMatch(
    /Harvest Power Bowl|Avocado Toast|Berry Pancake|1,494|1–14 Sep 2025|Version A|Evidence checked/,
  );
};

describe('authored dashboard pages with live inputs', () => {
  it('plots one verified opening under its own UTC batch across midnight', () => {
    const absent = { value: null, status: 'MISSING' };
    const currentWindow = { start_time: '2026-11-21T00:00:00Z', end_time: '2026-11-21T00:05:00Z' };
    const previousWindow = { start_time: '2026-11-20T23:55:00Z', end_time: '2026-11-21T00:00:00Z' };
    const metrics = (count: number) => ({
      menu_sessions: { value: count, status: 'NORMAL' },
      dish_opens: { value: count, status: 'NORMAL' },
      avg_interaction_time_seconds: absent,
      portion_previews_shown: absent,
      verified_orders: absent,
    });
    const input = {
      periods: { current: currentWindow, baseline: previousWindow },
      current: metrics(1),
      baseline: metrics(12),
      daily_opens: {
        current: [{ ...currentWindow, opens: metrics(1).dish_opens }],
        baseline: [{ ...previousWindow, opens: metrics(12).dish_opens }],
      },
    };
    expect(OwnerReportSummarySchema.safeParse(input).success).toBe(false);
    const html = renderToStaticMarkup(
      <Overview
        {...common}
        live={{
          ...identity,
          menu: [],
          summarySource: 'production',
          summaryBatch: true,
          summary: ProductionBatchSummarySchema.parse(input),
        }}
      />,
    );
    expect(html).toContain('Dish opens by batch');
    expect(html).toContain('11-21 00:00 UTC');
    expect(html).toContain('11-21 00:05 UTC');
    expect(html).toContain('<div class="v num">1</div>');
  });
  it('renders actual menu identity without prototype images or aggregate metrics', () => {
    const html = renderToStaticMarkup(
      <Overview
        {...common}
        {...{
          live: {
            ...identity,
            menu: [
              {
                id: 'real-1',
                name: 'Actual Soup',
                category: 'Soups',
                priceLabel: 'Price not recorded',
                imageUrl: '/actual-soup.png',
              },
            ],
          },
        }}
      />,
    );
    expect(html).toContain('Actual Kitchen');
    expect(html).toContain('Actual Soup');
    expect(html).toContain('/actual-soup.png');
    expect(html).toContain('Price not recorded');
    expect(html).toContain('Menu sessions');
    expect(html).not.toContain('aria-haspopup="dialog"');
    expect(html.match(/class="kpi"/g)).toHaveLength(5);
    expect(html).toContain('Unavailable');
    expect(html).not.toContain('0 planned');
    noSamples(html);
  });

  it.each([0, 12.75])(
    'uses the existing cards for validated totals, average %s and explicit prior periods',
    (average) => {
      const missing = { value: null, status: 'MISSING' as const };
      const current = {
        menu_sessions: { value: 20, status: 'NORMAL' as const },
        dish_opens: { value: 42, status: 'NORMAL' as const },
        avg_interaction_time_seconds: {
          value: average,
          status: average === 0 ? 'VALID_ZERO' : 'NORMAL',
        },
        portion_previews_shown: missing,
        verified_orders: missing,
      };
      const html = renderToStaticMarkup(
        <Overview
          {...common}
          live={{
            ...identity,
            menu: [],
            summary: OwnerReportSummarySchema.parse({
              periods: {
                current: { start_time: '2026-11-16T00:00:00Z', end_time: '2026-11-17T00:00:00Z' },
                baseline: { start_time: '2026-11-15T00:00:00Z', end_time: '2026-11-16T00:00:00Z' },
              },
              current,
              baseline: {
                ...current,
                menu_sessions: { value: 15, status: 'NORMAL' },
                avg_interaction_time_seconds: { value: null, status: 'SUPPRESSED' },
              },
            }),
          }}
        />,
      );
      const cards = html.split('<div class="kpi">').slice(1);
      expect(cards).toHaveLength(5);
      expect(cards[0]).toContain('<div class="v num">20</div>');
      expect(cards[0]).toContain('Previous period: 15');
      expect(cards[1]).toContain('<div class="v num">42</div>');
      expect(cards[2]).toContain(`<div class="v num">${average}<small>s</small></div>`);
      expect(cards[2]).toContain('Previous period: Not enough visits yet');
      expect(cards[3]).toContain('Unavailable');
      expect(cards[4]).toContain('Unavailable');
      expect(html).toContain('2026-11-15');
      expect(html).toContain('2026-11-17');
      expect(html).not.toContain('last week');
      expect(html).not.toContain('did this week');
      noSamples(html);
    },
  );

  it.each([
    ['SUPPRESSED', 'Not enough visits yet'],
    ['STALE', 'Out of date'],
    ['NOT_MEASURABLE', 'Not measurable'],
    ['EVIDENCE_CHECK_FAILED', 'Couldn’t verify'],
  ] as const)('does not display %s values as measured zero', (status, label) => {
    const hidden = { value: null, status };
    const metrics = {
      menu_sessions: hidden,
      dish_opens: hidden,
      avg_interaction_time_seconds: hidden,
      portion_previews_shown: { value: null, status: 'MISSING' as const },
      verified_orders: { value: null, status: 'MISSING' as const },
    };
    const html = renderToStaticMarkup(
      <Overview
        {...common}
        live={{
          ...identity,
          menu: [],
          summary: {
            periods: {
              current: { start_time: '2026-11-16T00:00:00Z', end_time: '2026-11-17T00:00:00Z' },
              baseline: { start_time: '2026-11-15T00:00:00Z', end_time: '2026-11-16T00:00:00Z' },
            },
            current: metrics,
            baseline: metrics,
          },
        }}
      />,
    );
    expect(html).toContain(label);
    expect(html).not.toContain('<div class="v num">0');
    expect(html).not.toContain('Verified order</span>');
    noSamples(html);
  });

  it('keeps unavailable reports honest and uses the supplied validated report view', () => {
    const absent = renderToStaticMarkup(<Report {...common} {...{ live: identity }} />);
    expect(absent).toContain('Report unavailable');
    expect(absent).not.toContain('Approve');
    noSamples(absent);
    const present = renderToStaticMarkup(
      <Report
        {...common}
        {...{
          live: {
            ...identity,
            period: 'Actual period',
            reportContent: <p>Validated report: Not enough visits yet</p>,
          },
        }}
      />,
    );
    expect(present).toContain('Actual period');
    expect(present).toContain('Validated report: Not enough visits yet');
    noSamples(present);
  });

  it('shows no fabricated actions and renders only explicitly supplied saved actions', () => {
    const empty = renderToStaticMarkup(<Actions {...common} {...{ live: identity }} />);
    expect(empty).toContain('No saved actions');
    expect(empty).not.toContain('Log as done');
    noSamples(empty);
    const saved = renderToStaticMarkup(
      <Actions
        {...common}
        {...{
          live: {
            ...identity,
            actions: [
              {
                id: 'saved-1',
                title: 'Actual saved action',
                text: 'Owner recorded wording',
                status: 'planned' as const,
              },
            ],
          },
        }}
      />,
    );
    expect(saved).toContain('Actual saved action');
    expect(saved).toContain('Owner recorded wording');
    expect(saved).toContain('Planned');
    noSamples(saved);
  });
});
