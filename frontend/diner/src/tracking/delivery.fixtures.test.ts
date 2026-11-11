// TRK-01.3 delivery against the shared observation.v2 contract fixtures (S3-TRK-01.3 definition of
// done). Each delivery_cases request is sent through deliver() exactly as queued; the fake endpoint
// answers with the statuses the fixture expects, as receipts that must pass the shared
// ObservationReceiptBatchSchema. The backend proves those statuses against real ingestion in
// backend/src/observation-fixtures.test.ts; this file proves the diner sends the fixture bodies
// unchanged and reads those receipts correctly. Local, synthetic evidence only: not hosted
// acceptance (see the fixtures README).
import { readFileSync } from 'node:fs';
import { ObservationReceiptBatchSchema } from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import { deliver, type MenuToken, type QueuedEnvelope } from './delivery';

type Status = 'accepted' | 'retry' | 'rejected';
type DeliveryCase = {
  name: string;
  requests: { contract: string; events: QueuedEnvelope[] }[];
  expected_statuses: Status[][];
};

const fixtures = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/contracts/fixtures/observation.v2/fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { delivery_cases: DeliveryCase[] };

// Frozen fixture clock and test-only authorization for the fixture publication (fixtures README).
const NOW = Date.parse('2026-10-24T16:00:00.000Z');
const ENDPOINT = 'https://api.example.test/observations';
const TOKEN: MenuToken = {
  value: 'fixture-test-token',
  expiresAt: NOW + 30 * 60 * 1000,
  publicationRevisionId: '40000000-0000-4000-8000-000000000001',
};

const reasonFor = (status: Status) => (status === 'rejected' ? 'schema_invalid' : null);

// One fake ingestion endpoint per request: records what was sent and answers with the expected
// statuses as observation-receipt.v1, checked against the shared schema before it is returned.
function endpointAnswering(statuses: Status[]) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    const body = JSON.parse(String(init?.body)) as { events: { event_id: string }[] };
    const answer = ObservationReceiptBatchSchema.parse({
      contract: 'observation-receipt.v1',
      request_id: 'a0000000-0000-4000-8000-000000000001',
      receipts: body.events.map(({ event_id }, i) => {
        const status = statuses[i] as Status;
        return { event_id, status, reason_code: reasonFor(status), retryable: status === 'retry' };
      }),
    });
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

describe('delivery against the shared observation.v2 fixtures', () => {
  it('covers the agreed delivery cases', () => {
    expect(fixtures.delivery_cases.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'first_delivery',
        'identical_retry',
        'cross_request_conflict_deferred_to_consumer',
        'mixed_batch',
        'integer_schema_version',
      ]),
    );
  });

  for (const scenario of fixtures.delivery_cases) {
    it(`fixture: ${scenario.name}`, async () => {
      for (const [index, request] of scenario.requests.entries()) {
        const statuses = scenario.expected_statuses[index] as Status[];
        const server = endpointAnswering(statuses);
        const result = await deliver(request.events, {
          endpoint: ENDPOINT,
          fetch: server.fetch,
          now: () => NOW,
          token: () => TOKEN,
        });

        // Exactly one POST, the fixture request body byte for byte, the token in the header only.
        expect(server.sent).toHaveLength(1);
        const [call] = server.sent;
        expect(call?.url).toBe(ENDPOINT);
        expect(call?.init.method).toBe('POST');
        expect(JSON.parse(String(call?.init.body))).toEqual(request);
        expect(new Headers(call?.init.headers).get('Authorization')).toBe(`Bearer ${TOKEN.value}`);
        expect(String(call?.init.body)).not.toContain(TOKEN.value);

        // Per-event outcome from the receipts: accepted and rejected leave the outbox.
        const ids = request.events.map((e) => e.event_id);
        expect(result.done).toEqual(ids.filter((_, i) => statuses[i] !== 'retry'));
        expect(result.retry).toEqual(ids.filter((_, i) => statuses[i] === 'retry'));
        expect(result.counts.accepted).toBe(statuses.filter((s) => s === 'accepted').length);
        expect(result.counts.rejected).toBe(statuses.filter((s) => s === 'rejected').length);
        expect(result.requests).toBe(1);
      }
    });
  }

  it('resends an identical retry with the same event_id and payload', () => {
    const retry = fixtures.delivery_cases.find((c) => c.name === 'identical_retry');
    expect(retry?.requests[1]).toEqual(retry?.requests[0]);
  });

  it('leaves a changed payload under the same event_id to the consumer, never relabelling it', () => {
    const conflict = fixtures.delivery_cases.find(
      (c) => c.name === 'cross_request_conflict_deferred_to_consumer',
    );
    const [first, second] = conflict?.requests ?? [];
    expect(first?.events[0]?.event_id).toBe(second?.events[0]?.event_id);
    expect(first?.events[0]?.payload).not.toEqual(second?.events[0]?.payload);
  });
});
