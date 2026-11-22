import type { OwnerVenue } from '@peekaplate/contracts';
import type { Client } from 'pg';
import { AuthUnavailableError } from './auth';

export async function listOwnerVenues(client: Client, actorId: string): Promise<OwnerVenue[]> {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
    await client.query("SELECT set_config('app.tenant_id', '', true)");
    const memberships = await client.query<{
      tenant_id: string;
      permission: OwnerVenue['permission'];
    }>(
      `SELECT tenant_id, permission FROM app_private.staff_membership
       WHERE actor_id=$1 AND permission IN ('owner','editor')
       ORDER BY tenant_id LIMIT 101 FOR SHARE`,
      [actorId],
    );
    if (memberships.rows.length > 100) throw new AuthUnavailableError();
    const venues: OwnerVenue[] = [];
    for (const membership of memberships.rows) {
      // Venue RLS requires tenant context even after actor-scoped membership discovery.
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [membership.tenant_id]);
      const result = await client.query<{ id: string; name: string }>(
        'SELECT id,name FROM app_private.venues WHERE id=$1',
        [membership.tenant_id],
      );
      const venue = result.rows[0];
      if (!venue) throw new AuthUnavailableError();
      venues.push({ venueId: venue.id, name: venue.name, permission: membership.permission });
    }
    await client.query('COMMIT');
    return venues;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
