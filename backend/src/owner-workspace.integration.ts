import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listOwnerVenues } from './owner-workspace';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;

describe.skipIf(!runtimeUrl || !adminUrl)('Owner workspace runtime RLS', () => {
  const admin = new Client({ connectionString: adminUrl });
  const runtime = new Client({ connectionString: runtimeUrl });
  const owner = crypto.randomUUID();
  const editor = crypto.randomUUID();
  const viewer = crypto.randomUUID();
  const stranger = crypto.randomUUID();
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const privateVenue = crypto.randomUUID();
  beforeAll(async () => {
    await admin.connect();
    await runtime.connect();
    await admin.query(
      `INSERT INTO app_private.venues(id,name) VALUES($1,'Synthetic first'),($2,'Synthetic second'),($3,'Other private restaurant')`,
      [first, second, privateVenue],
    );
    await admin.query(
      `INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES($1,$4,'owner'),($2,$4,'editor'),($1,$5,'editor'),($1,$6,'viewer'),($3,$7,'owner')`,
      [first, second, privateVenue, owner, editor, viewer, stranger],
    );
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it('reads only the verified actor memberships under the restricted runtime role', async () => {
    const venues = await listOwnerVenues(runtime, owner);
    expect(venues).toHaveLength(2);
    expect(venues).toEqual(
      expect.arrayContaining([
        { venueId: first, name: 'Synthetic first', permission: 'owner' },
        { venueId: second, name: 'Synthetic second', permission: 'editor' },
      ]),
    );
    expect(venues.some((venue) => venue.venueId === privateVenue)).toBe(false);
    expect(await listOwnerVenues(runtime, viewer)).toEqual([]);
    expect(await listOwnerVenues(runtime, crypto.randomUUID())).toEqual([]);
    expect(await listOwnerVenues(runtime, editor)).toEqual([
      { venueId: first, name: 'Synthetic first', permission: 'editor' },
    ]);
  });
  it('does not leak actor or tenant settings across reused connections or failures', async () => {
    await listOwnerVenues(runtime, owner);
    const settings = await runtime.query(
      `SELECT current_setting('app.actor_id',true) AS actor, current_setting('app.tenant_id',true) AS tenant`,
    );
    expect(settings.rows[0]).toEqual({ actor: '', tenant: '' });
    await expect(listOwnerVenues(runtime, 'invalid-actor')).rejects.toBeDefined();
    expect(await listOwnerVenues(runtime, stranger)).toEqual([
      { venueId: privateVenue, name: 'Other private restaurant', permission: 'owner' },
    ]);
  });
  it('reflects current revocation rather than trusting an earlier membership response', async () => {
    await admin.query('DELETE FROM app_private.staff_membership WHERE actor_id=$1', [editor]);
    expect(await listOwnerVenues(runtime, editor)).toEqual([]);
  });
});
