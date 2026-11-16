import { describe, expect, it, vi } from 'vitest';
import { createOwnerMenuClient, OwnerMenuApiError, sha256Hex } from './api';
import { JOB, reviewSession, VENUE } from './fixtures.test-helpers';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<{ status: number; body: unknown } | Error>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no response queued');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function client(responses: Array<{ status: number; body: unknown } | Error>) {
  const fake = fakeFetch(responses);
  const api = createOwnerMenuClient({
    baseUrl: 'https://peekaplate-api-staging.vxkong.workers.dev/',
    getToken: () => 'staff-token',
    fetch: fake.fetchImpl,
  });
  return { api, calls: fake.calls };
}

const header = (call: Call | undefined, name: string) =>
  new Headers(call?.init.headers as HeadersInit).get(name);

const job = (overrides: Record<string, unknown> = {}) => ({
  id: JOB,
  source_type: 'pdf',
  status: 'queued',
  attempt_count: 0,
  max_attempts: 3,
  error_code: null,
  draft_count: 0,
  upload_index: 0,
  source_uploaded: false,
  created_at: '2026-11-12T10:00:00Z',
  started_at: null,
  finished_at: null,
  ...overrides,
});

describe('owner menu client', () => {
  it('verifies a saved dish with caller command identity and rejects a mismatched response', async () => {
    const command = { commandId: crypto.randomUUID(), expectedVersion: 1, verified: true };
    const { api, calls } = client([{ status: 200, body: { draft: { id: JOB } } }]);
    await expect(api.verifyDraft(VENUE, VENUE, command)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(calls[0]?.url).toContain(`/drafts/${VENUE}/verify`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(command);
  });

  it('approves only the requested draft photo through the existing authenticated transport', async () => {
    const { api, calls } = client([{ status: 200, body: { photo: { id: JOB } } }]);
    const commandId = crypto.randomUUID();
    await expect(api.approveDraftPhoto(VENUE, VENUE, JOB, { commandId })).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(calls[0]?.url).toContain(`/drafts/${VENUE}/photos/${JOB}/approve`);
    expect(header(calls[0], 'Authorization')).toBe('Bearer staff-token');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ commandId });
  });

  it('reads private image bytes with staff auth and rejects non-image responses', async () => {
    let type = 'image/png';
    const send = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': type } }),
    );
    const getToken = vi.fn(() => 'fresh-staff-token');
    const api = createOwnerMenuClient({ baseUrl: 'http://127.0.0.1:8787', getToken, fetch: send });
    const bytes = await api.readDraftPhoto(VENUE, JOB, JOB);
    expect(bytes.type).toBe('image/png');
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      headers: { Authorization: 'Bearer fresh-staff-token' },
    });
    type = 'text/html';
    await expect(api.readDraftPhoto(VENUE, JOB, JOB)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it('rejects a review session from another restaurant', async () => {
    const { api } = client([{ status: 200, body: { ...reviewSession(), venueId: JOB } }]);
    await expect(api.openReviewSession(VENUE, JOB, crypto.randomUUID())).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
  it('rejects an untrusted origin before reading credentials', () => {
    const getToken = vi.fn(() => 'private');
    for (const baseUrl of [
      'https://evil.test',
      'https://peekaplate-api-staging.vxkong.workers.dev/path',
      'https://user@peekaplate-api-staging.vxkong.workers.dev',
      'https://peekaplate-api-staging.vxkong.workers.dev/?x=1',
    ]) {
      expect(() => createOwnerMenuClient({ baseUrl, getToken })).toThrow();
    }
    expect(getToken).not.toHaveBeenCalled();
  });

  it('does not send after logout or cancellation during token refresh', async () => {
    const send = vi.fn();
    const controller = new AbortController();
    const api = createOwnerMenuClient({
      baseUrl: 'http://127.0.0.1:8787',
      getToken: async () => {
        controller.abort();
        return 'token';
      },
      signal: controller.signal,
      fetch: send,
    });
    await expect(api.listJobs(VENUE, 'g1')).rejects.toMatchObject({ code: 'aborted' });
    const signedOut = createOwnerMenuClient({
      baseUrl: 'http://127.0.0.1:8787',
      getToken: () => null,
      fetch: send,
    });
    await expect(signedOut.listJobs(VENUE, 'g1')).rejects.toMatchObject({ status: 401 });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects incomplete job data instead of rendering invented processing state', async () => {
    const { api } = client([{ status: 200, body: { jobs: [{ id: JOB }] } }]);
    await expect(api.listJobs(VENUE, 'g1')).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('declares an upload group with the bearer token and no cookies', async () => {
    const { api, calls } = client([{ status: 202, body: { group: { id: 'g1', jobs: [job()] } } }]);
    const hash = await sha256Hex(new Blob(['%PDF-1.7 fixture']));
    const group = await api.createUploadGroup(VENUE, {
      idempotencyKey: 'key_0123456789abcdef',
      files: [{ sourceType: 'pdf', sourceHash: hash }],
    });
    expect(group.jobs[0]?.id).toBe(JOB);
    expect(calls[0]?.url).toBe(
      `https://peekaplate-api-staging.vxkong.workers.dev/venues/${VENUE}/menus/upload-groups`,
    );
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.credentials).toBe('omit');
    expect(calls[0]?.init.redirect).toBe('error');
    expect(header(calls[0], 'Authorization')).toBe('Bearer staff-token');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      idempotencyKey: 'key_0123456789abcdef',
      files: [{ sourceType: 'pdf', sourceHash: hash }],
    });
  });

  it('rejects an invalid selection before sending anything', async () => {
    const { api, calls } = client([]);
    const hash = 'a'.repeat(64);
    // A PDF must be the only file.
    await expect(
      api.createUploadGroup(VENUE, {
        idempotencyKey: 'key_0123456789abcdef',
        files: [
          { sourceType: 'pdf', sourceHash: hash },
          { sourceType: 'photo', sourceHash: hash },
        ],
      }),
    ).rejects.toThrow();
    // Files over 12 MB never leave the browser.
    await expect(
      api.uploadGroupFile(
        VENUE,
        'g1',
        0,
        new Blob([new Uint8Array(12_000_001)]),
        'key_0123456789abcdef',
      ),
    ).rejects.toMatchObject({ code: 'file_too_large' });
    expect(calls).toHaveLength(0);
  });

  it('puts raw file bytes with their type and idempotency key', async () => {
    const { api, calls } = client([{ status: 202, body: { group: { id: 'g1', jobs: [job()] } } }]);
    const file = new Blob(['photo-bytes'], { type: 'image/jpeg' });
    await api.uploadGroupFile(VENUE, 'g1', 2, file, 'upload_key_0123456789');
    expect(calls[0]?.url).toBe(
      `https://peekaplate-api-staging.vxkong.workers.dev/venues/${VENUE}/menus/upload-groups/g1/files/2`,
    );
    expect(calls[0]?.init.method).toBe('PUT');
    expect(header(calls[0], 'Content-Type')).toBe('image/jpeg');
    expect(header(calls[0], 'Idempotency-Key')).toBe('upload_key_0123456789');
    expect(calls[0]?.init.body).toBe(file);
  });

  it('turns server errors into typed errors the screens can act on', async () => {
    const { api } = client([
      { status: 400, body: { error: 'menu_file_link_required' } },
      { status: 409, body: { error: 'version_conflict' } },
      { status: 503, body: {} },
      new TypeError('Failed to fetch'),
    ]);
    const url = { url: 'https://restaurant.example/menu', idempotencyKey: 'url_key_0123456789ab' };
    await expect(api.submitMenuUrl(VENUE, url)).rejects.toMatchObject({
      status: 400,
      code: 'menu_file_link_required',
      isRetryable: false,
    });
    const conflict = await api.getDraft(VENUE, 'd1').catch((error: OwnerMenuApiError) => error);
    expect(conflict).toBeInstanceOf(OwnerMenuApiError);
    expect(conflict).toMatchObject({ isConflict: true, isRetryable: false });
    await expect(api.listJobs(VENUE, 'g1')).rejects.toMatchObject({
      status: 503,
      code: 'http_error',
      isRetryable: true,
    });
    await expect(api.listJobs(VENUE, 'g1')).rejects.toMatchObject({
      code: 'network',
      isRetryable: true,
    });
  });

  it('reads jobs for resume and parses the review session against the contract', async () => {
    const session = reviewSession();
    const { api, calls } = client([
      { status: 200, body: { jobs: [job({ status: 'complete', draft_count: 3 })] } },
      { status: 200, body: session },
      { status: 200, body: { schemaVersion: 1, items: 'not a list' } },
    ]);
    const jobs = await api.listJobs(VENUE, 'g 1');
    expect(jobs[0]?.status).toBe('complete');
    expect(calls[0]?.url).toBe(
      `https://peekaplate-api-staging.vxkong.workers.dev/venues/${VENUE}/menus/jobs?groupId=g%201`,
    );
    const opened = await api.openReviewSession(VENUE, JOB, crypto.randomUUID());
    expect(opened.items.map((entry) => entry.effective.name)).toEqual(
      session.items.map((entry) => entry.effective.name),
    );
    // A body that does not match the contract never reaches the screen.
    await expect(api.openReviewSession(VENUE, JOB, crypto.randomUUID())).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('validates draft saves and review corrections before sending them', async () => {
    const { api, calls } = client([]);
    await expect(
      api.saveManualDraft(VENUE, 'd1', {
        commandId: crypto.randomUUID(),
        expectedVersion: 0,
        // An unknown allergen status cannot carry items.
        fields: {
          name: 'Soup',
          category: null,
          description: null,
          priceAmount: null,
          priceCurrency: null,
          ingredients: { status: 'unknown', items: [] },
          allergens: { status: 'unknown', items: ['milk'] },
          photoId: null,
        },
      }),
    ).rejects.toThrow();
    await expect(
      api.reviewCandidate(VENUE, 'extraction:1', 'draft:1', {
        commandId: crypto.randomUUID(),
        expectedVersion: 0,
        action: 'correct',
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('only uploads JPEG or PNG dish photos', async () => {
    const { api, calls } = client([]);
    await expect(
      api.uploadDraftPhoto(
        VENUE,
        'd1',
        new Blob(['x'], { type: 'image/gif' }),
        'photo_key_0123456789',
      ),
    ).rejects.toMatchObject({ code: 'unsupported_media_type' });
    expect(calls).toHaveLength(0);
  });

  it('preserves a previously rejected photo when identical bytes are uploaded again', async () => {
    const photo = {
      id: crypto.randomUUID(),
      draftId: JOB,
      contentType: 'image/png',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
      verificationStatus: 'rejected',
      storageKey: 'synthetic/private.png',
    };
    const { api } = client([{ status: 201, body: { photo } }]);
    await expect(
      api.uploadDraftPhoto(
        VENUE,
        JOB,
        new Blob(['x'], { type: 'image/png' }),
        'photo_key_0123456789',
      ),
    ).resolves.toEqual(photo);
  });
});

describe('timeouts', () => {
  it('fails a request with no answer as a retryable timeout instead of waiting forever', async () => {
    // A fetch that never answers until it is aborted.
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    const api = createOwnerMenuClient({
      baseUrl: 'https://peekaplate-api-staging.vxkong.workers.dev',
      getToken: () => 'staff-token',
      fetch: hanging,
      timeoutMs: 20,
    });
    await expect(api.listJobs(VENUE, 'g1')).rejects.toMatchObject({
      code: 'timeout',
      isRetryable: true,
    });
  });
});

describe('sha256Hex', () => {
  it('hashes the exact bytes as lowercase hex', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
