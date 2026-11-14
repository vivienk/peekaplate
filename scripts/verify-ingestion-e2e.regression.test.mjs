import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sanitizeEvidence,
  validateExtractionReport,
  verifyIngestionE2E,
} from './verify-ingestion-e2e.mjs';

const jobId = '11111111-1111-4111-8111-111111111111';
const venueId = '22222222-2222-4222-8222-222222222222';
const otherVenueId = '33333333-3333-4333-8333-333333333333';
const draftId = '44444444-4444-4444-8444-444444444444';
const attempt = '55555555-5555-4555-8555-555555555555';
const sourceHash = 'a'.repeat(64);
function fixture() {
  return {
    job: {
      id: jobId,
      tenant_id: venueId,
      status: 'complete',
      claim_token: null,
      locked_at: null,
      draft_count: 1,
      source_hash: sourceHash,
      result_storage_key: `reports/${venueId}/${jobId}/attempts/${attempt}/extraction.json`,
      finished_at: '2026-11-14T20:00:00Z',
    },
    drafts: [
      {
        id: draftId,
        tenant_id: venueId,
        job_id: jobId,
        draft_id: 'dish-0',
        draft_index: 0,
        extraction_status: 'needs_review',
        review_status: 'pending',
        verification_status: 'not_verified',
        evidence: { code_point_spans: [] },
      },
    ],
    report: {
      schema_version: 2,
      pipeline_version: '3',
      status: 'complete',
      source: { sha256: sourceHash },
      segments: [],
      drafts: [{ draft_id: 'dish-0', draft_index: 0 }],
      evidence: [{ draft_id: 'dish-0', draft_index: 0 }],
    },
  };
}
async function verify(f = fixture(), options = {}) {
  const requests = [];
  const request = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/verify'))
      return new Response('{}', {
        status: init.headers.Authorization === 'Bearer viewer-test' ? 403 : 400,
      });
    if (url.includes(`/venues/${otherVenueId}/`)) return new Response('{}', { status: 403 });
    if (url.includes('/drafts?')) return Response.json({ drafts: f.drafts });
    return Response.json(f.job === undefined ? {} : { job: f.job });
  };
  const outcome = await verifyIngestionE2E({
    jobId,
    venueId,
    token: 'owner-test',
    request,
    progress: () => {},
    ...options,
  });
  return { outcome, requests };
}

