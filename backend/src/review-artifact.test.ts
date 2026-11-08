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

  it.each([
    ['location', 'invented-other-menu.pdf'],
    ['kind', 'website'],
    ['retrieved_at', '2026-10-26T12:00:00Z'],
    ['size_bytes', 999],
  ])('rejects altered source %s with an otherwise genuine artifact', async (field, value) => {
    const tampered = structuredClone(candidates);
    tampered.source[field] = value;
    expect(
      await codeOf(
        verifyReviewArtifact({ appEnv: 'staging', venueId, input: request(tampered), read }),
      ),
    ).toBe('409 artifact_mismatch');
  });

  it('accepts an equivalent source retrieval instant in a different ISO representation', async () => {
    const equivalent = structuredClone(candidates);
    equivalent.source.retrieved_at = '2026-10-25T13:00:00+01:00';
    expect(
      await codeOf(
        verifyReviewArtifact({ appEnv: 'staging', venueId, input: request(equivalent), read }),
      ),
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

describe('verifyReviewArtifact page coverage and diagnostics (PR #73 finding A)', () => {
  const read = reader({ [key]: storedBundle() });
  const verify = (extractionResult: unknown) =>
    codeOf(
      verifyReviewArtifact({ appEnv: 'staging', venueId, input: request(extractionResult), read }),
    );

  it('T-A1 rejects a request that drops failed or skipped segments from the stored report', async () => {
    expect(candidates.segments.map((s: { status: string }) => s.status)).toEqual([
      'ready',
      'failed',
      'skipped',
    ]);
    const onlyReady = structuredClone(candidates);
    onlyReady.segments = onlyReady.segments.filter((s: { status: string }) => s.status === 'ready');
    const noSkipped = structuredClone(candidates);
    noSkipped.segments = noSkipped.segments.filter(
      (s: { status: string }) => s.status !== 'skipped',
    );
    expect(await verify(onlyReady)).toBe('409 artifact_mismatch');
    expect(await verify(noSkipped)).toBe('409 artifact_mismatch');
  });

  it('T-A2 rejects a request whose errors were cleared', async () => {
    const cleared = structuredClone(candidates);
    expect(cleared.errors.length).toBeGreaterThan(0);
    cleared.errors = [];
    expect(await verify(cleared)).toBe('409 artifact_mismatch');
  });

  it('T-A3 rejects a request whose warnings were cleared', async () => {
    const cleared = structuredClone(candidates);
    expect(cleared.warnings.length).toBeGreaterThan(0);
    cleared.warnings = [];
    expect(await verify(cleared)).toBe('409 artifact_mismatch');
  });

  it('T-A4 rejects a request that rewrites a failed segment as ready', async () => {
    const rewritten = structuredClone(candidates);
    const failed = rewritten.segments.find((s: { status: string }) => s.status === 'failed');
    failed.status = 'ready';
    failed.error = null;
    expect(await verify(rewritten)).toBe('409 artifact_mismatch');
  });

  it('T-A5 accepts the untouched exporter output, including exporter-added box links', async () => {
    expect(await verify(candidates)).toBe('ok');

    // Exporter-equivalent pair: the report carries box evidence on its evidence records and no
    // public map; the export adds metadata.candidate_box_evidence to the cited OCR segment.
    const boxed = boxEvidencePair();
    expect(await boxed.verify(boxed.exported)).toBe('ok');
  });

  it('T-A6 rejects forged or re-pointed box links while every other field still matches', async () => {
    const boxed = boxEvidencePair();
    const linked = boxed.exported.segments[0].metadata.candidate_box_evidence;
    const [owner = ''] = Object.keys(linked);
    expect(owner).toMatch(/^draft:/);
    const other = boxed.exported.candidates.find(
      (c: { candidate_id: string }) => c.candidate_id !== owner,
    ).candidate_id;

    const repointed = structuredClone(boxed.exported);
    repointed.segments[0].metadata.candidate_box_evidence = { [other]: linked[owner] };
    const injected = structuredClone(boxed.exported);
    injected.segments[0].metadata.candidate_box_evidence[owner][0].text = '9.99';
    const dropped = structuredClone(boxed.exported);
    delete dropped.segments[0].metadata.candidate_box_evidence;
    const outcomes: string[] = [];
    for (const forged of [repointed, injected, dropped]) {
      const parsed = UpsertExtractionReviewSessionRequestSchema.safeParse({
        commandId: 'c11ac10b-58cc-4372-a567-0e02b2c3d479',
        extractionResult: forged,
        jobId,
        privateArtifactRef: { schema_version: 1, key, sha256: boxed.sha },
      });
      // Each forged map still passes the contract, so the verifier is the guard under test.
      outcomes.push(
        parsed.success
          ? await codeOf(
              verifyReviewArtifact({
                appEnv: 'staging',
                venueId,
                input: parsed.data,
                read: boxed.read,
              }),
            )
          : 'contract rejected',
      );
    }
    expect(outcomes).toEqual(Array(3).fill('409 artifact_mismatch'));
  });
});

/**
 * Builds the producer report that the box-evidence export fixture was derived from, mirroring
 * review_candidates.export: drafts[i] pairs with evidence[draft_index=i], segments are copied and
 * only the cited OCR segment gains metadata.candidate_box_evidence.
 */
function boxEvidencePair() {
  const exported = fixture('box-evidence-candidates.json');
  const segments = structuredClone(exported.segments).map(
    (segment: { metadata: Record<string, unknown> }) => {
      delete segment.metadata.candidate_box_evidence;
      return segment;
    },
  );
  const links = exported.segments[0].metadata.candidate_box_evidence as Record<string, unknown[]>;
  const boxedReport = {
    schema_version: exported.schema_version,
    pipeline_version: exported.pipeline_version,
    status: exported.status,
    source: exported.source,
    started_at: exported.started_at,
    finished_at: exported.finished_at,
    segments,
    drafts: exported.candidates.map((c: { original: unknown }) => c.original),
    evidence: exported.candidates.map(
      (c: { candidate_id: string; evidence: unknown }, index: number) => ({
        draft_id: c.candidate_id,
        draft_index: index,
        spans: c.evidence,
        box_evidence: links[c.candidate_id] ?? [],
      }),
    ),
    warnings: exported.warnings,
    errors: exported.errors,
  };
  const text = storedBundle({
    report: boxedReport,
    scope: { source_hash: exported.source.sha256 },
  });
  const boxedRead = reader({ [key]: text });
  return {
    exported,
    sha: sha(text),
    read: boxedRead,
    verify: (extractionResult: unknown) =>
      codeOf(
        verifyReviewArtifact({
          appEnv: 'staging',
          venueId,
          input: request(extractionResult, { key, sha256: sha(text) }),
          read: boxedRead,
        }),
      ),
  };
}
