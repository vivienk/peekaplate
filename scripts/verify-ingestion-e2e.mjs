import { parseArgs } from 'node:util';

export const USAGE = `Usage: node scripts/verify-ingestion-e2e.mjs --job-id <uuid> --venue-id <uuid> [options]

Options:
  --job-id <uuid>         Ingestion job UUID to verify (required)
  --venue-id <uuid>       Tenant / venue UUID (required)
  --api-url <url>         API base URL (default: https://peekaplate-api-staging.vxkong.workers.dev)
  --token <bearer-token>  Staff Bearer authorization token for API verification
  --report-json <path>    Local path to downloaded extraction report JSON (optional)
  --help, -h              Show this help message
`;

/**
 * Validates whether an extraction report matches the expected contract.
 * Supports schema 1/pipeline 2 and schema 2/pipeline 3.
 */
export function validateExtractionReport(report) {
  const issues = [];
  if (!report || typeof report !== 'object') {
    return { valid: false, issues: ['Report is not an object'] };
  }

  if (report.schema_version !== 1 && report.schema_version !== 2) {
    issues.push(`Invalid schema_version: expected 1 or 2, got ${report.schema_version}`);
  }

  if (report.pipeline_version !== '2' && report.pipeline_version !== '3') {
    issues.push(`Invalid pipeline_version: expected "2" or "3", got ${report.pipeline_version}`);
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
 * Performs read-only verification of a completed menu ingestion job and its drafts.
 */
export async function verifyIngestionE2E({
  jobId,
  venueId,
  apiUrl = 'https://peekaplate-api-staging.vxkong.workers.dev',
  token,
  reportJson,
  request = fetch,
  readFileFn,
  progress = console.log,
}) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!uuidRegex.test(jobId ?? '')) {
    throw new Error(`Invalid or missing --job-id UUID: "${jobId}"\n${USAGE}`);
  }
  if (!uuidRegex.test(venueId ?? '')) {
    throw new Error(`Invalid or missing --venue-id UUID: "${venueId}"\n${USAGE}`);
  }

  const results = {
    jobId,
    venueId,
    checks: [],
    passed: true,
    job: null,
    drafts: [],
    report: null,
  };

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
      const jobUrl = `${apiUrl.replace(/\/+$/, '')}/venues/${venueId}/menus/jobs/${jobId}`;
      const jobRes = await request(jobUrl, { method: 'GET', headers });
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
      recordCheck(
        'Result Storage Key Scope',
        hasReportKey,
        `Expected key scoped under "${expectedPrefix}", got "${results.job.result_storage_key}"`,
      );
    }

    // 5. Drafts verification via API
    progress('Checking dish drafts via API...');
    try {
      const draftsUrl = `${apiUrl.replace(/\/+$/, '')}/venues/${venueId}/drafts?jobId=${jobId}`;
      const draftsRes = await request(draftsUrl, { method: 'GET', headers });
      if (!draftsRes.ok) {
        recordCheck('API Drafts Fetch', false, `HTTP ${draftsRes.status} from ${draftsUrl}`);
      } else {
        const draftsData = await draftsRes.json();
        results.drafts = draftsData.drafts ?? [];
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
        const indices = new Set();
        let uniqueIndices = true;

        for (const draft of results.drafts) {
          if (draft.extraction_status !== 'needs_review') allNeedsReview = false;
          if (draft.review_status !== 'pending') allPending = false;
          if (!draft.evidence || typeof draft.evidence !== 'object') allHaveEvidence = false;
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
      }
    } catch (err) {
      recordCheck('API Drafts Fetch', false, `Request failed: ${err.message}`);
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

      const reportValidation = validateExtractionReport(parsedReport);
      recordCheck(
        'Report Schema & Pipeline Version',
        reportValidation.valid,
        reportValidation.valid
          ? `Schema ${parsedReport.schema_version}, Pipeline ${parsedReport.pipeline_version}`
          : reportValidation.issues.join('; '),
      );

      // Verify report provenance matches target
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
      'report-json': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help || !values['job-id'] || !values['venue-id']) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const { readFile } = await import('node:fs/promises');

  try {
    const outcome = await verifyIngestionE2E({
      jobId: values['job-id'],
      venueId: values['venue-id'],
      apiUrl: values['api-url'],
      token: values.token,
      reportJson: values['report-json'],
      readFileFn: (p) => readFile(p, 'utf8'),
      progress: console.log,
    });

    console.log('\n--- Verification Summary ---');
    console.log(`Job ID:  ${outcome.jobId}`);
    console.log(`Passed:  ${outcome.passed ? 'ALL CHECKS PASSED' : 'FAILURES DETECTED'}`);
    process.exit(outcome.passed ? 0 : 1);
  } catch (err) {
    console.error(`Verification error: ${err.message}`);
    process.exit(1);
  }
}
