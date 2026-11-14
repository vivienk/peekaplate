import { parseArgs } from 'node:util';

export const MAX_PROVIDER_CALLS = 2;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const USAGE = `Usage: node scripts/verify-ingestion-e2e.mjs --job-id <uuid> --venue-id <uuid> [options]

Options:
  --job-id <uuid>              Ingestion job UUID to verify (required)
  --venue-id <uuid>            Tenant / venue UUID (required)
  --api-url <url>              API base URL (default: https://peekaplate-api-staging.vxkong.workers.dev)
  --token <bearer-token>       Staff Bearer authorization token for API verification
  --cross-tenant-venue-id <id> Secondary venue UUID expected to return 403 for --token
  --viewer-token <token>       Viewer/unauthorized token expected to return 403 on --venue-id
  --require-pr161              Require PR #161 verification_status fields and /verify route check
  --max-provider-calls <n>     Hard local harness call cap (default: 2, max: 2; does NOT enforce Queue/Python boundary)
  --expected-source-id <id>    Expected report.source.source_id for provenance verification (optional)
  --expected-source-hash <hex> Expected 64-hex SHA-256 of synthetic source for provenance verification (optional)
  --report-json <path>         Local path to downloaded extraction report JSON (optional)
  --evidence-out <path>        Write sanitized JSON evidence report to path (optional)
  --help, -h                   Show this help message
`;

/**
 * Redacts bearer tokens, JWTs, and sensitive query parameters from strings.
 */
export function redactSecrets(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
    .replace(
      /([?&](?:token|access_token|api_key|apikey|key|secret|password|auth)=)[^&\s]+/gi,
      '$1[REDACTED]',
    );
}

/**
 * Enforces the hard two-call provider budget and prevents uncontrolled retries.
 * Synchronous counter increment guarantees concurrent calls cannot bypass the limit.
 */
export function createProviderCallGuard(maxCalls = MAX_PROVIDER_CALLS) {
  if (!Number.isInteger(maxCalls) || maxCalls < 0 || maxCalls > MAX_PROVIDER_CALLS) {
    throw new Error(`maxProviderCalls must be an integer between 0 and ${MAX_PROVIDER_CALLS}`);
  }
  let consumed = 0;
  return {
    get consumed() {
      return consumed;
    },
    get limit() {
      return maxCalls;
    },
    consume(label = 'provider_call') {
      if (consumed + 1 > maxCalls) {
        throw new Error(
          `Provider call budget exceeded (${consumed}/${maxCalls}) before "${label}"; aborting without retry.`,
        );
      }
      consumed += 1;
      return consumed;
    },
    async execute(syntheticInput, label, fn) {
      assertSyntheticInput(syntheticInput);
      this.consume(label);
      return await fn();
    },
  };
}

/**
 * Ensures active test inputs are explicitly marked as synthetic.
 */
export function assertSyntheticInput({ venueId, label, url }) {
  if (!UUID_RE.test(venueId ?? '')) {
    throw new Error(`Invalid synthetic venueId: "${venueId}"`);
  }
  const combined = `${label ?? ''} ${url ?? ''}`.toLowerCase();
  if (!combined.includes('synthetic') && !combined.includes('test')) {
    throw new Error('Active E2E inputs must be explicitly labelled as synthetic/test.');
  }
}

/**
 * Returns a sanitized, secret-free evidence object suitable for committing to docs/evidence/.
 */
export function sanitizeEvidence(results, { verifiedAt = new Date().toISOString() } = {}) {
  return {
    verifiedAt,
    jobId: results.jobId,
    venueId: results.venueId,
    passed: results.passed,
    providerCallsConsumed: results.providerCallsConsumed ?? 0,
    maxProviderCalls: results.maxProviderCalls ?? MAX_PROVIDER_CALLS,
    localHarnessGuardOnly: true,
    providerBudgetEnforcedAtBoundary: results.providerBudgetEnforcedAtBoundary ?? false,
    requestIds: results.requestIds ?? [],
    evidenceIds: results.evidenceIds ?? {},
    checks: (results.checks ?? []).map((c) => ({
      name: c.name,
      passed: c.passed,
      details: redactSecrets(c.details),
    })),
  };
}

/**
 * Validates whether an extraction report matches the expected contract.
 * Accepts ONLY exact pairs: (1, "2") or (2, "3").
 */
