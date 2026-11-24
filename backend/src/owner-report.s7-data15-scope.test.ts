import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const SYNTHETIC_DIR = path.join(REPO_ROOT, 'test-data/owner-synthetic-p0-v2');
const GENERATOR_SCRIPT = path.join(SYNTHETIC_DIR, 'generate_full_dataset.py');
const FULL_DATASET_FILE = path.join(SYNTHETIC_DIR, 'events/full_dataset.jsonl');
const FRONTEND_DATA_PATH = path.join(REPO_ROOT, 'frontend/console/src/owner-dashboard/data.ts');
const FRONTEND_PAGES_PATH = path.join(REPO_ROOT, 'frontend/console/src/owner-dashboard/pages.tsx');
const README_PATH = path.join(SYNTHETIC_DIR, 'README.md');

const EXPECTED_DASHBOARD_FIELDS = [
  'active_sessions',
  'open_rate',
  'engagement_rate',
  'save_rate',
  'avg_interaction_time_seconds',
  'timing_coverage',
  'revisit_rate',
  'portion_previews_shown',
  'photo_fallback_opens',
  'comparison_rate',
  'most_compared_pairs',
  'weekly_trend_delta',
  'verified_orders',
  'dish_order_record_coverage',
  'weekly_verified_orders',
  'checkout_revenue',
  'pos_ticket_value',
  'unconsented_diner_events',
  'test_traffic_events',
  'realtime_ingestion_staleness',
] as const;

function resolvePythonCommand() {
  for (const candidate of [
    { cmd: 'python3', prefixArgs: [] },
    { cmd: 'python', prefixArgs: [] },
    { cmd: 'py', prefixArgs: ['-3'] },
  ]) {
    const res = spawnSync(candidate.cmd, [...candidate.prefixArgs, '--version'], {
      encoding: 'utf8',
    });
    if (res.status === 0) return candidate;
  }
  return null;
}

const PYTHON_CLI = resolvePythonCommand();

describe('S7-DATA-15 synthetic dashboard scope, order cleanup, and CLI determinism', () => {
  it('classifies the complete inventory of displayed dashboard fields uniquely with unit and source metadata', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(SYNTHETIC_DIR, 'manifest.json'), 'utf8'));
    expect(manifest.expected_counts).toEqual({
      pair_count: 150,
      delivered_lines: 3300,
      unique_events: 3150,
      distinct_sessions: 300,
    });
    expect(manifest.trusted_sha256).toMatch(/^[a-f0-9]{64}$/);

    const entries = manifest.dashboard_field_classification as Array<{
      name: string;
      dashboard_label: string;
      category: string;
      unit: string;
      source: string;
      unavailable_conditions: string[];
    }>;

    const names = entries.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(names)).toEqual(new Set(EXPECTED_DASHBOARD_FIELDS));

    const categories = new Set(entries.map((f) => f.category));
    expect(categories).toEqual(new Set(['supported', 'derived', 'unavailable', 'excluded']));

    for (const entry of entries) {
      expect(typeof entry.dashboard_label).toBe('string');
      expect(entry.dashboard_label.trim().length).toBeGreaterThan(0);
      expect(typeof entry.unit).toBe('string');
      expect(entry.unit.trim().length).toBeGreaterThan(0);
      expect(typeof entry.source).toBe('string');
      expect(entry.source.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(entry.unavailable_conditions)).toBe(true);
      expect(entry.unavailable_conditions.length).toBeGreaterThan(0);
    }

    expect(manifest.unavailable_metrics.verified_orders.status).toBe('UNAVAILABLE');
  });

  it('removes manual order claims, T.ord / T.withRec references, and fabricated order counts across console files', () => {
    const dataTs = fs.readFileSync(FRONTEND_DATA_PATH, 'utf8');
    const pagesTsx = fs.readFileSync(FRONTEND_PAGES_PATH, 'utf8');
    expect(dataTs).not.toMatch(/\bord:\s*\d+/);
    expect(dataTs).not.toContain('T.ord');
    expect(dataTs).not.toContain('T.withRec');
    expect(pagesTsx).not.toContain('T.ord');
    expect(pagesTsx).toContain("value: 'Unavailable'");
  });

  it('has clean README encoding, spacing, and Windows-compatible commands', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    expect(readme).not.toContain('ΓÇö');
    expect(readme).not.toContain('ordercounts');
    expect(readme).toContain(
      'py -3 test-data/owner-synthetic-p0-v2/generate_full_dataset.py --dry-run',
    );
  });

  it.skipIf(!PYTHON_CLI)(
    'executes the real generator CLI for --dry-run, --replay, and fails --replay when artifact is missing',
    () => {
      const py = PYTHON_CLI!;
      const manifest = JSON.parse(
        fs.readFileSync(path.join(SYNTHETIC_DIR, 'manifest.json'), 'utf8'),
      );
      const hadOutputBefore = fs.existsSync(FULL_DATASET_FILE);
      const originalBytes = hadOutputBefore ? fs.readFileSync(FULL_DATASET_FILE) : null;

      try {
        const dryRunStdout = execFileSync(
          py.cmd,
          [...py.prefixArgs, GENERATOR_SCRIPT, '--dry-run'],
          { encoding: 'utf8' },
        );
        const dryRun = JSON.parse(dryRunStdout);
        expect(dryRun.mode).toBe('dry-run');
        expect(dryRun.sha256).toBe(manifest.trusted_sha256);
        expect(fs.existsSync(FULL_DATASET_FILE)).toBe(hadOutputBefore);

        if (hadOutputBefore) {
          fs.unlinkSync(FULL_DATASET_FILE);
        }
        const missingReplay = spawnSync(
          py.cmd,
          [...py.prefixArgs, GENERATOR_SCRIPT, '--replay'],
          { encoding: 'utf8' },
        );
        expect(missingReplay.status).not.toBe(0);
        expect(missingReplay.stderr).toContain('existing full_dataset.jsonl is missing');

        if (originalBytes) {
          fs.writeFileSync(FULL_DATASET_FILE, originalBytes);
        } else {
          execFileSync(py.cmd, [...py.prefixArgs, GENERATOR_SCRIPT], { encoding: 'utf8' });
        }

        const replayStdout = execFileSync(
          py.cmd,
          [...py.prefixArgs, GENERATOR_SCRIPT, '--replay'],
          { encoding: 'utf8' },
        );
        const replay = JSON.parse(replayStdout);
        expect(replay.mode).toBe('replay');
        expect(replay.sha256).toBe(manifest.trusted_sha256);
      } finally {
        if (originalBytes) {
          fs.writeFileSync(FULL_DATASET_FILE, originalBytes);
        } else if (fs.existsSync(FULL_DATASET_FILE)) {
          fs.unlinkSync(FULL_DATASET_FILE);
        }
      }
    },
  );
});
