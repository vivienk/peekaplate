import {
  OWNER_PRODUCTION_DAY_VERSION,
  OWNER_PRODUCTION_TODAY_VERSION,
  OwnerDishReportSchema,
} from '@peekaplate/contracts/owner-report';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Overview } from './pages';
import { ReportView } from './report-data';
import { UNEEZA_REPORT } from './uneeza-report';

const REPORT = OwnerDishReportSchema.parse(UNEEZA_REPORT);

describe('authored performance presentation with report API data', () => {
  it('shows today so far and yesterday as San Francisco calendar periods', () => {
    const current = {
      start_time: '2026-11-23T08:00:00.000Z',
      end_time: '2026-11-24T05:15:00.000Z',
    };
    const baseline = { start_time: '2026-11-22T08:00:00.000Z', end_time: current.start_time };
    const missing = { value: null, status: 'MISSING' } as const;
    const yesterday = {
      menu_sessions: missing,
      dish_opens: missing,
      avg_interaction_time_seconds: missing,
      portion_previews_shown: missing,
      verified_orders: missing,
    };
    const report = OwnerDishReportSchema.parse({
      ...REPORT,
      source: 'production',
      dishes: REPORT.dishes.slice(0, 1).map((dish) => ({
        ...dish,
        name: 'Single-session dish',
        metrics: {
          ...dish.metrics,
          active_sessions: { value: 1, status: 'NORMAL' },
          open_rate: { value: 1, status: 'NORMAL' },
        },
      })),
      report_metadata: {
        ...REPORT.report_metadata,
        calculation_version: OWNER_PRODUCTION_DAY_VERSION,
        generated_at: current.end_time,
        date_window: { ...baseline, duration_hours: 24 },
      },
      summary: {
        periods: { current, baseline },
        current: {
          ...yesterday,
          menu_sessions: { value: 1, status: 'NORMAL' },
          dish_opens: { value: 1, status: 'NORMAL' },
        },
        baseline: yesterday,
      },
    });
    const page = renderToStaticMarkup(
      <Overview
        go={() => {}}
        sim={{ scn: 'empty' }}
        acts={{}}
        openDish={() => {}}
        openInsight={() => {}}
        live={{
          restaurantName: 'Production QA fixture',
          menu: [],
          summaryDay: true,
          summarySource: 'production',
          ...(report.summary ? { summary: report.summary } : {}),
        }}
      />,
    );
    expect(page).toContain('Nov 23, 12:00 AM PST');
    expect(page).toContain('Nov 23, 9:15 PM PST');
    expect(page).toContain('Today so far');
    expect(page).toContain('Yesterday');
    expect(page).toContain('Menu sessions</span><div class="v num">1</div>');
    expect(page).toContain('Dish opens</span><div class="v num">1</div>');
    expect(page).not.toContain('Dish opens by batch');
    const performance = renderToStaticMarkup(
      <ReportView state={{ kind: 'ready', report }} presentation="performance" />,
    );
    expect(performance).toContain('previous completed San Francisco day');
    expect(performance).not.toContain('least ten eligible visits');
    expect(performance).toContain('Nov 22, 12:00 AM PST');
    expect(performance).toContain('2.5D previews');
    expect(performance).toContain('Single-session dish: Open rate 1');
    expect(performance).not.toContain('Nov 23, 9:15 PM PST');

    const today = OwnerDishReportSchema.parse({
      ...report,
      report_metadata: {
        ...report.report_metadata,
        calculation_version: OWNER_PRODUCTION_TODAY_VERSION,
        date_window: { ...current, duration_hours: 21 },
      },
    });
    const livePerformance = renderToStaticMarkup(
      <ReportView state={{ kind: 'ready', report: today }} presentation="performance" />,
    );
    expect(livePerformance).toContain('verified dish activity updates through the cutoff');
    expect(livePerformance).toContain('Nov 23, 9:15 PM PST');
    expect(livePerformance).toContain('Single-session dish: Open rate 1');
    expect(livePerformance).not.toContain('previous completed San Francisco day');
  });
  it('uses the authored screen with API values and truthful missing evidence', () => {
    const page = renderToStaticMarkup(
      <ReportView state={{ kind: 'ready', report: REPORT }} presentation="performance" />,
    );
    expect(page).toContain('What diners did with each dish');
    expect(page).toContain('aria-label="Metric"');
    expect(page).toContain('Search dishes');
    expect(page).toContain('Open rate');
    expect(page).toContain('Not measurable');
    expect(page).toContain('0%');
    expect(page).toContain('Synthetic test data from the report API');
    expect(page).not.toContain('First opens');
    expect(page).not.toContain('<img');
  });

  it('keeps unknown freshness and suppressed values distinct from zero', () => {
    const report = structuredClone(REPORT);
    report.report_metadata.freshness.is_stale = null;
    for (const dish of report.dishes) {
      dish.evidence_state = 'SUPPRESSED';
      for (const metric of Object.values(dish.metrics)) {
        metric.status = 'SUPPRESSED';
        metric.value = null;
      }
    }
    const page = renderToStaticMarkup(
      <ReportView state={{ kind: 'ready', report }} presentation="performance" />,
    );
    expect(page).toContain('freshness not known');
    expect(page).toContain('Not enough visits yet');
    expect(page.replace(/<[^>]*>/g, '')).not.toContain('0%');
    expect(page).not.toContain('up to date');
  });

  it('keeps the performance title but no values during access failure or loading', () => {
    for (const kind of ['loading', 'denied', 'invalid', 'error'] as const) {
      const page = renderToStaticMarkup(<ReportView state={{ kind }} presentation="performance" />);
      expect(page).toContain('What diners did with each dish');
      expect(page).not.toContain('<table');
      expect(page).not.toContain('0%');
    }
  });

  it('shows the saved menu independently when a completed production batch has no reportable dishes', () => {
    const report = OwnerDishReportSchema.parse({
      ...REPORT,
      source: 'production',
      report_metadata: {
        ...REPORT.report_metadata,
        calculation_version: 'production.batch.v1',
        report_status: 'EMPTY',
        coverage: { total_dishes_monitored: 0, measurable_dishes_count: 0 },
        freshness: { last_event_ingested_at: null, is_stale: null },
      },
      dishes: [],
    });
    const markup = renderToStaticMarkup(
      <ReportView
        state={{ kind: 'ready', report }}
        presentation="performance"
        savedMenu={[{ id: 'draft-id', name: 'QA Lentil Soup' }]}
      />,
    );
    expect(markup).toContain('These are your saved dishes.');
    expect(markup).toMatch(/<tr class="tbl-pending"><td><b>QA Lentil Soup<\/b><\/td>/);
    // One dash per measurement column, each announced as "No data yet".
    expect(markup.match(/<span class="sr">No data yet<\/span>/g)).toHaveLength(6);
    expect(markup).not.toContain('<ul>');
    expect(markup).toContain('Dish metrics appear when enough eligible visits');
    expect(markup).not.toContain('0 of 0 dishes');
    expect(markup).not.toContain('View as table');
  });
});
