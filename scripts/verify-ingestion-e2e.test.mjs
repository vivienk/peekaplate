import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSyntheticInput,
  createProviderCallGuard,
  MAX_PROVIDER_CALLS,
  redactSecrets,
  sanitizeEvidence,
  validateExtractionReport,
  verifyIngestionE2E,
} from './verify-ingestion-e2e.mjs';

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

test('createProviderCallGuard enforces hard two-call maximum', () => {
  assert.equal(MAX_PROVIDER_CALLS, 2);
  assert.throws(() => createProviderCallGuard(3), /between 0 and 2/);

  const guard = createProviderCallGuard(2);
  assert.equal(guard.consume('first_call'), 1);
  assert.equal(guard.consume('second_call'), 2);
  assert.throws(() => guard.consume('third_call'), /Provider call budget exceeded/);
});

test('assertSyntheticInput requires valid UUID and synthetic/test label', () => {
  assert.throws(
    () => assertSyntheticInput({ venueId: 'not-a-uuid', label: 'synthetic menu' }),
    /Invalid synthetic venueId/,
  );
  assert.throws(
    () =>
      assertSyntheticInput({
        venueId: '22222222-2222-2222-2222-222222222222',
        label: 'real customer menu',
      }),
    /explicitly labelled as synthetic/,
  );
  assert.doesNotThrow(() =>
    assertSyntheticInput({
      venueId: '22222222-2222-2222-2222-222222222222',
      label: 'synthetic two-dish PDF',
    }),
  );
});

test('verifyIngestionE2E checks PR #161, cross-tenant 403, viewer 403, request IDs, and sanitized evidence', async () => {
  const testJobId = '11111111-1111-1111-1111-111111111111';
  const testVenueId = '22222222-2222-2222-2222-222222222222';
  const otherVenueId = '33333333-3333-3333-3333-333333333333';

  const mockJob = {
    id: testJobId,
    tenant_id: testVenueId,
    status: 'complete',
    claim_token: null,
    locked_at: null,
    draft_count: 1,
    source_hash: 'a'.repeat(64),
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
      verification_status: 'not_verified',
      evidence: { spans: [] },
    },
  ];

  const mockFetch = async (url, init) => {
    const headers = new Headers({ 'x-request-id': 'req-test-123' });
    if (url.includes(`/venues/${otherVenueId}/menus/jobs/${testJobId}`)) {
      return { ok: false, status: 403, headers };
    }
    if (url.endsWith('/verify')) {
      return { ok: false, status: 400, headers };
    }
    if (url.endsWith('/approve') && init?.headers?.Authorization === 'Bearer viewer-jwt') {
      return { ok: false, status: 403, headers };
    }
    if (url.includes(`/venues/${testVenueId}/menus/jobs/${testJobId}`)) {
      return { ok: true, status: 200, headers, json: async () => ({ job: mockJob }) };
    }
    if (url.includes(`/venues/${testVenueId}/drafts?jobId=${testJobId}`)) {
      return { ok: true, status: 200, headers, json: async () => ({ drafts: mockDrafts }) };
    }
    return { ok: false, status: 404, headers };
  };

  const outcome = await verifyIngestionE2E({
    jobId: testJobId,
    venueId: testVenueId,
    token: 'owner-jwt',
    crossTenantVenueId: otherVenueId,
    viewerToken: 'viewer-jwt',
    requirePr161: true,
    request: mockFetch,
    progress: () => {},
  });

  assert.equal(outcome.passed, true);
  assert.equal(outcome.requestIds.length, 5);
  assert.equal(outcome.evidenceIds.sourceHash, 'a'.repeat(64));

  const evidence = sanitizeEvidence(outcome);
  assert.equal(evidence.providerCallsConsumed, 0);
  assert.equal(evidence.maxProviderCalls, 2);
  assert.ok(!JSON.stringify(evidence).includes('owner-jwt'));
  assert.ok(!JSON.stringify(evidence).includes('viewer-jwt'));
});

test('provider guard blocks concurrent bypass and validates synthetic input before consuming budget', async () => {
  const guard = createProviderCallGuard(2);
  const validSynthetic = {
    venueId: '22222222-2222-2222-2222-222222222222',
    label: 'synthetic menu',
  };

  await assert.rejects(
    () =>
      guard.execute(
        { venueId: '22222222-2222-2222-2222-222222222222', label: 'prod menu' },
        'invalid',
        async () => 'should-not-run',
      ),
    /explicitly labelled as synthetic/,
  );
  assert.equal(guard.consumed, 0);

  const settled = await Promise.allSettled([
    guard.execute(validSynthetic, 'call-1', async () => 'ok-1'),
    guard.execute(validSynthetic, 'call-2', async () => 'ok-2'),
    guard.execute(validSynthetic, 'call-3', async () => 'should-not-run'),
  ]);
  assert.equal(guard.consumed, 2);
  assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 2);
  assert.equal(settled.filter((r) => r.status === 'rejected').length, 1);
});

test('redactSecrets and sanitizeEvidence scrub tokens, JWTs, and query secrets reproducibly', () => {
  const raw =
    'Failed GET https://example.com?token=secret123&api_key=abc Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
  const redacted = redactSecrets(raw);
  assert.ok(!redacted.includes('secret123'));
  assert.ok(!redacted.includes('abc'));
  assert.ok(!redacted.includes('eyJhbGciOiJIUzI1NiJ9'));

  const evidence = sanitizeEvidence(
    {
      jobId: '11111111-1111-1111-1111-111111111111',
      venueId: '22222222-2222-2222-2222-222222222222',
      passed: false,
      checks: [{ name: 'Auth', passed: false, details: raw }],
    },
    { verifiedAt: '2026-11-14T20:00:00.000Z' },
  );
  assert.equal(evidence.verifiedAt, '2026-11-14T20:00:00.000Z');
  assert.ok(!evidence.checks[0].details.includes('secret123'));
});

test('verifyIngestionE2E distinguishes 401 auth failure from 403 authz denial', async () => {
  const testJobId = '11111111-1111-1111-1111-111111111111';
  const testVenueId = '22222222-2222-2222-2222-222222222222';
  const otherVenueId = '33333333-3333-3333-3333-333333333333';

  const outcome = await verifyIngestionE2E({
    jobId: testJobId,
    venueId: testVenueId,
    token: 'expired-jwt',
    crossTenantVenueId: otherVenueId,
    request: async () => ({ ok: false, status: 401, headers: new Headers() }),
    progress: () => {},
  });

  assert.equal(outcome.passed, false);
  const crossCheck = outcome.checks.find((c) => c.name === 'Cross-Tenant Isolation (403)');
  assert.equal(crossCheck?.passed, false);
  assert.match(crossCheck?.details ?? '', /Authentication failed \(401\)/);
});
