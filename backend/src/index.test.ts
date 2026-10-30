import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import app, { createApp } from './index';
import { ReviewCommandError } from './review-command';

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

describe('foundation API', () => {
  it('returns a minimal liveness response without database or secret configuration', async () => {
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      service: 'peekaplate-api',
      stage: 'foundation',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('does not expose an unimplemented event ingestion endpoint', async () => {
    const response = await app.request('/events', { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
  });
  it('rejects an unauthenticated dish revision before accessing the database', async () => {
    const response = await app.request(
      '/venues/00000000-0000-4000-8000-000000000001/dishes/00000000-0000-4000-8000-000000000002/revisions',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });
});

describe('dish HTTP boundary', () => {
  const venueId = '00000000-0000-4000-8000-000000000001';
  const dishId = '00000000-0000-4000-8000-000000000002';
  const actorId = '00000000-0000-4000-8000-000000000003';
  const command = {
    commandId: crypto.randomUUID(),
    expectedVersion: 0,
    name: 'Soup',
    description: '',
  };
  const path = `/venues/${venueId}/dishes/${dishId}/revisions`;
  it('derives actor from verification and passes validated content to the transaction', async () => {
    const result = {
      dishId,
      revisionId: crypto.randomUUID(),
      version: 1,
      name: 'Soup',
      description: '',
    };
    const execute = vi.fn().mockResolvedValue(result);
    const verify = vi.fn().mockResolvedValue(actorId);
    const response = await createApp({ verify, execute }).request(path, {
      method: 'POST',
      headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(execute).toHaveBeenCalledWith(actorId, venueId, { ...command, dishId }, {});
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('rejects malformed JSON, forged authority, wrong media type and oversized bodies before writing', async () => {
    const execute = vi.fn();
    const testApp = createApp({ verify: async () => actorId, execute });
    for (const [body, contentType, status] of [
      ['{', 'application/json', 400],
      [JSON.stringify({ ...command, actorId }), 'application/json', 400],
      [JSON.stringify(command), 'text/plain', 415],
      ['x'.repeat(16_385), 'application/json', 413],
    ] as const) {
      const response = await testApp.request(path, {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': contentType },
        body,
      });
      expect(response.status).toBe(status);
    }
    expect(execute).not.toHaveBeenCalled();
  });
  it('fails closed when hosted authentication is unconfigured', async () => {
    const response = await app.request(path, {
      method: 'POST',
      headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
  });
});

describe('review candidate HTTP boundaries', () => {
  const venueId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const extractionId = 'extraction:e1bb4c9c059eb377dc7e92f340e78416';
  const candidateId = 'draft:0bbe00087c6841623c76d7b6f9da5ebf';
  const actorId = 'a11ac10b-58cc-4372-a567-0e02b2c3d479';
  const commandId = 'c11ac10b-58cc-4372-a567-0e02b2c3d479';

  const sessionPath = `/venues/${venueId}/extractions/${extractionId}/review-session`;
  const candidatesPath = `/venues/${venueId}/extractions/${extractionId}/candidates`;
  const reviewPath = `/venues/${venueId}/extractions/${extractionId}/candidates/${candidateId}/review`;

  const minimalExtractionResult = fixtureV2;

  describe('PUT .../review-session', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const response = await app.request(sessionPath, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId, extractionResult: minimalExtractionResult }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    });

    it('rejects unsupported media type with 415', async () => {
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
      });
      const response = await testApp.request(sessionPath, {
        method: 'PUT',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'text/plain' },
        body: 'invalid',
      });
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: 'unsupported_media_type' });
    });

    it('rejects malformed JSON with 400', async () => {
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
      });
      const response = await testApp.request(sessionPath, {
        method: 'PUT',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: '{ malformed json',
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_json' });
    });

    it('rejects mismatched extraction_id with 400', async () => {
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
      });
      const response = await testApp.request(sessionPath, {
        method: 'PUT',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId,
          extractionResult: {
            ...minimalExtractionResult,
            extraction_id: 'extraction:mismatched',
          },
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    });

    it('delegates to upsertReviewSession and returns 200 on valid request', async () => {
      const expectedResponse = {
        schemaVersion: 1,
        venueId,
        extractionResult: minimalExtractionResult,
        items: [],
        privateArtifactRef: null,
        published: false,
      };
      const upsertReviewSession = vi.fn().mockResolvedValue(expectedResponse);
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
        upsertReviewSession,
      });
      const response = await testApp.request(sessionPath, {
        method: 'PUT',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId, extractionResult: minimalExtractionResult }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expectedResponse);
      expect(upsertReviewSession).toHaveBeenCalledWith(
        actorId,
        venueId,
        { commandId, extractionResult: minimalExtractionResult },
        {},
      );
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/);
    });
    it('enforces 512 KB limit on PUT review-session and allows bodies above 16 KB', async () => {
      const upsertReviewSession = vi.fn().mockResolvedValue({
        schemaVersion: 1,
        venueId,
        extractionResult: minimalExtractionResult,
        items: [],
        privateArtifactRef: null,
        published: false,
      });
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
        upsertReviewSession,
      });

      // Positive case: valid payload > 16 KB (padded metadata ~30 KB)
      const largePayload = {
        commandId,
        extractionResult: {
          ...minimalExtractionResult,
          segments: minimalExtractionResult.segments.map(
            (seg: (typeof minimalExtractionResult.segments)[number], i: number) =>
              i === 0 ? { ...seg, metadata: { ...seg.metadata, pad: 'x'.repeat(30_000) } } : seg,
          ),
        },
      };
      const largePayloadString = JSON.stringify(largePayload);
      expect(largePayloadString.length).toBeGreaterThan(16_384);
      expect(largePayloadString.length).toBeLessThan(524_288);

      const largeResponse = await testApp.request(sessionPath, {
        method: 'PUT',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: largePayloadString,
      });
      expect(largeResponse.status).toBe(200);
      expect(upsertReviewSession).toHaveBeenCalled();

      // Negative case: exceeds 512 KB
      const oversizeResponse = await testApp.request(sessionPath, {
        method: 'PUT',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: 'x'.repeat(524_289),
      });
      expect(oversizeResponse.status).toBe(413);
      expect(await oversizeResponse.json()).toEqual({ error: 'body_too_large' });
    });
  });

  describe('GET .../candidates', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const response = await app.request(candidatesPath);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    });

    it('delegates to getReviewSession and returns 200 on success', async () => {
      const expectedResponse = {
        schemaVersion: 1,
        venueId,
        extractionResult: minimalExtractionResult,
        items: [],
        privateArtifactRef: null,
        published: false,
      };
      const getReviewSession = vi.fn().mockResolvedValue(expectedResponse);
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
        getReviewSession,
      });
      const response = await testApp.request(candidatesPath, {
        headers: { Authorization: 'Bearer signed' },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expectedResponse);
      expect(getReviewSession).toHaveBeenCalledWith(actorId, venueId, extractionId, {});
    });
  });

  describe('POST .../review', () => {
    const validCorrectCommand = {
      commandId,
      expectedVersion: 0,
      action: 'correct',
      corrected: { name: 'Organic Soup', price_amount: '10.00' },
    };

    it('rejects unauthenticated requests with 401', async () => {
      const response = await app.request(reviewPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validCorrectCommand),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    });

    it('rejects oversized candidate review bodies (> 16 KB) with 413', async () => {
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
      });
      const response = await testApp.request(reviewPath, {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: 'x'.repeat(16_385),
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'body_too_large' });
    });
    it('strictly enforces 16 KB limit even when extractionId is literal review-session', async () => {
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
      });
      const bypassAttemptPath = `/venues/${venueId}/extractions/review-session/candidates/${candidateId}/review`;
      const response = await testApp.request(bypassAttemptPath, {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: 'x'.repeat(16_385),
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'body_too_large' });
    });

    it('rejects invalid action commands with 400', async () => {
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
      });
      // action correct without corrected fields
      const response = await testApp.request(reviewPath, {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId,
          expectedVersion: 0,
          action: 'correct',
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    });

    it('delegates to saveCandidateReview and returns 200 on success', async () => {
      const expectedItemResponse = {
        candidate: {
          candidate_id: candidateId,
          original: {
            name: 'Garden Soup',
            description: null,
            category: null,
            price_amount: null,
            price_currency: null,
            ingredients: null,
            source_id: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            source_text: 'Soup',
            image_id: null,
            review_warnings: [],
            status: 'needs_review',
          },
          evidence: [{ segment_id: 'seg:1', start: 0, end: 4 }],
          missing_fields: [],
        },
        review: {
          extractionId,
          candidateId,
          revisionId: crypto.randomUUID(),
          version: 1,
          reviewStatus: 'corrected',
          corrected: { name: 'Organic Soup', price_amount: '10.00' },
          editedFields: ['name', 'price_amount'],
          incompleteFields: [],
          reviewNote: null,
          reviewedBy: actorId,
          reviewedAt: new Date().toISOString(),
          publishable: false,
        },
        effective: {
          name: 'Organic Soup',
          description: null,
          category: null,
          price_amount: '10.00',
          price_currency: null,
          ingredients: null,
        },
      };

      const saveCandidateReview = vi.fn().mockResolvedValue(expectedItemResponse);
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
        saveCandidateReview,
      });
      const response = await testApp.request(reviewPath, {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: JSON.stringify(validCorrectCommand),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expectedItemResponse);
      expect(saveCandidateReview).toHaveBeenCalledWith(
        actorId,
        venueId,
        extractionId,
        candidateId,
        validCorrectCommand,
        {},
      );
    });
    it('maps ReviewCommandError codes and statuses properly in app.onError', async () => {
      for (const [code, status] of [
        ['forbidden', 403],
        ['not_found', 404],
        ['version_conflict', 409],
        ['command_conflict', 409],
        ['invalid_candidate', 400],
      ] as const) {
        const saveCandidateReview = vi.fn().mockRejectedValue(new ReviewCommandError(code, status));
        const testApp = createApp({
          verify: async () => actorId,
          execute: vi.fn(),
          saveCandidateReview,
        });
        const response = await testApp.request(reviewPath, {
          method: 'POST',
          headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
          body: JSON.stringify(validCorrectCommand),
        });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ error: code });
      }
    });
  });
});
