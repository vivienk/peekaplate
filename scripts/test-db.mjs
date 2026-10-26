import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const suffix = `${process.pid}-${Date.now()}`;
const network = `peekaplate-db-${suffix}`;
const container = `peekaplate-db-${suffix}`;
const postgresImage = 'peekaplate-postgres-pgtap:16.11';
const dbmateImage = 'ghcr.io/amacneil/dbmate:2.36.0';
const databaseUrl = 'postgres://postgres:peekaplate_test@db:5432/peekaplate?sslmode=disable';

export function ensureSuccess(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr?.trim().slice(-2000);
    throw new Error(
      `${label}: exited ${result.status ?? 'without a status'}${detail ? `\n${detail}` : ''}`,
    );
  }
}

export function validateTap(output) {
  if (/^\s*bail out!/im.test(output)) throw new Error('pgTAP bailed out');
  const failure = output.match(/^\s*not ok.*$/im);
  if (failure) {
    const lines = output.split(/\r?\n/);
    const index = lines.findIndex((line) => line.trim() === failure[0].trim());
    throw new Error(
      `pgTAP assertion failed: ${lines
        .slice(index, index + 5)
        .join(' ')
        .trim()}`,
    );
  }

  const plans = [...output.matchAll(/^\s*1\.\.(\d+)\s*$/gm)];
  if (plans.length !== 1) throw new Error('pgTAP must emit exactly one plan');

  const planned = Number(plans[0][1]);
  const assertions = [...output.matchAll(/^\s*ok\s+(\d+)(?:\s|$)/gim)].map((match) =>
    Number(match[1]),
  );
  if (planned === 0 || assertions.length !== planned)
    throw new Error(`pgTAP plan mismatch: expected ${planned}, got ${assertions.length}`);
  if (
    new Set(assertions).size !== planned ||
    assertions.some((number) => number < 1 || number > planned)
  ) {
    throw new Error('pgTAP assertion numbering is invalid');
  }
  return planned;
}

function docker(args, label, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  });
  ensureSuccess(result, label);
  return result;
}

async function waitForPostgres() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    // The temporary bootstrap server accepts Unix sockets before TCP is available.
    const result = spawnSync(
      'docker',
      [
        'exec',
        container,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-p',
        '5432',
        '-U',
        'postgres',
        '-d',
        'peekaplate',
      ],
      { cwd: root, encoding: 'utf8', timeout: 5_000 },
    );
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Postgres did not become ready within 30 seconds');
}

export function stopDatabase() {
  spawnSync('docker', ['rm', '--force', '--volumes', container], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  spawnSync('docker', ['network', 'rm', network], { encoding: 'utf8', timeout: 30_000 });
}

export function databaseSql(query) {
  return docker(
    [
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      'peekaplate',
      '--set',
      'ON_ERROR_STOP=1',
      '--tuples-only',
      '--no-align',
    ],
    'database fixture',
    { input: query },
  ).stdout;
}

export async function startDatabase() {
  try {
    docker(
      ['build', '--tag', postgresImage, '--file', 'tests/db/Dockerfile', 'tests/db'],
      'build database test image',
    );
    docker(['network', 'create', network], 'create database test network');
    docker(
      [
        'run',
        '--detach',
        '--name',
        container,
        '--network',
        network,
        '--network-alias',
        'db',
        '--publish',
        '127.0.0.1::5432',
        '--mount',
        `type=bind,source=${root}tests/db,target=/tests,readonly`,
        '--env',
        'POSTGRES_PASSWORD=peekaplate_test',
        '--env',
        'POSTGRES_DB=peekaplate',
        postgresImage,
      ],
      'start Postgres',
    );
    await waitForPostgres();
    const dbmateArgs = [
      'run',
      '--rm',
      '--network',
      network,
      '--env',
      `DATABASE_URL=${databaseUrl}`,
      '--mount',
      `type=bind,source=${root}migrations,target=/migrations,readonly`,
      '--mount',
      `type=bind,source=${root}migrations/202610130001_foundation.sql,target=/foundation/202610130001_foundation.sql,readonly`,
      dbmateImage,
      '--migrations-dir',
      '/migrations',
      'up',
    ];
    const foundationArgs = [...dbmateArgs];
    foundationArgs[foundationArgs.indexOf('/migrations')] = '/foundation';
    docker(foundationArgs, 'install previous schema');
    databaseSql(
      "INSERT INTO app_private.venues(id,name) VALUES ('00000000-0000-4000-8000-000000000099','Upgrade fixture');",
    );
    docker(dbmateArgs, 'apply migrations');
    docker(dbmateArgs, 'confirm migrations are already applied');
    if (
      databaseSql(
        "SELECT count(*) FROM app_private.venues WHERE id='00000000-0000-4000-8000-000000000099';",
      ).trim() !== '1'
    ) {
      throw new Error('Upgrade lost an existing venue');
    }
    databaseSql(
      "CREATE ROLE peekaplate_local LOGIN PASSWORD 'peekaplate_local_test' IN ROLE peekaplate_runtime;",
    );
    const address = docker(
      ['port', container, '5432/tcp'],
      'locate disposable database',
    ).stdout.trim();
    if (!/^127\.0\.0\.1:\d+$/.test(address))
      throw new Error('Test database must bind only to loopback');
    return {
      adminUrl: `postgres://postgres:peekaplate_test@${address}/peekaplate?sslmode=disable`,
      runtimeUrl: `postgres://peekaplate_local:peekaplate_local_test@${address}/peekaplate?sslmode=disable`,
    };
  } catch (error) {
    stopDatabase();
    throw error;
  }
}

export function runIntegrationTests(database, run = spawnSync) {
  const vitest = fileURLToPath(new URL('vitest.mjs', import.meta.resolve('vitest/package.json')));
  ensureSuccess(
    run(process.execPath, [vitest, 'run', '--config', 'vitest.db.config.ts'], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'inherit',
      timeout: 120_000,
      env: {
        ...process.env,
        PEEKAPLATE_DB_TEST_URL: database.runtimeUrl,
        PEEKAPLATE_DB_ADMIN_URL: database.adminUrl,
      },
    }),
    'real database integration tests',
  );
}

export async function main() {
  try {
    const database = await startDatabase();
    for (const file of readdirSync(new URL('../tests/db/', import.meta.url))
      .filter((file) => file.endsWith('.sql'))
      .sort()) {
      const tap = docker(
        [
          'exec',
          container,
          'psql',
          '--tuples-only',
          '--no-align',
          '--username',
          'postgres',
          '--dbname',
          'peekaplate',
          '--set',
          'ON_ERROR_STOP=1',
          '--file',
          `/tests/${file}`,
        ],
        'run pgTAP',
      );
      const count = validateTap(tap.stdout);
      process.stdout.write(`pgTAP ${file}: ${count} assertions passed\n`);
    }
    runIntegrationTests(database);
    ensureSuccess(
      spawnSync(process.execPath, ['backend/local.mjs', 'check'], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'inherit',
        timeout: 120_000,
      }),
      'local development command smoke test',
    );
  } finally {
    stopDatabase();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`test:db failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
