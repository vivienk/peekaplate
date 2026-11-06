import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import type { ReviewCandidate, ReviewCandidateCommand } from '@peekaplate/contracts';
import type { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  buildReviewSessionResponse,
  type CandidateReviewEvent,
  candidateStreamId,
  canonicalStringify,
  ReplayError,
  replayCandidateReview,
  resolveEffectiveFields,
  saveCandidateReviewCommand,
  upsertExtractionReviewSession,
} from './review-command';

const fixtureV2 = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../processing/tests/fixtures/review-candidates/representative-candidates-v2.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);

describe('S3-RES-01.2 review-command unit tests', () => {
  const venueId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const extractionId = 'extraction:e1bb4c9c059eb377dc7e92f340e78416';
  const candidateId = 'draft:0bbe00087c6841623c76d7b6f9da5ebf';
  const actorId = 'a11ac10b-58cc-4372-a567-0e02b2c3d479';

  describe('candidateStreamId', () => {
    it('generates deterministic valid UUID matching candidate scope', () => {
      const streamId1 = candidateStreamId(venueId, extractionId, candidateId);
      const streamId2 = candidateStreamId(venueId, extractionId, candidateId);
      expect(streamId1).toBe(streamId2);
      expect(streamId1).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      const streamIdOther = candidateStreamId(venueId, extractionId, 'draft:other');
      expect(streamId1).not.toBe(streamIdOther);
    });
  });
  describe('canonicalStringify', () => {
    it('produces identical output regardless of object property insertion order', () => {
      const objA = { z: 1, a: 2, m: { y: 'test', b: [1, { k: 3, c: 4 }] } };
      const objB = { a: 2, z: 1, m: { b: [1, { c: 4, k: 3 }], y: 'test' } };
      expect(canonicalStringify(objA)).toBe(canonicalStringify(objB));
    });
  });

  describe('resolveEffectiveFields', () => {
    it('overlays corrected fields while preserving untouched original fields', () => {
      const soup = fixtureV2.candidates[0] as ReviewCandidate;
      const originalCopy = structuredClone(soup.original);

      const corrected = {
        name: 'Organic Garden Soup',
        price_amount: '9.50',
      };

      const effective = resolveEffectiveFields(soup, corrected);

      expect(effective.name).toBe('Organic Garden Soup');
      expect(effective.price_amount).toBe('9.50');
      // Untouched fields from original:
      expect(effective.description).toBe(soup.original.description);
      expect(effective.category).toBe(soup.original.category);
      expect(effective.subcategory).toBe(soup.original.subcategory);
      expect(effective.category_page_number).toBe(soup.original.category_page_number);
      expect(effective.price_text).toBe(soup.original.price_text);
      expect(effective.price_currency).toBe(soup.original.price_currency);
      expect(effective.ingredients).toEqual(soup.original.ingredients);

      // Verify original candidate object is strictly unchanged
      expect(soup.original).toEqual(originalCopy);
    });
  });

  describe('buildReviewSessionResponse', () => {
    it('constructs complete session with pending items for candidates without review rows', () => {
      const sessionRow = {
        tenant_id: venueId,
        extraction_id: fixtureV2.extraction_id,
        schema_version: fixtureV2.schema_version,
        pipeline_version: fixtureV2.pipeline_version,
        extraction_status: fixtureV2.status,
        source_id: fixtureV2.source_id,
        source_sha256: fixtureV2.source_sha256,
        job_id: null,
        private_artifact_key: null,
        private_artifact_sha256: null,
        payload: fixtureV2,
        created_by: actorId,
        created_at: new Date('2026-10-30T10:00:00Z'),
      };

      const response = buildReviewSessionResponse(venueId, sessionRow, []);

      expect(response.venueId).toBe(venueId);
      expect(response.extractionResult.extraction_id).toBe(fixtureV2.extraction_id);
      expect(response.items).toHaveLength(fixtureV2.candidates.length);
      expect(response.published).toBe(false);

      for (let i = 0; i < response.items.length; i++) {
        const item = response.items[i];
        expect(item).toBeDefined();
        if (!item) continue;
        expect(item.review.reviewStatus).toBe('pending');
        expect(item.review.version).toBe(0);
        expect(item.review.publishable).toBe(false);
        expect(item.effective.name).toBe(fixtureV2.candidates[i]?.original.name);
      }
    });

    it('overlays review rows and artifact ref properly', () => {
      const soupId = fixtureV2.candidates[0].candidate_id;
      const sessionRow = {
        tenant_id: venueId,
        extraction_id: fixtureV2.extraction_id,
        schema_version: fixtureV2.schema_version,
        pipeline_version: fixtureV2.pipeline_version,
        extraction_status: fixtureV2.status,
        source_id: fixtureV2.source_id,
        source_sha256: fixtureV2.source_sha256,
        job_id: 'b11ac10b-58cc-4372-a567-0e02b2c3d479',
        private_artifact_key: `menu-ingestion/review-artifacts/${venueId}/art-1.json`,
        private_artifact_sha256: 'a'.repeat(64),
        payload: fixtureV2,
        created_by: actorId,
        created_at: new Date('2026-10-30T10:00:00Z'),
      };

      const reviewRows = [
        {
          tenant_id: venueId,
          extraction_id: fixtureV2.extraction_id,
          candidate_id: soupId,
          stream_id: candidateStreamId(venueId, fixtureV2.extraction_id, soupId),
          version: 2,
          revision_id: 'c11ac10b-58cc-4372-a567-0e02b2c3d479',
          review_status: 'corrected' as const,
          corrected_fields: { name: 'Fixed Soup', price_amount: '10.00' },
          edited_fields: ['name', 'price_amount'],
          incomplete_fields: [],
          review_note: 'Verified with manager',
          reviewed_by: actorId,
          reviewed_at: new Date('2026-10-30T11:00:00Z'),
        },
      ];

      const response = buildReviewSessionResponse(venueId, sessionRow, reviewRows);

      expect(response.privateArtifactRef).toEqual({
        schema_version: 1,
        key: `menu-ingestion/review-artifacts/${venueId}/art-1.json`,
        sha256: 'a'.repeat(64),
      });

      const soupItem = response.items.find((i) => i.candidate.candidate_id === soupId);
      expect(soupItem).toBeDefined();
      expect(soupItem?.review.reviewStatus).toBe('corrected');
      expect(soupItem?.review.version).toBe(2);
      expect(soupItem?.effective.name).toBe('Fixed Soup');
      expect(soupItem?.effective.price_amount).toBe('10.00');
    });
  });

  describe('replayCandidateReview', () => {
    const streamId = candidateStreamId(venueId, extractionId, candidateId);

    it('returns null for empty event stream', () => {
      expect(replayCandidateReview([])).toBeNull();
    });

    it('replays a sequence of candidate review transitions accurately', () => {
      const events: CandidateReviewEvent[] = [
        {
          id: 'e11ac10b-58cc-4372-a567-0e02b2c3d471',
          tenantId: venueId,
          streamType: 'candidate_review',
          streamId,
          version: 1,
          schemaVersion: 1,
          eventType: 'candidate.review.saved',
          payload: {
            extractionId,
            candidateId,
            revisionId: 'd11ac10b-58cc-4372-a567-0e02b2c3d471',
            version: 1,
            reviewStatus: 'corrected',
            corrected: { name: 'Initial Correction' },
            editedFields: ['name'],
            incompleteFields: [],
            reviewNote: 'First pass',
            reviewedBy: actorId,
            reviewedAt: '2026-10-30T10:00:00.000Z',
          },
          metadata: { actorId },
          occurredAt: '2026-10-30T10:00:00.000Z',
        },
        {
          id: 'e11ac10b-58cc-4372-a567-0e02b2c3d472',
          tenantId: venueId,
          streamType: 'candidate_review',
          streamId,
          version: 2,
          schemaVersion: 1,
          eventType: 'candidate.review.saved',
          payload: {
            extractionId,
            candidateId,
            revisionId: 'd11ac10b-58cc-4372-a567-0e02b2c3d472',
            version: 2,
            reviewStatus: 'incomplete',
            corrected: { name: 'Initial Correction' },
            editedFields: ['name'],
            incompleteFields: ['price_amount'],
            reviewNote: 'Need price clarification',
            reviewedBy: actorId,
            reviewedAt: '2026-10-30T10:05:00.000Z',
          },
          metadata: { actorId },
          occurredAt: '2026-10-30T10:05:00.000Z',
        },
        {
          id: 'e11ac10b-58cc-4372-a567-0e02b2c3d473',
          tenantId: venueId,
          streamType: 'candidate_review',
          streamId,
          version: 3,
          schemaVersion: 1,
          eventType: 'candidate.review.saved',
          payload: {
            extractionId,
            candidateId,
            revisionId: 'd11ac10b-58cc-4372-a567-0e02b2c3d473',
            version: 3,
            reviewStatus: 'rejected',
            corrected: {},
            editedFields: [],
            incompleteFields: [],
            reviewNote: 'Dish discontinued',
            reviewedBy: actorId,
            reviewedAt: '2026-10-30T10:10:00.000Z',
          },
          metadata: { actorId },
          occurredAt: '2026-10-30T10:10:00.000Z',
        },
      ];

      const state = replayCandidateReview(events);
      expect(state).not.toBeNull();
      expect(state?.version).toBe(3);
      expect(state?.reviewStatus).toBe('rejected');
      expect(state?.corrected).toEqual({});
      expect(state?.editedFields).toEqual([]);
      expect(state?.incompleteFields).toEqual([]);
      expect(state?.reviewNote).toBe('Dish discontinued');
      expect(state?.publishable).toBe(false);
    });

    it('rejects non-contiguous version sequences', () => {
      const nonContiguous: CandidateReviewEvent[] = [
        {
          id: 'e11ac10b-58cc-4372-a567-0e02b2c3d471',
          tenantId: venueId,
          streamType: 'candidate_review',
          streamId,
          version: 1,
          schemaVersion: 1,
          eventType: 'candidate.review.saved',
          payload: {
            extractionId,
            candidateId,
            revisionId: 'd11ac10b-58cc-4372-a567-0e02b2c3d471',
            version: 1,
            reviewStatus: 'corrected',
            corrected: { name: 'V1' },
            editedFields: ['name'],
            incompleteFields: [],
            reviewNote: null,
            reviewedBy: actorId,
            reviewedAt: '2026-10-30T10:00:00.000Z',
          },
          metadata: {},
        },
        {
          id: 'e11ac10b-58cc-4372-a567-0e02b2c3d472',
          tenantId: venueId,
          streamType: 'candidate_review',
          streamId,
          version: 3, // gap: expected 2
          schemaVersion: 1,
          eventType: 'candidate.review.saved',
          payload: {
            extractionId,
            candidateId,
            revisionId: 'd11ac10b-58cc-4372-a567-0e02b2c3d472',
            version: 3,
            reviewStatus: 'corrected',
            corrected: { name: 'V3' },
            editedFields: ['name'],
            incompleteFields: [],
            reviewNote: null,
            reviewedBy: actorId,
            reviewedAt: '2026-10-30T10:05:00.000Z',
          },
          metadata: {},
        },
      ];

      expect(() => replayCandidateReview(nonContiguous)).toThrow(ReplayError);
    });

    it('rejects mixed stream IDs or stream types', () => {
      const mixedStream: CandidateReviewEvent[] = [
        {
          id: 'e11ac10b-58cc-4372-a567-0e02b2c3d471',
          tenantId: venueId,
          streamType: 'candidate_review',
          streamId,
          version: 1,
          schemaVersion: 1,
          eventType: 'candidate.review.saved',
          payload: {
            extractionId,
            candidateId,
            revisionId: 'd11ac10b-58cc-4372-a567-0e02b2c3d471',
            version: 1,
            reviewStatus: 'corrected',
            corrected: { name: 'V1' },
            editedFields: ['name'],
            incompleteFields: [],
            reviewNote: null,
            reviewedBy: actorId,
            reviewedAt: '2026-10-30T10:00:00.000Z',
          },
          metadata: {},
        },
        {
          id: 'e11ac10b-58cc-4372-a567-0e02b2c3d472',
          tenantId: venueId,
          streamType: 'candidate_review',
          streamId: 'f11ac10b-58cc-4372-a567-0e02b2c3d479', // different streamId
          version: 2,
          schemaVersion: 1,
          eventType: 'candidate.review.saved',
          payload: {
            extractionId,
            candidateId,
            revisionId: 'd11ac10b-58cc-4372-a567-0e02b2c3d472',
            version: 2,
            reviewStatus: 'corrected',
            corrected: { name: 'V2' },
            editedFields: ['name'],
            incompleteFields: [],
            reviewNote: null,
            reviewedBy: actorId,
            reviewedAt: '2026-10-30T10:05:00.000Z',
          },
          metadata: {},
        },
      ];

      expect(() => replayCandidateReview(mixedStream)).toThrow(ReplayError);
    });
  });
});

