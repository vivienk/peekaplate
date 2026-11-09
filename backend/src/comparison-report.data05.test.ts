import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { readComparisonReport } from './comparison-report';

const venueId = 'e2a66159-bd14-44cb-8217-36d001a12676';

const windows = [
  '2026-10-26T00:00:00Z',
  '2026-11-02T00:00:00Z',
  '2026-10-19T00:00:00Z',
  '2026-10-26T00:00:00Z',
] as const;

function createClient(sessionCount: number) {
  const row = {
    dish_id: '45806808-4376-46ff-912b-ab8a5519881a',
    name: 'Synthetic DATA-05 Dish',
    current_sessions: String(sessionCount),
    baseline_sessions: String(sessionCount),
    current_exposure_sessions: String(sessionCount),
    baseline_exposure_sessions: String(sessionCount),
    current_opening_sessions: String(sessionCount),
    baseline_opening_sessions: String(sessionCount),
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
  for (const sessionCount of [9, 10, 11]) {
    it(`validates ${sessionCount} eligible sessions`, async () => {
      const { client } = createClient(sessionCount);

      const report = await readComparisonReport(client, venueId, venueId, ...windows);

      const dish = report.dishes[0];
      expect(dish).toBeDefined();

      for (const metric of Object.values(dish!.metrics)) {
        if (sessionCount < 10) {
          expect(metric.status).toBe('INSUFFICIENT');
          expect(metric.current_value).toBeNull();
          expect(metric.baseline_value).toBeNull();
          expect(metric.delta).toBeNull();
          expect(metric.eligible_sessions).toBeNull();
        } else {
          expect(metric.status).toBe('COMPARABLE');
          expect(metric.current_value).not.toBeNull();
          expect(metric.baseline_value).not.toBeNull();
          expect(metric.eligible_sessions).toBe(sessionCount);
        }
      }

      expect(report.comparison_eligibility).toBe(sessionCount < 10 ? 'INSUFFICIENT' : 'COMPARABLE');
    });
  }
});
