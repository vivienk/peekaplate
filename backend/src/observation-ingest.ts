import {
  canonicalJson,
  classifyObservationTimeWindow,
  IsoDateTimeSchema,
  type ObservationQueueEnvelope,
  type ObservationReceipt,
  type ObservationReceiptBatch,
  ObservationReceiptBatchSchema,
  type ObservationV2,
  ObservationV2Schema,
  sha256,
} from '@peekaplate/contracts';
import type { MenuAuthority } from './menu-token';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_TYPES = new Set([
  'menu_viewed',
  'dish_viewed',
  'dish_detail_opened',
  'dish_detail_closed',
  'dish_activity_checkpoint',
  'dish_compared',
  'dish_saved',
  'dish_unsaved',
  'shortlist_viewed',
]);

export type ObservationIngestServices = {
  enqueue(message: ObservationQueueEnvelope): Promise<void>;
  now?: (() => Date) | undefined;
};

export type ObservationIngestResult =
  | { queueUnavailable: true }
  | { queueUnavailable: false; response: ObservationReceiptBatch };

type Candidate = {
  index: number;
  event: ObservationV2;
  canonical: string;
};

type ConflictEvidence =
  | { validation: 'valid'; event: ObservationV2 }
  | {
      validation: 'invalid';
      metadata: {
        schemaVersionStatus: 'observation.v2' | 'other' | 'missing';
        eventType: ObservationV2['type'] | 'unknown' | 'missing';
        occurredAt: string | null;
        publicationStatus: 'matches_authority' | 'mismatch' | 'invalid' | 'missing';
        payloadObject: boolean;
      };
    };

export async function ingestObservations(
  rawEvents: readonly unknown[],
  authority: MenuAuthority,
  services: ObservationIngestServices,
): Promise<ObservationIngestResult> {
  const now = (services.now ?? (() => new Date()))();
  const firstReceivedAt = now.toISOString();
  const receipts: (ObservationReceipt | undefined)[] = new Array(rawEvents.length);
  const candidates: Candidate[] = [];
  const quarantinedIndexes = new Set<number>();
  const rawGroups = new Map<
    string,
    { index: number; canonical: string; evidence: ConflictEvidence }[]
  >();

  for (const [index, raw] of rawEvents.entries()) {
    const eventId = rawEventId(raw);
    if (!eventId) continue;
    const { canonical, evidence } = conflictEvidence(raw, authority);
    const group = rawGroups.get(eventId) ?? [];
    group.push({ index, canonical, evidence });
    rawGroups.set(eventId, group);
  }

  for (const [eventId, group] of rawGroups) {
    if (new Set(group.map(({ canonical }) => canonical)).size <= 1) continue;
    try {
      await services.enqueue({
        kind: 'observation_conflict.v1',
        tenantId: authority.venueId,
        eventId,
        authorizedPublicationId: authority.publicationId,
        firstReceivedAt,
        reasonCode: 'event_id_conflict',
        copies: await Promise.all(
          group.map(async ({ canonical, evidence }) => ({
            ...evidence,
            canonicalChecksum: await sha256(canonical),
          })),
        ),
      });
    } catch {
      return { queueUnavailable: true };
    }
    for (const { index } of group) {
      quarantinedIndexes.add(index);
      receipts[index] = rejected(eventId, 'event_id_conflict');
    }
  }

  for (const [index, raw] of rawEvents.entries()) {
    if (quarantinedIndexes.has(index)) continue;
    const eventId = rawEventId(raw);
    const rawType = rawEventType(raw);
    if (rawType && !ALLOWED_TYPES.has(rawType)) {
      receipts[index] = rejected(eventId, 'unknown_type');
      continue;
    }
    const parsed = ObservationV2Schema.safeParse(raw);
    if (!parsed.success) {
      receipts[index] = rejected(eventId, 'schema_invalid');
      continue;
    }
    const event = parsed.data;
    if (event.publication_revision_id !== authority.publicationId) {
      receipts[index] = rejected(event.event_id, 'publication_not_allowed');
      continue;
    }
    const timeClassification = classifyObservationTimeWindow(event.occurred_at, firstReceivedAt);
    if (timeClassification.disposition === 'rejected') {
      receipts[index] = rejected(event.event_id, timeClassification.reasonCode!);
      continue;
    }
    candidates.push({ index, event, canonical: canonicalJson(event) });
  }

  const byEventId = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = byEventId.get(candidate.event.event_id) ?? [];
    group.push(candidate);
    byEventId.set(candidate.event.event_id, group);
  }

  const queueCandidates: Candidate[] = [];
  const duplicateIndexes = new Map<number, number[]>();
  for (const group of byEventId.values()) {
    const payloads = new Set(group.map(({ canonical }) => canonical));
    if (payloads.size > 1) {
      for (const candidate of group) {
        receipts[candidate.index] = rejected(candidate.event.event_id, 'event_id_conflict');
      }
      continue;
    }
    const [first, ...duplicates] = group;
    if (!first) continue;
    queueCandidates.push(first);
    duplicateIndexes.set(
      first.index,
      duplicates.map(({ index }) => index),
    );
  }

  let acceptedCount = 0;
  let queueFailureCount = 0;
  for (const candidate of queueCandidates) {
    let receipt: ObservationReceipt;
    try {
      await services.enqueue(toQueueMessage(candidate.event, authority, firstReceivedAt));
      acceptedCount += 1;
      receipt = {
        event_id: candidate.event.event_id,
        status: 'accepted',
        reason_code: null,
        retryable: false,
      };
    } catch {
      queueFailureCount += 1;
      receipt = {
        event_id: candidate.event.event_id,
        status: 'retry',
        reason_code: null,
        retryable: true,
      };
    }
    receipts[candidate.index] = receipt;
    for (const duplicateIndex of duplicateIndexes.get(candidate.index) ?? []) {
      receipts[duplicateIndex] = { ...receipt, reason_code: 'duplicate_in_batch' };
    }
  }

  if (queueCandidates.length > 0 && acceptedCount === 0 && queueFailureCount > 0) {
    return { queueUnavailable: true };
  }

  const response = ObservationReceiptBatchSchema.parse({
    contract: 'observation-receipt.v1',
    request_id: crypto.randomUUID(),
    receipts,
  });
  return { queueUnavailable: false, response };
}