/** Minimal in-memory stand-in for the transaction queries upsertExtractionReviewSession issues. */
function fakeReviewDatabase() {
  const commands = new Map<string, { request_hash: string; result: unknown }>();
  const sessions = new Map<string, Record<string, unknown>>();
  const writes: string[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(text) || text.includes('set_config'))
        return { rows: [] };
      if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (text.includes('FROM app_private.staff_membership'))
        return { rows: [{ permission: 'owner' }] };
      if (text.startsWith('SELECT request_hash, result FROM app_private.es_command')) {
        const found = commands.get(`${params[0]}:${params[1]}:${params[2]}`);
        return { rows: found ? [found] : [] };
      }
      if (text.startsWith('INSERT INTO app_private.es_command')) {
        writes.push('es_command');
        commands.set(`${params[1]}:${params[2]}:${params[3]}`, {
          request_hash: params[5] as string,
          result: JSON.parse(params[6] as string),
        });
        return { rows: [] };
      }
      if (text.includes('FROM app_private.extraction_review_session')) {
        const found = sessions.get(`${params[0]}:${params[1]}`);
        return { rows: found ? [found] : [] };
      }
      if (text.startsWith('INSERT INTO app_private.extraction_review_session')) {
        writes.push('session');
        const row = {
          tenant_id: params[0],
          extraction_id: params[1],
          schema_version: params[2],
          pipeline_version: params[3],
          extraction_status: params[4],
          source_id: params[5],
          source_sha256: params[6],
          job_id: params[7],
          private_artifact_key: params[8],
          private_artifact_sha256: params[9],
          payload: JSON.parse(params[10] as string),
          created_by: params[11],
          created_at: new Date('2026-11-03T00:00:00Z'),
        };
        sessions.set(`${params[0]}:${params[1]}`, row);
        return { rows: [row] };
      }
      if (text.includes('FROM app_private.candidate_review_current')) return { rows: [] };
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    },
  };
  return { client: client as unknown as Client, commands, writes };
}

