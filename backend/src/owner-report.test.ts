import { OwnerDishReportSchema } from '@peekaplate/contracts';
import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { CommandError } from './dish-command';
import { readOwnerReport } from './owner-report';

const venueId = 'e2a66159-bd14-44cb-8217-36d001a12676';
const dishId = '45806808-4376-46ff-912b-ab8a5519881a';

// A stand-in for pg's Client: records every statement and answers the membership lookup.
function fakeClient(permission: string | null, reportRows: Record<string, unknown>[] = []) {
  const statements: string[] = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    // Keep the whole statement on one line so later checks can find any part of it.
    statements.push(text.trim().replace(/\s+/g, ' '));
    if (text.includes('app_private.staff_membership')) {
      return { rows: permission === null ? [] : [{ permission }] };
    }
    if (text.includes('app_private.owner_observation_v1')) return { rows: reportRows };
    return { rows: [] };
  });
  return { client: { query } as unknown as Client, statements, query };
}

function reportRow(overrides: Record<string, unknown> = {}) {
  return {
    dish_id: dishId,
    dish_name: 'Synthetic dish',
    total_sessions: 9,
    exposed_open_sessions: 8,
    open_eligible_sessions: 8,
    engaged_sessions: 7,
    saved_sessions: 6,
    timed_sessions: 5,
    average_active_seconds: 18,
    last_event_ingested_at: new Date('2026-11-06T09:00:00Z'),
    ...overrides,
  };
}

