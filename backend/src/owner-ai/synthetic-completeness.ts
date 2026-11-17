import { createHash } from 'node:crypto';
import { canonicalJson } from '@peekaplate/contracts';
import type { Client } from 'pg';
import { z } from 'zod';
import { buildRawArchiveKey } from '../consumer/types';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const sealSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('sealed_scripted_scenario'),
  venue_id: z.uuid(),
  publication_revision_id: z.uuid(),
  manifest_sha256: digest,
  event_count: z.number().int().min(1).max(1000),
  index_sha256: digest,
  facts_sha256: digest,
  producer_closed_at: instant,
  sealed_at: instant,
  expires_at: instant,
  archive_proof: z.strictObject({
    kind: z.literal('operator_verified_create_only_r2'),
    verified_at: instant,
    reconciliation_sha256: digest,
    index_sha256: digest,
    facts_sha256: digest,
  }),
});

type EvidenceRow = {
  index: Record<string, unknown>;
  event: Record<string, unknown> | null;
  details: Record<string, Record<string, unknown>>;
};

/** Same canonical encoding is used by the private operator reconciliation artifact. */
export function syntheticEvidenceDigests(rows: EvidenceRow[]) {
  const ordered = [...rows].sort((a, b) =>
    String(a.index.event_id).localeCompare(String(b.index.event_id)),
  );
  const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
  return {
    index_sha256: hash(ordered.map((row) => row.index)),
    facts_sha256: hash(ordered.map(({ event, details }) => ({ event, details }))),
  };
}

const detailFamily: Record<string, string> = {
  menu_viewed: 'menu_view',
  dish_viewed: 'exposure',
  dish_detail_opened: 'opening',
  dish_activity_checkpoint: 'activity',
  dish_detail_closed: 'closing',
  dish_compared: 'comparison',
  dish_saved: 'save',
  dish_unsaved: 'save',
  shortlist_viewed: 'shortlist_view',
};

// Deliberately includes rejected/unprojected/unclassified index rows: an extra row cannot
// disappear merely because the report view omits it. Never use this index to calculate metrics.
export const SYNTHETIC_EVIDENCE_QUERY = `
SELECT to_jsonb(i) AS index, to_jsonb(e) AS event,
  jsonb_strip_nulls(jsonb_build_object(
    'menu_view',to_jsonb(m), 'exposure',to_jsonb(x), 'opening',to_jsonb(o),
    'activity',to_jsonb(a), 'closing',to_jsonb(c), 'comparison',to_jsonb(p),
    'save',to_jsonb(s), 'shortlist_view',to_jsonb(v))) AS details
FROM app_private.observation_index i
LEFT JOIN app_private.observation_event e USING (tenant_id,event_id)
LEFT JOIN app_private.observation_menu_view m USING (tenant_id,event_id)
LEFT JOIN app_private.observation_exposure x USING (tenant_id,event_id)
LEFT JOIN app_private.observation_opening o USING (tenant_id,event_id)
LEFT JOIN app_private.observation_activity a USING (tenant_id,event_id)
LEFT JOIN app_private.observation_closing c USING (tenant_id,event_id)
LEFT JOIN app_private.observation_comparison p USING (tenant_id,event_id)
LEFT JOIN app_private.observation_save s USING (tenant_id,event_id)
LEFT JOIN app_private.observation_shortlist_view v USING (tenant_id,event_id)
WHERE i.tenant_id=$1 AND i.occurred_at >= $2 AND i.occurred_at < $3
ORDER BY i.event_id LIMIT 1001`;

/** Caller already checked owner membership and set tenant scope in a repeatable-read transaction.
 * The protected operator seal attests real archive reconciliation, not live pipeline freshness.
 * No trusted seal / any mismatch leaves freshness unknown. No writes or network calls.
 */
export async function verifySyntheticCompleteness(
  client: Client,
  options: {
    seal?: string;
    venueId: string;
    anchor: Date;
    validationNow: Date;
  },
): Promise<boolean> {
  if (!options.seal || options.seal.length > 4096) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(options.seal);
  } catch {
    return false;
  }
  const parsed = sealSchema.safeParse(raw);
  if (!parsed.success) return false;
  const seal = parsed.data;
  const anchor = options.anchor.getTime();
  const wallClock = options.validationNow.getTime();
  const closed = Date.parse(seal.producer_closed_at);
  const verified = Date.parse(seal.archive_proof.verified_at);
  const sealed = Date.parse(seal.sealed_at);
  const expires = Date.parse(seal.expires_at);
  if (
    seal.venue_id !== options.venueId ||
    !Number.isFinite(anchor) ||
    !Number.isFinite(wallClock) ||
    closed > verified ||
    verified > sealed ||
    sealed > anchor ||
    anchor > wallClock ||
    wallClock - anchor > 60_000 ||
    wallClock >= expires ||
    expires <= sealed ||
    expires - sealed > 15 * 60_000 ||
    seal.archive_proof.index_sha256 !== seal.index_sha256 ||
    seal.archive_proof.facts_sha256 !== seal.facts_sha256
  )
    return false;

  // Conservatively refuse any unresolved conflict for this dedicated scenario tenant.
  const conflicts = await client.query(
    'SELECT 1 FROM app_private.observation_conflict WHERE tenant_id=$1 LIMIT 1',
    [options.venueId],
  );
  if (conflicts.rows.length) return false;
  const start = anchor - 24 * 60 * 60_000;
  const result = await client.query<EvidenceRow>(SYNTHETIC_EVIDENCE_QUERY, [
    options.venueId,
    new Date(start),
    options.anchor,
  ]);
  if (result.rows.length !== seal.event_count) return false;
  for (const { index, event, details } of result.rows) {
    const occurred = Date.parse(String(index.occurred_at));
    const received = Date.parse(String(index.first_received_at));
    const family = detailFamily[String(index.event_type)];
    const detail = details[family ?? ''];
    if (
      index.tenant_id !== options.venueId ||
      index.disposition !== 'accepted' ||
      index.schema_version !== 'observation.v2' ||
      index.authorized_publication_id !== seal.publication_revision_id ||
      !z.uuid().safeParse(index.event_id).success ||
      !digest.safeParse(index.canonical_payload_checksum).success ||
      !Number.isFinite(occurred) ||
      occurred < start ||
      occurred >= anchor ||
      occurred > closed ||
      !Number.isFinite(received) ||
      received > verified ||
      index.r2_archive_key !== buildRawArchiveKey(options.venueId, String(index.event_id)) ||
      !event ||
      event.traffic_class !== 'test' ||
      event.disposition !== 'accepted' ||
      event.tenant_id !== options.venueId ||
      event.event_id !== index.event_id ||
      event.event_type !== index.event_type ||
      event.publication_revision_id !== seal.publication_revision_id ||
      Object.keys(details).length !== 1 ||
      !detail ||
      detail.tenant_id !== options.venueId ||
      detail.event_id !== index.event_id ||
      detail.event_type !== index.event_type
    )
      return false;
  }
  const actual = syntheticEvidenceDigests(result.rows);
  return actual.index_sha256 === seal.index_sha256 && actual.facts_sha256 === seal.facts_sha256;
}
