import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import privacyCases from '../../tests/data05/comparison_privacy_cases.json';
import { readComparisonReport } from './comparison-report';

const venueId = 'e2a66159-bd14-44cb-8217-36d001a12676';

const windows = [
  '2026-10-26T00:00:00Z',
  '2026-11-02T00:00:00Z',
  '2026-10-19T00:00:00Z',
  '2026-10-26T00:00:00Z',
] as const;

type PeriodCohort = { sessions: number; exposure_sessions: number; opening_sessions: number };

function createClient(current: PeriodCohort, baseline: PeriodCohort) {
  const row = {
    dish_id: '45806808-4376-46ff-912b-ab8a5519881a',
    name: 'Synthetic DATA-05 Dish',
    current_sessions: String(current.sessions),
    baseline_sessions: String(baseline.sessions),
    current_exposure_sessions: String(current.exposure_sessions),
    baseline_exposure_sessions: String(baseline.exposure_sessions),
    current_opening_sessions: String(current.opening_sessions),
    baseline_opening_sessions: String(baseline.opening_sessions),
    current_open_rate: '0.5',
    baseline_open_rate: '0.25',
    open_rate_delta: '0.25',
    current_engagement_rate: '0.4',
    baseline_engagement_rate: '0.3',
    engagement_rate_delta: '0.1',
    current_save_rate: '0.2',
    baseline_save_rate: '0.1',
    save_rate_delta: '0.1',
  };

  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM app_private.staff_membership')) {
      return { rows: [{ permission: 'viewer' }] };
    }
    if (sql.includes('WITH current_period AS')) {
      return { rows: [row] };
    }
    return { rows: [] };
  });

  return { query, client: { query } as unknown as Client };
}

describe('DATA-05 independent privacy boundaries', () => {
  for (const scenario of privacyCases.cases) {
    it(`${scenario.case_id}: ${scenario.description}`, async () => {
      const { current, baseline } = scenario.input;
      const { client } = createClient(current, baseline);

      const report = await readComparisonReport(client, venueId, venueId, ...windows);

      const dish = report.dishes[0];
      expect(dish).toBeDefined();

      const rates = {
        open_rate: { current_value: 0.5, baseline_value: 0.25, delta: 0.25 },
        engagement_rate: { current_value: 0.4, baseline_value: 0.3, delta: 0.1 },
        save_rate: { current_value: 0.2, baseline_value: 0.1, delta: 0.1 },
      };
      for (const name of ['open_rate', 'engagement_rate', 'save_rate'] as const) {
        const metric = dish!.metrics[name];
        if (scenario.expected.insufficient_metrics.includes(name)) {
          expect(metric, name).toEqual({
            metric_version: 'session_rate.v1',
            status: 'INSUFFICIENT',
            current_value: null,
            baseline_value: null,
            delta: null,
            eligible_sessions: null,
          });
        } else {
          const denominator = name === 'engagement_rate' ? 'opening_sessions' : 'exposure_sessions';
          expect(metric, name).toEqual({
            metric_version: 'session_rate.v1',
            status: 'COMPARABLE',
            ...rates[name],
            eligible_sessions: Math.min(current[denominator], baseline[denominator]),
          });
        }
      }

      expect(dish!.comparison_status).toBe(scenario.expected.comparison_eligibility);
      expect(report.comparison_eligibility).toBe(scenario.expected.comparison_eligibility);
    });
  }
});