describe('upsertExtractionReviewSession idempotency', () => {
  const venueId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const actorId = 'a11ac10b-58cc-4372-a567-0e02b2c3d479';
  const commandId = 'c11ac10b-58cc-4372-a567-0e02b2c3d479';

  it('conflicts when a commandId is reused with a different extraction payload', async () => {
    const db = fakeReviewDatabase();
    await upsertExtractionReviewSession(db.client, actorId, venueId, {
      commandId,
      extractionResult: fixtureV2,
    });
    const changed = structuredClone(fixtureV2);
    changed.candidates[0].original.name = 'Changed Name';
    const writesBefore = db.writes.length;
    await expect(
      upsertExtractionReviewSession(db.client, actorId, venueId, {
        commandId,
        extractionResult: changed,
      }),
    ).rejects.toMatchObject({ code: 'command_conflict', status: 409 });
    expect(db.writes.length).toBe(writesBefore);
  });

  it('replays an identical retry from the stored session and keeps the receipt compact', async () => {
    const db = fakeReviewDatabase();
    const first = await upsertExtractionReviewSession(db.client, actorId, venueId, {
      commandId,
      extractionResult: fixtureV2,
    });
    const replay = await upsertExtractionReviewSession(db.client, actorId, venueId, {
      commandId,
      extractionResult: fixtureV2,
    });
    expect(replay).toEqual(first);
    expect(db.writes).toEqual(['session', 'es_command']);
    const receipt = [...db.commands.values()][0]?.result as Record<string, unknown>;
    expect(Object.keys(receipt).sort()).toEqual(['extractionId', 'payloadSha256', 'schemaVersion']);
    expect(JSON.stringify(receipt).length).toBeLessThan(200);
  });
});