describe('readOwnerReport ownership check', () => {
  it('lets an owner read, inside one read-only transaction with the actor set first', async () => {
    const { client, statements } = fakeClient('owner');
    await readOwnerReport(client, 'actor-1', venueId, new Date('2026-11-04T10:00:00Z'));
    expect(statements[0]).toBe('BEGIN READ ONLY');
    const actorAt = statements.findIndex((s) => s.includes("set_config('app.actor_id'"));
    const membershipAt = statements.findIndex((s) => s.startsWith('SELECT permission'));
    const tenantAt = statements.findIndex((s) => s.includes("set_config('app.tenant_id'"));
    const reportAt = statements.findIndex((s) => s.includes('owner_observation_v1'));
    expect(actorAt).toBeGreaterThan(0);
    expect(membershipAt).toBeGreaterThan(actorAt);
    // The tenant is set only after ownership is confirmed, and before anything is read.
    expect(tenantAt).toBeGreaterThan(membershipAt);
    expect(reportAt).toBeGreaterThan(tenantAt);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  for (const permission of ['editor', 'viewer', null]) {
    it(`refuses ${permission ?? 'a non-member'} with 403 and reads nothing`, async () => {
      const { client, statements } = fakeClient(permission);
      const attempt = readOwnerReport(client, 'actor-1', venueId, new Date());
      await expect(attempt).rejects.toBeInstanceOf(CommandError);
      await expect(attempt).rejects.toMatchObject({ code: 'forbidden', status: 403 });
      expect(statements.some((s) => s.includes('owner_observation_v1'))).toBe(false);
      expect(statements.some((s) => s.includes("set_config('app.tenant_id'"))).toBe(false);
      expect(statements.at(-1)).toBe('ROLLBACK');
    });
  }
});

describe('readOwnerReport report contract and session metrics', () => {
  it('suppresses every behavioral value below ten sessions and serializes the owner schema', async () => {
    const { client } = fakeClient('owner', [
      reportRow({
        active_sessions_value: 9,
        open_rate_value: 0.8,
        engagement_rate_value: 0.875,
        save_rate_value: 0.75,
      }),
    ]);

    const report = await readOwnerReport(
      client,
      'actor-1',
      venueId,
      new Date('2026-11-06T10:00:00Z'),
    );
    const json = JSON.parse(JSON.stringify(report)) as {
      dishes: Array<{
        evidence_state: string;
        metrics: Record<string, { value: number | null; status: string }>;
      }>;
      report_metadata: unknown;
    };

    expect(OwnerDishReportSchema.safeParse(json).success).toBe(true);
    expect(json.dishes[0]?.evidence_state).toBe('SUPPRESSED');
    for (const metric of [
      'active_sessions',
      'open_rate',
      'engagement_rate',
      'save_rate',
      'avg_interaction_time_seconds',
      'timing_coverage',
    ]) {
      expect(json.dishes[0]?.metrics[metric]).toMatchObject({
        value: null,
        status: 'SUPPRESSED',
      });
    }
    expect(JSON.stringify(json)).not.toContain('eligible_sessions');
  });

  it('uses the owner_report.v1 envelope and strips internal cohort counts', async () => {
    const { client } = fakeClient('owner', [
      reportRow({
        total_sessions: 12,
        exposed_open_sessions: 10,
        open_eligible_sessions: 10,
        engaged_sessions: 10,
        saved_sessions: 2,
        timed_sessions: 10,
        average_active_seconds: 18,
      }),
    ]);

    const report = await readOwnerReport(
      client,
      'actor-1',
      venueId,
      new Date('2026-11-06T10:00:00Z'),
    );

    expect(OwnerDishReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({
      schema_version: 'owner_report.v1',
      venue_id: venueId,
      source: 'production',
      report_metadata: {
        date_window: { duration_hours: 24 },
        coverage: { total_dishes_monitored: 1, measurable_dishes_count: 1 },
        freshness: {
          is_stale: null,
          last_event_ingested_at: '2026-11-06T09:00:00.000Z',
        },
        report_status: 'NORMAL',
      },
      dishes: [
        {
          dish_id: dishId,
          name: 'Synthetic dish',
          metrics: {
            active_sessions: { value: 12, status: 'NORMAL' },
            open_rate: { value: 0.833, status: 'NORMAL' },
            engagement_rate: { value: 1, status: 'NORMAL' },
            save_rate: { value: 0.167, status: 'NORMAL' },
            avg_interaction_time_seconds: { value: 18, status: 'NORMAL' },
            timing_coverage: { value: 1, status: 'NORMAL' },
          },
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain('eligible_sessions');
  });

  it('labels synthetic reports and calculations as synthetic', async () => {
    const { client } = fakeClient('owner', [reportRow()]);
    const report = await readOwnerReport(
      client,
      'actor-1',
      venueId,
      new Date('2026-11-06T10:00:00Z'),
      'synthetic',
    );

    expect(OwnerDishReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({
      source: 'synthetic',
      report_metadata: { calculation_version: 'synthetic.v1' },
    });
  });

  it('masks timing-related indicators when nine of ten sessions have valid timing', async () => {
    const { client } = fakeClient('owner', [
      reportRow({
        total_sessions: 10,
        exposed_open_sessions: 10,
        open_eligible_sessions: 10,
        engaged_sessions: 8,
        saved_sessions: 3,
        timed_sessions: 9,
      }),
    ]);

    const report = await readOwnerReport(
      client,
      'actor-1',
      venueId,
      new Date('2026-11-06T10:00:00Z'),
    );

    expect(OwnerDishReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({
      dishes: [
        {
          evidence_state: 'NORMAL',
          metrics: {
            active_sessions: { value: null, status: 'SUPPRESSED' },
            avg_interaction_time_seconds: { value: null, status: 'SUPPRESSED' },
            timing_coverage: { value: null, status: 'SUPPRESSED' },
            open_rate: { value: null, status: 'SUPPRESSED' },
            engagement_rate: { value: 0.8, status: 'NORMAL' },
            save_rate: { value: 0.3, status: 'NORMAL' },
          },
        },
      ],
    });
  });

  it('accepts a source override while defaulting to production', async () => {
    const { client } = fakeClient('owner');
    const report = OwnerDishReportSchema.parse(
      await readOwnerReport(
        client,
        'actor-1',
        venueId,
        new Date('2026-11-06T10:00:00Z'),
        'synthetic',
      ),
    );

    expect(report.source).toBe('synthetic');
  });

  it('marks freshness unavailable while preserving the latest ingestion timestamp', async () => {
    const now = new Date('2026-11-06T10:00:00Z');
    const staleClient = fakeClient('owner', [
      reportRow({ last_event_ingested_at: new Date('2026-11-06T08:59:59Z') }),
    ]);
    const staleReport = await readOwnerReport(staleClient.client, 'actor-1', venueId, now);
    expect(staleReport).toMatchObject({
      report_metadata: {
        freshness: {
          is_stale: null,
          last_event_ingested_at: '2026-11-06T08:59:59.000Z',
        },
      },
    });

    const emptyClient = fakeClient('owner');
    const emptyReport = await readOwnerReport(emptyClient.client, 'actor-1', venueId, now);
    expect(emptyReport).toMatchObject({
      report_metadata: {
        freshness: {
          is_stale: null,
          last_event_ingested_at: null,
        },
      },
    });
  });

  it('counts unique sessions and the canonical linked-comparison event in SQL', async () => {
    const { client, statements, query } = fakeClient('owner', [reportRow()]);
    const now = new Date('2026-11-06T10:00:00Z');
    await readOwnerReport(client, 'actor-1', venueId, now);
    const sql = statements.find((statement) =>
      statement.includes('app_private.owner_observation_v1'),
    );
    const reportQuery = query.mock.calls.find(([statement]) =>
      statement.includes('app_private.owner_observation_v1'),
    );

    expect(sql).toContain("comp.event_type = 'dish_compared'");
    expect(sql).toContain('qualified_comparisons');
    expect(sql).toContain('comparison_engagement');
    expect(sql).toContain('opened.occurred_at < comp.occurred_at');
    expect(sql).toContain('opened.occurred_at = comp.occurred_at');
    expect(sql).toContain('opened.producer_id = comp_order.producer_id');
    expect(sql).toContain('opened.local_sequence < comp_order.local_sequence');
    expect(sql).toContain('FROM app_private.observation_event event');
    expect(sql).toContain('participant.dish_id');
    expect(sql).toContain('obs.occurred_at >= $2 AND obs.occurred_at <= $3');
    expect(sql).toContain('act.occurred_at >= $2 AND act.occurred_at <= $3');
    expect(reportQuery?.[1]).toEqual([venueId, new Date('2026-11-05T10:00:00Z'), now]);
    expect(sql).toContain('GROUP BY obs.dish_id, obs.session_id');
    expect(sql).toContain('COUNT(DISTINCT');
    expect(sql).toContain('sessions.has_active_engagement OR sessions.has_comparison');
    expect(sql).not.toContain('sessions.has_comparison AND sessions.is_exposed');
    expect(sql).toContain('sessions.is_exposed AND sessions.has_direct_save');
    expect(sql).not.toContain('sessions.is_opened AND sessions.has_direct_save');
    expect(sql).not.toContain("obs.event_type = 'portion_compare'");
  });
});