function toQueueMessage(
  event: ObservationV2,
  authority: MenuAuthority,
  firstReceivedAt: string,
): ObservationQueueEnvelope {
  return {
    kind: 'observation.v2',
    tenantId: authority.venueId,
    eventId: event.event_id,
    sessionId: event.session_id,
    schemaVersion: 'observation.v2',
    occurredAt: event.occurred_at,
    type: event.type,
    authorizedPublicationId: authority.publicationId,
    producerId: event.producer_id,
    localSequence: event.local_sequence,
    traffic_class: authority.trafficClass ?? authority.traffic_class ?? 'live',
    payload: event.payload,
    firstReceivedAt,
  };
}

function conflictEvidence(
  raw: unknown,
  authority: MenuAuthority,
): { canonical: string; evidence: ConflictEvidence } {
  const parsed = ObservationV2Schema.safeParse(raw);
  if (
    parsed.success &&
    parsed.data.publication_revision_id.toLowerCase() === authority.publicationId
  ) {
    return {
      canonical: canonicalJson(parsed.data),
      evidence: { validation: 'valid', event: parsed.data },
    };
  }

  const record = parsed.success
    ? (parsed.data as unknown as Record<string, unknown>)
    : raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const schemaVersionStatus =
    record.schema_version === 'observation.v2'
      ? 'observation.v2'
      : record.schema_version === undefined
        ? 'missing'
        : 'other';
  const rawType = parsed.success ? parsed.data.type : rawEventType(raw);
  const eventType: ObservationV2['type'] | 'unknown' | 'missing' =
    rawType === null
      ? 'missing'
      : ALLOWED_TYPES.has(rawType)
        ? (rawType as ObservationV2['type'])
        : 'unknown';
  const rawOccurredAt = record.occurred_at;
  const occurredAt =
    typeof rawOccurredAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      rawOccurredAt,
    ) &&
    IsoDateTimeSchema.safeParse(rawOccurredAt).success &&
    Number.isFinite(Date.parse(rawOccurredAt))
      ? rawOccurredAt
      : null;
  const rawPublication = record.publication_revision_id;
  const publicationStatus =
    rawPublication === undefined
      ? 'missing'
      : typeof rawPublication !== 'string' || !UUID_PATTERN.test(rawPublication)
        ? 'invalid'
        : (rawPublication as string).toLowerCase() === authority.publicationId
          ? 'matches_authority'
          : 'mismatch';
  const metadata: Extract<ConflictEvidence, { validation: 'invalid' }>['metadata'] = {
    schemaVersionStatus,
    eventType,
    occurredAt,
    publicationStatus,
    payloadObject:
      record.payload !== null &&
      typeof record.payload === 'object' &&
      !Array.isArray(record.payload),
  };
  return {
    canonical: parsed.success ? canonicalJson(parsed.data) : canonicalJson(raw),
    evidence: { validation: 'invalid', metadata },
  };
}

function rawEventId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = (raw as Record<string, unknown>).event_id;
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function rawEventType(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = (raw as Record<string, unknown>).type;
  return typeof value === 'string' ? value : null;
}

function rejected(
  eventId: string | null,
  reasonCode: Extract<
    NonNullable<ObservationReceipt['reason_code']>,
    | 'schema_invalid'
    | 'unknown_type'
    | 'too_old'
    | 'future_time'
    | 'publication_not_allowed'
    | 'event_id_conflict'
  >,
): ObservationReceipt {
  return {
    event_id: eventId,
    status: 'rejected',
    reason_code: reasonCode,
    retryable: false,
  };
}
