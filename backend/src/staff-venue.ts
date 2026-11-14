import type { Client } from 'pg';
import { CommandError } from './dish-command';

export async function authorizeStaffVenue(
  client: Client,
  actorId: string,
  venueId: string,
  inTransaction = false,
): Promise<void> {
  let started = false;
  try {
    if (!inTransaction) {
      await client.query('BEGIN');
      started = true;
    }
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
    const membership = await client.query<{ permission: string }>(
      `SELECT permission FROM app_private.staff_membership WHERE tenant_id=$1 AND actor_id=$2 FOR SHARE`,
      [venueId, actorId],
    );
    if (!['owner', 'editor'].includes(membership.rows[0]?.permission ?? ''))
      throw new CommandError('forbidden', 403);
    if (!inTransaction) await client.query('COMMIT');
    started = false;
  } catch (error) {
    if (started) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* Preserve the original authorization error. */
      }
    }
    throw error;
  }
}
