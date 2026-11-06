import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CandidateCorrectedFieldsSchema,
  CandidateReviewRecordSchema,
  CandidateReviewScopeSchema,
  ExtractionReviewScopeSchema,
  ExtractionReviewSessionResponseSchema,
  ResolvedCandidateFieldsSchema,
  ReviewCandidateCommandSchema,
  ReviewCandidateItemResponseSchema,
  UpsertExtractionReviewSessionRequestSchema,
} from './index';

const fixtureV1 = JSON.parse(
  readFileSync(
    new URL(
      '../../../processing/tests/fixtures/review-candidates/representative-candidates.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

const fixtureV2 = JSON.parse(
  readFileSync(
    new URL(
      '../../../processing/tests/fixtures/review-candidates/representative-candidates-v2.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

describe('S3-RES-01.2 review persistence contracts', () => {
  const validVenueId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const validActorId = 'a11ac10b-58cc-4372-a567-0e02b2c3d479';
  const validCommandId = 'c11ac10b-58cc-4372-a567-0e02b2c3d479';
  const validRevisionId = 'b11ac10b-58cc-4372-a567-0e02b2c3d479';

  describe('ExtractionReviewScopeSchema & CandidateReviewScopeSchema', () => {
    it('accepts valid scopes and transforms uuid to lowercase', () => {
      const scope = ExtractionReviewScopeSchema.parse({
        venueId: validVenueId.toUpperCase(),
        extractionId: 'extraction:12345',
      });
      expect(scope.venueId).toBe(validVenueId);
      expect(scope.extractionId).toBe('extraction:12345');

      const candScope = CandidateReviewScopeSchema.parse({
        venueId: validVenueId,
        extractionId: 'extraction:12345',
        candidateId: 'draft:abcde',
      });
      expect(candScope.candidateId).toBe('draft:abcde');
    });

    it('rejects invalid uuid, empty strings, and NUL bytes', () => {
      expect(
        ExtractionReviewScopeSchema.safeParse({
          venueId: 'not-a-uuid',
          extractionId: 'extraction:123',
        }).success,
      ).toBe(false);

      expect(
        ExtractionReviewScopeSchema.safeParse({
          venueId: validVenueId,
          extractionId: '',
        }).success,
      ).toBe(false);

      expect(
        ExtractionReviewScopeSchema.safeParse({
          venueId: validVenueId,
          extractionId: 'extraction:\u0000bad',
        }).success,
      ).toBe(false);

      expect(
        CandidateReviewScopeSchema.safeParse({
          venueId: validVenueId,
          extractionId: 'extraction:123',
          candidateId: 'draft:\u0000bad',
        }).success,
      ).toBe(false);
    });
  });

  describe('CandidateCorrectedFieldsSchema', () => {
    it('accepts valid corrected field subsets', () => {
      const parsed = CandidateCorrectedFieldsSchema.parse({
        name: 'Updated Dish Name',
        price_amount: '12.50',
        price_currency: 'USD',
        ingredients: ['Tomato', 'Basil'],
      });
      expect(parsed.name).toBe('Updated Dish Name');
      expect(parsed.price_amount).toBe('12.50');
    });

    it('accepts canonical zero price amount "0.00" and nulls for nullable fields', () => {
      const parsed = CandidateCorrectedFieldsSchema.parse({
        price_amount: '0.00',
        description: null,
        category: null,
        subcategory: null,
        price_text: null,
      });
      expect(parsed.price_amount).toBe('0.00');
      expect(parsed.description).toBeNull();
    });

    it('rejects empty object when action is correct', () => {
      expect(CandidateCorrectedFieldsSchema.safeParse({}).success).toBe(false);
    });

    it('rejects invalid price amounts and lowercase currency', () => {
      expect(
        CandidateCorrectedFieldsSchema.safeParse({
          price_amount: '-5.00',
        }).success,
      ).toBe(false);

      expect(
        CandidateCorrectedFieldsSchema.safeParse({
          price_amount: 'abc',
        }).success,
      ).toBe(false);

      expect(
        CandidateCorrectedFieldsSchema.safeParse({
          price_currency: 'usd',
        }).success,
      ).toBe(false);
    });

    it('rejects NUL bytes and unknown properties', () => {
      expect(
        CandidateCorrectedFieldsSchema.safeParse({
          name: 'Dish\u0000Bad',
        }).success,
      ).toBe(false);

      expect(
        CandidateCorrectedFieldsSchema.safeParse({
          name: 'Dish',
          extra: 'unknown',
        }).success,
      ).toBe(false);
    });
  });

  describe('ReviewCandidateCommandSchema', () => {
    it('accepts valid correct command', () => {
      const cmd = ReviewCandidateCommandSchema.parse({
        commandId: validCommandId,
        expectedVersion: 0,
        action: 'correct',
        corrected: {
          name: 'Organic Garden Soup',
          price_amount: '9.50',
        },
        reviewNote: 'Verified with staff',
      });
      expect(cmd.action).toBe('correct');
      expect(cmd.expectedVersion).toBe(0);
      expect(cmd.corrected?.name).toBe('Organic Garden Soup');
    });

    it('rejects correct command without corrected fields', () => {
      expect(
        ReviewCandidateCommandSchema.safeParse({
          commandId: validCommandId,
          expectedVersion: 0,
          action: 'correct',
        }).success,
      ).toBe(false);
    });

    it('accepts valid reject command and rejects reject command with corrected fields', () => {
      const rejectCmd = ReviewCandidateCommandSchema.parse({
        commandId: validCommandId,
        expectedVersion: 1,
        action: 'reject',
        reviewNote: 'Not a menu item',
      });
      expect(rejectCmd.action).toBe('reject');

      expect(
        ReviewCandidateCommandSchema.safeParse({
          commandId: validCommandId,
          expectedVersion: 1,
          action: 'reject',
          corrected: { name: 'Cannot correct on reject' },
        }).success,
      ).toBe(false);
    });

    it('accepts mark_incomplete command with unique fields and rejects empty or duplicate fields', () => {
      const incompleteCmd = ReviewCandidateCommandSchema.parse({
        commandId: validCommandId,
        expectedVersion: 0,
        action: 'mark_incomplete',
        incompleteFields: ['price_amount', 'description'],
        reviewNote: 'Price obscured in photo',
      });
      expect(incompleteCmd.incompleteFields).toEqual(['price_amount', 'description']);

      expect(
        ReviewCandidateCommandSchema.safeParse({
          commandId: validCommandId,
          expectedVersion: 0,
          action: 'mark_incomplete',
          incompleteFields: [],
        }).success,
      ).toBe(false);

      expect(
        ReviewCandidateCommandSchema.safeParse({
          commandId: validCommandId,
          expectedVersion: 0,
          action: 'mark_incomplete',
          incompleteFields: ['price_amount', 'price_amount'],
        }).success,
      ).toBe(false);
    });
  });

  describe('ResolvedCandidateFieldsSchema & CandidateReviewRecordSchema', () => {
    it('validates CandidateReviewRecordSchema and strictly enforces publishable: false', () => {
      const record = CandidateReviewRecordSchema.parse({
        extractionId: 'extraction:12345',
        candidateId: 'draft:abcde',
        revisionId: validRevisionId,
        version: 1,
        reviewStatus: 'corrected',
        corrected: {
          name: 'Fixed Name',
        },
        editedFields: ['name'],
        incompleteFields: [],
        reviewNote: 'Corrected name',
        reviewedBy: validActorId,
        reviewedAt: '2026-10-30T12:00:00.000Z',
        publishable: false,
      });
      expect(record.version).toBe(1);
      expect(record.publishable).toBe(false);

      expect(
        CandidateReviewRecordSchema.safeParse({
          ...record,
          publishable: true,
        }).success,
      ).toBe(false);
    });

    it('validates ResolvedCandidateFieldsSchema with v2 subcategory and price_text', () => {
      const resolved = ResolvedCandidateFieldsSchema.parse({
        name: 'Garden Soup',
        description: 'Warm seasonal soup',
        category: 'Starters',
        subcategory: 'Soups',
        category_page_number: 1,
        price_text: '8.50 / 12.50 CAD',
        price_amount: '8.50',
        price_currency: 'CAD',
        ingredients: ['Carrot', 'Celery'],
      });
      expect(resolved.subcategory).toBe('Soups');
      expect(resolved.category_page_number).toBe(1);
      expect(resolved.price_text).toBe('8.50 / 12.50 CAD');
    });
  });

  describe('ReviewCandidateItemResponseSchema & ExtractionReviewSessionResponseSchema', () => {
    it('validates a full session response using v2 candidate fixtures', () => {
      const candidate0 = fixtureV2.candidates[0];
      const item = ReviewCandidateItemResponseSchema.parse({
        candidate: candidate0,
        review: {
          extractionId: fixtureV2.extraction_id,
          candidateId: candidate0.candidate_id,
          revisionId: null,
          version: 0,
          reviewStatus: 'pending',
          corrected: {},
          editedFields: [],
          incompleteFields: [],
          reviewNote: null,
          reviewedBy: null,
          reviewedAt: null,
          publishable: false,
        },
        effective: {
          name: candidate0.original.name,
          description: candidate0.original.description,
          category: candidate0.original.category,
          subcategory: candidate0.original.subcategory,
          category_page_number: candidate0.original.category_page_number,
          price_text: candidate0.original.price_text,
          price_amount: candidate0.original.price_amount,
          price_currency: candidate0.original.price_currency,
          ingredients: candidate0.original.ingredients,
        },
      });
      expect(item.candidate.candidate_id).toBe(candidate0.candidate_id);

      const sessionResponse = ExtractionReviewSessionResponseSchema.parse({
        schemaVersion: 1,
        venueId: validVenueId,
        extractionResult: fixtureV2,
        items: [item],
        privateArtifactRef: {
          schema_version: 1,
          key: `menu-ingestion/review-artifacts/${validVenueId}/artifact-1.json`,
          sha256: 'a'.repeat(64),
        },
        published: false,
      });
      expect(sessionResponse.schemaVersion).toBe(1);
      expect(sessionResponse.published).toBe(false);

      expect(
        ExtractionReviewSessionResponseSchema.safeParse({
          ...sessionResponse,
          published: true,
        }).success,
      ).toBe(false);
    });

    it('validates UpsertExtractionReviewSessionRequestSchema', () => {
      const req = UpsertExtractionReviewSessionRequestSchema.parse({
        commandId: validCommandId,
        extractionResult: fixtureV1,
      });
      expect(req.commandId).toBe(validCommandId);
      expect(req.extractionResult.extraction_id).toBe(fixtureV1.extraction_id);
    });
  });
});
