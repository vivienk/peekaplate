import { OwnerDishReportSchema } from '@peekaplate/contracts';
import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { CommandError } from './dish-command';
import { readOwnerReport } from './owner-report';

const VENUE_A = '00000000-0000-4000-8000-000000000123';
const VENUE_B = '00000000-0000-4000-8000-000000000999';
const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const REVOKED_OWNER = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-12T14:00:00.000Z');

function createMultiTenantClient(
  memberships: Record<string, Record<string, string>>,
  rowsByVenue: Record<string, Record<string, unknown>[]>,
) {
  let activeActorId = '';
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    const normalized = text.trim().replace(/\s+/g, ' ');
    if (normalized.includes('set_config') && Array.isArray(values) && values.length > 0) {
      activeActorId = String(values[0]);
      return { rows: [] };
    }
    if (normalized.includes('app_private.staff_membership')) {
      const requestedVenue = Array.isArray(values) ? String(values[0]) : '';
      const permission = memberships[activeActorId]?.[requestedVenue] ?? null;
      return { rows: permission ? [{ permission }] : [] };
    }
    if (normalized.includes('app_private.owner_observation_v1')) {
      const requestedVenue = Array.isArray(values) ? String(values[0]) : '';
      return { rows: rowsByVenue[requestedVenue] ?? [] };
    }
    return { rows: [] };
  });

  return { client: { query } as unknown as Client, query };
}

describe('S6-DATA-13 release hardening: Owner A/B isolation, revocation, 9/10/11 boundaries & states', () => {
  const boundaryRows = [
    {
      dish_id: '00000000-0000-4000-8000-000000000009',
      dish_name: 'Nine Sessions Suppressed Dish',
      total_sessions: 9,
      exposed_open_sessions: 5,
      open_eligible_sessions: 9,
      total_openings: 9,
      timed_openings: 9,
      engaged_sessions: 4,
      saved_sessions: 2,
      timed_sessions: 9,
      average_active_seconds: 15.2,
      last_event_ingested_at: new Date('2026-11-12T13:30:00.000Z'),
    },
    {
      dish_id: '00000000-0000-4000-8000-000000000010',
      dish_name: 'Ten Sessions Boundary Dish',
      total_sessions: 10,
      exposed_open_sessions: 6,
      open_eligible_sessions: 10,
      total_openings: 10,
      timed_openings: 10,
      engaged_sessions: 5,
      saved_sessions: 3,
      timed_sessions: 10,
      average_active_seconds: 20.0,
      last_event_ingested_at: new Date('2026-11-12T13:45:00.000Z'),
    },
    {
      dish_id: '00000000-0000-4000-8000-000000000011',
      dish_name: 'Eleven Sessions Valid Zero & Not Measurable Timing Dish',
      total_sessions: 11,
      exposed_open_sessions: 0,
      open_eligible_sessions: 11,
      total_openings: 0,
      timed_openings: 0,
      engaged_sessions: 0,
      saved_sessions: 0,
      timed_sessions: 0,
      average_active_seconds: null,
      last_event_ingested_at: null,
    },
  ];

  it('enforces Owner A/B isolation and blocks revoked membership with 403 and zero cross-restaurant leakage', async () => {
    const memberships = {
      [OWNER_A]: { [VENUE_A]: 'owner' },
      [OWNER_B]: { [VENUE_B]: 'owner' },
    };
    const { client } = createMultiTenantClient(memberships, {
      [VENUE_A]: boundaryRows,
      [VENUE_B]: [],
    });

    // Owner A reads Venue A successfully
    const reportA = OwnerDishReportSchema.parse(
      await readOwnerReport(client, OWNER_A, VENUE_A, NOW, 'synthetic'),
    );
    expect(reportA.venue_id).toBe(VENUE_A);
    expect(reportA.dishes).toHaveLength(3);

    // Owner B attempting to read Venue A must fail with 403 (no cross-restaurant leakage)
    await expect(readOwnerReport(client, OWNER_B, VENUE_A, NOW, 'synthetic')).rejects.toSatisfy(
      (err: unknown) => err instanceof CommandError && err.status === 403,
    );

    // Revoked Owner attempting to read Venue A must fail with 403
    await expect(
      readOwnerReport(client, REVOKED_OWNER, VENUE_A, NOW, 'synthetic'),
    ).rejects.toSatisfy((err: unknown) => err instanceof CommandError && err.status === 403);
  });

  it('verifies exact 9/10/11 suppression boundaries (null vs 0), valid-zero, and not-measurable states', async () => {
    const memberships = { [OWNER_A]: { [VENUE_A]: 'owner' } };
    const { client } = createMultiTenantClient(memberships, { [VENUE_A]: boundaryRows });

    const report = OwnerDishReportSchema.parse(
      await readOwnerReport(client, OWNER_A, VENUE_A, NOW, 'synthetic'),
    );

    // 1. 9 sessions -> SUPPRESSED with null (never coerced to 0)
    const dish9 = report.dishes.find((d) => d.dish_id === '00000000-0000-4000-8000-000000000009')!;
    expect(dish9.evidence_state).toBe('SUPPRESSED');
    expect(dish9.metrics.active_sessions.value).toBeNull();
    expect(dish9.metrics.open_rate.value).toBeNull();
    expect(dish9.metrics.engagement_rate.value).toBeNull();
    expect(dish9.metrics.save_rate.value).toBeNull();

    // 2. 10 sessions -> exact privacy floor threshold -> NORMAL
    const dish10 = report.dishes.find((d) => d.dish_id === '00000000-0000-4000-8000-000000000010')!;
    expect(dish10.evidence_state).toBe('NORMAL');
    expect(dish10.metrics.active_sessions.value).toBe(10);
    expect(dish10.metrics.open_rate.value).toBe(0.6);
    expect(dish10.metrics.engagement_rate.value).toBe(0.5);
    expect(dish10.metrics.save_rate.value).toBe(0.3);

    // 3. 11 sessions with 0 opens/saves (valid-zero) and 0 timed sessions (not-measurable timing)
    const dish11 = report.dishes.find((d) => d.dish_id === '00000000-0000-4000-8000-000000000011')!;
    expect(dish11.evidence_state).toBe('NORMAL');
    expect(dish11.metrics.active_sessions.value).toBe(11);
    expect(dish11.metrics.open_rate.value).toBe(0);
    expect(dish11.metrics.open_rate.status).toBe('VALID_ZERO');
    expect(dish11.metrics.save_rate.value).toBe(0);
    expect(dish11.metrics.save_rate.status).toBe('VALID_ZERO');
    expect(dish11.metrics.avg_interaction_time_seconds.value).toBeNull();
  });

  it('verifies missing/empty venue report returns EMPTY status with zero dishes and null freshness', async () => {
    const memberships = { [OWNER_A]: { [VENUE_A]: 'owner' } };
    const { client } = createMultiTenantClient(memberships, { [VENUE_A]: [] });

    const report = OwnerDishReportSchema.parse(
      await readOwnerReport(client, OWNER_A, VENUE_A, NOW, 'synthetic'),
    );
    expect(report.report_metadata.report_status).toBe('EMPTY');
    expect(report.report_metadata.coverage.total_dishes_monitored).toBe(0);
    expect(report.report_metadata.coverage.measurable_dishes_count).toBe(0);
    expect(report.report_metadata.freshness.is_stale).toBeNull();
    expect(report.report_metadata.freshness.last_event_ingested_at).toBeNull();
    expect(report.dishes).toEqual([]);
  });
});
