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
function setup() {
  const forward = vi.fn(async () => Response.json({ status: 'ok' }));
  const get = vi.fn(async () => ({ size: 3, body: new Blob(['pdf']).stream() }));
  const env: ExtractionHostEnv = {
    APP_ENV: 'staging',
    EXTRACTION_SERVICE_SECRET: secret,
    EXTRACTION_SOURCE_SIGNING_SECRET: signingSecret,
    EXTRACTION_SOURCE_ORIGIN: 'https://peekaplate-extraction-staging.vxkong.workers.dev',
    EXTRACTOR: { getByName: vi.fn(() => ({ fetch: forward })) },
    SOURCE_BUCKET: { get },
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
  return { env, get, forward, request };
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
