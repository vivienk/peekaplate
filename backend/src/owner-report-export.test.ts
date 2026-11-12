import { describe, expect, it } from 'vitest';
import {
  buildOwnerReportExportFilename,
  type ExportableOwnerReport,
  serializeOwnerReportCsv,
} from './owner-report-export';

describe('owner-report CSV export (S5-DATA-11)', () => {
  const sampleReport: ExportableOwnerReport = {
    schema_version: 'owner_report.v1',
    venue_id: '00000000-0000-4000-8000-000000000123',
    source: 'synthetic',
    report_metadata: {
      calculation_version: 'synthetic.v1',
      generated_at: '2026-11-08T12:00:00.000Z',
      date_window: {
        duration_hours: 24,
        start_time: '2026-11-07T12:00:00.000Z',
        end_time: '2026-11-08T12:00:00.000Z',
      },
      report_status: 'NORMAL',
    },
    dishes: [
      {
        dish_id: 'dish-b',
        name: 'Small Sample, Suppressed Dish',
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
        dish_id: 'dish-a',
        name: '=FormulaDish "Special"',
        evidence_state: 'NORMAL',
        metrics: {
          active_sessions: { value: 24, status: 'NORMAL' },
          avg_interaction_time_seconds: { value: 18.5, status: 'NORMAL' },
          timing_coverage: { value: 0.75, status: 'NORMAL' },
          open_rate: { value: 0.5, status: 'NORMAL' },
          engagement_rate: { value: 0.4, status: 'NORMAL' },
          save_rate: { value: 0.25, status: 'NORMAL' },
        },
      },
    ],
  };

  it('serializes approved aggregate rows deterministically with suppressed cells blanked and formulas escaped', () => {
    const csv = serializeOwnerReportCsv(sampleReport);
    const lines = csv.trim().split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('schema_version,venue_id,source');
    expect(lines[0]).toContain('open_rate,open_rate_status');

    // Sorted by dish_id: dish-a first, formula prefix escaped
    expect(lines[1]).toContain(
      'dish-a,"\'=FormulaDish ""Special""",NORMAL,24,NORMAL,18.5,NORMAL,0.75,NORMAL,0.5,NORMAL,0.4,NORMAL,0.25,NORMAL',
    );

    // Suppressed dish has blank values and SUPPRESSED statuses
    expect(lines[2]).toContain(
      'dish-b,"Small Sample, Suppressed Dish",SUPPRESSED,,SUPPRESSED,,SUPPRESSED,,SUPPRESSED,,SUPPRESSED,,SUPPRESSED,,SUPPRESSED',
    );
  });

  it('builds a deterministic attachment filename', () => {
    expect(
      buildOwnerReportExportFilename(
        '00000000-0000-4000-8000-000000000123',
        '2026-11-08T12:00:00.000Z',
      ),
    ).toBe('owner-report-00000000-0000-4000-8000-000000000123-2026-11-08.csv');
  });

  it.each([
    'avg_interaction_time_seconds',
    'timing_coverage',
    'open_rate',
    'engagement_rate',
    'save_rate',
  ] as const)('preserves a known zero for %s', (metric) => {
    const report = structuredClone(sampleReport);
    report.dishes[1].name = 'Synthetic zero';
    report.dishes[1].metrics[metric] = { value: 0, status: 'VALID_ZERO' };
    const [header, row] = serializeOwnerReportCsv(report).trim().split('\n');
    const headers = header.split(',');
    const cells = row.split(',');
    expect(cells[headers.indexOf(metric)]).toBe('0');
    expect(cells[headers.indexOf(`${metric}_status`)]).toBe('VALID_ZERO');
  });

  it.each(['SUPPRESSED', 'NOT_MEASURABLE', 'MISSING'])(
    'keeps an unavailable %s value blank without converting it to zero',
    (status) => {
      const report = structuredClone(sampleReport);
      report.dishes[1].name = 'Synthetic unavailable';
      report.dishes[1].metrics.save_rate = { value: null, status };
      const [header, row] = serializeOwnerReportCsv(report).trim().split('\n');
      const headers = header.split(',');
      const cells = row.split(',');
      expect(cells[headers.indexOf('save_rate')]).toBe('');
      expect(cells[headers.indexOf('save_rate_status')]).toBe(status);
    },
  );
});
