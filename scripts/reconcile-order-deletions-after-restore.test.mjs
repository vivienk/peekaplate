import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  createR2S3Storage,
  runReconcileCli,
  validateR2S3Env,
  validateReconcileCliEnv,
} from './reconcile-order-deletions-after-restore.mjs';

test('validateReconcileCliEnv fails closed when OPERATOR_DATABASE_URL is missing', () => {
  assert.throws(
    () =>
      validateReconcileCliEnv({
        RECONCILIATION_OPERATOR_ID: '00000000-0000-4000-8000-000000000001',
      }),
    /OPERATOR_DATABASE_URL is required/,
  );
});

test('validateReconcileCliEnv fails closed when RECONCILIATION_OPERATOR_ID is invalid', () => {
  assert.throws(
    () =>
      validateReconcileCliEnv({
        OPERATOR_DATABASE_URL: 'postgres://peekaplate_operator_login:pw@127.0.0.1:5432/peekaplate',
        RECONCILIATION_OPERATOR_ID: 'not-a-uuid',
      }),
    /RECONCILIATION_OPERATOR_ID must be a valid canonical UUID/,
  );
});

test('validateReconcileCliEnv returns validated operator config', () => {
  const res = validateReconcileCliEnv({
    OPERATOR_DATABASE_URL: 'postgres://peekaplate_operator_login:pw@127.0.0.1:5432/peekaplate',
    RECONCILIATION_OPERATOR_ID: '00000000-0000-4000-8000-000000000001',
  });
  assert.equal(res.operatorId, '00000000-0000-4000-8000-000000000001');
  assert.ok(res.operatorDatabaseUrl.startsWith('postgres://'));
});

test('validateR2S3Env fails closed when R2 credentials are incomplete', () => {
  assert.throws(
    () =>
      validateR2S3Env({
        R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
        R2_BUCKET: 'peekaplate-orders',
      }),
    /R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required/,
  );
});

test('runReconcileCli returns exitCode 0 on clean reconciliation and closes client', async () => {
  let connected = false;
  let ended = false;
  const logs = [];
  const res = await runReconcileCli({
    env: {
      OPERATOR_DATABASE_URL: 'postgres://peekaplate_operator_login:pw@127.0.0.1:5432/peekaplate',
      RECONCILIATION_OPERATOR_ID: '00000000-0000-4000-8000-000000000001',
      R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
      R2_BUCKET: 'peekaplate-orders',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
    },
    createClient: async () => ({
      connect: async () => {
        connected = true;
      },
      end: async () => {
        ended = true;
      },
    }),
    createStorage: () => ({
      list: async () => ({ objects: [], truncated: false }),
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    }),
    reconcileFn: async (opts) => {
      assert.equal(opts.operatorId, '00000000-0000-4000-8000-000000000001');
      assert.ok(opts.authorizedOperatorIds.has('00000000-0000-4000-8000-000000000001'));
      return {
        reconciliationRunId: 'run-1',
        status: 'completed',
        freezeLifted: true,
        entriesProcessed: 1,
        reconciledCount: 1,
        blockedIntentOnlyCount: 0,
        anomalyCount: 0,
        entries: [],
      };
    },
    log: (msg) => logs.push(msg),
  });

  assert.equal(connected, true);
  assert.equal(ended, true);
  assert.equal(res.exitCode, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /restore_reconciliation_finished/);
});

test('runReconcileCli returns exitCode 1 when anomalies keep freeze active', async () => {
  let ended = false;
  const res = await runReconcileCli({
    env: {
      OPERATOR_DATABASE_URL: 'postgres://peekaplate_operator_login:pw@127.0.0.1:5432/peekaplate',
      RECONCILIATION_OPERATOR_ID: '00000000-0000-4000-8000-000000000001',
      R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
      R2_BUCKET: 'peekaplate-orders',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
    },
    createClient: async () => ({
      connect: async () => {},
      end: async () => {
        ended = true;
      },
    }),
    createStorage: () => ({
      list: async () => ({ objects: [], truncated: false }),
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    }),
    reconcileFn: async () => ({
      reconciliationRunId: 'run-2',
      status: 'failed',
      freezeLifted: false,
      entriesProcessed: 1,
      reconciledCount: 0,
      blockedIntentOnlyCount: 0,
      anomalyCount: 1,
      entries: [],
    }),
    log: () => {},
  });

  assert.equal(ended, true);
  assert.equal(res.exitCode, 1);
});

test('createR2S3Storage signs SigV4 requests, paginates ListObjectsV2, and surfaces HTTP errors', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      requests.push({
        method: req.method,
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        auth: req.headers.authorization,
        amzDate: req.headers['x-amz-date'],
        amzSha: req.headers['x-amz-content-sha256'],
        body: Buffer.concat(chunks).toString('utf8'),
      });

      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        if (url.searchParams.get('prefix') === 'malformed/') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html><body>bad gateway</body></html>');
          return;
        }
        const token = url.searchParams.get('continuation-token');
        res.writeHead(200, { 'content-type': 'application/xml' });
        if (!token) {
          res.end(
            '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>page-2</NextContinuationToken><Contents><Key>order-deletion-ledger/v1/r1/intent.json</Key></Contents></ListBucketResult>',
          );
        } else {
          res.end(
            '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>order-deletion-ledger/v1/r1/completed.json</Key></Contents></ListBucketResult>',
          );
        }
        return;
      }
      if (req.method === 'GET' && url.pathname.endsWith('/missing.json')) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname.endsWith('/forbidden.json')) {
        res.writeHead(403);
        res.end('AccessDenied');
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'PUT' || req.method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(500);
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}`;

  try {
    const storage = createR2S3Storage({
      endpoint,
      bucket: 'test-bucket',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    });

    const page1 = await storage.list({ prefix: 'order-deletion-ledger/' });
    assert.equal(page1.truncated, true);
    assert.equal(page1.cursor, 'page-2');
    assert.deepEqual(page1.objects, [{ key: 'order-deletion-ledger/v1/r1/intent.json' }]);

    const page2 = await storage.list({ prefix: 'order-deletion-ledger/', cursor: page1.cursor });
    assert.equal(page2.truncated, false);
    assert.deepEqual(page2.objects, [{ key: 'order-deletion-ledger/v1/r1/completed.json' }]);

    const missing = await storage.get('missing.json');
    assert.equal(missing, null);

    // Ensure XML entity decoding does not double-unescape &amp;lt; into <
    const listPage1 = await storage.list({ prefix: 'order-imports/' });
    assert.ok(Array.isArray(listPage1.objects));

    const present = await storage.get('order-deletion-ledger/v1/r1/intent.json');
    assert.deepEqual(await present.json(), { ok: true });

    await storage.put('order-deletion-ledger/v1/r1/reconciled.json', '{"reconciled":true}', {
      httpMetadata: { contentType: 'application/json' },
    });
    await storage.delete('order-imports/v1/b1/source.csv');

    await assert.rejects(() => storage.get('forbidden.json'), /failed with HTTP 403/);
    await assert.rejects(
      () => storage.list({ prefix: 'malformed/' }),
      /Malformed ListObjectsV2 XML response/,
    );

    for (const r of requests) {
      assert.match(
        r.auth,
        /^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=(content-type;)?host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
      );
      assert.ok(r.amzDate);
      assert.match(r.amzSha, /^[0-9a-f]{64}$/);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
