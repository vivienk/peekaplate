import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('local launcher propagates frontend startup failure without disclosing configuration', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'owner-ai-launcher-'));
  try {
    const stub = join(directory, 'pnpm');
    await writeFile(stub, '#!/bin/sh\nexit 17\n');
    await chmod(stub, 0o700);
    const child = spawn(
      process.execPath,
      ['--import', './scripts/node-ts-hooks.mjs', 'backend/scripts/owner-ai-local.ts'],
      {
        env: { PATH: directory, OWNER_AI_LOCAL_MOCK: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
    });
    child.stderr.on('data', (data) => {
      output += data;
    });
    const [code] = await once(child, 'exit');
    assert.equal(code, 17);
    assert.doesNotMatch(output, /Bearer|sk-proj-/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('private Python wrapper preserves subprocess failure status', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import runpy
from unittest.mock import patch, Mock
with patch('sys.stdin') as stdin, patch('getpass.getpass', return_value='sk-' + 'synthetic' * 5), patch('builtins.input', return_value='proj_synthetic'), patch('subprocess.run', return_value=Mock(returncode=17)):
    stdin.isatty.return_value = True
    runpy.run_path('scripts/start-owner-ai-private.py', run_name='__main__')
`,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(result.status, 17, result.stderr);
  assert.equal(result.stdout, '');
});
