import assert from 'node:assert/strict';
import test from 'node:test';
import { localModelProxy } from './local-model-proxy.mjs';

async function call({
  url = '/__local3d/v1/model-jobs',
  method = 'POST',
  headers = {},
  body = '{}',
  token = 'synthetic-server-token',
  upstream,
} = {}) {
  const calls = [];
  const req = {
    url,
    method,
    headers: { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', ...headers },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body);
    },
  };
  const res = {
    writeHead(status, responseHeaders) {
      this.status = status;
      this.headers = responseHeaders;
    },
    end(data) {
      this.body = data;
    },
  };
  await localModelProxy({
    token,
    fetchImpl: async (...args) => {
      calls.push(args);
      return (
        upstream ||
        new Response('{"status":"queued"}', {
          status: 202,
          headers: { 'content-type': 'application/json', authorization: 'must-not-forward' },
        })
      );
    },
  })(req, res, () => {
    res.next = true;
  });
  return { res, calls };
}

test('proxy injects only server credentials into the fixed loopback API', async () => {
  const { res, calls } = await call({
    headers: { authorization: 'browser-value', cookie: 'private' },
  });
  assert.equal(calls[0][0], 'http://127.0.0.1:5182/v1/model-jobs');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer synthetic-server-token');
  assert.equal(calls[0][1].headers.cookie, undefined);
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(res.status, 202);
  assert.equal(res.headers.authorization, undefined);
  assert.ok(!res.body.toString().includes('synthetic-server-token'));
});

test('proxy blocks cross-origin writes, hostile hosts, arbitrary routes and query strings', async () => {
  for (const input of [
    { headers: { origin: 'https://evil.test' } },
    { headers: { origin: undefined } },
    { headers: { host: 'evil.test' } },
    { headers: { 'sec-fetch-site': 'cross-site' } },
    { url: '/__local3d/v1/model-jobs?target=other' },
    { url: '/__local3d/../../account' },
  ]) {
    const { res, calls } = await call(input);
    assert.ok([403, 404].includes(res.status));
    assert.equal(calls.length, 0);
  }
});

test('proxy fails closed without configuration and bounds request bodies', async () => {
  assert.equal((await call({ token: '' })).res.status, 503);
  const { res, calls } = await call({ body: 'x'.repeat(8193) });
  assert.equal(res.status, 413);
  assert.equal(calls.length, 0);
});

test('only whitelisted artifact downloads are forwarded', async () => {
  const base = '/__local3d/v1/model-jobs/22222222-2222-4222-8222-222222222222/artifacts/';
  assert.equal((await call({ url: base + 'model.glb', method: 'GET' })).calls.length, 1);
  assert.equal((await call({ url: base + 'job.json', method: 'GET' })).res.status, 404);
});