test('real-shaped completed job, draft and source report pass without an invented extraction_id', async () => {
  const f = fixture();
  const { outcome } = await verify(f, {
    reportJson: 'synthetic-report.json',
    readFileFn: async () => JSON.stringify(f.report),
  });
  assert.equal(outcome.passed, true);
});
test('missing or failed job and missing or empty drafts cannot pass', async () => {
  for (const change of [
    (f) => {
      f.job = undefined;
    },
    (f) => {
      f.job.status = 'failed';
    },
    (f) => {
      f.drafts = undefined;
    },
    (f) => {
      f.drafts = [];
      f.job.draft_count = 0;
    },
  ]) {
    const f = fixture();
    change(f);
    assert.equal((await verify(f)).outcome.passed, false);
  }
});
test('foreign job and malformed or foreign draft identities fail closed', async () => {
  for (const change of [
    (f) => {
      f.job.id = draftId;
    },
    (f) => {
      f.job.tenant_id = otherVenueId;
    },
    (f) => {
      f.drafts[0].tenant_id = otherVenueId;
    },
    (f) => {
      f.drafts[0].job_id = draftId;
    },
    (f) => {
      f.drafts[0].id = 'not-a-uuid';
    },
    (f) => {
      f.drafts[0].draft_index = -1;
    },
    (f) => {
      f.drafts[0].evidence = [];
    },
    (f) => {
      f.job.source_hash = null;
    },
    (f) => {
      f.drafts.push({ ...f.drafts[0], draft_index: 1 });
      f.job.draft_count = 2;
    },
  ]) {
    const f = fixture();
    change(f);
    assert.equal((await verify(f)).outcome.passed, false);
  }
});
test('only supported schema/pipeline pairs are accepted', () => {
  for (const pair of [
    [1, '3'],
    [2, '2'],
  ]) {
    assert.equal(
      validateExtractionReport({
        ...fixture().report,
        schema_version: pair[0],
        pipeline_version: pair[1],
      }).valid,
      false,
    );
  }
});
test('producer evidence ID remains authoritative when candidate ID differs', async () => {
  const f = fixture();
  f.report.drafts[0] = { candidate_id: 'distinct-candidate', draft_index: 0 };
  assert.equal(
    (
      await verify(f, {
        reportJson: 'report.json',
        readFileFn: async () => JSON.stringify(f.report),
      })
    ).outcome.passed,
    true,
  );
});
test('viewer probe uses identity-first verify route and never approve', async () => {
  const { outcome, requests } = await verify(fixture(), {
    viewerToken: 'viewer-test',
    requirePr161: true,
    crossTenantVenueId: otherVenueId,
  });
  assert.equal(outcome.passed, true);
  assert.ok(
    requests
      .filter((r) => r.init.headers.Authorization === 'Bearer viewer-test')
      .every((r) => r.url.endsWith('/verify')),
  );
});
test('same-count report from another source, status or producer draft fails', async () => {
  for (const change of [
    (f) => {
      f.report.source.sha256 = 'b'.repeat(64);
    },
    (f) => {
      f.report.status = 'incomplete';
    },
    (f) => {
      f.report.drafts[0].draft_id = 'unrelated';
      f.report.evidence[0].draft_id = 'unrelated';
    },
  ]) {
    const f = fixture();
    change(f);
    assert.equal(
      (
        await verify(f, {
          reportJson: 'synthetic-report.json',
          readFileFn: async () => JSON.stringify(f.report),
        })
      ).outcome.passed,
      false,
    );
  }
});
test('report-only and requested report without a reader do not claim API acceptance', async () => {
  const f = fixture();
  assert.equal(
    (
      await verify(f, {
        token: undefined,
        reportJson: 'report.json',
        readFileFn: async () => JSON.stringify(f.report),
      })
    ).outcome.passed,
    false,
  );
  assert.equal((await verify(f, { reportJson: 'report.json' })).outcome.passed, false);
});
test('verifier reports unknown upstream calls rather than a fabricated zero or enforced cap', async () => {
  const { outcome } = await verify();
  assert.equal(outcome.providerCallsConsumed, null);
  assert.equal(outcome.providerBudgetEnforced, false);
  assert.equal(outcome.providerCallsByVerifier, 0);
  assert.equal(sanitizeEvidence(outcome).providerCallsConsumed, null);
});
test('bearers never go to arbitrary origins and redirects are rejected', async () => {
  let called = false;
  await assert.rejects(
    () =>
      verifyIngestionE2E({
        jobId,
        venueId,
        token: 'owner-test',
        apiUrl: 'https://attacker.example',
        request: async () => {
          called = true;
        },
        progress: () => {},
      }),
    /API|origin/i,
  );
  assert.equal(called, false);
  const { requests } = await verify();
  assert.ok(requests.every((r) => r.init.redirect === 'error' && r.init.signal));
});
test('sanitized evidence omits unvalidated IDs, keys and secret-bearing fields', () => {
  const result = sanitizeEvidence({
    jobId,
    venueId,
    passed: false,
    checks: [],
    requestIds: ['Bearer secret-marker'],
    evidenceIds: {
      sourceHash: 'Bearer secret-marker',
      resultStorageKey: 'Bearer secret-marker',
      extractionId: 'Bearer secret-marker',
      draftIds: ['Bearer secret-marker'],
    },
  });
  assert.ok(!JSON.stringify(result).includes('secret-marker'));
});
