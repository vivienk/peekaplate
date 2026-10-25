import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyTeamDenial } from './verify-team-access.mjs';

const token = 'synthetic_token_not_a_credential';
const identity = { login: 'fixture-outsider', id: 12, type: 'User' };

function fixture(responses, overrides = {}) {
  const logs = [];
  const calls = [];
  return {
    logs,
    calls,
    options: {
      expectedLogin: identity.login,
      getToken: async () => token,
      progress: (line) => logs.push(line),
      request: async (url, init) => {
        calls.push({ url, init });
        return responses.shift();
      },
      ...overrides,
    },
  };
}

test('only passes a verified identity and both explicit forbidden responses', async () => {
  const setup = fixture([
    Response.json(identity),
    Response.json({ error: 'forbidden' }, { status: 403 }),
    Response.json({ error: 'forbidden' }, { status: 403 }),
  ]);
  const result = await verifyTeamDenial(setup.options);
  assert.equal(result.passed, true);
  assert.deepEqual(
    result.checks.map((check) => check.status),
    [200, 403, 403],
  );
  assert.equal(result.login, identity.login);
  assert.equal(setup.calls.length, 3);
  assert.equal(setup.logs.join('\n').includes(token), false);
  for (const call of setup.calls) {
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.method, 'GET');
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal(call.init.headers.Authorization, `Bearer ${token}`);
  }
  assert.equal(new URL(setup.calls[0].url).origin, 'https://api.github.com');
  assert.equal(
    new URL(setup.calls[1].url).origin,
    'https://peekaplate-api-staging.vxkong.workers.dev',
  );
});

test('refuses a different signed-in account before contacting staging', async () => {
  const setup = fixture([Response.json({ ...identity, login: 'different-user' })]);
  const result = await verifyTeamDenial(setup.options);
  assert.equal(result.passed, false);
  assert.match(result.reason, /does not match/);
  assert.equal(setup.calls.length, 1);
});

test('invalid GitHub authentication cannot count as a membership denial', async () => {
  const setup = fixture([Response.json({ message: token }, { status: 401 })]);
  const result = await verifyTeamDenial(setup.options);
  assert.equal(result.passed, false);
  assert.equal(setup.calls.length, 1);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('requires both endpoints and the exact forbidden error', async () => {
  for (const [status, body] of [
    [401, { error: 'unauthorized' }],
    [503, {}],
    [403, { error: 'other' }],
    [302, {}],
  ]) {
    const setup = fixture([
      Response.json(identity),
      Response.json(body, { status }),
      Response.json({ error: 'forbidden' }, { status: 403 }),
    ]);
    const result = await verifyTeamDenial(setup.options);
    assert.equal(result.passed, false, `status ${status} must not pass`);
    assert.equal(setup.calls.length, 3, 'the second endpoint is still tested');
  }
});

test('unexpected access is a failed test and returned analytics are never read', async () => {
  const response = Response.json({ privateData: token });
  response.json = () => {
    throw new Error('must not read analytics');
  };
  const setup = fixture([
    Response.json(identity),
    response,
    Response.json({ error: 'forbidden' }, { status: 403 }),
  ]);
  const result = await verifyTeamDenial(setup.options);
  assert.equal(result.passed, false);
  assert.equal(result.checks[1].status, 200);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(setup.logs.join('\n').includes(token), false);
});

test('network failures are bounded and cannot leak provider exception text', async () => {
  const setup = fixture([], {
    timeoutMs: 5,
    request: async (_url, init) => {
      await new Promise((resolve) => {
        init.signal.addEventListener('abort', resolve, { once: true });
      });
      throw new Error(token);
    },
  });
  // AbortSignal.timeout uses an unref timer; keep this isolated fixture alive until abort.
  const keepAlive = setInterval(() => {}, 20);
  try {
    const result = await verifyTeamDenial(setup.options);
    assert.equal(result.passed, false);
    assert.match(result.reason, /failed or timed out/);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(setup.logs.join('\n').includes(token), false);
  } finally {
    clearInterval(keepAlive);
  }
});

test('malformed denial JSON fails without printing its body', async () => {
  const setup = fixture([
    Response.json(identity),
    new Response(token, { status: 403 }),
    Response.json({ error: 'forbidden' }, { status: 403 }),
  ]);
  const result = await verifyTeamDenial(setup.options);
  assert.equal(result.passed, false);
  assert.match(result.checks[1].error, /invalid denial JSON/);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('credential lookup failures expose guidance instead of child-process output', async () => {
  const setup = fixture([], {
    getToken: async () => {
      throw new Error(token);
    },
  });
  await assert.rejects(verifyTeamDenial(setup.options), /GitHub CLI credential unavailable/);
  assert.equal(setup.calls.length, 0);
  assert.equal(setup.logs.join('\n').includes(token), false);
});

test('records only safe request IDs and matches accounts case-insensitively', async () => {
  const setup = fixture(
    [
      Response.json(identity),
      Response.json(
        { error: 'forbidden' },
        { status: 403, headers: { 'X-Request-ID': '00000000-0000-4000-8000-000000000001' } },
      ),
      Response.json({ error: 'forbidden' }, { status: 403, headers: { 'X-Request-ID': token } }),
    ],
    { expectedLogin: identity.login.toUpperCase() },
  );
  const result = await verifyTeamDenial(setup.options);
  assert.equal(result.passed, true);
  assert.ok(result.verifiedAt.endsWith('Z'));
  assert.equal(result.checks[1].requestId, '00000000-0000-4000-8000-000000000001');
  assert.equal('requestId' in result.checks[2], false);
});

test('CLI help and invalid arguments finish without token prompts or argument disclosure', () => {
  const script = fileURLToPath(new URL('./verify-team-access.mjs', import.meta.url));
  for (const args of [['--help'], [], [`--token=${token}`]]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.signal, null);
    assert.equal(result.status, args[0] === '--help' ? 0 : 1);
    assert.match(result.stdout + result.stderr, /Usage:/);
    assert.equal((result.stdout + result.stderr).includes(token), false);
    assert.equal((result.stdout + result.stderr).includes('input hidden'), false);
  }
});
