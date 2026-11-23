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

function resolvePythonCommand() {
  for (const candidate of [
    { cmd: 'python3', prefixArgs: [] },
    { cmd: 'python', prefixArgs: [] },
    { cmd: 'py', prefixArgs: ['-3'] },
  ]) {
    const res = spawnSync(candidate.cmd, [...candidate.prefixArgs, '--version'], { encoding: 'utf8' });
    if (res.status === 0) return candidate;
  }
  return null;
}

describe('S7-DATA-15 synthetic dashboard scope, order cleanup, and CLI determinism', () => {
  it('classifies every displayed dashboard field as supported, derived, unavailable, or excluded in manifest.json', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(SYNTHETIC_DIR, 'manifest.json'), 'utf8'));
    expect(manifest.expected_counts).toEqual({
      pair_count: 150,
      delivered_lines: 3300,
      unique_events: 3150,
      distinct_sessions: 300,
    });
    expect(manifest.trusted_sha256).toMatch(/^[a-f0-9]{64}$/);
    const categories = new Set(manifest.dashboard_field_classification.map((f) => f.category));
    expect(categories).toEqual(new Set(['supported', 'derived', 'unavailable', 'excluded']));
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
    expect(readme).toContain('py -3 test-data/owner-synthetic-p0-v2/generate_full_dataset.py --dry-run');
  });

  it('executes the real generator CLI for --dry-run and --replay against trusted SHA-256', () => {
    const py = resolvePythonCommand();
    const manifest = JSON.parse(fs.readFileSync(path.join(SYNTHETIC_DIR, 'manifest.json'), 'utf8'));
    if (!py) {
      expect(fs.existsSync(GENERATOR_SCRIPT)).toBe(true);
      return;
    }
    const hadOutputBefore = fs.existsSync(FULL_DATASET_FILE);
    const dryRunStdout = execFileSync(py.cmd, [...py.prefixArgs, GENERATOR_SCRIPT, '--dry-run'], { encoding: 'utf8' });
    const dryRun = JSON.parse(dryRunStdout);
    expect(dryRun.mode).toBe('dry-run');
    expect(dryRun.sha256).toBe(manifest.trusted_sha256);
    expect(fs.existsSync(FULL_DATASET_FILE)).toBe(hadOutputBefore);

    const replayStdout = execFileSync(py.cmd, [...py.prefixArgs, GENERATOR_SCRIPT, '--replay'], { encoding: 'utf8' });
    const replay = JSON.parse(replayStdout);
    expect(replay.mode).toBe('replay');
    expect(replay.sha256).toBe(manifest.trusted_sha256);
    if (!hadOutputBefore && fs.existsSync(FULL_DATASET_FILE)) fs.unlinkSync(FULL_DATASET_FILE);
  });
});
