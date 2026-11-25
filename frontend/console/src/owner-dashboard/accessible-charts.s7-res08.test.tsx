import { OwnerDishReportSchema } from '@peekaplate/contracts/owner-report';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Overview } from './pages';
import { ReportView } from './report-data';
import { EngagementPeriodChart, LineChart } from './ui';

describe('S7-RES-08 clear, exact, and accessible dashboard charts', () => {
  it('exposes 71.4% (not 0.714) across bar, exact-value table, and accessible name for 10 of 14 opens', () => {
    const report = OwnerDishReportSchema.parse({
      schema_version: 'owner_report.v1',
      venue_id: '11111111-1111-4111-8111-111111111111',
      source: 'production',
      report_metadata: {
        calculation_version: 'production.batch.v1',
        generated_at: '2026-11-24T12:00:00.000Z',
        date_window: {
          start_time: '2026-11-24T11:50:00.000Z',
          end_time: '2026-11-24T11:55:00.000Z',
          duration_hours: 1,
        },
        coverage: { total_dishes_monitored: 4, measurable_dishes_count: 2 },
        freshness: { last_event_ingested_at: null, is_stale: null },
        report_status: 'NORMAL',
      },
      dishes: [
        {
          dish_id: '22222222-2222-4222-8222-222222222222',
          name: 'Lentil Bowl',
          evidence_state: 'NORMAL',
          metrics: {
            active_sessions: { value: 14, status: 'NORMAL' },
            avg_interaction_time_seconds: { value: 18, status: 'NORMAL' },
            timing_coverage: { value: 1, status: 'NORMAL' },
            open_rate: { value: 10 / 14, status: 'NORMAL' },
            engagement_rate: { value: 0.6, status: 'NORMAL' },
            save_rate: { value: 0.2, status: 'NORMAL' },
          },
        },
        {
          dish_id: '33333333-3333-4333-8333-333333333333',
          name: 'Zero Open Soup',
          evidence_state: 'NORMAL',
          metrics: {
            active_sessions: { value: 12, status: 'NORMAL' },
            avg_interaction_time_seconds: { value: null, status: 'NOT_MEASURABLE' },
            timing_coverage: { value: null, status: 'NOT_MEASURABLE' },
            open_rate: { value: 0, status: 'VALID_ZERO' },
            engagement_rate: { value: null, status: 'NOT_MEASURABLE' },
            save_rate: { value: 0, status: 'VALID_ZERO' },
          },
        },
        {
          dish_id: '44444444-4444-4444-8444-444444444444',
          name: 'Low Traffic Salad',
          evidence_state: 'SUPPRESSED',
          metrics: {
            active_sessions: { value: null, status: 'SUPPRESSED' },
            avg_interaction_time_seconds: { value: null, status: 'SUPPRESSED' },
            timing_coverage: { value: null, status: 'SUPPRESSED' },
            open_rate: { value: null, status: 'SUPPRESSED' },
            engagement_rate: { value: null, status: 'SUPPRESSED' },
            save_rate: { value: null, status: 'SUPPRESSED' },
          },
        },
        {
          dish_id: '55555555-5555-4555-8555-555555555555',
          name: 'Unmeasured Wrap',
          evidence_state: 'NOT_MEASURABLE',
          metrics: {
            active_sessions: { value: null, status: 'MISSING' },
            avg_interaction_time_seconds: { value: null, status: 'MISSING' },
            timing_coverage: { value: null, status: 'MISSING' },
            open_rate: { value: null, status: 'MISSING' },
            engagement_rate: { value: null, status: 'MISSING' },
            save_rate: { value: null, status: 'MISSING' },
          },
        },
      ],
    });

    const html = renderToStaticMarkup(
      <ReportView state={{ kind: 'ready', report }} presentation="performance" />,
    );

    expect(html).toContain('Which dishes have the highest open rate?');
    expect(html).toContain('aria-label="Lentil Bowl: Open rate 71.4%"');
    expect(html).toContain('>71.4%<');
    expect(html).not.toContain('0.714');
    expect(html).toContain('aria-label="Zero Open Soup: Open rate 0%"');
    expect(html).toContain('aria-label="Low Traffic Salad: Not enough visits yet"');
    expect(html).toContain('aria-label="Unmeasured Wrap: No data"');
  });

  it('compares 10/10 vs 12/20 engagement and shows engaged visits increased while rate fell from 100% to 60%', () => {
    const html = renderToStaticMarkup(
      <EngagementPeriodChart
        baseline={{ label: 'Previous period', engagedVisits: 10, eligibleVisits: 10 }}
        current={{ label: 'Current period', engagedVisits: 12, eligibleVisits: 20 }}
      />,
    );

    expect(html).toContain('Did engagement change over the period?');
    expect(html).toContain(
      'Engaged visits increased (10 → 12), while engagement rate fell from 100% to 60%.',
    );
    expect(html).toContain('aria-label="Previous period: Engagement rate 100%"');
    expect(html).toContain('aria-label="Current period: Engagement rate 60%"');
    expect(html).toContain('10 of 10 eligible visits');
    expect(html).toContain('12 of 20 eligible visits');
  });

  it('handles zero, missing, and suppressed values cleanly in EngagementPeriodChart', () => {
    const suppressedHtml = renderToStaticMarkup(
      <EngagementPeriodChart
        baseline={{ label: 'Previous period', engagedVisits: 4, eligibleVisits: 6 }}
        current={{ label: 'Current period', engagedVisits: 0, eligibleVisits: 12 }}
      />,
    );
    expect(suppressedHtml).toContain('aria-label="Previous period: Not enough visits yet"');
    expect(suppressedHtml).toContain('aria-label="Current period: Engagement rate 0%"');

    const missingHtml = renderToStaticMarkup(
      <EngagementPeriodChart
        baseline={{ label: 'Previous period', engagedVisits: null, eligibleVisits: null }}
        current={{ label: 'Current period', engagedVisits: 10, eligibleVisits: 10 }}
      />,
    );
    expect(missingHtml).toContain('aria-label="Previous period: No data"');
    expect(missingHtml).toContain('aria-label="Current period: Engagement rate 100%"');
  });

  it('exposes keyboard navigation guidance on LineChart', () => {
    const html = renderToStaticMarkup(
      <LineChart
        labels={['Mon', 'Tue']}
        desc="Daily openings count"
        series={[{ name: 'Daily openings', color: 'orange', values: [12, 15] }]}
      />,
    );
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(
      'aria-label="Daily openings count. Use Left and Right arrow keys to inspect each point."',
    );
  });

  it('hides raw visit counts in the table when a period is below the 10-visit floor or SUPPRESSED', () => {
    const html = renderToStaticMarkup(
      <EngagementPeriodChart
        baseline={{ label: 'Previous period', engagedVisits: 4, eligibleVisits: 6 }}
        current={{
          label: 'Current period',
          engagedVisits: 7,
          eligibleVisits: 30,
          status: 'SUPPRESSED',
        }}
      />,
    );
    expect(html).toContain('Not enough visits yet');
    expect(html).not.toContain('4 of 6 eligible visits');
    expect(html).not.toContain('7 of 30 eligible visits');
  });

  it('renders the 10/10 -> 12/20 period engagement comparison directly on Overview', () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      <Overview go={noop} sim={{ scn: 'A' }} acts={{}} openDish={noop} openInsight={noop} />,
    );
    expect(html).toContain('Did engagement change over the period?');
    expect(html).toContain(
      'Engaged visits increased (10 → 12), while engagement rate fell from 100% to 60%.',
    );
  });
});