type FakeCandidateDatabase = {
  client: Client;
  current: Map<string, Record<string, unknown>>;
  events: CandidateReviewEvent[];
  writes: string[];
};

/**
 * In-memory stand-in for the queries saveCandidateReviewCommand issues: one registered v2
 * session, the candidate projection, the event stream and command receipts.
 */
function fakeCandidateDatabase(venueId: string, extractionId: string): FakeCandidateDatabase {
  const commands = new Map<string, { request_hash: string; result: unknown }>();
  const current = new Map<string, Record<string, unknown>>();
  const events: CandidateReviewEvent[] = [];
  const writes: string[] = [];
  const session = {
    tenant_id: venueId,
    extraction_id: extractionId,
    schema_version: fixtureV2.schema_version,
    pipeline_version: fixtureV2.pipeline_version,
    extraction_status: fixtureV2.status,
    source_id: fixtureV2.source.source_id,
    source_sha256: fixtureV2.source.sha256,
    job_id: null,
    private_artifact_key: null,
    private_artifact_sha256: null,
    payload: fixtureV2,
    created_by: 'a11ac10b-58cc-4372-a567-0e02b2c3d479',
    created_at: new Date('2026-11-03T00:00:00Z'),
  };
  const client = {
    async query(sql: string, params: unknown[] = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(text) || text.includes('set_config'))
        return { rows: [] };
      if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (text.includes('FROM app_private.staff_membership'))
        return { rows: [{ permission: 'owner' }] };
      if (text.startsWith('SELECT request_hash, result FROM app_private.es_command')) {
        const found = commands.get(`${params[0]}:${params[1]}:${params[2]}`);
        return { rows: found ? [structuredClone(found)] : [] };
      }
      if (text.startsWith('INSERT INTO app_private.es_command')) {
        writes.push('es_command');
        commands.set(`${params[1]}:${params[2]}:${params[3]}`, {
          request_hash: params[5] as string,
          result: JSON.parse(params[6] as string),
        });
        return { rows: [] };
      }
      if (text.includes('FROM app_private.extraction_review_session')) {
        return { rows: params[1] === extractionId ? [session] : [] };
      }
      if (text.includes('FROM app_private.candidate_review_current')) {
        const row = current.get(params[2] as string);
        return { rows: row ? [structuredClone(row)] : [] };
      }
      if (text.startsWith('INSERT INTO app_private.es_event')) {
        writes.push('es_event');
        events.push({
          id: params[0] as string,
          tenantId: params[1] as string,
          streamType: 'candidate_review',
          streamId: params[2] as string,
          version: params[3] as number,
          schemaVersion: 1,
          eventType: 'candidate.review.saved',
          payload: JSON.parse(params[4] as string),
          metadata: JSON.parse(params[5] as string),
        });
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO app_private.candidate_review_current')) {
        writes.push('current');
        current.set(params[2] as string, {
          candidate_id: params[2],
          stream_id: params[3],
          version: params[4],
          revision_id: params[5],
          review_status: params[6],
          corrected_fields: JSON.parse(params[7] as string),
          edited_fields: params[8],
          incomplete_fields: params[9],
          review_note: params[10],
          reviewed_by: params[11],
          reviewed_at: params[12],
        });
        return { rows: [] };
      }
      if (text.startsWith('UPDATE app_private.candidate_review_current')) {
        writes.push('current');
        const row = current.get(params[2] as string) ?? {};
        current.set(params[2] as string, {
          ...row,
          version: params[3],
          revision_id: params[4],
          review_status: params[5],
          corrected_fields: JSON.parse(params[6] as string),
          edited_fields: params[7],
          incomplete_fields: params[8],
          review_note: params[9],
          reviewed_by: params[10],
          reviewed_at: params[11],
        });
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO app_private.outbox')) {
        writes.push('outbox');
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    },
  };
  return { client: client as unknown as Client, current, events, writes };
}

