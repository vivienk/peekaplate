import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { unstable_dev } from 'wrangler';
import { databaseSql, startDatabase, stopDatabase } from '../scripts/test-db.mjs';

const sessionFile = new URL('../work/local-session.json', import.meta.url);

async function demo() {
  const session = JSON.parse(await readFile(sessionFile, 'utf8'));
  const origin = new URL(session.origin);
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/'
  ) {
    throw new Error('The demo may contact only the local Worker');
  }
  const dishId = crypto.randomUUID();
  const input = {
    commandId: crypto.randomUUID(),
    expectedVersion: 0,
    name: 'Local test dish',
    description: 'Synthetic development content',
  };
  const response = await fetch(
    new URL(`/venues/${session.venueId}/dishes/${dishId}/revisions`, origin),
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const responseText = await response.text();
  let result;

  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Local command returned non-JSON (${response.status} ${response.headers.get('content-type')}): ${responseText.slice(0, 500) || '<empty body>'}`,
    );
  }

  if (!response.ok) {
    throw new Error(`Local command failed (${response.status}): ${result.error ?? responseText}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

async function develop(smoke) {
  let worker;
  let issuerServer;
  let wroteSession = false;
  let cleanupStarted = false;
  const cleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    try {
      if (worker) await worker.stop();
    } finally {
      try {
        if (issuerServer) await new Promise((resolve) => issuerServer.close(resolve));
      } finally {
        stopDatabase();
        if (wroteSession) await unlink(sessionFile);
      }
    }
  };
  const shutdown = () => {
    cleanup().finally(() => process.exit());
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    const database = await startDatabase();
    const venueId = crypto.randomUUID();
    const actorId = crypto.randomUUID();
    // IDs are generated here; the local fixture never accepts SQL or identity from a browser.
    databaseSql(`INSERT INTO app_private.venues(id,name) VALUES ('${venueId}','Local synthetic venue');
      INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES ('${venueId}','${actorId}','owner');`);
    const keys = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'local', alg: 'ES256' };
    issuerServer = createServer((request, response) => {
      if (request.url !== '/auth/v1/.well-known/jwks.json') {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise((resolve, reject) => {
      issuerServer.once('error', reject);
      issuerServer.listen(0, '127.0.0.1', resolve);
    });
    const issuer = `http://127.0.0.1:${issuerServer.address().port}/auth/v1`;
    worker = await unstable_dev(fileURLToPath(new URL('./src/index.ts', import.meta.url)), {
      config: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)),
      local: true,
      ip: '127.0.0.1',
      port: 8790,
      inspectorPort: 0,
      logLevel: 'error',
      vars: { APP_ENV: 'local', AUTH_ISSUER: issuer, LOCAL_DATABASE_URL: database.runtimeUrl },
      experimental: {
        disableExperimentalWarning: true,
        forceLocal: true,
        disableDevRegistry: true,
      },
    });
    const token = await new SignJWT({ role: 'authenticated', is_anonymous: false })
      .setProtectedHeader({ alg: 'ES256', kid: 'local' })
      .setIssuer(issuer)
      .setAudience('authenticated')
      .setSubject(actorId)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keys.privateKey);
    await mkdir(new URL('../work/', import.meta.url), { recursive: true });
    await writeFile(
      sessionFile,
      JSON.stringify({ origin: `http://127.0.0.1:${worker.port}`, venueId, actorId, token }),
      { flag: 'wx', mode: 0o600 },
    );
    wroteSession = true;
    console.log(
      `Local Worker ready at http://127.0.0.1:${worker.port}. Run pnpm local:demo in another terminal.`,
    );
    console.log(
      'Synthetic credentials expire in one hour. Ctrl+C removes the disposable database and session file.',
    );
    if (smoke) await demo();
    else await worker.waitUntilExit();
  } finally {
    await cleanup();
  }
}

try {
  if (process.argv[2] === 'demo') await demo();
  else await develop(process.argv[2] === 'check');
} catch (error) {
  console.error(`Local backend: ${error.message}`);
  process.exitCode = 1;
}
