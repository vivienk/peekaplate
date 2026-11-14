import assert from 'node:assert/strict';
import test from 'node:test';
import { runLunaAccessProbe } from './probe-owner-ai-luna.mjs';

const model = 'gpt-6-luna';
const args = ['--run-approved-probe'];
const env = {
  OWNER_AI_OPENAI_API_KEY: 'sk-fixture-only',
  OWNER_AI_OPENAI_PROJECT_ID: 'proj_fixture_only',
};

function responseBody() {
  return {
    id: 'resp_fixture_only',
    model,
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_fixture_only', summary: [] },
      {
        type: 'message',
        id: 'msg_fixture_only',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '{"status":"connected"}', annotations: [] }],
      },
    ],
    usage: { input_tokens: 19, output_tokens: 7, total_tokens: 26 },
  };
}

test('needs an exact opt-in flag and both dedicated credentials before any outbound request', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return Response.json(responseBody());
  };

  for (const disabledArgs of [[], ['--run-approved-probe', '--extra'], ['--extra']]) {
    assert.deepEqual(await runLunaAccessProbe({ args: disabledArgs, env, fetchImpl }), {
      status: 'disabled',
      model,
    });
  }

  for (const incompleteEnv of [
    {},
    { OWNER_AI_OPENAI_API_KEY: env.OWNER_AI_OPENAI_API_KEY },
    { OWNER_AI_OPENAI_PROJECT_ID: env.OWNER_AI_OPENAI_PROJECT_ID },
    {
      OPENAI_API_KEY: env.OWNER_AI_OPENAI_API_KEY,
      OWNER_AI_OPENAI_PROJECT_ID: env.OWNER_AI_OPENAI_PROJECT_ID,
    },
  ]) {
    assert.deepEqual(await runLunaAccessProbe({ args, env: incompleteEnv, fetchImpl }), {
      status: 'configuration_required',
      model,
    });
  }
  assert.equal(calls, 0);
});

test('sends one bounded structured request and reports only normalized usage', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ ...responseBody(), model: 'gpt-6-luna-2026-11-01' });
  };

  assert.deepEqual(await runLunaAccessProbe({ args, env, fetchImpl }), {
    status: 'verified',
    model,
    usage: { inputTokens: 19, outputTokens: 7, totalTokens: 26 },
  });
  assert.equal(requests.length, 1);
  const [{ url, init }] = requests;
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  const headers = new Headers(init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${env.OWNER_AI_OPENAI_API_KEY}`);
  assert.equal(headers.get('openai-project'), env.OWNER_AI_OPENAI_PROJECT_ID);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.ok(!init.body.includes(env.OWNER_AI_OPENAI_API_KEY));
  assert.ok(!init.body.includes(env.OWNER_AI_OPENAI_PROJECT_ID));

  const body = JSON.parse(init.body);
  assert.equal(body.model, model);
  assert.equal(body.store, false);
  assert.notEqual(body.stream, true);
  assert.equal(body.max_output_tokens, 64);
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.equal(body.tool_choice, 'none');
  assert.deepEqual(body.tools ?? [], []);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  const schema = body.text.format.schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['status']);
  assert.deepEqual(Object.keys(schema.properties), ['status']);
  const status = schema.properties.status;
  assert.deepEqual(status.enum ?? [status.const], ['connected']);
});

test('reports HTTP and redirect failure without reading a private error body or retrying', async () => {
  for (const status of [302, 401, 429, 500]) {
    let calls = 0;
    let bodyReads = 0;
    const result = await runLunaAccessProbe({
      args,
      env,
      fetchImpl: async () => {
        calls++;
        return {
          status,
          ok: false,
          headers: new Headers({ Location: 'https://fixture.invalid/' }),
          json() {
            bodyReads++;
            return { privateError: env.OWNER_AI_OPENAI_API_KEY };
          },
        };
      },
    });
    assert.deepEqual(result, { status: 'request_failed', model });
    assert.equal(calls, 1);
    assert.equal(bodyReads, 0);
  }
});

test('fails closed for invalid, refused, ambiguous or unaccountable provider output', async () => {
  const assistant = responseBody().output[1];
  for (const change of [
    { status: 'incomplete' },
    { model: 'other-model' },
    { output: [{ ...assistant, role: 'user' }] },
    { output: [{ ...assistant, content: [{ type: 'refusal', refusal: 'Fixture refusal' }] }] },
    { output: [{ ...assistant, content: [{ type: 'output_text', text: 'invalid JSON' }] }] },
    {
      output: [
        { ...assistant, content: [{ type: 'output_text', text: '{"status":"unexpected"}' }] },
      ],
    },
    {
      output: [
        {
          ...assistant,
          content: [{ type: 'output_text', text: '{"status":"connected","extra":true}' }],
        },
      ],
    },
    { output: [{ type: 'function_call', name: 'unexpected_tool' }, assistant] },
    { output: [assistant, assistant] },
    { usage: undefined },
    { usage: { input_tokens: 19, output_tokens: 7, total_tokens: 27 } },
  ]) {
    const result = await runLunaAccessProbe({
      args,
      env,
      fetchImpl: async () => Response.json({ ...responseBody(), ...change }),
    });
    assert.deepEqual(result, { status: 'invalid_response', model });
  }
});

test('sanitizes transport exceptions and classifies deadline expiry without retrying', async () => {
  for (const [error, status] of [
    [new Error(`Fixture diagnostic containing ${env.OWNER_AI_OPENAI_API_KEY}`), 'request_failed'],
    [new DOMException('Fixture deadline expired', 'TimeoutError'), 'timed_out'],
  ]) {
    let calls = 0;
    const result = await runLunaAccessProbe({
      args,
      env,
      fetchImpl: async () => {
        calls++;
        throw error;
      },
    });
    assert.deepEqual(result, { status, model });
    assert.equal(calls, 1);
  }
});
