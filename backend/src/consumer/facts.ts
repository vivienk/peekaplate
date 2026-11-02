import {
  canonicalJson,
  ObservationQueueMessageSchema,
  sha256,
  toCanonicalObservation,
} from '@peekaplate/contracts';
import type { Client } from 'pg';
import type { CanonicalObservationRecord } from './types';

// Runs only inside the repository's tenant-scoped identity transaction.
export async function insertObservationFacts(client: Client, record: CanonicalObservationRecord) {
  if (!record.factEnvelope) return;
  const envelope = ObservationQueueMessageSchema.parse(record.factEnvelope);
  const event = toCanonicalObservation(envelope);
  if (
    envelope.tenantId !== record.tenantId ||
    envelope.eventId !== record.eventId ||
    (await sha256(canonicalJson(event))) !== record.checksum
  ) {
    throw new Error('Fact identity does not match the canonical observation');
  }
  const matching = await client.query(
    `SELECT 1 FROM app_private.observation_index
     WHERE tenant_id=$1 AND event_id=$2 AND canonical_payload_checksum=$3
       AND event_type=$4 AND authorized_publication_id=$5 AND occurred_at=$6::timestamptz
       AND first_received_at=$7::timestamptz AND r2_archive_key=$8 AND disposition='accepted'`,
    [
      record.tenantId,
      event.event_id,
      record.checksum,
      event.type,
      event.publication_revision_id,
      event.occurred_at,
      envelope.firstReceivedAt,
      record.r2ArchiveKey,
    ],
  );
  if (matching.rowCount !== 1) throw new Error('Archive does not match the accepted index');
  const inserted = await client.query(
    `INSERT INTO app_private.observation_event
     (tenant_id,event_id,event_type,session_id,producer_id,local_sequence,publication_revision_id,traffic_class)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id,event_id) DO NOTHING RETURNING 1`,
    [
      record.tenantId,
      event.event_id,
      event.type,
      event.session_id,
      event.producer_id,
      event.local_sequence,
      event.publication_revision_id,
      envelope.traffic_class,
    ],
  );
  if (inserted.rowCount === 0) return;
  let table: string;
  let fields: Record<string, unknown>;
  switch (event.type) {
    case 'menu_viewed':
      table = 'menu_view';
      fields = event.payload;
      break;
    case 'dish_viewed':
      table = 'exposure';
      fields = event.payload;
      break;
    case 'dish_detail_opened':
      table = 'opening';
      fields = event.payload;
      break;
    case 'dish_activity_checkpoint':
      table = 'activity';
      fields = event.payload;
      break;
    case 'dish_detail_closed':
      table = 'closing';
      fields = event.payload;
      break;
    case 'dish_compared':
      table = 'comparison';
      fields = event.payload;
      break;
    case 'dish_saved': {
      const { save_surface, ...payload } = event.payload;
      table = 'save';
      fields = { ...payload, surface: save_surface };
      break;
    }
    case 'dish_unsaved': {
      const { unsave_surface, ...payload } = event.payload;
      table = 'save';
      fields = { ...payload, surface: unsave_surface };
      break;
    }
    case 'shortlist_viewed':
      table = 'shortlist_view';
      fields = event.payload;
      break;
  }
  // Table and column names come only from the strict shared schema above, never arbitrary JSON.
  const columns = ['tenant_id', 'event_id', 'event_type', ...Object.keys(fields)];
  await client.query(
    `INSERT INTO app_private.observation_${table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`,
    [record.tenantId, event.event_id, event.type, ...Object.values(fields)],
  );
}
