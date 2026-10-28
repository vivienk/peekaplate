import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/containers', () => ({ Container: class {} }));

import { mintExtractionCapability } from './extraction-capability';
import host, { ExtractionContainer, type ExtractionHostEnv } from './extraction-host';

const secret = 'synthetic-host-test-'.repeat(4);
const tenant = '00000000-0000-4000-8000-000000000002';
const job = '00000000-0000-4000-8000-000000000001';
const signingSecret = 'synthetic-job-signing-key-'.repeat(3);
let capability = '';
beforeAll(async () => {
  capability = await mintExtractionCapability(
    { tenantId: tenant, jobId: job, sourceHash: 'a'.repeat(64) },
    signingSecret,
  );
});
function artifactBundle() {
  return {
    schema_version: 1,
    report: {
      schema_version: 2,
      pipeline_version: '3',
      status: 'incomplete',
      source: { source_id: `sha256:${'a'.repeat(64)}`, sha256: 'a'.repeat(64) },
      configuration: { input_mode: 'ocr_image' },
      drafts: [],
      evidence: [],
    },
    review_suggestions: {
      schema_version: 1,
      source_id: `sha256:${'a'.repeat(64)}`,
      input_mode: 'ocr_image',
      status: 'complete',
      suggestions: [{ status: 'unvalidated', original: { name: 'PRIVATE_REJECTED_VALUE' } }],
    },
    timings: {
      schema_version: 1,
      input_mode: 'ocr_image',
      status: 'incomplete',
      timings_seconds: { total: 42.5 },
    },
  };
}
function bundleResponse(value: unknown = artifactBundle()) {
  return Response.json(value, { headers: { 'X-Extraction-Artifact-Bundle': '1' } });
}
function setup() {
  const forward = vi.fn(async (_request: Request) => bundleResponse());
  const get = vi.fn(async () => ({ size: 3, body: new Blob(['pdf']).stream() }));
  const put = vi.fn(
    async (_key: string, _value: string, _options: unknown): Promise<{ etag: string } | null> => ({
      etag: 'synthetic',
    }),
  );
  const env: ExtractionHostEnv = {
    APP_ENV: 'staging',
    EXTRACTION_SERVICE_SECRET: secret,
    EXTRACTION_SOURCE_SIGNING_SECRET: signingSecret,
    EXTRACTION_SOURCE_ORIGIN: 'https://peekaplate-extraction-staging.vxkong.workers.dev',
    EXTRACTOR: { getByName: vi.fn(() => ({ fetch: forward })) },
    SOURCE_BUCKET: { get, put },
  };
  const request = (path: string, token = secret, method = 'GET') =>
    new Request(`https://host.invalid${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Source-Capability': capability,
        'X-Source-Hash': 'a'.repeat(64),
        'X-Tenant-ID': tenant,
        'X-Job-ID': job,
      },
    });
  return { env, get, put, forward, request };
}

describe('staging extraction host', () => {
  it('denies a valid service credential and job-A capability requesting another valid job', async () => {
    const { env, get, request } = setup();
    const otherJob = '00000000-0000-4000-8000-000000000003';
    expect((await host.fetch(request(`/sources/${tenant}/${otherJob}`), env)).status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });
  it('rejects missing, tampered, expired and different-hash grants before R2 access', async () => {
    const { env, get, request } = setup();
    const expired = await mintExtractionCapability(
      { tenantId: tenant, jobId: job, sourceHash: 'a'.repeat(64) },
      signingSecret,
      Date.now() - 1_000_000,
    );
    for (const token of ['', capability + 'tampered', expired]) {
      const input = request(`/sources/${tenant}/${job}`);
      input.headers.set('X-Source-Capability', token);
      expect((await host.fetch(input, env)).status).toBe(403);
    }
    const input = request(`/sources/${tenant}/${job}`);
    input.headers.set('X-Source-Hash', 'b'.repeat(64));
    expect((await host.fetch(input, env)).status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });
  it('keeps the source signing key out of the Python container environment', () => {
    const { env } = setup();
    const container = new ExtractionContainer(
      {} as ConstructorParameters<typeof ExtractionContainer>[0],
      env,
    );
    expect(container.envVars.EXTRACTION_SERVICE_SECRET).toBe(secret);
    expect(container.envVars.EXTRACTION_SOURCE_SIGNING_SECRET).toBeUndefined();
  });
  it('requires distinct service and source-signing credentials', async () => {
    const { env, get, request } = setup();
    expect(
      (await host.fetch(request('/health'), { ...env, EXTRACTION_SOURCE_SIGNING_SECRET: secret }))
        .status,
    ).toBe(503);
    expect(get).not.toHaveBeenCalled();
  });
  it('denies missing/invalid credentials before touching R2 or starting a container', async () => {
    const { env, get, forward, request } = setup();
    expect((await host.fetch(request('/extract', 'wrong', 'POST'), env)).status).toBe(401);
    expect(get).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });
  it('derives the sole source key from path IDs and streams it without caching', async () => {
    const { env, get, forward, request } = setup();
    const response = await host.fetch(request(`/sources/${tenant}/${job}`), env);
    expect(get).toHaveBeenCalledWith(`menu-ingestion/sources/${tenant}/${job}/source`);
    expect(await response.text()).toBe('pdf');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-length')).toBe('3');
    expect(forward).not.toHaveBeenCalled();
  });
  it('does not accept arbitrary source keys, queries or methods', async () => {
    const { env, get, request } = setup();
    for (const path of ['/sources/other/file', `/sources/${tenant}/${job}?key=other`]) {
      expect((await host.fetch(request(path), env)).status).toBeGreaterThanOrEqual(400);
    }
    expect(
      (await host.fetch(request(`/sources/${tenant}/${job}`, secret, 'POST'), env)).status,
    ).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });
  it('uses one fixed container name for authenticated extraction', async () => {
    const { env, forward, request } = setup();
    expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(200);
    expect(env.EXTRACTOR.getByName).toHaveBeenCalledWith('staging-extractor');
    expect(forward).toHaveBeenCalledOnce();
  });
  it('retains the private bundle before returning only the existing report shape', async () => {
    const { env, put, forward, request } = setup();
    const response = await host.fetch(request('/extract', secret, 'POST'), env);
    expect(response.status).toBe(200);
    expect(put).toHaveBeenCalledOnce();
    const [key, content, options] = put.mock.calls[0] ?? [];
    expect(key).toMatch(
      new RegExp(`^menu-ingestion/review-artifacts/${tenant}/${job}/[0-9a-f-]+/bundle.json$`),
    );
    expect(options).toMatchObject({ onlyIf: { etagDoesNotMatch: '*' } });
    const stored = JSON.parse(content ?? '{}');
    expect(stored.review_suggestions.suggestions[0].original.name).toBe('PRIVATE_REJECTED_VALUE');
    expect(stored.timings.timings_seconds.total).toBe(42.5);
    expect(stored.scope).toMatchObject({
      tenant_id: tenant,
      job_id: job,
      source_hash: 'a'.repeat(64),
    });
    const result = (await response.json()) as ReturnType<typeof artifactBundle>['report'] & {
      configuration: { private_review_artifact: { key: string; sha256: string } };
    };
    expect(result.configuration.private_review_artifact.key).toBe(key);
    expect(result.configuration.private_review_artifact.sha256).toBe(
      createHash('sha256')
        .update(content ?? '')
        .digest('hex'),
    );
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REJECTED_VALUE');
    expect(result).not.toHaveProperty('review_suggestions');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(forward.mock.calls[0]?.[0].headers.get('x-extraction-artifact-bundle')).toBe('1');
  });
  it('uses a new create-only attempt key for each repeat without overwriting history', async () => {
    const { env, put, request } = setup();
    for (let index = 0; index < 2; index++) {
      expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(200);
    }
    expect(put.mock.calls[0]?.[0]).not.toBe(put.mock.calls[1]?.[0]);
  });
  it('does not return success if private R2 retention fails', async () => {
    const { env, put, request } = setup();
    put.mockRejectedValue(new Error('synthetic-storage-secret'));
    const response = await host.fetch(request('/extract', secret, 'POST'), env);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('synthetic-storage-secret');
  });
  it('rejects missing, mismatched and cross-source bundles without writing R2', async () => {
    const { env, put, forward, request } = setup();
    for (const changed of ['version', 'source', 'private-source', 'mode', 'missing-timing']) {
      const value = artifactBundle();
      if (changed === 'version') value.schema_version = 9;
      if (changed === 'source') value.report.source.sha256 = 'b'.repeat(64);
      if (changed === 'private-source')
        value.review_suggestions.source_id = `sha256:${'b'.repeat(64)}`;
      if (changed === 'mode') value.review_suggestions.input_mode = 'image';
      if (changed === 'missing-timing') Object.assign(value, { timings: null });
      forward.mockImplementationOnce(async () => bundleResponse(value));
      expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(502);
    }
    expect(put).not.toHaveBeenCalled();
  });
  it('rejects old unbundled upstream success instead of silently dropping artifacts', async () => {
    const { env, put, forward, request } = setup();
    forward.mockImplementationOnce(async () => Response.json(artifactBundle().report));
    expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(502);
    expect(put).not.toHaveBeenCalled();
  });
  it('consumes the same full synthetic bundle verified by Python service tests', async () => {
    const bundle = JSON.parse(
      readFileSync(
        new URL(
          '../../processing/tests/fixtures/service-artifacts/representative-bundle.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const { env, put, forward, request } = setup();
    const input = request('/extract', secret, 'POST');
    input.headers.set(
      'X-Source-Capability',
      await mintExtractionCapability(
        { tenantId: tenant, jobId: job, sourceHash: bundle.report.source.sha256 },
        signingSecret,
      ),
    );
    forward.mockImplementationOnce(async () => bundleResponse(bundle));
    const response = await host.fetch(input, env);
    expect(response.status).toBe(200);
    const result = (await response.json()) as typeof bundle.report;
    expect(result.schema_version).toBe(2);
    expect(result.drafts).toEqual(bundle.report.drafts);
    expect(result.evidence).toEqual(bundle.report.evidence);
    const stored = JSON.parse(put.mock.calls[0]?.[1] ?? '{}');
    expect(stored.report).toEqual(bundle.report);
    expect(stored.review_suggestions).toEqual(bundle.review_suggestions);
    expect(stored.timings).toEqual(bundle.timings);
  });
  it('refuses conditional-write collisions instead of claiming retention succeeded', async () => {
    const { env, put, request } = setup();
    put.mockResolvedValueOnce(null);
    expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(502);
  });
  it('rejects oversized or malformed upstream bundles before private writes', async () => {
    const { env, put, forward, request } = setup();
    forward.mockImplementationOnce(
      async () =>
        new Response('{}', {
          headers: {
            'Content-Type': 'application/json',
            'X-Extraction-Artifact-Bundle': '1',
            'Content-Length': '32000001',
          },
        }),
    );
    expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(502);
    forward.mockImplementationOnce(
      async () =>
        new Response('invalid JSON', {
          headers: { 'Content-Type': 'application/json', 'X-Extraction-Artifact-Bundle': '1' },
        }),
    );
    expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(502);
    expect(put).not.toHaveBeenCalled();
  });
  it('preserves Unicode private values split across upstream stream chunks', async () => {
    const { env, put, forward, request } = setup();
    const bundle = artifactBundle();
    bundle.review_suggestions.suggestions = [
      { status: 'unvalidated', original: { name: 'Synthetic 🍜' } },
    ];
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    forward.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let index = 0; index < bytes.length; index++)
                controller.enqueue(bytes.slice(index, index + 1));
              controller.close();
            },
          }),
          { headers: { 'Content-Type': 'application/json', 'X-Extraction-Artifact-Bundle': '1' } },
        ),
    );
    expect((await host.fetch(request('/extract', secret, 'POST'), env)).status).toBe(200);
    expect(
      JSON.parse(put.mock.calls[0]?.[1] ?? '{}').review_suggestions.suggestions[0].original.name,
    ).toBe('Synthetic 🍜');
  });
  it('passes upstream errors through without pretending an artifact was stored', async () => {
    const { env, put, forward, request } = setup();
    forward.mockImplementationOnce(async () =>
      Response.json({ error: 'busy' }, { status: 429, headers: { 'Retry-After': '10' } }),
    );
    const response = await host.fetch(request('/extract', secret, 'POST'), env);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('10');
    expect(put).not.toHaveBeenCalled();
  });
  it('does not trust a grant from another tenant/job for storage', async () => {
    const { env, put, forward, request } = setup();
    const input = request('/extract', secret, 'POST');
    input.headers.set('X-Tenant-ID', '00000000-0000-4000-8000-000000000099');
    expect((await host.fetch(input, env)).status).toBe(403);
    expect(put).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });
  it('fails closed outside staging and hides provider failures', async () => {
    const { env, get, request } = setup();
    expect((await host.fetch(request('/health'), { ...env, APP_ENV: 'production' })).status).toBe(
      503,
    );
    get.mockRejectedValue(new Error('synthetic-sensitive-detail'));
    const result = await host.fetch(request(`/sources/${tenant}/${job}`), env);
    expect(result.status).toBe(502);
    expect(await result.text()).not.toContain('synthetic-sensitive-detail');
  });
});
