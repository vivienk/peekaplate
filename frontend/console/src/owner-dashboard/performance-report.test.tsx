import { OwnerDishReportSchema } from '@peekaplate/contracts/owner-report';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReportView } from './report-data';
import { UNEEZA_REPORT } from './uneeza-report';

const REPORT = OwnerDishReportSchema.parse(UNEEZA_REPORT);

describe('authored performance presentation with report API data', () => {
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
});
