import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = JSON.parse(
  readFileSync(new URL('../backend/wrangler.jsonc', import.meta.url), 'utf8'),
);
const staging = config.env.staging;

test('the extraction application uses the provider-required Durable Object scheduler', () => {
  const host = JSON.parse(
    readFileSync(new URL('../backend/wrangler.extraction.jsonc', import.meta.url), 'utf8'),
  );
  assert.equal(host.containers[0].scheduling_policy, 'durable_object');
  assert.equal(host.containers[0].images.base.dockerfile, '../processing/Dockerfile');
  assert.equal(host.containers[0].image, undefined);
  assert.equal(host.containers[0].max_instances, undefined);
});

test('menu ingestion has its own staging producer without redirecting observations', () => {
  const producers = staging.queues.producers;
  assert.equal(
    producers.find((item) => item.binding === 'INGESTION_QUEUE')?.queue,
    'peekaplate-staging-menu-ingestion',
  );
  assert.equal(
    producers.find((item) => item.binding === 'OBSERVATION_QUEUE')?.queue,
    'peekaplate-staging-observations',
  );
  assert.equal(new Set(producers.map((item) => item.binding)).size, producers.length);
});

test('menu token issuer in staging wrangler configuration uses root trusted origin', () => {
  const issuer = new URL(staging.vars.MENU_TOKEN_ISSUER);
  assert.equal(issuer.protocol, 'https:');
  assert.equal(issuer.pathname, '/');
  assert.equal(issuer.search, '');
  assert.equal(issuer.hash, '');
});

test('private ingestion reports reuse the staging bucket with an explicit binding', () => {
  const reports = staging.r2_buckets.find((item) => item.binding === 'INGESTION_REPORTS_BUCKET');
  const observations = staging.r2_buckets.find(
    (item) => item.binding === 'OBSERVATION_ARCHIVE_BUCKET',
  );
  assert.equal(reports?.bucket_name, 'peekaplate-staging-assets');
  assert.equal(observations?.bucket_name, reports.bucket_name);
});

test('menu consumer is bounded separately from observations and has its own DLQ', () => {
  const menu = staging.queues.consumers.find(
    (item) => item.queue === 'peekaplate-staging-menu-ingestion',
  );
  assert.deepEqual(menu, {
    queue: 'peekaplate-staging-menu-ingestion',
    max_batch_size: 1,
    max_batch_timeout: 1,
    max_concurrency: 1,
    max_retries: 3,
    dead_letter_queue: 'peekaplate-staging-menu-ingestion-dlq',
    retry_delay: 60,
  });
  assert.equal(staging.vars.EXTRACTION_SERVICE_URL, undefined);
  assert.equal(staging.vars.EXTRACTION_SERVICE_SECRET, undefined);
  assert.equal(
    staging.queues.consumers.find((item) => item.queue === 'peekaplate-staging-observations')
      .max_batch_size,
    10,
  );
});

test('extraction deployment resolves the locked backend CLI and guards main SHA', async () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/deploy-extraction-staging.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /working-directory: backend/);
  assert.match(workflow, /pnpm exec wrangler deploy --config wrangler\.extraction\.jsonc/);
  assert.match(workflow, /test "\$GITHUB_SHA" = "\$EXPECTED_SHA"/);
});

test('extraction host is staging-only, single-instance and contains no secret values', () => {
  const host = JSON.parse(
    readFileSync(new URL('../backend/wrangler.extraction.jsonc', import.meta.url), 'utf8'),
  );
  assert.equal(host.name, 'peekaplate-extraction-staging');
  assert.equal(host.containers.length, 1);
  assert.equal(host.containers[0].scheduling_policy, 'durable_object');
  assert.equal(host.r2_buckets[0].bucket_name, 'peekaplate-staging-assets');
  assert.deepEqual(Object.keys(host.vars).sort(), ['APP_ENV', 'EXTRACTION_SOURCE_ORIGIN']);
  assert.equal(host.vars.APP_ENV, 'staging');
});
