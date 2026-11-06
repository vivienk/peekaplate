import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import {
  type UpsertExtractionReviewSessionRequest,
  UpsertExtractionReviewSessionRequestSchema,
} from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import { type ReviewArtifactReader, verifyReviewArtifact } from './review-artifact';
import { ReviewCommandError } from './review-command';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../../processing/tests/fixtures/review-candidates/${name}`, import.meta.url),
      ),
      'utf8',
    ),
  );

// The v2 pair is the processor-shaped report and its exported review candidates.
const report = fixture('representative-extraction-v2.json');
const candidates = fixture('representative-candidates-v2.json');

const venueId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const jobId = '0b9f2c8e-6f1d-4b7a-9c3e-2d5a7e1f4b60';
const attemptId = '7c1e5d2a-3b4f-4e6a-8d9c-1a2b3c4d5e6f';
const key = `menu-ingestion/review-artifacts/${venueId}/${jobId}/${attemptId}/bundle.json`;

/** Mirrors the extraction host: the stored bytes are the bundle plus its server-derived scope. */
function storedBundle(overrides: { report?: unknown; scope?: Record<string, unknown> } = {}) {
  return JSON.stringify({
    schema_version: 1,
    report: overrides.report ?? report,
    review_suggestions: { schema_version: 1, suggestions: [] },
    timings: { schema_version: 1, timings_seconds: {} },
    scope: {
      tenant_id: venueId,
      job_id: jobId,
      source_hash: report.source.sha256,
      attempt_id: attemptId,
      ...overrides.scope,
    },
  });
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function reader(objects: Record<string, string>): ReviewArtifactReader {
  return async (k) => {
    const text = objects[k];
    if (text === undefined) return null;
    const bytes = new TextEncoder().encode(text);
    return { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
  };
}

function request(
  extractionResult: unknown = candidates,
  ref: { key: string; sha256: string } | null = { key, sha256: sha(storedBundle()) },
  job: string | null = jobId,
): UpsertExtractionReviewSessionRequest {
  return UpsertExtractionReviewSessionRequestSchema.parse({
    commandId: 'c11ac10b-58cc-4372-a567-0e02b2c3d479',
    extractionResult,
    ...(job ? { jobId: job } : {}),
    privateArtifactRef: ref ? { schema_version: 1, ...ref } : null,
  });
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    if (error instanceof ReviewCommandError) return `${error.status} ${error.code}`;
    throw error;
  }
}

describe('verifyReviewArtifact', () => {
  const read = reader({ [key]: storedBundle() });

  it('accepts candidates that exactly match the stored producer bundle', async () => {
    expect(
      await codeOf(verifyReviewArtifact({ appEnv: 'staging', venueId, input: request(), read })),
    ).toBe('ok');
  });

  it('requires the artifact reference and job outside local, but not for local fixtures', async () => {
    const noRef = request(candidates, null);
    expect(
      await codeOf(verifyReviewArtifact({ appEnv: 'staging', venueId, input: noRef, read })),
    ).toBe('400 artifact_required');
    expect(
      await codeOf(verifyReviewArtifact({ appEnv: undefined, venueId, input: noRef, read })),
    ).toBe('400 artifact_required');
    expect(
      await codeOf(verifyReviewArtifact({ appEnv: 'local', venueId, input: noRef, read })),
    ).toBe('ok');
    const noJob = request(candidates, { key, sha256: sha(storedBundle()) }, null);
    expect(
      await codeOf(verifyReviewArtifact({ appEnv: 'local', venueId, input: noJob, read })),
    ).toBe('400 artifact_required');
  });

  it('rejects a fabricated original even when the client supplies a valid reference', async () => {
    const tampered = structuredClone(candidates);
    tampered.candidates[0].original.name = 'Invented Dish';
    expect(
      await codeOf(
        verifyReviewArtifact({ appEnv: 'staging', venueId, input: request(tampered), read }),
      ),
    ).toBe('409 artifact_mismatch');
  });

  it('rejects added, removed or re-pointed candidates and altered evidence spans', async () => {
    const extra = structuredClone(candidates);
    extra.candidates.push({
      ...structuredClone(candidates.candidates[0]),
      candidate_id: 'draft:ffffffffffffffffffffffffffffffff',
    });
    const fewer = structuredClone(candidates);
    fewer.candidates.pop();
    const spans = structuredClone(candidates);
    spans.candidates[0].evidence[0].end -= 1;
    let verified = 0;
    for (const input of [extra, fewer, spans]) {
      const parsed = UpsertExtractionReviewSessionRequestSchema.safeParse({
        commandId: 'c11ac10b-58cc-4372-a567-0e02b2c3d479',
        extractionResult: input,
        jobId,
        privateArtifactRef: { schema_version: 1, key, sha256: sha(storedBundle()) },
      });
      if (!parsed.success) continue; // the contract already rejects it before verification
      verified += 1;
      expect(
        await codeOf(
          verifyReviewArtifact({ appEnv: 'staging', venueId, input: parsed.data, read }),
        ),
      ).toBe('409 artifact_mismatch');
    }
    expect(verified).toBeGreaterThan(0);
  });

  it('rejects a reference whose hash does not match the stored bytes', async () => {
    const wrongHash = request(candidates, { key, sha256: 'a'.repeat(64) });
    expect(
      await codeOf(verifyReviewArtifact({ appEnv: 'staging', venueId, input: wrongHash, read })),
    ).toBe('409 artifact_mismatch');
  });

  it('rejects keys outside the request venue and job, or with extra segments', async () => {
    const otherVenue = 'e47ac10b-58cc-4372-a567-0e02b2c3d479';
    const otherJob = '1b9f2c8e-6f1d-4b7a-9c3e-2d5a7e1f4b60';
    for (const badKey of [
      key.replace(venueId, otherVenue),
      key.replace(jobId, otherJob),
      key.replace(`${attemptId}/`, `${attemptId}/../`),
      `${key}.old`,
    ]) {
      const input = request(candidates, { key: badKey, sha256: sha(storedBundle()) });
      expect(await codeOf(verifyReviewArtifact({ appEnv: 'staging', venueId, input, read }))).toBe(
        '400 invalid_candidate',
      );
    }
  });

  it('rejects a bundle whose stored scope or source does not match the request', async () => {
    for (const scope of [
      { tenant_id: 'e47ac10b-58cc-4372-a567-0e02b2c3d479' },
      { job_id: '1b9f2c8e-6f1d-4b7a-9c3e-2d5a7e1f4b60' },
      { attempt_id: '8c1e5d2a-3b4f-4e6a-8d9c-1a2b3c4d5e6f' },
      { source_hash: 'b'.repeat(64) },
    ]) {
      const text = storedBundle({ scope });
      const input = request(candidates, { key, sha256: sha(text) });
      expect(
        await codeOf(
          verifyReviewArtifact({
            appEnv: 'staging',
            venueId,
            input,
            read: reader({ [key]: text }),
          }),
        ),
      ).toBe('409 artifact_mismatch');
    }
  });

  it('reports a missing object and a missing bucket binding distinctly', async () => {
    expect(
      await codeOf(
        verifyReviewArtifact({ appEnv: 'staging', venueId, input: request(), read: reader({}) }),
      ),
    ).toBe('404 artifact_not_found');
    expect(
      await codeOf(
        verifyReviewArtifact({ appEnv: 'staging', venueId, input: request(), read: undefined }),
      ),
    ).toBe('503 artifact_unavailable');
  });
});
