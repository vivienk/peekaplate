import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PROVIDER_CALLS,
  redactSecrets,
  sanitizeEvidence,
  validateExtractionReport,
  validateReportProvenance,
  verifyIngestionE2E,
} from './verify-ingestion-e2e.mjs';

const ids = {
  jobId: '11111111-1111-4111-8111-111111111111',
  venueId: '22222222-2222-4222-8222-222222222222',
};
test('report versions use real source hashes and reject malformed arrays', () => {
  const report = {
    schema_version: 1,
    pipeline_version: '2',
    status: 'complete',
    source: { sha256: 'a'.repeat(64) },
    drafts: [],
    segments: [],
    evidence: [],
  };
  assert.equal(validateExtractionReport(report).valid, true);
  assert.equal(
    validateExtractionReport({ ...report, schema_version: 2, pipeline_version: '3' }).valid,
    true,
  );
  for (const bad of [
    null,
    [],
    { ...report, evidence: [null] },
    { ...report, source: null },
    { ...report, pipeline_version: '4' },
  ])
    assert.equal(validateExtractionReport(bad).valid, false);
});
test('invalid IDs, outcomes and declared allowance reject before network access', async () => {
  assert.equal(MAX_PROVIDER_CALLS, 2);
  for (const options of [
    { jobId: 'invalid' },
    { venueId: 'invalid' },
    { expectedStatus: 'failed' },
    { maxProviderCalls: 3 },
    { maxProviderCalls: -1 },
    { maxProviderCalls: NaN },
  ])
    await assert.rejects(
      () =>
        verifyIngestionE2E({
          ...ids,
          ...options,
          request: () => {
            throw Error('must not request');
          },
          progress: () => {},
        }),
      /Invalid|allowance/,
    );
});
test('no session cannot silently pass and 401 cannot stand in for a 403', async () => {
  assert.equal((await verifyIngestionE2E({ ...ids, progress: () => {} })).passed, false);
  const result = await verifyIngestionE2E({
    ...ids,
    token: 'expired-test',
    viewerToken: 'expired-viewer',
    crossTenantVenueId: '33333333-3333-4333-8333-333333333333',
    request: async () => new Response('{}', { status: 401 }),
    progress: () => {},
  });
  assert.equal(result.passed, false);
  for (const name of ['Cross-Tenant Isolation (403)', 'Viewer Write Denial (403)'])
    assert.match(
      result.checks.find((c) => c.name === name).details,
      /Authentication failed \(401\)/,
    );
});
test('credentials are redacted and evidence carries unknown upstream usage explicitly', () => {
  const raw =
    'https://example.com?token=secret123&api_key=secret456 Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
  const evidence = sanitizeEvidence(
    { ...ids, passed: false, checks: [{ name: 'Auth', passed: false, details: raw }] },
    { verifiedAt: '2026-11-14T20:00:00Z' },
  );
  assert.ok(!redactSecrets(raw).includes('secret123'));
  assert.ok(!JSON.stringify(evidence).includes('secret456'));
  assert.ok(!JSON.stringify(evidence).includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.equal(evidence.providerCallsConsumed, null);
  assert.equal(evidence.providerBudgetEnforced, false);
});
test('author source pins and optional job identity reject mismatches without echoing values', () => {
  const report = {
    job_id: ids.jobId,
    source: { source_id: 'synthetic-source', sha256: 'a'.repeat(64) },
    drafts: [{ draft_id: 'dish-0' }],
    evidence: [{ draft_id: 'dish-0', draft_index: 0 }],
  };
  assert.equal(
    validateReportProvenance(report, {
      ...ids,
      expectedSourceId: 'synthetic-source',
      expectedSourceHash: 'a'.repeat(64),
    }).valid,
    true,
  );
  assert.equal(
    validateReportProvenance({
      ...report,
      drafts: [{ draft_id: 'dish-0', draft_index: 7 }],
      evidence: [{ draft_id: 'dish-0', draft_index: 7 }],
    }).valid,
    true,
  );
  for (const pins of [
    { jobId: ids.venueId },
    { expectedSourceId: 'other-source' },
    { expectedSourceHash: 'b'.repeat(64) },
  ])
    assert.equal(validateReportProvenance(report, pins).valid, false);
  const bad = validateReportProvenance({
    drafts: [{ draft_id: 'dish-0' }],
    evidence: [{ draft_id: 'unrelated', draft_index: 5 }],
  });
  assert.equal(bad.valid, false);
  assert.ok(bad.issues.some((x) => x.includes('unknown draft_id')));
  assert.ok(bad.issues.some((x) => x.includes('out-of-range')));
});
