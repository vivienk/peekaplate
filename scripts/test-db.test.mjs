import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test, { mock } from 'node:test';
import { ensureSuccess, runIntegrationTests, startDatabase, validateTap } from './test-db.mjs';

test('integration launcher accepts pnpm mjs entry points and preserves failure reporting', (t) => {
  const originalExecPath = process.env.npm_execpath;
  process.env.npm_execpath = 'C:\\tools with spaces\\pnpm.mjs';
  t.after(() => {
    if (originalExecPath === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = originalExecPath;
  });
  const database = { runtimeUrl: 'runtime-fixture', adminUrl: 'admin-fixture' };
  let launched = false;
  runIntegrationTests(database, (command, args, options) => {
    assert.deepEqual(args.slice(1), ['run', '--config', 'vitest.db.config.ts']);
    assert.equal(options.env.PEEKAPLATE_DB_TEST_URL, database.runtimeUrl);
    assert.equal(options.env.PEEKAPLATE_DB_ADMIN_URL, database.adminUrl);
    const result = spawnSync(command, [args[0], '--version'], {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /vitest\//);
    launched = true;
    return result;
  });
  assert.equal(launched, true);
  assert.throws(
    () => runIntegrationTests(database, () => ({ status: 1, stderr: 'runner failure' })),
    /real database integration tests: exited 1.*runner failure/s,
  );
});

test('ensureSuccess rejects failed command exits', () => {
  assert.throws(() => ensureSuccess({ status: 1 }, 'migration'), /migration: exited 1/);
  assert.throws(
    () => ensureSuccess({ status: null, error: new Error('timeout') }, 'pgTAP'),
    /pgTAP: timeout/,
  );
});

test('failed database commands retain bounded stderr needed to diagnose SQL errors', () => {
  assert.throws(
    () => ensureSuccess({ status: 3, stderr: 'ERROR: column does not exist' }, 'pgTAP'),
    /pgTAP: exited 3.*column does not exist/s,
  );
  assert.throws(
    () => ensureSuccess({ status: 1, stderr: 'x'.repeat(3000) }, 'docker'),
    (error) => error.message.length < 2100,
  );
});

test('validateTap accepts a complete passing plan', () => {
  assert.equal(validateTap('1..2\nok 1 - first\nok 2 - second\n'), 2);
});

test('validateTap fails closed for invalid TAP', () => {
  for (const output of [
    ' ok 1 - first\n',
    '1..2\nok 1 - first\n',
    '1..1\n not ok 1 - failed\n',
    '1..1\nBail out! abort\n',
    '1..1\nok 1 - first\nBail out! abort after assertion\n',
  ]) {
    assert.throws(() => validateTap(output));
  }
});

test('database initialization waits for TCP instead of the temporary bootstrap socket', async (t) => {
  let tcpReady = false;
  let tcpChecks = 0;
  let migrations = 0;
  const subprocess = mock.method(childProcess, 'spawnSync', (_command, args, options = {}) => {
    const result = { status: 0, stdout: '', stderr: '' };
    if (args.includes('pg_isready')) {
      // PostgreSQL's bootstrap server accepts socket connections before TCP exists.
      if (!args.includes('-h')) return result;
      tcpReady = ++tcpChecks >= 2;
      return { ...result, status: tcpReady ? 0 : 1 };
    }
    if (args.includes('ghcr.io/amacneil/dbmate:2.36.0')) {
      if (!tcpReady) return { ...result, status: 2, stderr: 'TCP connection refused' };
      migrations += 1;
    }
    if (options.input?.startsWith('SELECT count(*)')) result.stdout = '1\n';
    if (args[0] === 'port') result.stdout = '127.0.0.1:55432\n';
    return result;
  });
  t.after(() => {
    subprocess.mock.restore();
    syncBuiltinESMExports();
  });
  syncBuiltinESMExports();

  const database = await startDatabase();
  assert.equal(tcpChecks, 2);
  assert.equal(migrations, 3);
  assert.match(database.runtimeUrl, /@127\.0\.0\.1:55432\/peekaplate/);
});
