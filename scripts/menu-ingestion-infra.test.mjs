import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = JSON.parse(
  readFileSync(new URL('../backend/wrangler.jsonc', import.meta.url), 'utf8'),
);
const staging = config.env.staging;

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

test('private ingestion reports reuse the staging bucket with an explicit binding', () => {
  const reports = staging.r2_buckets.find((item) => item.binding === 'INGESTION_REPORTS_BUCKET');
  const observations = staging.r2_buckets.find(
    (item) => item.binding === 'OBSERVATION_ARCHIVE_BUCKET',
  );
  assert.equal(reports?.bucket_name, 'peekaplate-staging-assets');
  assert.equal(observations?.bucket_name, reports.bucket_name);
});

test('binding-only setup does not attach an unimplemented menu consumer or invent a service URL', () => {
  // Replace this setup guard when the reviewed consumer and real service are released together.
  assert.equal(
    (staging.queues.consumers ?? []).some(
      (item) => item.queue === 'peekaplate-staging-menu-ingestion',
    ),
    false,
  );
  assert.equal(staging.vars.EXTRACTION_SERVICE_URL, undefined);
  assert.equal(staging.vars.EXTRACTION_SERVICE_SECRET, undefined);
});

test('extraction host is staging-only, single-instance and contains no secret values', () => {
  const host = JSON.parse(
    readFileSync(new URL('../backend/wrangler.extraction.jsonc', import.meta.url), 'utf8'),
  );
  assert.equal(host.name, 'peekaplate-extraction-staging');
  assert.equal(host.containers.length, 1);
  assert.equal(host.containers[0].max_instances, 1);
  assert.equal(host.containers[0].instance_type, 'basic');
  assert.equal(host.r2_buckets[0].bucket_name, 'peekaplate-staging-assets');
  assert.deepEqual(Object.keys(host.vars).sort(), ['APP_ENV', 'EXTRACTION_SOURCE_ORIGIN']);
  assert.equal(host.vars.APP_ENV, 'staging');
});
