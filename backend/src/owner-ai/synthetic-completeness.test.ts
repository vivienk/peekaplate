import { createHash } from 'node:crypto';
import { canonicalJson, OwnerDishReportSchema } from '@peekaplate/contracts';
import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { readOwnerReport } from '../owner-report';
import { mintOwnerReportReference, readOwnerReportReference } from './report-reference';
import { verifySyntheticCompleteness } from './synthetic-completeness';

const venue = '1ea97f31-bce5-4b8a-99f0-588afed9102e';
const publication = 'b2fdf294-1b3f-4c9d-9143-0193a265c18e';
const eventId = 'a1000000-0000-4000-8000-000000000001';
const now = new Date('2026-11-17T19:00:00.000Z');
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function fixture() {
  const rows = [
    {
      index: {
        tenant_id: venue,
        event_id: eventId,
        event_type: 'menu_viewed',
        canonical_payload_checksum: 'a'.repeat(64),
        schema_version: 'observation.v2',
        authorized_publication_id: publication,
        occurred_at: '2026-11-17T18:00:00.000Z',
        first_received_at: '2026-11-17T18:00:01.000Z',
        disposition: 'accepted',
        r2_archive_key: `raw/observations/${venue}/${eventId}.json`,
        reason_code: null,
      },
      event: {
        tenant_id: venue,
        event_id: eventId,
        event_type: 'menu_viewed',
        disposition: 'accepted',
        session_id: 'b1000000-0000-4000-8000-000000000001',
        producer_id: 'c1000000-0000-4000-8000-000000000001',
        local_sequence: 1,
        publication_revision_id: publication,
        traffic_class: 'test',
      },
      details: {
        menu_view: {
          tenant_id: venue,
          event_id: eventId,
          event_type: 'menu_viewed',
          entry_source: 'qr',
        },
      },
    },
  ];
  const indexHash = hash(rows.map((row) => row.index));
  const factsHash = hash(rows.map(({ event, details }) => ({ event, details })));
  const seal = {
    version: 1,
    kind: 'sealed_scripted_scenario',
    venue_id: venue,
    publication_revision_id: publication,
    manifest_sha256: 'b'.repeat(64),
    event_count: 1,
    index_sha256: indexHash,
    facts_sha256: factsHash,
    producer_closed_at: '2026-11-17T18:10:00.000Z',
    sealed_at: '2026-11-17T18:59:00.000Z',
    expires_at: '2026-11-17T19:10:00.000Z',
    archive_proof: {
      kind: 'operator_verified_create_only_r2',
      verified_at: '2026-11-17T18:58:00.000Z',
      reconciliation_sha256: 'c'.repeat(64),
      index_sha256: indexHash,
      facts_sha256: factsHash,
    },
  };
  const query = vi.fn(async (sql: string) =>
    sql.includes('observation_conflict')
      ? { rows: [], rowCount: 0 }
      : { rows, rowCount: rows.length },
  );
  return { rows, seal, query, client: { query } as unknown as Client };
}

