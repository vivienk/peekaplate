import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { readComparisonReport } from './comparison-report';

const makeRow = (overrides: Record<string, unknown> = {}) => ({
  dish_id: '45806808-4376-46ff-912b-ab8a5519881a',
  name: 'Thieb',
  current_sessions: '12',
  baseline_sessions: '15',
  current_exposure_sessions: '11',
  baseline_exposure_sessions: '12',
  current_opening_sessions: '10',
  baseline_opening_sessions: '11',
  current_open_rate: '0.5',
  baseline_open_rate: '0.25',
  open_rate_delta: '0.25',
  current_engagement_rate: '0.4',
  baseline_engagement_rate: '0.3',
  engagement_rate_delta: '0.1',
  current_save_rate: '0.2',
  baseline_save_rate: '0.1',
  save_rate_delta: '0.1',
  ...overrides,
});

const windows = [
  '2026-10-26T00:00:00Z',
  '2026-11-02T00:00:00Z',
  '2026-10-19T00:00:00Z',
  '2026-10-26T00:00:00Z',
] as const;

function createClient(rows: ReturnType<typeof makeRow>[]) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM app_private.staff_membership')) {
      return { rows: [{ permission: 'viewer' }] };
    }
    if (sql.includes('WITH scoped_facts AS MATERIALIZED')) return { rows };
    return { rows: [] };
  });
  return { client: { query } as unknown as Client, query };
}

describe('readComparisonReport', () => {
  it('aggregates matched periods into the versioned report contract', async () => {
    const { client, query } = createClient([makeRow()]);

    const report = await readComparisonReport(
      client,
      'e2a66159-bd14-44cb-8217-36d001a12676',
      'e2a66159-bd14-44cb-8217-36d001a12676',
      ...windows,
    );

    expect(report.schema_version).toBe('comparison_report.v1');
    expect(report.comparison_eligibility).toBe('COMPARABLE');
    expect(report.dishes[0]?.metrics.open_rate).toEqual({
      metric_version: 'session_rate.v1',
      status: 'COMPARABLE',
      current_value: 0.5,
      baseline_value: 0.25,
      delta: 0.25,
      eligible_sessions: 11,
    });
    const sql = query.mock.calls.find(([statement]) =>
      statement.includes('WITH scoped_facts AS MATERIALIZED'),
    )?.[0];
    expect(sql).toContain('baseline_period AS');
    expect(sql).toContain('FULL OUTER JOIN baseline_period USING (dish_id)');
    expect(sql).toContain("obs.traffic_class = 'live'");
    expect(sql).toContain('sessions.has_exposure AND sessions.has_opening');
    expect(sql).not.toContain("fact.opening_source = 'menu_card'");
    expect(sql).not.toContain("opening_source = 'compare_view'");
    expect(sql).toContain('linked_opening.occurred_at >= $2::timestamptz');
    expect(sql).toContain('linked_opening.occurred_at >= $4::timestamptz');
  });

  it('masks metrics and eligible-session counts below the ten-session floor', async () => {
    const { client } = createClient([
      makeRow({
        current_sessions: '9',
        current_open_rate: null,
        baseline_open_rate: null,
        open_rate_delta: null,
        current_engagement_rate: null,
        baseline_engagement_rate: null,
        engagement_rate_delta: null,
        current_save_rate: null,
        baseline_save_rate: null,
        save_rate_delta: null,
      }),
    ]);

    const report = await readComparisonReport(
      client,
      'e2a66159-bd14-44cb-8217-36d001a12676',
      'e2a66159-bd14-44cb-8217-36d001a12676',
      ...windows,
    );

    expect(report.dishes[0]?.comparison_status).toBe('INSUFFICIENT');
    for (const comparisonMetric of Object.values(report.dishes[0]!.metrics)) {
      expect(comparisonMetric).toMatchObject({
        status: 'INSUFFICIENT',
        current_value: null,
        baseline_value: null,
        delta: null,
        eligible_sessions: null,
      });
    }
    expect(report.comparison_eligibility).toBe('INSUFFICIENT');
  });

  it('marks a dish insufficient when its denominator cohorts are below the floor', async () => {
    const { client } = createClient([
      makeRow({
        current_exposure_sessions: '9',
        baseline_exposure_sessions: '8',
        current_opening_sessions: '3',
        baseline_opening_sessions: '4',
        current_open_rate: null,
        baseline_open_rate: null,
        open_rate_delta: null,
        current_engagement_rate: null,
        baseline_engagement_rate: null,
        engagement_rate_delta: null,
        current_save_rate: null,
        baseline_save_rate: null,
        save_rate_delta: null,
      }),
    ]);

    const report = await readComparisonReport(
      client,
      'e2a66159-bd14-44cb-8217-36d001a12676',
      'e2a66159-bd14-44cb-8217-36d001a12676',
      ...windows,
    );

    expect(report.dishes[0]?.comparison_status).toBe('INSUFFICIENT');
  });

  it('rejects invalid time windows before querying', async () => {
    const { client, query } = createClient([]);
    await expect(
      readComparisonReport(
        client,
        'e2a66159-bd14-44cb-8217-36d001a12676',
        'e2a66159-bd14-44cb-8217-36d001a12676',
        windows[1],
        windows[0],
        windows[2],
        windows[3],
      ),
    ).rejects.toThrow('Current period must be a valid, increasing time window');
    expect(query).not.toHaveBeenCalled();
  });
});
