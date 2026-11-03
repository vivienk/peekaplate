// Strict observation.v2 validation (S3-TRK-01 follow-up, agreed with Jeffin): every event is
// checked against the shared ObservationV2Schema from @peekaplate/contracts, the same schema the
// ingestion endpoint uses, so the diner never queues an event the server would reject as invalid.
// It runs before a sequence number is assigned, so a rejected event never uses one.
import { ObservationV2Schema } from '@peekaplate/contracts';
import type { P0EventName } from './event-names';

// Placeholders for the fields the layer fills in after validation. They are valid by construction,
// so only the caller's type, publication and payload can make the check fail.
const PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000';
const PLACEHOLDER_TIME = '2000-01-01T00:00:00.000Z';

export function isValidObservation(
  type: P0EventName,
  publicationRevisionId: string,
  payload: Record<string, unknown>,
): boolean {
  return ObservationV2Schema.safeParse({
    schema_version: 'observation.v2',
    event_id: PLACEHOLDER_UUID,
    type,
    session_id: PLACEHOLDER_UUID,
    producer_id: PLACEHOLDER_UUID,
    local_sequence: 1,
    occurred_at: PLACEHOLDER_TIME,
    publication_revision_id: publicationRevisionId,
    payload,
  }).success;
}
