import assert from 'node:assert/strict';
import test from 'node:test';
import { validateExtractionReport, verifyIngestionE2E } from './verify-ingestion-e2e.mjs';

test('validateExtractionReport validates schema 1 / pipeline 2', () => {
  const report = {
    schema_version: 1,
    pipeline_version: '2',
    status: 'complete',
    drafts: [],
    segments: [],
    evidence: [],
  };
  const result = validateExtractionReport(report);
  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0);
});

test('validateExtractionReport validates schema 2 / pipeline 3', () => {
  const report = {
    schema_version: 2,
    pipeline_version: '3',
    status: 'incomplete',
    drafts: [{ name: 'Dish' }],
    segments: [{ segment_id: 's1' }],
    evidence: [{ draft_id: 'd1' }],
  };
  const result = validateExtractionReport(report);
  assert.equal(result.valid, true);
});

test('validateExtractionReport rejects invalid versions and missing arrays', () => {
  const report = {
    schema_version: 99,
    pipeline_version: '4',
    status: 'invalid_status',
  };
  const result = validateExtractionReport(report);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.includes('schema_version')));
  assert.ok(result.issues.some((i) => i.includes('pipeline_version')));
  assert.ok(result.issues.some((i) => i.includes('drafts')));
});

test('verifyIngestionE2E rejects missing or invalid UUIDs', async () => {
  await assert.rejects(
    () => verifyIngestionE2E({ jobId: 'invalid', venueId: '00000000-0000-0000-0000-000000000001' }),
    /Invalid or missing --job-id UUID/,
  );

  await assert.rejects(
    () =>
      verifyIngestionE2E({ jobId: '00000000-0000-0000-0000-000000000001', venueId: 'not-a-uuid' }),
    /Invalid or missing --venue-id UUID/,
  );
});

test('verifyIngestionE2E performs mock API verification and validates draft invariants', async () => {
  const testJobId = '11111111-1111-1111-1111-111111111111';
  const testVenueId = '22222222-2222-2222-2222-222222222222';

  const mockJob = {
    id: testJobId,
    tenant_id: testVenueId,
    status: 'complete',
    claim_token: null,
    locked_at: null,
    draft_count: 2,
    result_storage_key: `reports/${testVenueId}/${testJobId}/extraction.json`,
    finished_at: new Date().toISOString(),
  };

  const mockDrafts = [
    {
      id: 'd1',
      tenant_id: testVenueId,
      job_id: testJobId,
      draft_index: 0,
      extraction_status: 'needs_review',
      review_status: 'pending',
      evidence: { spans: [] },
    },
    {
      id: 'd2',
      tenant_id: testVenueId,
      job_id: testJobId,
      draft_index: 1,
      extraction_status: 'needs_review',
      review_status: 'pending',
      evidence: { spans: [] },
    },
  ];

  const mockFetch = async (url) => {
    if (url.includes(`/venues/${testVenueId}/menus/jobs/${testJobId}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ job: mockJob }),
      };
    }
    if (url.includes(`/venues/${testVenueId}/drafts?jobId=${testJobId}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ drafts: mockDrafts }),
      };
    }
    return { ok: false, status: 404 };
  };

  const outcome = await verifyIngestionE2E({
    jobId: testJobId,
    venueId: testVenueId,
    token: 'test-token',
    request: mockFetch,
    progress: () => {},
  });

  assert.equal(outcome.passed, true);
  assert.equal(outcome.drafts.length, 2);
  assert.ok(outcome.checks.every((c) => c.passed));
});

test('verifyIngestionE2E fails when zero checks are performed', async () => {
  const testJobId = '11111111-1111-1111-1111-111111111111';
  const testVenueId = '22222222-2222-2222-2222-222222222222';

  const outcome = await verifyIngestionE2E({
    jobId: testJobId,
    venueId: testVenueId,
    // Neither token nor reportJson provided
    progress: () => {},
  });

  assert.equal(outcome.passed, false);
  assert.equal(outcome.checks.length, 1);
  assert.equal(outcome.checks[0].name, 'Verification Execution');
  assert.equal(outcome.checks[0].passed, false);
  assert.match(outcome.checks[0].details, /No checks were executed/i);
});
