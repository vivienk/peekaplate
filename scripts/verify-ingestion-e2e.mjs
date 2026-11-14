import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// Declared upstream allowance only; a read-only verifier cannot enforce provider calls.
export const MAX_PROVIDER_CALLS = 2;
const API_ORIGIN = 'https://peekaplate-api-staging.vxkong.workers.dev';
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value) => typeof value === 'string' && UUID_RE.test(value);
const hash = (value) => typeof value === 'string' && SHA256_HEX_RE.test(value);
const reportKey = (key, venue, job) =>
  typeof key === 'string' &&
  key.startsWith('reports/' + venue + '/' + job + '/attempts/') &&
  uuid(key.split('/')[4]) &&
  key === 'reports/' + venue + '/' + job + '/attempts/' + key.split('/')[4] + '/extraction.json';

export const USAGE =
  'Usage: node scripts/verify-ingestion-e2e.mjs --job-id <uuid> --venue-id <uuid> [options]\n\n' +
  'Read-only job/draft verification: no menu submission, provider calls or Queue changes.\n' +
  'Use PEEKAPLATE_STAFF_TOKEN and PEEKAPLATE_VIEWER_TOKEN environment variables.\n' +
  'Legacy --token/--viewer-token are supported but expose credentials in process arguments.\n\n' +
  '  --api-url <url>              Approved staging API or http://127.0.0.1:8787\n' +
  '  --cross-tenant-venue-id <id>  Venue expected to return 403 for the staff session\n' +
  '  --require-pr161              Verification fields and non-mutating /verify probe\n' +
  '  --expected-status <status>   complete (default) or explicit incomplete diagnostics\n' +
  '  --max-provider-calls <n>     Declared allowance, 0–2; NOT enforced here\n' +
  '  --expected-source-id <id>    Pin the original source identity\n' +
  '  --expected-source-hash <hex> Pin the original source SHA-256\n' +
  '  --report-json <path>         Downloaded attempt-scoped extraction report\n' +
  '  --evidence-out <path>        Write allowlisted, redacted evidence\n' +
  '  --help, -h                  Show help\n\n' +
  'PASS covers recorded checks only. Provider budget, UI save/reload, authenticated R2\n' +
  'retrieval and full FE-06.4 acceptance need their separate evidence.\n';

export function redactSecrets(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
    .replace(
      /([?&](?:token|access_token|api_key|apikey|key|secret|password|auth)=)[^&\s]+/gi,
      '$1[REDACTED]',
    );
}
function safeRequestId(value) {
  return (
    typeof value === 'string' &&
    /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value) &&
    redactSecrets(value) === value
  );
}
export function sanitizeEvidence(results, { verifiedAt = new Date().toISOString() } = {}) {
  const ids = results.evidenceIds ?? {};
  return {
    verifiedAt,
    ...(uuid(results.jobId) ? { jobId: results.jobId } : {}),
    ...(uuid(results.venueId) ? { venueId: results.venueId } : {}),
    passed: results.passed === true,
    scope: 'read_only_job_and_draft_checks',
    providerCallsConsumed: null,
    providerCallsByVerifier: 0,
    providerBudgetEnforced: false,
    maxProviderCalls: results.maxProviderCalls ?? MAX_PROVIDER_CALLS,
    requestIds: (Array.isArray(results.requestIds) ? results.requestIds : []).filter(safeRequestId),
    evidenceIds: {
      ...(hash(ids.sourceHash) ? { sourceHash: ids.sourceHash } : {}),
      ...(hash(ids.reportSha256) ? { reportSha256: ids.reportSha256 } : {}),
      ...(reportKey(ids.resultStorageKey, results.venueId, results.jobId)
        ? { resultStorageKey: ids.resultStorageKey }
        : {}),
      draftIds: (Array.isArray(ids.draftIds) ? ids.draftIds : []).filter(uuid),
    },
    checks: (results.checks ?? []).map((c) => ({
      name: redactSecrets(c.name),
      passed: c.passed === true,
      details: redactSecrets(c.details),
    })),
  };
}

// Bounded integrity checks; the production adapter owns the complete extraction schema.
export function validateExtractionReport(report) {
  if (!object(report)) return { valid: false, issues: ['Report is not an object'] };
  const issues = [];
  if (
    !(
      (report.schema_version === 1 && report.pipeline_version === '2') ||
      (report.schema_version === 2 && report.pipeline_version === '3')
    )
  )
    issues.push('Unsupported schema_version/pipeline_version pair; expected (1,"2") or (2,"3")');
  if (!['complete', 'incomplete', 'failed'].includes(report.status))
    issues.push('Invalid report status');
  if (!object(report.source) || !hash(report.source.sha256))
    issues.push('Missing valid source SHA-256');
  for (const key of ['drafts', 'segments', 'evidence'])
    if (!Array.isArray(report[key]) || report[key].some((row) => !object(row)))
      issues.push('Invalid ' + key + ' array');
  return { valid: issues.length === 0, issues };
}

