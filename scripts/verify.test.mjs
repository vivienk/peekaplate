import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  checkSpec,
  recordFailure,
  runChecks,
  runProcess,
  validateChecks,
  validGitHubRunUrl,
} from './verify.mjs';

const temp = () => mkdtemp(join(tmpdir(), 'peekaplate-verify-'));

test('rejects arbitrary commands before invoking a runner', () => {
  assert.throws(() => validateChecks(['lint; whoami']), /Unknown check/);
  assert.deepEqual(checkSpec('pr:check'), {
    command: process.execPath,
    args: ['scripts/check-pr.mjs'],
  });
});

test('stops after the first failed named check and records no command output', async () => {
  const root = await temp();
  const ledger = join(root, 'errors.md');
  const seen = [];
  try {
    const result = await runChecks(['test:e2e:workspace', 'build'], {
      ledger,
      execute: async (spec) => {
        seen.push(spec);
        return { exitCode: 7, signal: null, stdout: 'token=do-not-record' };
      },
    });
    assert.equal(result.exitCode, 7);
    assert.deepEqual(seen, [checkSpec('test:e2e:workspace')]);
    const recorded = await readFile(ledger, 'utf8');
    assert.match(recorded, /"check":"test:e2e:workspace"/);
    assert.doesNotMatch(recorded, /do-not-record|token=/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('successful checks create no ledger entry', async () => {
  const root = await temp();
  const ledger = join(root, 'errors.md');
  try {
    const result = await runChecks(['lint'], {
      ledger,
      execute: async () => ({ exitCode: 0, signal: null }),
    });
    assert.equal(result.exitCode, 0);
    await assert.rejects(readFile(ledger, 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runs an allowlisted pnpm check through the real platform invocation', async () => {
  const root = await temp();
  try {
    const result = await runChecks(['docs:check'], { ledger: join(root, 'errors.md') });
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves child exit, signal, and spawn failure results', async () => {
  const exited = await runProcess(process.execPath, ['-e', 'process.exit(9)']);
  assert.deepEqual(exited, { exitCode: 9, signal: null });
  const signaled = await runProcess(process.execPath, [
    '-e',
    'process.kill(process.pid, "SIGTERM")',
  ]);
  assert.ok(
    signaled.signal === 'SIGTERM' || signaled.exitCode === 1,
    'Windows Node reports SIGTERM self-termination as exit 1',
  );
  const missing = await runProcess('peekaplate-command-does-not-exist', []);
  assert.equal(missing.exitCode, null);
  assert.equal(missing.signal, null);
  assert.match(missing.spawnError, /ENOENT/);
});

test('append-only records preserve existing manual content, concurrent observations, and safe CI summary', async () => {
  const root = await temp();
  const ledger = join(root, 'errors.md');
  const summary = join(root, 'summary.md');
  try {
    await writeFile(ledger, '# Manual cause\nsecret=keep-out-of-records\n');
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        recordFailure({ check: 'lint', exitCode: index + 1, signal: null }, { ledger }),
      ),
    );
    await recordFailure(
      { check: 'lint', exitCode: 3, signal: null, stdout: 'secret=never-copy' },
      { ledger, summary, githubRunUrl: 'https://github.com/acme/plate/actions/runs/12345' },
    );
    const entries = await readFile(ledger, 'utf8');
    const report = await readFile(summary, 'utf8');
    assert.match(entries, /# Manual cause/);
    assert.equal((entries.match(/"check":"lint"/g) ?? []).length, 5);
    assert.doesNotMatch(entries, /never-copy/);
    assert.match(report, /https:\/\/github\.com\/acme\/plate\/actions\/runs\/12345/);
    assert.doesNotMatch(report, /never-copy|secret=/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('creates nested CI ledger and summary paths before recording', async () => {
  const root = await temp();
  const ledger = join(root, 'work', 'errors.md');
  const summary = join(root, 'summary', 'step.md');
  try {
    await recordFailure({ check: 'lint', exitCode: 2, signal: null }, { ledger, summary });
    assert.match(await readFile(ledger, 'utf8'), /"exitCode":2/);
    assert.match(await readFile(summary, 'utf8'), /Check `lint` failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('records only credential-free GitHub URLs and operating-system signals', async () => {
  const root = await temp();
  const ledger = join(root, 'errors.md');
  try {
    assert.equal(
      validGitHubRunUrl('https://github.com/acme/plate/actions/runs/1'),
      'https://github.com/acme/plate/actions/runs/1',
    );
    assert.equal(validGitHubRunUrl('https://token@github.com/acme/plate/actions/runs/1'), null);
    assert.equal(validGitHubRunUrl('https://github.com:443/acme/plate/actions/runs/1'), null);
    await recordFailure(
      { check: 'lint', exitCode: null, signal: 'not-a-signal' },
      { ledger, githubRunUrl: 'https://token@github.com/acme/plate/actions/runs/1' },
    );
    const entry = await readFile(ledger, 'utf8');
    assert.doesNotMatch(entry, /not-a-signal|githubRunUrl|token@/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