export function validateExtractionReport(report) {
  const issues = [];
  if (!report || typeof report !== 'object') {
    return { valid: false, issues: ['Report is not an object'] };
  }

  const validPair =
    (report.schema_version === 1 && report.pipeline_version === '2') ||
    (report.schema_version === 2 && report.pipeline_version === '3');
  if (!validPair) {
    issues.push(
      `Invalid schema_version/pipeline_version pair: expected (1, "2") or (2, "3"), got (${JSON.stringify(report.schema_version)}, ${JSON.stringify(report.pipeline_version)})`,
    );
  }

  if (!['complete', 'incomplete', 'failed'].includes(report.status)) {
    issues.push(`Invalid status: ${report.status}`);
  }

  if (!Array.isArray(report.drafts)) {
    issues.push('Report missing drafts array');
  }

  if (!Array.isArray(report.segments)) {
    issues.push('Report missing segments array');
  }

  if (!Array.isArray(report.evidence)) {
    issues.push('Report missing evidence array');
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Validates that an extraction report's job, source identity, source SHA-256,
 * and draft/evidence identifiers bind to the requested job and synthetic source.
 */
export function validateReportProvenance(
  report,
  { jobId, expectedSourceId, expectedSourceHash } = {},
) {
  const issues = [];
  if (!report || typeof report !== 'object') {
    return { valid: false, issues: ['Report is not an object'] };
  }

  if (report.job_id !== undefined && jobId && report.job_id !== jobId) {
    issues.push(`Report job_id "${report.job_id}" does not match requested jobId "${jobId}"`);
  }

  const source = report.source;
  if (!source || typeof source !== 'object') {
    issues.push('Report missing source provenance object');
  } else {
    if (typeof source.source_id !== 'string' || source.source_id.trim().length === 0) {
      issues.push('Report source.source_id is missing');
    } else if (expectedSourceId && source.source_id !== expectedSourceId) {
      issues.push(
        `Report source.source_id "${source.source_id}" does not match expected "${expectedSourceId}"`,
      );
    }

    if (typeof source.sha256 !== 'string' || !SHA256_HEX_RE.test(source.sha256)) {
      issues.push('Report source.sha256 is missing or invalid 64-hex SHA-256');
    } else if (expectedSourceHash && source.sha256 !== expectedSourceHash) {
      issues.push(
        `Report source.sha256 "${source.sha256}" does not match expected "${expectedSourceHash}"`,
      );
    }
  }

  const drafts = Array.isArray(report.drafts) ? report.drafts : [];
  const evidence = Array.isArray(report.evidence) ? report.evidence : [];
  const draftIds = new Set();

  for (let i = 0; i < drafts.length; i += 1) {
    const draftId = drafts[i]?.draft_id;
    if (draftId !== undefined) {
      if (typeof draftId !== 'string' || draftId.length === 0) {
        issues.push(`Draft at index ${i} has invalid draft_id`);
      } else {
        draftIds.add(draftId);
      }
    }
  }

  for (let i = 0; i < evidence.length; i += 1) {
    const ev = evidence[i];
    const evDraftId = ev?.draft_id;
    if (typeof evDraftId !== 'string' || evDraftId.length === 0) {
      issues.push(`Evidence at index ${i} missing draft_id`);
    } else if (draftIds.size > 0 && !draftIds.has(evDraftId)) {
      issues.push(`Evidence at index ${i} references unknown draft_id "${evDraftId}"`);
    }
    if (
      ev?.draft_index !== undefined &&
      (!Number.isInteger(ev.draft_index) || ev.draft_index < 0 || ev.draft_index >= drafts.length)
    ) {
      issues.push(`Evidence at index ${i} has out-of-range draft_index ${ev.draft_index}`);
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Performs read-only verification of a completed menu ingestion job and its drafts.
 */
export async function verifyIngestionE2E({
  jobId,
  venueId,
  apiUrl = 'https://peekaplate-api-staging.vxkong.workers.dev',
  token,
  crossTenantVenueId,
  viewerToken,
  requirePr161 = false,
  maxProviderCalls = MAX_PROVIDER_CALLS,
  expectedSourceId,
  expectedSourceHash,
  reportJson,
  request = fetch,
  readFileFn,
  progress = console.log,
}) {
  const providerGuard = createProviderCallGuard(maxProviderCalls);

  if (!UUID_RE.test(jobId ?? '')) {
    throw new Error(`Invalid or missing --job-id UUID: "${jobId}"\n${USAGE}`);
  }
  if (!UUID_RE.test(venueId ?? '')) {
    throw new Error(`Invalid or missing --venue-id UUID: "${venueId}"\n${USAGE}`);
  }

  const baseUrl = apiUrl.replace(/\/+$/, '');
  const results = {
    jobId,
    venueId,
    checks: [],
    passed: true,
    providerCallsConsumed: providerGuard.consumed,
    maxProviderCalls: providerGuard.limit,
    providerBudgetEnforcedAtBoundary: false,
    requestIds: [],
    evidenceIds: { jobId, venueId },
    job: null,
    drafts: [],
    report: null,
  };

  function recordRequestId(res) {
    const reqId = res?.headers?.get?.('x-request-id');
    if (reqId) results.requestIds.push(reqId);
  }

  function recordCheck(name, passed, details) {
    results.checks.push({ name, passed, details });
    if (!passed) results.passed = false;
    progress(`  [${passed ? 'PASS' : 'FAIL'}] ${name}: ${details}`);
  }

  progress(`Starting read-only verification for Job ${jobId} (Venue: ${venueId})...`);

  // 1. API Verification (if token provided)
  if (token) {
    progress('Checking job status via API...');
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };

    try {
      const jobUrl = `${baseUrl}/venues/${venueId}/menus/jobs/${jobId}`;
      const jobRes = await request(jobUrl, { method: 'GET', headers });
      recordRequestId(jobRes);
      if (!jobRes.ok) {
        recordCheck('API Job Fetch', false, `HTTP ${jobRes.status} from ${jobUrl}`);
      } else {
        const jobData = await jobRes.json();
        results.job = jobData.job ?? null;
        recordCheck('API Job Fetch', true, `Job found with status "${results.job?.status}"`);
      }
    } catch (err) {
      recordCheck('API Job Fetch', false, `Request failed: ${err.message}`);
    }

    if (results.job) {
      if (typeof results.job.source_hash === 'string') {
        results.evidenceIds.sourceHash = results.job.source_hash;
        recordCheck(
          'Source Hash Format',
          SHA256_HEX_RE.test(results.job.source_hash),
          `source_hash=${results.job.source_hash.slice(0, 12)}...`,
        );
      }

      // 2. Terminal state check
      const isTerminal = ['complete', 'incomplete', 'failed'].includes(results.job.status);
      recordCheck(
        'Job Terminal State',
        isTerminal,
        `Status is "${results.job.status}" (finished_at: ${results.job.finished_at ?? 'null'})`,
      );

      // 3. Lease released check
      const leaseReleased = results.job.claim_token === null && results.job.locked_at === null;
      recordCheck(
        'Job Lease Released',
        leaseReleased,
        `claim_token=${results.job.claim_token ?? 'null'}, locked_at=${results.job.locked_at ?? 'null'}`,
      );

      // 4. Result storage key check
      const expectedPrefix = `reports/${venueId}/${jobId}/`;
      const hasReportKey =
        typeof results.job.result_storage_key === 'string' &&
        results.job.result_storage_key.startsWith(expectedPrefix) &&
        results.job.result_storage_key.endsWith('/extraction.json');
      if (hasReportKey) {
        results.evidenceIds.resultStorageKey = results.job.result_storage_key;
      }
      recordCheck(
        'Result Storage Key Scope',
        hasReportKey,
        `Expected key scoped under "${expectedPrefix}", got "${results.job.result_storage_key}"`,
      );
    }

    // 5. Drafts verification via API
    progress('Checking dish drafts via API...');
    try {
      const draftsUrl = `${baseUrl}/venues/${venueId}/drafts?jobId=${jobId}`;
      const draftsRes = await request(draftsUrl, { method: 'GET', headers });
      recordRequestId(draftsRes);
      if (!draftsRes.ok) {
        recordCheck('API Drafts Fetch', false, `HTTP ${draftsRes.status} from ${draftsUrl}`);
      } else {
        const draftsData = await draftsRes.json();
        results.drafts = draftsData.drafts ?? [];
        results.evidenceIds.draftIds = results.drafts.map((d) => d.id).filter(Boolean);
        recordCheck('API Drafts Fetch', true, `Retrieved ${results.drafts.length} drafts`);

        if (results.job) {
          const countMatches = results.drafts.length === results.job.draft_count;
          recordCheck(
            'Draft Count Consistency',
            countMatches,
            `Drafts array length (${results.drafts.length}) matches job.draft_count (${results.job.draft_count})`,
          );
        }

        // Validate draft integrity
        let allNeedsReview = true;
        let allPending = true;
        let allHaveEvidence = true;
        let allHaveValidVerification = true;
        const indices = new Set();
        let uniqueIndices = true;

        for (const draft of results.drafts) {
          if (draft.extraction_status !== 'needs_review') allNeedsReview = false;
          if (draft.review_status !== 'pending') allPending = false;
          if (!draft.evidence || typeof draft.evidence !== 'object') allHaveEvidence = false;
          if (
            requirePr161 &&
            draft.verification_status !== 'not_verified' &&
            draft.verification_status !== 'verified'
          ) {
            allHaveValidVerification = false;
          }
          if (indices.has(draft.draft_index)) uniqueIndices = false;
          indices.add(draft.draft_index);
        }

        recordCheck(
          'Drafts Invariant: extraction_status = needs_review',
          allNeedsReview,
          allNeedsReview
            ? 'All drafts have extraction_status "needs_review"'
            : 'Some drafts violate status check',
        );
        recordCheck(
          'Drafts Invariant: review_status = pending',
          allPending,
          allPending
            ? 'All drafts have initial review_status "pending"'
            : 'Some drafts have non-pending status',
        );
        recordCheck(
          'Drafts Evidence Structure',
          allHaveEvidence,
          allHaveEvidence
            ? 'All drafts contain structured evidence object'
            : 'Missing evidence on drafts',
        );
        recordCheck(
          'Unique draft_index Preservation',
          uniqueIndices,
          uniqueIndices
            ? `All ${indices.size} drafts have unique non-colliding draft_index`
            : 'Duplicate draft_index detected',
        );
        if (requirePr161) {
          recordCheck(
            'PR #161 Verification Status Field',
            allHaveValidVerification,
            allHaveValidVerification
              ? 'All drafts expose valid verification_status'
              : 'Missing or invalid verification_status on one or more drafts',
          );
        }
      }
    } catch (err) {
      recordCheck('API Drafts Fetch', false, `Request failed: ${err.message}`);
    }

    // 5b. PR #161 identity-first /verify probe (owner empty-body expects 400; proves auth passed before body validation, NOT migration/lifecycle correctness)
    if (requirePr161) {
      const verifyProbeUrl = `${baseUrl}/venues/${venueId}/drafts/00000000-0000-4000-8000-000000000001/verify`;
      try {
        const probeRes = await request(verifyProbeUrl, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: '{}',
        });
        recordRequestId(probeRes);
        recordCheck(
          'PR #161 /verify Owner Auth Probe (400)',
          probeRes.status === 400,
          probeRes.status === 401
            ? 'Authentication failed (401) — owner token invalid/expired'
            : `Expected HTTP 400 on empty-body /verify probe (auth before body validation), got HTTP ${probeRes.status}`,
        );
      } catch (err) {
        recordCheck(
          'PR #161 /verify Owner Auth Probe (400)',
          false,
          `Request failed: ${err.message}`,
        );
      }
    }

    // 5c. Cross-tenant isolation check (Restaurant B -> 403)
    if (crossTenantVenueId) {
      if (!UUID_RE.test(crossTenantVenueId)) {
        recordCheck('Cross-Tenant Isolation (403)', false, 'Invalid crossTenantVenueId UUID');
      } else {
        try {
          const crossRes = await request(
            `${baseUrl}/venues/${crossTenantVenueId}/menus/jobs/${jobId}`,
            { method: 'GET', headers },
          );
          recordRequestId(crossRes);
          recordCheck(
            'Cross-Tenant Isolation (403)',
            crossRes.status === 403,
            crossRes.status === 401
              ? 'Authentication failed (401) — token invalid/expired, not an authorization denial (403)'
              : `Expected HTTP 403 for cross-tenant venue, got HTTP ${crossRes.status}`,
          );
        } catch (err) {
          recordCheck('Cross-Tenant Isolation (403)', false, `Request failed: ${err.message}`);
        }
      }
    }

    // 5d. Viewer / unauthorized write denial check on identity-first PR #161 /verify (403)
    if (viewerToken) {
      try {
        const viewerRes = await request(
          `${baseUrl}/venues/${venueId}/drafts/00000000-0000-4000-8000-000000000001/verify`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${viewerToken}`,
              'Content-Type': 'application/json',
            },
            body: '{}',
          },
        );
        recordRequestId(viewerRes);
        recordCheck(
          'PR #161 /verify Viewer Denial (403)',
          viewerRes.status === 403,
          viewerRes.status === 401
            ? 'Authentication failed (401) — viewer token invalid/expired, not an authorization denial (403)'
            : `Expected HTTP 403 on empty-body /verify probe for viewer, got HTTP ${viewerRes.status}`,
        );
      } catch (err) {
        recordCheck('PR #161 /verify Viewer Denial (403)', false, `Request failed: ${err.message}`);
      }
    }
  } else {
    progress('Note: No --token provided; skipping authenticated API checks.');
  }

  // 6. Report JSON Artifact Validation (if provided)
  if (reportJson && readFileFn) {
    progress(`Inspecting local extraction report file: ${reportJson}...`);
    try {
      const rawContent = await readFileFn(reportJson);
      const parsedReport = JSON.parse(rawContent);
      results.report = parsedReport;
      if (typeof parsedReport.extraction_id === 'string') {
        results.evidenceIds.extractionId = parsedReport.extraction_id;
      }

      const reportValidation = validateExtractionReport(parsedReport);
      recordCheck(
        'Report Schema & Pipeline Version',
        reportValidation.valid,
        reportValidation.valid
          ? `Schema ${parsedReport.schema_version}, Pipeline ${parsedReport.pipeline_version}`
          : reportValidation.issues.join('; '),
      );

      // Verify report provenance matches target job, source identity, and SHA-256
      const resolvedSourceHash = expectedSourceHash ?? results.job?.source_hash;
      const provenance = validateReportProvenance(parsedReport, {
        jobId,
        expectedSourceId,
        expectedSourceHash: resolvedSourceHash,
      });
      if (parsedReport.source?.source_id) {
        results.evidenceIds.reportSourceId = parsedReport.source.source_id;
      }
      if (parsedReport.source?.sha256) {
        results.evidenceIds.reportSourceHash = parsedReport.source.sha256;
      }
      recordCheck(
        'Report Job & Source Provenance',
        provenance.valid,
        provenance.valid
          ? `Source ${parsedReport.source?.source_id} (${parsedReport.source?.sha256?.slice(0, 12)}...) verified`
          : provenance.issues.join('; '),
      );

      const reportDraftsCount = parsedReport.drafts?.length ?? 0;
      if (results.job) {
        const reportMatchesJob = reportDraftsCount === results.job.draft_count;
        recordCheck(
          'Report vs Job Draft Count',
          reportMatchesJob,
          `Report has ${reportDraftsCount} drafts, job recorded ${results.job.draft_count}`,
        );
      }
    } catch (err) {
      recordCheck('Report File Inspection', false, `Failed to read/parse report: ${err.message}`);
    }
  }

  // Guard against zero-check success: verification must never pass if no checks ran
  if (results.checks.length === 0) {
    recordCheck(
      'Verification Execution',
      false,
      'No checks were executed: neither API token nor report JSON was provided for verification',
    );
  }

  results.providerCallsConsumed = providerGuard.consumed;
  results.passed = results.checks.length > 0 && results.checks.every((c) => c.passed);

  return results;
}

// CLI entrypoint
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const { values } = parseArgs({
    options: {
      'job-id': { type: 'string' },
      'venue-id': { type: 'string' },
      'api-url': { type: 'string', default: 'https://peekaplate-api-staging.vxkong.workers.dev' },
      token: { type: 'string' },
      'cross-tenant-venue-id': { type: 'string' },
      'viewer-token': { type: 'string' },
      'require-pr161': { type: 'boolean', default: false },
      'max-provider-calls': { type: 'string' },
      'expected-source-id': { type: 'string' },
      'expected-source-hash': { type: 'string' },
      'report-json': { type: 'string' },
      'evidence-out': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help || !values['job-id'] || !values['venue-id']) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const { readFile, writeFile } = await import('node:fs/promises');
  const maxProviderCalls =
    values['max-provider-calls'] !== undefined
      ? Number(values['max-provider-calls'])
      : MAX_PROVIDER_CALLS;

  try {
    const outcome = await verifyIngestionE2E({
      jobId: values['job-id'],
      venueId: values['venue-id'],
      apiUrl: values['api-url'],
      token: values.token,
      crossTenantVenueId: values['cross-tenant-venue-id'],
      viewerToken: values['viewer-token'],
      requirePr161: values['require-pr161'],
      maxProviderCalls,
      expectedSourceId: values['expected-source-id'],
      expectedSourceHash: values['expected-source-hash'],
      reportJson: values['report-json'],
      readFileFn: (p) => readFile(p, 'utf8'),
      progress: console.log,
    });

    if (values['evidence-out']) {
      const sanitized = sanitizeEvidence(outcome);
      await writeFile(values['evidence-out'], `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
      console.log(`Sanitized evidence written to ${values['evidence-out']}`);
    }

    console.log('\n--- Verification Summary ---');
    console.log(`Job ID:  ${outcome.jobId}`);
    console.log(`Passed:  ${outcome.passed ? 'ALL CHECKS PASSED' : 'FAILURES DETECTED'}`);
    process.exit(outcome.passed ? 0 : 1);
  } catch (err) {
    console.error(`Verification error: ${err.message}`);
    process.exit(1);
  }
}