export function validateReportProvenance(
  report,
  { jobId, expectedSourceId, expectedSourceHash } = {},
) {
  const issues = [];
  if (!object(report)) return { valid: false, issues: ['Report is not an object'] };
  if (report.job_id !== undefined && jobId && report.job_id !== jobId)
    issues.push('Report job_id mismatch');
  if (!object(report.source)) issues.push('Report missing source provenance');
  else {
    if (typeof report.source.source_id !== 'string' || !report.source.source_id.trim())
      issues.push('Missing source_id');
    if (expectedSourceId !== undefined && report.source.source_id !== expectedSourceId)
      issues.push('Report source_id mismatch');
    if (
      !hash(report.source.sha256) ||
      (expectedSourceHash !== undefined && report.source.sha256 !== expectedSourceHash)
    )
      issues.push('Report source SHA-256 mismatch');
  }
  const drafts = Array.isArray(report.drafts) ? report.drafts : [];
  const evidence = Array.isArray(report.evidence) ? report.evidence : [];
  const ids = new Set(drafts.map((d) => d?.draft_id).filter((id) => typeof id === 'string'));
  const indices = new Set(drafts.map((d, index) => d?.draft_index ?? index));
  for (const row of evidence) {
    if (
      !object(row) ||
      typeof row.draft_id !== 'string' ||
      !row.draft_id ||
      (ids.size > 0 && !ids.has(row.draft_id))
    )
      issues.push('Evidence references unknown draft_id');
    if (
      row?.draft_index !== undefined &&
      (!Number.isInteger(row.draft_index) || row.draft_index < 0 || !indices.has(row.draft_index))
    )
      issues.push('Evidence has out-of-range draft_index');
  }
  return { valid: issues.length === 0, issues };
}

