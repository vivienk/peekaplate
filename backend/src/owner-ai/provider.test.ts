import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isOwnerAiProjectId,
  logOwnerAiFailure,
  OwnerAiProviderFailure,
  requestOwnerAiResponse,
} from './provider';

const request = {
  apiKey: 'synthetic-key-never-for-a-real-provider',
  projectId: 'proj_synthetic-project_1',
  body: { model: 'gpt-6-luna', store: false, tools: [], input: 'Synthetic fixture' },
};
afterEach(() => vi.restoreAllMocks());

describe('owner AI provider boundary', () => {
  it('dispatches one bounded request with the provisioned project-ID format', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetchImpl = vi.fn(async () => Response.json({ status: 'completed' }));
    expect(await requestOwnerAiResponse({ ...request, fetchImpl })).toEqual({
      data: { status: 'completed' },
      httpStatus: 200,
    });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(5_000);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('https://api.openai.com/v1/responses', {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        'OpenAI-Project': request.projectId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request.body),
    });
  });

  it.each([undefined, '', 'proj_', 'proj_bad value', 'proj_bad\nheader', 'other_fixture'])(
    'rejects invalid project configuration %s before transport',
    async (projectId) => {
      expect(isOwnerAiProjectId(projectId)).toBe(false);
      const fetchImpl = vi.fn();
      await expect(
        requestOwnerAiResponse({ ...request, projectId: projectId ?? '', fetchImpl }),
      ).rejects.toMatchObject({
        diagnostic: { category: 'configuration', httpStatus: null, providerCode: null },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    [400, 'invalid_json_schema'],
    [401, 'invalid_api_key'],
    [403, 'insufficient_permissions'],
    [404, 'model_not_found'],
    [429, 'insufficient_quota'],
    [429, 'rate_limit_exceeded'],
    [429, 'credit_balance_exhausted'],
    [429, 'project_spend_limit_exceeded'],
    [429, 'organization_spend_limit_exceeded'],
    [429, 'organization_usage_limit_exceeded'],
    [503, 'server_is_overloaded'],
  ] as const)('retains only HTTP %s and code %s without retry', async (httpStatus, code) => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: { code, message: request.apiKey, param: request.body, type: request.apiKey } },
        { status: httpStatus, headers: { 'x-request-id': request.apiKey } },
      ),
    );
    const error = await requestOwnerAiResponse({ ...request, fetchImpl }).catch((error) => error);
    expect(error).toBeInstanceOf(OwnerAiProviderFailure);
    expect(error.diagnostic).toEqual({ category: 'provider_http', httpStatus, providerCode: code });
    expect(JSON.stringify(error)).not.toContain(request.apiKey);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([request.apiKey, 'unknown_machine_code', { secret: request.apiKey }, null])(
    'drops unrecognized or non-string provider codes',
    async (code) => {
      const fetchImpl = vi.fn(async () => Response.json({ error: { code } }, { status: 400 }));
      await expect(requestOwnerAiResponse({ ...request, fetchImpl })).rejects.toMatchObject({
        diagnostic: { category: 'provider_http', httpStatus: 400, providerCode: null },
      });
    },
  );

  it.each([302, 401, 429, 500])(
    'retains HTTP %s when error content is not JSON',
    async (status) => {
      const fetchImpl = vi.fn(async () => new Response(request.apiKey, { status }));
      await expect(requestOwnerAiResponse({ ...request, fetchImpl })).rejects.toMatchObject({
        diagnostic: { category: 'provider_http', httpStatus: status, providerCode: null },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([200, 429])(
    'bounds streamed bytes and cancels oversized HTTP %s bodies',
    async (status) => {
      const cancel = vi.fn();
      const bytes = new TextEncoder().encode(`{"value":"${'é'.repeat(17_000)}"}`);
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes.subarray(0, 16_000));
                controller.enqueue(bytes.subarray(16_000));
              },
              cancel,
            }),
            { status },
          ),
      );
      await expect(requestOwnerAiResponse({ ...request, fetchImpl })).rejects.toMatchObject({
        diagnostic: {
          category: status === 200 ? 'invalid_response' : 'provider_http',
          httpStatus: status,
          providerCode: null,
        },
      });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it('accepts exactly the byte limit and UTF-8 split across chunks', async () => {
    const text = JSON.stringify({ value: `é${'a'.repeat(32_754)}` });
    const bytes = new TextEncoder().encode(text);
    expect(bytes.byteLength).toBe(32_768);
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 11));
              controller.enqueue(bytes.subarray(11));
              controller.close();
            },
          }),
        ),
    );
    expect(await requestOwnerAiResponse({ ...request, fetchImpl })).toEqual({
      data: JSON.parse(text),
      httpStatus: 200,
    });
  });

  it.each(['not-json', 'null', '[]', '"a string"'])(
    'classifies malformed successful content without logging it',
    async (body) => {
      const fetchImpl = vi.fn(async () => new Response(body));
      await expect(requestOwnerAiResponse({ ...request, fetchImpl })).rejects.toMatchObject({
        diagnostic: { category: 'invalid_response', httpStatus: 200, providerCode: null },
      });
    },
  );

  it('classifies transport failure without retaining exception details', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(request.apiKey);
    });
    await expect(requestOwnerAiResponse({ ...request, fetchImpl })).rejects.toMatchObject({
      diagnostic: { category: 'transport', httpStatus: null, providerCode: null },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('enforces the deadline when fetch never resolves', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const pending = requestOwnerAiResponse({ ...request, fetchImpl });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      diagnostic: { category: 'timeout', httpStatus: null, providerCode: null },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([200, 429])('bounds a stalled HTTP %s response body', async (status) => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let started: () => void = () => {};
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull() {
              started();
            },
            cancel,
          }),
          { status },
        ),
    );
    const pending = requestOwnerAiResponse({ ...request, fetchImpl });
    await reading;
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      diagnostic: {
        category: status === 200 ? 'timeout' : 'provider_http',
        httpStatus: status,
        providerCode: null,
      },
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('owner AI operational logging', () => {
  it('logs only the operation, category, status and allowlisted code', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = new OwnerAiProviderFailure({
      category: 'provider_http',
      httpStatus: 401,
      providerCode: 'invalid_api_key',
    });
    Object.assign(error, { message: request.apiKey, cause: request, headers: request });
    logOwnerAiFailure('owner_analysis', error);
    expect(warn).toHaveBeenCalledExactlyOnceWith('owner_ai_failure', {
      operation: 'owner_analysis',
      category: 'provider_http',
      httpStatus: 401,
      providerCode: 'invalid_api_key',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(request.apiKey);
  });

  it('drops codes that echo secrets and does not trust arbitrary error objects', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = new OwnerAiProviderFailure({
      category: 'provider_http',
      httpStatus: 400,
      providerCode: request.apiKey,
    });
    logOwnerAiFailure('dish_description', error);
    logOwnerAiFailure(
      'owner_analysis',
      { diagnostic: request, message: request.apiKey },
      {
        category: 'invalid_response',
        httpStatus: 200,
      },
    );
    expect(warn.mock.calls).toEqual([
      [
        'owner_ai_failure',
        {
          operation: 'dish_description',
          category: 'provider_http',
          httpStatus: 400,
          providerCode: null,
        },
      ],
      [
        'owner_ai_failure',
        {
          operation: 'owner_analysis',
          category: 'invalid_response',
          httpStatus: 200,
          providerCode: null,
        },
      ],
    ]);
  });

  it('does not propagate logger failure into the public response path', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('synthetic unavailable logger');
    });
    expect(() => logOwnerAiFailure('owner_analysis', new Error(request.apiKey))).not.toThrow();
  });
});
