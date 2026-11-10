import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'test-results/owner-ai/development-evaluation.json');
mkdirSync(resolve(root, 'test-results/owner-ai'), { recursive: true });
// Never leave an old passing report in place if test discovery/startup fails.
rmSync(output, { force: true });
const result = spawnSync(
  process.execPath,
  [
    resolve(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    'backend/src/owner-ai/evaluation.test.ts',
  ],
  { cwd: root, stdio: 'inherit', env: { ...process.env, OWNER_AI_EVAL_OUTPUT: output } },
);
let exitCode = result.error || result.signal ? 1 : (result.status ?? 1);
if (exitCode === 0) {
  try {
    const report = JSON.parse(readFileSync(output, 'utf8'));
    // Frozen dataset size: skipped or undiscovered cases cannot certify a passing evaluation.
    if (
      report.schemaVersion !== 'owner-ai-development-evaluation.v1' ||
      report.datasetVersion !== 'synthetic-core.v1' ||
      report.disposition !== 'DEVELOPMENT_CHECK_PASS' ||
      report.expectedCases !== 21 ||
      report.executedCases !== 21 ||
      !Array.isArray(report.records) ||
      report.records.length !== 21 ||
      !report.records.every(
        (row) =>
          typeof row.fixtureId === 'string' && row.fixtureId.length > 0 && row.passed === true,
      ) ||
      new Set(report.records.map((row) => row.fixtureId)).size !== 21
    ) {
      throw new Error('Incomplete evaluation');
    }
  } catch {
    console.error('Owner AI evaluation did not produce a complete passing report.');
    exitCode = 1;
  }
}
process.exitCode = exitCode;
