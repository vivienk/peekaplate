import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyObservationTimeWindow,
  ObservationBatchV2Schema,
  type ObservationQueueEnvelope,
  ObservationV2Schema,
} from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import { ingestObservations } from './observation-ingest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATOR_PATH = join(
  REPO_ROOT,
  'test-data/owner-synthetic-p0-v2/generate_staging_activity.py',
);

const VENUE_ID = '00000000-0000-4000-8000-000000000123';
const PUBLICATION_ID = '11111111-1111-4111-8111-111111111111';
const DISH_ID = '22222222-2222-4222-8222-222222222222';
const DISH_REVISION_ID = '33333333-3333-4333-8333-333333333333';
const WINDOW_START = '2026-11-23T14:00:00Z';
const WINDOW_END = '2026-11-23T14:30:00Z';
const REFERENCE_RECEIVED_AT = '2026-11-23T14:31:00Z';

type Manifest = {
  schema_version: string;
  run_id: string;
  scenario: 'A' | 'B';
  dry_run: boolean;
  manifest_sha256: string;
  event_count: number;
  batch_count: number;
  session_ids: string[];
  event_ids: string[];
  expected_metrics: {
    unique_events: number;
    evidence_state: string;
    metrics: Record<string, { value: number | null; status: string }>;
  };
  batches: Array<{ contract: 'observation.v2'; events: unknown[] }>;
};

function runDryRunGenerator(scenario: 'A' | 'B', seed = 's7-data-18-contract-test'): Manifest {
  const dir = mkdtempSync(join(tmpdir(), 's7-data-18-'));
  try {
    const outPath = join(dir, `manifest-${scenario}.json`);
    execFileSync(
      'python3',
      [
        GENERATOR_PATH,
        '--scenario',
        scenario,
        '--venue-id',
        VENUE_ID,
        '--publication-id',
        PUBLICATION_ID,
        '--current-publication-id',
        PUBLICATION_ID,
        '--dish-id',
        DISH_ID,
        '--dish-revision-id',
        DISH_REVISION_ID,
        '--seed',
        seed,
        '--window-start',
        WINDOW_START,
        '--window-end',
        WINDOW_END,
        '--reference-received-at',
        REFERENCE_RECEIVED_AT,
        '--event-cap',
        '100',
        '--output',
        outPath,
      ],
      { encoding: 'utf8' },
    );
    return JSON.parse(readFileSync(outPath, 'utf8')) as Manifest;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('S7-DATA-18 synthetic staging activity contracts', () => {
  it.each(['A', 'B'] as const)(
    'Scenario %s emits valid observation.v2 batches accepted by normal tracking ingestion',
    async (scenario) => {
      const manifest = runDryRunGenerator(scenario);
      expect(manifest.dry_run).toBe(true);
      expect(manifest.schema_version).toBe('s7-data-18.manifest.v1');

      const allEvents: unknown[] = [];
      for (const batch of manifest.batches) {
        const parsedBatch = ObservationBatchV2Schema.safeParse(batch);
        expect(parsedBatch.success).toBe(true);
        for (const event of batch.events) {
          const parsedEvent = ObservationV2Schema.safeParse(event);
          expect(parsedEvent.success).toBe(true);
          if (parsedEvent.success) {
            const timeCheck = classifyObservationTimeWindow(
              parsedEvent.data.occurred_at,
              REFERENCE_RECEIVED_AT,
            );
            expect(timeCheck.disposition).toBe('accepted');
          }
          allEvents.push(event);
        }
      }
      expect(allEvents).toHaveLength(manifest.event_count);

      // Deliver through normal ingestObservations path and verify all events are accepted.
      const enqueued: ObservationQueueEnvelope[] = [];
      const authority = {
        venueId: VENUE_ID,
        publicationId: PUBLICATION_ID,
        jti: 'test-menu-jti',
        trafficClass: 'test' as const,
      };
      for (const batch of manifest.batches) {
        const result = await ingestObservations(batch.events, authority, {
          enqueue: async (msg) => {
            enqueued.push(msg);
          },
          now: () => new Date(REFERENCE_RECEIVED_AT),
        });
        expect(result.queueUnavailable).toBe(false);
        if (!result.queueUnavailable) {
          for (const receipt of result.response.receipts) {
            expect(receipt.status).toBe('accepted');
          }
        }
      }
      expect(enqueued).toHaveLength(manifest.event_count);
    },
  );

  it('Scenario A and Scenario B expected metrics match DATA-17 definitions', () => {
    const manifestA = runDryRunGenerator('A');
    expect(manifestA.expected_metrics.metrics.active_sessions).toEqual({
      value: 14,
      status: 'NORMAL',
    });
    expect(manifestA.expected_metrics.metrics.open_rate?.value).toBe(0.714);
    expect(manifestA.expected_metrics.metrics.timing_coverage?.value).toBe(0.909);
    expect(manifestA.expected_metrics.metrics.avg_interaction_time_seconds?.value).toBe(12);
    expect(manifestA.expected_metrics.metrics.engagement_rate?.value).toBe(1);
    expect(manifestA.expected_metrics.metrics.save_rate?.value).toBe(0.214);

    const manifestB = runDryRunGenerator('B');
    expect(manifestB.expected_metrics.metrics.active_sessions).toEqual({
      value: 10,
      status: 'NORMAL',
    });
    expect(manifestB.expected_metrics.metrics.open_rate?.value).toBe(1);
    expect(manifestB.expected_metrics.metrics.timing_coverage?.value).toBe(1);
    expect(manifestB.expected_metrics.metrics.avg_interaction_time_seconds?.value).toBe(8);
    expect(manifestB.expected_metrics.metrics.engagement_rate).toMatchObject({
      value: 0,
      status: 'VALID_ZERO',
    });
    expect(manifestB.expected_metrics.metrics.save_rate).toMatchObject({
      value: 0,
      status: 'VALID_ZERO',
    });
  });
});
