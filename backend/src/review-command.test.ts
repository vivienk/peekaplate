import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import type { ReviewCandidate } from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildReviewSessionResponse,
  type CandidateReviewEvent,
  candidateStreamId,
  canonicalStringify,
  ReplayError,
  replayCandidateReview,
  resolveEffectiveFields,
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