describe('saveCandidateReviewCommand (PR #73 findings B and C)', () => {
  const venueId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const actorId = 'a11ac10b-58cc-4372-a567-0e02b2c3d479';
  const extractionId = fixtureV2.extraction_id as string;
  const candidateId = 'draft:0bbe00087c6841623c76d7b6f9da5ebf';
  const save = (db: FakeCandidateDatabase, input: ReviewCandidateCommand) =>
    saveCandidateReviewCommand(db.client, actorId, venueId, extractionId, candidateId, input);
  const id = (n: number) => `c11ac10b-58cc-4372-a567-0e02b2c3d4${String(n).padStart(2, '0')}`;

  async function withRetainedNote() {
    const db = fakeCandidateDatabase(venueId, extractionId);
    await save(db, {
      commandId: id(1),
      expectedVersion: 0,
      action: 'correct',
      corrected: { name: 'Organic Garden Soup' },
      reviewNote: 'Retained note',
    });
    const omitted = await save(db, {
      commandId: id(2),
      expectedVersion: 1,
      action: 'correct',
      corrected: { price_amount: '9.50' },
    });
    return { db, omitted };
  }

  it('T-B1 conflicts when an omitted-note commandId is reused with an explicit null note', async () => {
    const { db, omitted } = await withRetainedNote();
    expect(omitted.review.reviewNote).toBe('Retained note');
    const writesBefore = db.writes.length;
    await expect(
      save(db, {
        commandId: id(2),
        expectedVersion: 1,
        action: 'correct',
        corrected: { price_amount: '9.50' },
        reviewNote: null,
      }),
    ).rejects.toMatchObject({ code: 'command_conflict', status: 409 });
    expect(db.writes.length).toBe(writesBefore);
    expect(db.current.get(candidateId)?.review_note).toBe('Retained note');
  });

  it('T-B2 replays the stored receipt for an identical retry with the same field presence', async () => {
    const { db, omitted } = await withRetainedNote();
    const writesBefore = db.writes.length;
    const retry = await save(db, {
      commandId: id(2),
      expectedVersion: 1,
      action: 'correct',
      corrected: { price_amount: '9.50' },
    });
    expect(retry).toEqual(omitted);
    expect(db.writes.length).toBe(writesBefore);
  });

  it('T-B3 clears the note for a new commandId with an explicit null note', async () => {
    const { db } = await withRetainedNote();
    const cleared = await save(db, {
      commandId: id(3),
      expectedVersion: 2,
      action: 'correct',
      corrected: { price_amount: '9.50' },
      reviewNote: null,
    });
    expect(cleared.review.reviewNote).toBeNull();
    expect(db.current.get(candidateId)?.review_note).toBeNull();
  });

  async function correctedThenIncomplete() {
    const db = fakeCandidateDatabase(venueId, extractionId);
    await save(db, {
      commandId: id(10),
      expectedVersion: 0,
      action: 'correct',
      corrected: { price_amount: '9.50', name: 'Organic Garden Soup' },
    });
    const incomplete = await save(db, {
      commandId: id(11),
      expectedVersion: 1,
      action: 'mark_incomplete',
      incompleteFields: ['price_amount'],
    });
    return { db, incomplete };
  }

  it('T-C1 removes a field marked incomplete from the active corrections', async () => {
    const { incomplete } = await correctedThenIncomplete();
    expect(incomplete.review.reviewStatus).toBe('incomplete');
    expect(incomplete.review.incompleteFields).toEqual(['price_amount']);
    expect(incomplete.review.corrected).toEqual({ name: 'Organic Garden Soup' });
    expect(incomplete.review.editedFields).toEqual(['name']);
    expect(incomplete.effective.price_amount).toBe(
      fixtureV2.candidates.find((c: { candidate_id: string }) => c.candidate_id === candidateId)
        .original.price_amount ?? null,
    );
  });

  it('T-C2 reloads the same pruned state from the projection and the event stream', async () => {
    const { db, incomplete } = await correctedThenIncomplete();
    const row = db.current.get(candidateId);
    expect(row?.corrected_fields).toEqual({ name: 'Organic Garden Soup' });
    expect(row?.edited_fields).toEqual(['name']);
    expect(row?.incomplete_fields).toEqual(['price_amount']);
    expect(replayCandidateReview(db.events)).toEqual(incomplete.review);
  });

  it('T-C3 rejects a field listed as both corrected and incomplete before any write', async () => {
    const db = fakeCandidateDatabase(venueId, extractionId);
    for (const action of ['mark_incomplete', 'correct'] as const) {
      await expect(
        save(db, {
          commandId: id(action === 'correct' ? 20 : 21),
          expectedVersion: 0,
          action,
          corrected: { price_amount: '9.50' },
          incompleteFields: ['price_amount'],
        }),
      ).rejects.toMatchObject({ code: 'invalid_candidate', status: 400 });
    }
    expect(db.writes).toEqual([]);
    expect(db.current.size).toBe(0);
  });
});
