import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const passingReport = () => ({
  schemaVersion: 'owner-ai-development-evaluation.v1',
  datasetVersion: 'synthetic-core.v1',
  expectedCases: 21,
  executedCases: 21,
  disposition: 'DEVELOPMENT_CHECK_PASS',
  records: Array.from({ length: 21 }, (_, n) => ({ fixtureId: `fixture-${n}`, passed: true })),
});

function run(report, childExit = 0) {
  const root = mkdtempSync(join(tmpdir(), 'owner-ai-eval-'));
  const output = join(root, 'test-results/owner-ai/development-evaluation.json');
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'node_modules/vitest'), { recursive: true });
    mkdirSync(join(root, 'test-results/owner-ai'), { recursive: true });
    copyFileSync(
      new URL('./evaluate-owner-ai.mjs', import.meta.url),
      join(root, 'scripts/evaluate-owner-ai.mjs'),
    );
    writeFileSync(output, JSON.stringify(passingReport()));
    writeFileSync(
      join(root, 'node_modules/vitest/vitest.mjs'),
      `
      import { existsSync, writeFileSync } from 'node:fs';
      if (existsSync(process.env.OWNER_AI_EVAL_OUTPUT)) process.exit(99);
      const report = ${JSON.stringify(report)};
      if (report !== null) writeFileSync(process.env.OWNER_AI_EVAL_OUTPUT, JSON.stringify(report));
      process.exit(${childExit});
    `,
    );
    const result = spawnSync(process.execPath, [join(root, 'scripts/evaluate-owner-ai.mjs')], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.ifError(result.error);
    return { status: result.status, reportExists: existsSync(output), stderr: result.stderr };
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('owner-ai-eval-'));
    rmSync(root, { recursive: true, force: true });
  }
}

test('accepts a complete fresh passing evaluation and clears the old artifact first', () => {
  assert.equal(run(passingReport()).status, 0);
});

test('rejects a zero-exit child that leaves no new report', () => {
  const result = run(null);
  assert.equal(result.status, 1);
  assert.equal(result.reportExists, false);
});

test('rejects incomplete evidence even when the test process exits successfully', () => {
  const report = passingReport();
  report.executedCases = 1;
  report.records = report.records.slice(0, 1);
  report.disposition = 'DEVELOPMENT_CHECK_FAIL';
  assert.equal(run(report).status, 1);
});

test('rejects false passing summaries with missing, failed or duplicate records', () => {
  for (const change of [
    (report) => {
      report.records.pop();
    },
    (report) => {
      report.records[0].passed = false;
    },
    (report) => {
      report.records[0].fixtureId = report.records[1].fixtureId;
    },
    (report) => {
      report.expectedCases = 1;
      report.executedCases = 1;
      report.records = report.records.slice(0, 1);
    },
  ]) {
    const report = passingReport();
    change(report);
    assert.equal(run(report).status, 1);
  }
});

test('preserves a failed child exit rather than accepting its passing artifact', () => {
  assert.equal(run(passingReport(), 7).status, 7);
});
