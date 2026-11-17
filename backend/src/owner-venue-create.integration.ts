import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOwnerVenue } from './owner-venue-create';
import { listOwnerVenues } from './owner-workspace';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;

describe.skipIf(!runtimeUrl || !adminUrl)(
  'self-service restaurant creation (restricted database role)',
  () => {
    const admin = new Client({ connectionString: adminUrl });
    const runtime = new Client({ connectionString: runtimeUrl });
    beforeAll(async () => {
      await admin.connect();
      await runtime.connect();
    });
    afterAll(async () => {
      await runtime.end();
      await admin.end();
    });
    const create = (
      actor: string,
      commandId = crypto.randomUUID(),
      name = 'Synthetic self-service cafe',
    ) => createOwnerVenue(runtime, actor, { commandId, name });

    it('atomically creates owner authority and one audit/outbox identity, then replays without side effects', async () => {
      const actor = crypto.randomUUID();
      const commandId = crypto.randomUUID();
      const first = await create(actor, commandId);
      expect(first).toMatchObject({ name: 'Synthetic self-service cafe', permission: 'owner' });
      expect(await create(actor, commandId)).toEqual(first);
      expect(await listOwnerVenues(runtime, actor)).toEqual([first]);
      const counts = await admin.query(
        `SELECT
      (SELECT count(*)::int FROM app_private.staff_membership WHERE tenant_id=$1 AND actor_id=$2) AS memberships,
      (SELECT count(*)::int FROM app_private.es_event WHERE tenant_id=$1) AS events,
      (SELECT count(*)::int FROM app_private.es_command WHERE tenant_id=$1) AS commands,
      (SELECT count(*)::int FROM app_private.outbox WHERE tenant_id=$1) AS messages`,
        [first.venueId, actor],
      );
      expect(counts.rows[0]).toEqual({ memberships: 1, events: 1, commands: 1, messages: 1 });
      expect(
        (
          await runtime.query(
            "SELECT nullif(current_setting('app.actor_id',true),'') AS actor, nullif(current_setting('app.tenant_id',true),'') AS tenant",
          )
        ).rows[0],
      ).toEqual({ actor: null, tenant: null });
    });

    it('keeps commands actor-scoped, rejects changed replay input and rejects revoked replay authority', async () => {
      const actor = crypto.randomUUID();
      const other = crypto.randomUUID();
      const command = crypto.randomUUID();
      const first = await create(actor, command);
      await expect(create(actor, command, 'Changed name')).rejects.toMatchObject({
        code: 'command_conflict',
        status: 409,
      });
      const second = await create(other, command);
      expect(second.venueId).not.toBe(first.venueId);
      expect(await listOwnerVenues(runtime, other)).toEqual([second]);
      await admin.query(
        'DELETE FROM app_private.staff_membership WHERE tenant_id=$1 AND actor_id=$2',
        [first.venueId, actor],
      );
      await expect(create(actor, command)).rejects.toMatchObject({
        code: 'forbidden',
        status: 403,
      });
    });

    it('serializes concurrent retries under two real restricted connections', async () => {
      const second = new Client({ connectionString: runtimeUrl });
      await second.connect();
      try {
        const actor = crypto.randomUUID();
        const input = { commandId: crypto.randomUUID(), name: 'Synthetic concurrent cafe' };
        const results = await Promise.all([
          createOwnerVenue(runtime, actor, input),
          createOwnerVenue(second, actor, input),
        ]);
        expect(results[0]).toEqual(results[1]);
        expect(await listOwnerVenues(runtime, actor)).toHaveLength(1);
      } finally {
        await second.end();
      }
    });

    it('bounds rolling-day creations while replay remains available at the limit', async () => {
      const actor = crypto.randomUUID();
      const command = crypto.randomUUID();
      const first = await create(actor, command);
      for (let n = 1; n < 5; n++) await create(actor);
      await expect(create(actor)).rejects.toMatchObject({ status: 429 });
      expect(await create(actor, command)).toEqual(first);
      expect(await listOwnerVenues(runtime, actor)).toHaveLength(5);
    });

    it('retains the lifetime bound after old commands fall outside the daily window', async () => {
      const actor = crypto.randomUUID();
      for (let n = 0; n < 20; n++) {
        await create(actor);
        // Only disposable admin fixtures move the clock; runtime cannot rewrite receipts.
        await admin.query(
          "UPDATE app_private.es_command SET created_at=now()-interval '2 days' WHERE actor_id=$1 AND command_type='owner.venue.create.v1'",
          [actor],
        );
      }
      await expect(create(actor)).rejects.toMatchObject({ status: 429 });
      expect(await listOwnerVenues(runtime, actor)).toHaveLength(20);
    });

    it('cannot grant direct membership/venue writes or assume the function owner role', async () => {
      expect(
        (
          await admin.query(`SELECT
      has_table_privilege('peekaplate_runtime','app_private.venues','INSERT') AS venues,
      has_table_privilege('peekaplate_runtime','app_private.staff_membership','INSERT') AS memberships,
      pg_has_role('peekaplate_runtime','peekaplate_venue_creator','MEMBER') AS creator`)
        ).rows[0],
      ).toEqual({ venues: false, memberships: false, creator: false });
      await expect(
        runtime.query("INSERT INTO app_private.venues(id,name) VALUES(gen_random_uuid(),'Forged')"),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(runtime.query('SET ROLE peekaplate_venue_creator')).rejects.toMatchObject({
        code: '42501',
      });
    });
  },
);
