import { isAllowedEvent, type P0EventName } from '@peekaplate/analytics/event-names';
import { describe, expect, it } from 'vitest';
import fixtures from '../../../../packages/contracts/fixtures/observation.v2/fixtures.json';
import { buildEnvelope } from './envelope';
import type { Identity } from './identity';
import { isValidObservation } from './validate';

// The shared synthetic fixtures (packages/contracts/fixtures/observation.v2): one valid and one
// invalid example per event type. Only the 8 P0 types reach validation; the allowlist drops the rest.
type Fixture = {
  type: string;
  publication_revision_id: string;
  payload: Record<string, unknown>;
};
const valid = fixtures.valid_events as Fixture[];
const invalid = fixtures.invalid_events as { name: string; event: Fixture }[];

const p0 = <T extends { type: string }>(items: T[]) =>
  items.filter((item) => isAllowedEvent(item.type));

describe('strict observation.v2 validation', () => {
  it('accepts every valid shared fixture for the P0 events', () => {
    expect(p0(valid)).toHaveLength(8);
    for (const event of p0(valid)) {
      expect(
        isValidObservation(event.type as P0EventName, event.publication_revision_id, event.payload),
        event.type,
      ).toBe(true);
    }
  });

  it('rejects every invalid shared fixture for the P0 events', () => {
    const cases = p0(invalid.map(({ name, event }) => ({ name, ...event })));
    expect(cases).toHaveLength(8);
    for (const event of cases) {
      expect(
        isValidObservation(event.type as P0EventName, event.publication_revision_id, event.payload),
        event.name,
      ).toBe(false);
    }
  });

  it('rejects unknown payload fields and a publication that is not a UUID', () => {
    const menuViewed = { entry_source: 'qr' };
    const publication = 'a5000000-0000-4000-8000-000000000001';
    expect(isValidObservation('menu_viewed', publication, menuViewed)).toBe(true);
    expect(isValidObservation('menu_viewed', publication, { ...menuViewed, table: '12' })).toBe(
      false,
    );
    expect(isValidObservation('menu_viewed', 'not-a-uuid', menuViewed)).toBe(false);
  });

  it('is the default check in buildEnvelope, and a rejected event uses no sequence number', () => {
    let sequence = 0;
    const identity: Identity = {
      next: () => {
        sequence += 1;
        return {
          sessionId: 'a0000000-0000-4000-8000-000000000001',
          producerId: 'b0000000-0000-4000-8000-000000000001',
          localSequence: sequence,
        };
      },
    } as Identity;
    const ctx = { identity, now: () => Date.UTC(2026, 10, 2), uuid: () => crypto.randomUUID() };
    const publication_revision_id = 'a5000000-0000-4000-8000-000000000001';

    expect(
      buildEnvelope('menu_viewed', { publication_revision_id, entry_source: 'table_qr' }, ctx),
    ).toBeNull();
    expect(sequence).toBe(0);
    const envelope = buildEnvelope(
      'menu_viewed',
      { publication_revision_id, entry_source: 'qr' },
      ctx,
    );
    expect(envelope?.local_sequence).toBe(1);
  });
});