export async function verifyIngestionE2E({
  jobId,
  venueId,
  apiUrl = API_ORIGIN,
  token,
  crossTenantVenueId,
  viewerToken,
  requirePr161 = false,
  expectedStatus = 'complete',
  maxProviderCalls = MAX_PROVIDER_CALLS,
  expectedSourceId,
  expectedSourceHash,
  reportJson,
  request = fetch,
  readFileFn,
  progress = console.log,
}) {
  if (!uuid(jobId)) throw new Error('Invalid or missing --job-id UUID');
  if (!uuid(venueId)) throw new Error('Invalid or missing --venue-id UUID');
  if (
    !Number.isInteger(maxProviderCalls) ||
    maxProviderCalls < 0 ||
    maxProviderCalls > MAX_PROVIDER_CALLS
  )
    throw new Error('Declared provider allowance must be an integer between 0 and 2');
  if (!['complete', 'incomplete'].includes(expectedStatus))
    throw new Error('Invalid expected status');
  if (expectedSourceHash !== undefined && !hash(expectedSourceHash))
    throw new Error('Invalid expected source hash');
  if (
    expectedSourceId !== undefined &&
    (typeof expectedSourceId !== 'string' ||
      !expectedSourceId.trim() ||
      expectedSourceId.length > 2048)
  )
    throw new Error('Invalid expected source ID');
  const base = new URL(apiUrl);
  if (expectedSourceId !== undefined && !reportJson)
    throw new Error('Expected source ID requires a report');
  if (
    ![API_ORIGIN, 'http://127.0.0.1:8787'].includes(base.origin) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw new Error(
      'API origin must be the approved staging API or exact loopback development endpoint',
    );
  const baseUrl = base.origin;
  jobId = jobId.toLowerCase();
  venueId = venueId.toLowerCase();
  const results = {
    jobId,
    venueId,
    checks: [],
    passed: false,
    providerCallsConsumed: null,
    providerCallsByVerifier: 0,
    providerBudgetEnforced: false,
    maxProviderCalls,
    requestIds: [],
    evidenceIds: {},
    job: null,
    drafts: [],
    report: null,
  };
  const safe = (value) => {
    let text = String(value);
    for (const secret of [token, viewerToken])
      if (secret) text = text.split(secret).join('[REDACTED]');
    return redactSecrets(text);
  };
  const check = (name, passed, details) => {
    const row = { name, passed: Boolean(passed), details: safe(details) };
    results.checks.push(row);
    progress('  [' + (row.passed ? 'PASS' : 'FAIL') + '] ' + row.name + ': ' + row.details);
  };
  const fetchApi = async (path, credential, method = 'GET') => {
    const response = await request(baseUrl + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + credential,
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: '{}' } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    const id = response.headers?.get?.('x-request-id');
    if (safeRequestId(id) && safe(id) === id) results.requestIds.push(id);
    return response;
  };
  const probe = async (name, path, credential, method, expected) => {
    try {
      const response = await fetchApi(path, credential, method);
      check(
        name,
        response.status === expected,
        response.status === 401
          ? 'Authentication failed (401); this is not an authorization denial (403)'
          : 'Expected HTTP ' + expected + ', got HTTP ' + response.status,
      );
    } catch (error) {
      check(name, false, error.message);
    }
  };
  progress(
    'Read-only verification; upstream provider usage is unknown and its allowance is not enforced here.',
  );
  if (!token)
    check(
      'Authenticated API Required',
      false,
      'No staff session supplied; offline report checks cannot establish job acceptance',
    );
  else {
    try {
      const response = await fetchApi('/venues/' + venueId + '/menus/jobs/' + jobId, token);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const job = (await response.json()).job;
      const valid =
        object(job) &&
        job.id === jobId &&
        job.tenant_id === venueId &&
        hash(job.source_hash) &&
        Number.isInteger(job.draft_count) &&
        job.draft_count > 0 &&
        typeof job.finished_at === 'string' &&
        Number.isFinite(Date.parse(job.finished_at));
      check(
        'API Job Fetch',
        valid,
        valid
          ? 'Requested tenant/job identity, source hash and nonempty result verified'
          : 'Missing, foreign or malformed completed job',
      );
      if (valid) {
        results.job = job;
        results.evidenceIds.sourceHash = job.source_hash;
        if (expectedSourceHash)
          check(
            'Expected Input Source Hash',
            job.source_hash === expectedSourceHash,
            'Job source hash must match the pinned original bytes',
          );
        check(
          'Expected Job Outcome',
          job.status === expectedStatus,
          'Expected ' + expectedStatus + ', got ' + job.status,
        );
        check(
          'Job Lease Released',
          job.claim_token === null && job.locked_at === null,
          'Expected no active claim or lock; token values withheld',
        );
        const scoped = reportKey(job.result_storage_key, venueId, jobId);
        check(
          'Result Storage Key Scope',
          scoped,
          'Expected exact tenant/job/attempt-scoped extraction.json key',
        );
        if (scoped) results.evidenceIds.resultStorageKey = job.result_storage_key;
      }
    } catch (error) {
      check('API Job Fetch', false, error.message);
    }
    try {
      const response = await fetchApi('/venues/' + venueId + '/drafts?jobId=' + jobId, token);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const drafts = (await response.json()).drafts;
      const valid =
        Array.isArray(drafts) &&
        drafts.length > 0 &&
        drafts.every(
          (d) =>
            object(d) &&
            uuid(d.id) &&
            d.tenant_id === venueId &&
            d.job_id === jobId &&
            typeof d.draft_id === 'string' &&
            d.draft_id.length > 0 &&
            Number.isInteger(d.draft_index) &&
            d.draft_index >= 0 &&
            object(d.evidence),
        ) &&
        new Set(drafts.map((d) => d.id)).size === drafts.length &&
        new Set(drafts.map((d) => d.draft_index)).size === drafts.length;
      check(
        'API Drafts Fetch',
        valid,
        valid
          ? 'Nonempty, unique, tenant/job-bound drafts with structured evidence'
          : 'Missing, foreign, duplicate or malformed drafts',
      );
      if (valid) {
        results.drafts = drafts;
        results.evidenceIds.draftIds = drafts.map((d) => d.id);
        check(
          'Draft Count Consistency',
          results.job && drafts.length === results.job.draft_count,
          'API drafts must match the validated job count',
        );
        check(
          'Drafts Await Human Review',
          drafts.every(
            (d) => d.extraction_status === 'needs_review' && d.review_status === 'pending',
          ),
          'Run before corrections/approval; this is not publication acceptance',
        );
        if (requirePr161)
          check(
            'PR #161 Verification Status Field',
            drafts.every((d) => ['not_verified', 'verified'].includes(d.verification_status)),
            'Every draft must expose verification_status',
          );
      }
    } catch (error) {
      check('API Drafts Fetch', false, error.message);
    }
    const path = '/venues/' + venueId + '/drafts/00000000-0000-4000-8000-000000000001/verify';
    if (requirePr161) await probe('PR #161 /verify Route Presence Only', path, token, 'POST', 400);
    if (crossTenantVenueId) {
      if (!uuid(crossTenantVenueId) || crossTenantVenueId.toLowerCase() === venueId)
        check('Cross-Tenant Isolation (403)', false, 'Expected a distinct valid negative venue');
      else
        await probe(
          'Cross-Tenant Isolation (403)',
          '/venues/' + crossTenantVenueId.toLowerCase() + '/menus/jobs/' + jobId,
          token,
          'GET',
          403,
        );
    }
    if (viewerToken) await probe('Viewer Write Denial (403)', path, viewerToken, 'POST', 403);
  }
  if (reportJson) {
    if (!readFileFn)
      check('Report File Inspection', false, 'Requested report reader is unavailable');
    else
      try {
        const bytes = await readFileFn(reportJson);
        if (Buffer.byteLength(bytes) > 24_000_000)
          throw new Error('Report exceeds bounded artifact size');
        const report = JSON.parse(bytes);
        const validation = validateExtractionReport(report);
        check(
          'Report Schema & Pipeline Version',
          validation.valid,
          validation.valid
            ? 'Supported report version pair and bounded structure'
            : validation.issues.join('; '),
        );
        if (validation.valid) {
          results.report = report;
          results.evidenceIds.reportSha256 = createHash('sha256').update(bytes).digest('hex');
          const provenance = validateReportProvenance(report, {
            jobId,
            expectedSourceId,
            expectedSourceHash: expectedSourceHash ?? results.job?.source_hash,
          });
          check(
            'Report Job & Source Provenance',
            provenance.valid,
            provenance.valid
              ? 'Pinned source identity/hash and report evidence references agree'
              : provenance.issues.join('; '),
          );
          check(
            'Report Source and Outcome',
            results.job &&
              report.source.sha256 === results.job.source_hash &&
              report.status === results.job.status,
            'Report source SHA-256 and outcome must match the validated job',
          );
          check(
            'Report vs Job Draft Count',
            results.job && report.drafts.length === results.job.draft_count,
            'Equal count is necessary, never sufficient provenance',
          );
          const mapped =
            results.drafts.length > 0 &&
            results.drafts.every((d) => {
              const evidence = report.evidence.find((e) => e.draft_id === d.draft_id);
              const entry = report.drafts.find(
                (raw, i) => (raw.draft_index ?? i) === d.draft_index,
              );
              return (
                entry &&
                evidence &&
                (evidence.draft_index === undefined || evidence.draft_index === d.draft_index)
              );
            });
          check(
            'Report Producer Draft Identities',
            mapped,
            'Persisted producer IDs/indices must match report drafts and evidence; physical row UUIDs are separate',
          );
        }
      } catch (error) {
        check('Report File Inspection', false, error.message);
      }
  }
  results.passed = results.checks.length > 0 && results.checks.every((c) => c.passed);
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      'job-id': { type: 'string' },
      'venue-id': { type: 'string' },
      'api-url': { type: 'string', default: API_ORIGIN },
      token: { type: 'string' },
      'viewer-token': { type: 'string' },
      'cross-tenant-venue-id': { type: 'string' },
      'require-pr161': { type: 'boolean', default: false },
      'expected-status': { type: 'string', default: 'complete' },
      'max-provider-calls': { type: 'string', default: '2' },
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
  try {
    const outcome = await verifyIngestionE2E({
      jobId: values['job-id'],
      venueId: values['venue-id'],
      apiUrl: values['api-url'],
      token: process.env.PEEKAPLATE_STAFF_TOKEN ?? values.token,
      viewerToken: process.env.PEEKAPLATE_VIEWER_TOKEN ?? values['viewer-token'],
      crossTenantVenueId: values['cross-tenant-venue-id'],
      requirePr161: values['require-pr161'],
      expectedStatus: values['expected-status'],
      maxProviderCalls: Number(values['max-provider-calls']),
      expectedSourceId: values['expected-source-id'],
      expectedSourceHash: values['expected-source-hash'],
      reportJson: values['report-json'],
      readFileFn: (p) => readFile(p, 'utf8'),
    });
    if (values['evidence-out'])
      await writeFile(
        values['evidence-out'],
        JSON.stringify(sanitizeEvidence(outcome), null, 2) + '\n',
        'utf8',
      );
    console.log(
      'Read-only verification: ' +
        (outcome.passed ? 'PASS' : 'FAIL') +
        '; upstream provider calls: UNKNOWN (not enforced here)',
    );
    process.exit(outcome.passed ? 0 : 1);
  } catch (error) {
    console.error('Verification error: ' + redactSecrets(error.message));
    process.exit(1);
  }
}
