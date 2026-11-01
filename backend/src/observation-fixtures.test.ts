import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { ObservationV2Schema } from '@peekaplate/contracts';
import { expect, it, vi } from 'vitest';
import { ingestObservations } from './observation-ingest';

const fixtures = JSON.parse(
  readFileSync(
    new URL('../../packages/contracts/fixtures/observation.v2/fixtures.json', import.meta.url),
    'utf8',
  ),
) as {
  valid_events: unknown[];
  invalid_events: { name: string; event: unknown }[];
  delivery_cases: {
    name: string;
    requests: { events: unknown[] }[];
    expected_statuses: string[][];
  }[];
};
it('validates all nine shared P0 examples and negative counterparts', () => {
  expect(fixtures.valid_events).toHaveLength(9);
  expect(
    new Set(fixtures.valid_events.map((event) => ObservationV2Schema.parse(event).type)).size,
  ).toBe(9);
  for (const fixture of fixtures.invalid_events)
    expect(ObservationV2Schema.safeParse(fixture.event).success, fixture.name).toBe(false);
});
for (const scenario of fixtures.delivery_cases) {
  it(`shared delivery fixture: ${scenario.name}`, async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    if (scenario.name === 'identical_retry') {
      expect(scenario.requests[1]).toEqual(scenario.requests[0]);
    }
    for (const [index, request] of scenario.requests.entries()) {
      const expected = scenario.expected_statuses[index];
      if (!expected) throw new Error('Missing expected receipt statuses');
      enqueue.mockClear();
      const result = await ingestObservations(
        request.events,
        {
          venueId: '00000000-0000-4000-8000-000000000001',
          publicationId: '40000000-0000-4000-8000-000000000001',
          jti: '00000000-0000-4000-8000-000000000003',
        },
        { enqueue, now: () => new Date('2026-10-24T16:00:00.000Z') },
      );
      expect(result.queueUnavailable).toBe(false);
      if (result.queueUnavailable) throw new Error('Unexpected Queue failure');
      expect(result.response.receipts.map((receipt) => receipt.status)).toEqual(
        scenario.expected_statuses[index],
      );
      expect(enqueue).toHaveBeenCalledTimes(
        expected.filter((status) => status === 'accepted').length,
      );
      for (const [eventIndex, receipt] of result.response.receipts.entries()) {
        const event = request.events[eventIndex] as { event_id: string };
        expect(receipt).toEqual({
          event_id: event.event_id,
          status: expected[eventIndex],
          reason_code: receipt.status === 'rejected' ? 'schema_invalid' : null,
          retryable: false,
        });
      }
      for (const [message] of enqueue.mock.calls) {
        const original = request.events.find(
          (event) => (event as { event_id: string }).event_id === message.eventId,
        );
        const event = ObservationV2Schema.parse(original);
        expect(message).toMatchObject({
          eventId: event.event_id,
          producerId: event.producer_id,
          localSequence: event.local_sequence,
          traffic_class: 'live',
          payload: event.payload,
        });
      }
    }
  });
}
