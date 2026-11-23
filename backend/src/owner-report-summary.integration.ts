import { ObservationQueueMessageSchema } from '@peekaplate/contracts';
import { OwnerDishReportSchema } from '@peekaplate/contracts/owner-report';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresObservationRepository } from './consumer/database';
import { QueueConsumer } from './consumer/queue-consumer';
import { FakeR2ArchiveStorage } from './consumer/r2-storage';
import { createDishRevision } from './dish-command';
import { readOwnerReport } from './owner-report';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;
describe.skipIf(!runtimeUrl || !adminUrl)('owner KPI summary (canonical PostgreSQL facts)', () => {
  const admin = new Client({ connectionString: adminUrl });
  const runtime = new Client({ connectionString: runtimeUrl });
  const actor = crypto.randomUUID();
  const now = new Date('2035-02-03T00:00:00Z');
  const current = Date.parse('2035-02-02T00:00:00Z');
  const baseline = Date.parse('2035-02-01T00:00:00Z');
  const consumer = new QueueConsumer({
    r2Storage: new FakeR2ArchiveStorage(),
    repository: new PostgresObservationRepository(runtime),
  });
  beforeAll(async () => {
    await admin.connect();
    await runtime.connect();
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });
  async function venue() {
    const id = crypto.randomUUID();
    await admin.query(
      "INSERT INTO app_private.venues(id,name) VALUES($1,'Synthetic KPI fixture')",
      [id],
    );
    await admin.query(
      "INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES($1,$2,'owner')",
      [id, actor],
    );
    const dishes = [];
    for (let i = 0; i < 2; i++) {
      const dishId = crypto.randomUUID();
      const revision = await createDishRevision(runtime, actor, id, {
        dishId,
        commandId: crypto.randomUUID(),
        expectedVersion: 0,
        name: `Synthetic KPI dish ${i}`,
        description: 'Fictional database fixture.',
      });
      dishes.push({ dish_id: dishId, dish_revision_id: revision.revisionId });
    }
    return { id, dishes };
  }
  async function event(
    tenant: string,
    session: string,
    producer: string,
    sequence: number,
    time: number,
    type: string,
    payload: Record<string, unknown>,
    traffic = 'test',
  ) {
    const envelope = ObservationQueueMessageSchema.parse({
      kind: 'observation.v2',
      tenantId: tenant,
      eventId: crypto.randomUUID(),
      sessionId: session,
      producerId: producer,
      localSequence: sequence,
      schemaVersion: 'observation.v2',
      authorizedPublicationId: tenant,
      occurredAt: new Date(time).toISOString(),
      firstReceivedAt: new Date(time).toISOString(),
      type,
      payload,
      traffic_class: traffic,
    });
    expect(await consumer.processMessage(envelope)).toEqual({
      status: 'acknowledged',
      reason: 'persisted',
    });
    expect(await consumer.processMessage(envelope)).toEqual({
      status: 'acknowledged',
      reason: 'duplicate_same_payload',
    });
  }
  async function visit(
    tenant: string,
    dishes: { dish_id: string; dish_revision_id: string }[],
    time: number,
    seconds: number[],
  ) {
    const session = crypto.randomUUID(),
      producer = crypto.randomUUID();
    let sequence = 0;
    await event(tenant, session, producer, ++sequence, time, 'menu_viewed', {
      entry_source: 'direct_link',
    });
    for (const [i, dish] of dishes.entries()) {
      const exposure = crypto.randomUUID(),
        opening = crypto.randomUUID();
      await event(tenant, session, producer, ++sequence, time + sequence, 'dish_viewed', {
        ...dish,
        exposure_id: exposure,
        surface: 'menu_list',
        position: i + 1,
        exposure_basis: 'viewport_50pct_1s',
      });
      await event(tenant, session, producer, ++sequence, time + sequence, 'dish_detail_opened', {
        ...dish,
        opening_id: opening,
        source: 'menu_card',
        from_exposure_id: exposure,
        save_available: true,
      });
      // Cumulative checkpoints must be MAXed per opening, never summed.
      for (const final of [false, true])
        await event(
          tenant,
          session,
          producer,
          ++sequence,
          time + sequence,
          'dish_activity_checkpoint',
          {
            ...dish,
            opening_id: opening,
            active_ms: final ? seconds[i]! * 1000 : 0,
            final,
          },
        );
    }
  }
  const report = async (tenant: string, trafficClass: 'test' | 'live' = 'test') =>
    OwnerDishReportSchema.parse(
      await readOwnerReport(runtime, actor, tenant, now, 'synthetic', {
        trafficClass,
        includeSummary: true,
      }),
    );

  it('counts venue sessions once, actual openings, and weighted final activity across two exact windows', async () => {
    const fixture = await venue();
    for (let i = 0; i < 20; i++)
      await visit(
        fixture.id,
        i < 10 ? fixture.dishes : fixture.dishes.slice(0, 1),
        current + i * 60000,
        [10, 30],
      );
    for (let i = 0; i < 10; i++)
      await visit(fixture.id, fixture.dishes.slice(0, 1), baseline + i * 60000, [0]);
    // An exact end-boundary event and live-class events must not contaminate the test report.
    await event(
      fixture.id,
      crypto.randomUUID(),
      crypto.randomUUID(),
      1,
      now.getTime(),
      'menu_viewed',
      { entry_source: 'qr' },
    );
    for (let i = 0; i < 10; i++)
      await event(
        fixture.id,
        crypto.randomUUID(),
        crypto.randomUUID(),
        1,
        current,
        'menu_viewed',
        { entry_source: 'qr' },
        'live',
      );
    const result = await report(fixture.id);
    expect(result.summary?.current.menu_sessions).toEqual({ value: 20, status: 'NORMAL' });
    expect(result.summary?.current.dish_opens).toEqual({ value: 30, status: 'NORMAL' });
    expect(result.summary?.daily_opens?.current).toEqual([
      {
        start_time: '2035-02-02T00:00:00.000Z',
        end_time: '2035-02-03T00:00:00.000Z',
        opens: { value: 30, status: 'NORMAL' },
      },
    ]);
    expect(result.summary?.daily_opens?.baseline[0]?.opens).toEqual({
      value: 10,
      status: 'NORMAL',
    });
    expect(result.summary?.current.avg_interaction_time_seconds.value).toBeCloseTo(500 / 30);
    expect(result.summary?.baseline.menu_sessions).toEqual({ value: 10, status: 'NORMAL' });
    expect(result.summary?.baseline.dish_opens).toEqual({ value: 10, status: 'NORMAL' });
    expect(result.summary?.baseline.avg_interaction_time_seconds).toEqual({
      value: 0,
      status: 'VALID_ZERO',
    });
    expect(result.summary?.current.verified_orders).toEqual({ value: null, status: 'MISSING' });
    expect(result.report_metadata.freshness.is_stale).toBeNull();
    expect((await report(fixture.id, 'live')).summary?.current.menu_sessions.value).toBe(10);
  });
  it('suppresses protected constituent dishes, independently withholds empty baseline, and denies outsiders', async () => {
    const fixture = await venue();
    for (let i = 0; i < 20; i++)
      await visit(
        fixture.id,
        i < 9 ? fixture.dishes : fixture.dishes.slice(0, 1),
        current + i * 60000,
        [10, 30],
      );
    const result = await report(fixture.id);
    for (const key of ['menu_sessions', 'dish_opens', 'avg_interaction_time_seconds'] as const)
      expect(result.summary?.current[key]).toEqual({ value: null, status: 'SUPPRESSED' });
    expect(result.summary?.baseline.menu_sessions).toEqual({
      value: null,
      status: 'NOT_MEASURABLE',
    });
    await expect(
      readOwnerReport(runtime, crypto.randomUUID(), fixture.id, now, 'synthetic', {
        includeSummary: true,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('clips UTC buckets at a noon window and suppresses both buckets and totals when one has nine sessions', async () => {
    const fixture = await venue();
    for (let i = 0; i < 19; i++)
      await visit(
        fixture.id,
        fixture.dishes.slice(0, 1),
        current + (i < 10 ? 13 : 25) * 3600000 + i * 60000,
        [10],
      );
    const result = OwnerDishReportSchema.parse(
      await readOwnerReport(
        runtime,
        actor,
        fixture.id,
        new Date('2035-02-03T12:00:00Z'),
        'synthetic',
        { trafficClass: 'test', includeSummary: true },
      ),
    );
    expect(result.summary?.current.dish_opens).toEqual({ value: null, status: 'SUPPRESSED' });
    expect(result.summary?.daily_opens?.current).toEqual([
      {
        start_time: '2035-02-02T12:00:00.000Z',
        end_time: '2035-02-03T00:00:00.000Z',
        opens: { value: null, status: 'SUPPRESSED' },
      },
      {
        start_time: '2035-02-03T00:00:00.000Z',
        end_time: '2035-02-03T12:00:00.000Z',
        opens: { value: null, status: 'SUPPRESSED' },
      },
    ]);
  });
});
