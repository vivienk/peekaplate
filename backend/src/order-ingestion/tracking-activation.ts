import type { Client } from 'pg';

export interface VenueTrackingActivationRecord {
  tenantId: string;
  activatedAt: Date;
  activatedBy: string;
  source: 'menu_publication' | 'administrative';
}

/**
 * Authoritative administrative tracking activation helper.
 * Activates live diner tracking for a venue, recording an explicit server-controlled timestamp.
 * Rejects non-server timestamps, client backdating, and unauthorized staff.
 */
export async function recordVenueTrackingActivation(
  client: Client,
  actorId: string,
  venueId: string,
  source: 'menu_publication' | 'administrative' = 'administrative',
): Promise<VenueTrackingActivationRecord> {
  // Validate that actor is an authorized staff owner or editor for this venue
  const authRes = await client.query<{ permission: string }>(
    `SELECT permission FROM app_private.staff_membership
     WHERE tenant_id = $1 AND actor_id = $2`,
    [venueId, actorId],
  );
  const permission = authRes.rows[0]?.permission;
  if (!permission || (permission !== 'owner' && permission !== 'editor')) {
    throw new Error('Authorized staff owner or editor permission required to activate tracking');
  }

  await client.query(
    `INSERT INTO app_private.venue_tracking_activations
      (tenant_id, activated_at, activated_by, source)
     VALUES ($1, now(), $2, $3)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [venueId, actorId, source],
  );

  const res = await client.query<{
    tenant_id: string;
    activated_at: Date;
    activated_by: string;
    source: 'menu_publication' | 'administrative';
  }>(
    `SELECT tenant_id, activated_at, activated_by, source
     FROM app_private.venue_tracking_activations
     WHERE tenant_id = $1`,
    [venueId],
  );

  const row = res.rows[0];
  if (!row) {
    throw new Error('Failed to retrieve venue tracking activation');
  }

  return {
    tenantId: row.tenant_id,
    activatedAt: row.activated_at,
    activatedBy: row.activated_by,
    source: row.source,
  };
}

/**
 * Looks up the authoritative venue tracking activation timestamp.
 * Returns null if the venue has not activated live tracking.
 */
export async function getVenueTrackingActivation(
  client: Client,
  venueId: string,
): Promise<{ activatedAt: Date; source: string } | null> {
  const res = await client.query<{ activated_at: Date; source: string }>(
    `SELECT activated_at, source
     FROM app_private.venue_tracking_activations
     WHERE tenant_id = $1`,
    [venueId],
  );
  if (!res.rows[0]) return null;
  return {
    activatedAt: res.rows[0].activated_at,
    source: res.rows[0].source,
  };
}