describe('sealed synthetic scenario completeness', () => {
  it('accepts only the exact archived/indexed/typed test scenario', async () => {
    const { client, seal } = fixture();
    expect(
      await verifySyntheticCompleteness(client, {
        seal: JSON.stringify(seal),
        venueId: venue,
        anchor: now,
        validationNow: now,
      }),
    ).toBe(true);
  });

  const invalid: [string, (f: ReturnType<typeof fixture>) => void][] = [
    [
      'wrong tenant',
      (f) => {
        f.seal.venue_id = publication;
      },
    ],
    [
      'wrong publication',
      (f) => {
        f.rows[0]!.index.authorized_publication_id = venue;
      },
    ],
    [
      'live traffic',
      (f) => {
        f.rows[0]!.event.traffic_class = 'live';
      },
    ],
    [
      'missing event',
      (f) => {
        f.rows.pop();
      },
    ],
    [
      'extra event / late arrival',
      (f) => {
        f.rows.push(structuredClone(f.rows[0]!));
      },
    ],
    [
      'missing projection',
      (f) => {
        f.rows[0]!.details = {} as (typeof f.rows)[0]['details'];
      },
    ],
    [
      'index checksum mismatch',
      (f) => {
        f.rows[0]!.index.canonical_payload_checksum = 'd'.repeat(64);
      },
    ],
    [
      'typed payload mismatch',
      (f) => {
        f.rows[0]!.details.menu_view.entry_source = 'direct_link';
      },
    ],
    [
      'foreign typed identity',
      (f) => {
        f.rows[0]!.event.tenant_id = publication;
      },
    ],
    [
      'wrong archive path',
      (f) => {
        f.rows[0]!.index.r2_archive_key = 'another/key';
      },
    ],
    [
      'proof does not bind index',
      (f) => {
        f.seal.archive_proof.index_sha256 = 'd'.repeat(64);
      },
    ],
    [
      'proof does not bind facts',
      (f) => {
        f.seal.archive_proof.facts_sha256 = 'd'.repeat(64);
      },
    ],
    [
      'proof absent',
      (f) => {
        delete (f.seal as Partial<typeof f.seal>).archive_proof;
      },
    ],
    [
      'expired seal',
      (f) => {
        f.seal.expires_at = now.toISOString();
      },
    ],
    [
      'overlong seal',
      (f) => {
        f.seal.expires_at = '2026-11-17T20:00:00.000Z';
      },
    ],
    [
      'producer not closed before archive proof',
      (f) => {
        f.seal.producer_closed_at = now.toISOString();
      },
    ],
    [
      'receipt newer than archive proof',
      (f) => {
        f.rows[0]!.index.first_received_at = now.toISOString();
      },
    ],
    [
      'event outside rolling window',
      (f) => {
        f.rows[0]!.index.occurred_at = '2026-11-16T18:59:59.000Z';
      },
    ],
    [
      'unknown seal field',
      (f) => {
        Object.assign(f.seal, { approved: true });
      },
    ],
  ];
  it.each(invalid)('keeps freshness unknown: %s', async (_, mutate) => {
    const f = fixture();
    mutate(f);
    expect(
      await verifySyntheticCompleteness(f.client, {
        seal: JSON.stringify(f.seal),
        venueId: venue,
        anchor: now,
        validationNow: now,
      }),
    ).toBe(false);
  });

  it('rejects unresolved conflicts before reading facts', async () => {
    const f = fixture();
    f.query.mockResolvedValueOnce({ rows: [{}] as typeof f.rows, rowCount: 1 });
    expect(
      await verifySyntheticCompleteness(f.client, {
        seal: JSON.stringify(f.seal),
        venueId: venue,
        anchor: now,
        validationNow: now,
      }),
    ).toBe(false);
    expect(f.query).toHaveBeenCalledTimes(1);
  });

  it('uses actual wall clock for expiry, never the signed report anchor', async () => {
    const f = fixture();
    f.seal.expires_at = new Date(now.getTime() + 30_000).toISOString();
    expect(
      await verifySyntheticCompleteness(f.client, {
        seal: JSON.stringify(f.seal),
        venueId: venue,
        anchor: now,
        validationNow: new Date(f.seal.expires_at),
      }),
    ).toBe(false);
    expect(f.query).not.toHaveBeenCalled();
  });

  it('rejects a report anchor in the future of the actual validation clock', async () => {
    const f = fixture();
    expect(
      await verifySyntheticCompleteness(f.client, {
        seal: JSON.stringify(f.seal),
        venueId: venue,
        anchor: now,
        validationNow: new Date(now.getTime() - 1),
      }),
    ).toBe(false);
    expect(f.query).not.toHaveBeenCalled();
  });

  it.each(['production', 'synthetic'] as const)(
    'a seal does not authorize live traffic: %s',
    async (source) => {
      const f = fixture();
      const client = {
        query: vi.fn(async (sql: string) => ({
          rows: sql.includes('SELECT permission') ? [{ permission: 'owner' }] : [],
        })),
      } as unknown as Client;
      const report = OwnerDishReportSchema.parse(
        await readOwnerReport(client, 'actor', venue, now, source, {
          trafficClass: 'live',
          syntheticSeal: JSON.stringify(f.seal),
          validationNow: now,
        }),
      );
      expect(report.report_metadata.freshness.is_stale).toBeNull();
      expect(client.query).not.toHaveBeenCalledWith(
        expect.stringContaining('observation_conflict'),
        expect.anything(),
      );
    },
  );

  it.each([undefined, '', '{', '{}'])('missing/invalid seal %s reads no evidence', async (seal) => {
    const f = fixture();
    expect(
      await verifySyntheticCompleteness(f.client, {
        ...(seal ? { seal } : {}),
        venueId: venue,
        anchor: now,
        validationNow: now,
      }),
    ).toBe(false);
    expect(f.query).not.toHaveBeenCalled();
  });

  it('checks ownership first and joins proof to the exact report transaction', async () => {
    const f = fixture();
    const statements: string[] = [];
    let owner = true;
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('SELECT permission'))
          return { rows: owner ? [{ permission: 'owner' }] : [] };
        if (sql.includes('AS index')) return { rows: f.rows };
        return { rows: [] };
      }),
    } as unknown as Client;
    const options = {
      trafficClass: 'test' as const,
      syntheticSeal: JSON.stringify(f.seal),
      validationNow: now,
    };
    const report = OwnerDishReportSchema.parse(
      await readOwnerReport(client, 'actor', venue, now, 'synthetic', options),
    );
    expect(report.report_metadata.freshness.is_stale).toBe(false);
    expect(statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements.findIndex((s) => s.includes('AS index'))).toBeGreaterThan(
      statements.findIndex((s) => s.includes('owner_observation')),
    );
    owner = false;
    statements.length = 0;
    await expect(
      readOwnerReport(client, 'actor', venue, now, 'synthetic', options),
    ).rejects.toMatchObject({ status: 403 });
    expect(statements.some((s) => s.includes('observation_index'))).toBe(false);
  });

  it('preserves signed reference expiry independently of a valid seal', async () => {
    const f = fixture();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT permission')) return { rows: [{ permission: 'owner' }] };
        return { rows: sql.includes('AS index') ? f.rows : [] };
      }),
    } as unknown as Client;
    const report = OwnerDishReportSchema.parse(
      await readOwnerReport(client, 'actor', venue, now, 'synthetic', {
        trafficClass: 'test',
        syntheticSeal: JSON.stringify(f.seal),
        validationNow: now,
      }),
    );
    const scope = { actorId: 'actor', venueId: venue };
    const secret = 's'.repeat(48);
    const reference = await mintOwnerReportReference(report, scope, secret, now);
    expect(await readOwnerReportReference(reference, scope, secret, now)).not.toBeNull();
    expect(
      await readOwnerReportReference(reference, scope, secret, new Date(now.getTime() + 60_000)),
    ).toBeNull();
  });
});
