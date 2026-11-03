import { randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { unstable_dev } from 'wrangler';

const args = process.argv.slice(2);
const tenantId = args[0];
if (
  !tenantId ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId) ||
  args.slice(1).some((arg) => arg !== '--apply') ||
  args.length > 2
) {
  throw new Error(
    'Usage: node backfill-observations.mjs <synthetic-or-approved-venue-uuid> [--apply]',
  );
}
const staging = JSON.parse(await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8')).env
  .staging;
const secret = randomBytes(32).toString('hex');
const configPath = new URL(`./.wrangler/backfill-${crypto.randomUUID()}.json`, import.meta.url);
let worker;
try {
  await mkdir(new URL('./.wrangler/', import.meta.url), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      name: 'peekaplate-backfill-operator',
      account_id: staging.account_id,
      main: fileURLToPath(new URL('./src/consumer/backfill.ts', import.meta.url)),
      compatibility_date: '2026-10-13',
      compatibility_flags: ['nodejs_compat'],
      send_metrics: false,
      workers_dev: false,
      preview_urls: false,
      hyperdrive: staging.hyperdrive,
      r2_buckets: staging.r2_buckets.filter(
        (bucket) => bucket.binding === 'OBSERVATION_ARCHIVE_BUCKET',
      ),
    }),
  );
  worker = await unstable_dev(
    fileURLToPath(new URL('./src/consumer/backfill.ts', import.meta.url)),
    {
      config: fileURLToPath(configPath),
      local: false,
      ip: '127.0.0.1',
      port: 0,
      inspectorPort: 0,
      logLevel: 'error',
      vars: { APP_ENV: 'staging', BACKFILL_SECRET: secret, BACKFILL_TENANT: tenantId },
      experimental: { disableExperimentalWarning: true, watch: false, disableDevRegistry: true },
    },
  );
  const response = await worker.fetch('http://localhost/', {
    method: args.includes('--apply') ? 'POST' : 'GET',
    headers: { 'x-backfill-secret': secret },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok)
    throw new Error(
      `Backfill operator returned ${response.status}; no raw database error recorded`,
    );
  const rows = await response.json();
  console.log(
    JSON.stringify(
      { mode: args.includes('--apply') ? 'apply' : 'inspect', tenantId, rows },
      null,
      2,
    ),
  );
  if (rows.some((row) => row.status === 'blocked')) process.exitCode = 1;
} finally {
  if (worker) await worker.stop();
  await unlink(configPath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
