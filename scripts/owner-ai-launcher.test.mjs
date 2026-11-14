import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

test('local launcher starts installed Vite directly and propagates frontend failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'owner-ai-launcher-'));
  try {
    const hook = join(directory, 'frontend-hook.mjs');
    await writeFile(
      hook,
      `import { registerHooks } from 'node:module';
      const stub = new URL('./frontend-stub.mjs', import.meta.url).href;
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === 'node:child_process' && context.parentURL?.endsWith('/backend/scripts/owner-ai-local.ts')) {
            return nextResolve(stub, context);
          }
          return nextResolve(specifier, context);
        },
      });`,
    );
    await writeFile(
      join(directory, 'frontend-stub.mjs'),
      `import assert from 'node:assert/strict';
      import { spawn as realSpawn } from 'node:child_process';
      import { join } from 'node:path';
      export function spawn(command, args, options) {
        assert.equal(command, process.execPath);
        assert.equal(args[0], join(options.cwd, 'node_modules', 'vite', 'bin', 'vite.js'));
        assert.deepEqual(args.slice(1), ['--host', '127.0.0.1', '--port', '5174', '--strictPort']);
        assert.equal(options.env.OWNER_AI_LOCAL_PREVIEW, 'true');
        assert.equal(options.env.OWNER_AI_OPENAI_API_KEY, undefined);
        assert.equal(options.env.OWNER_AI_OPENAI_PROJECT_ID, undefined);
        return realSpawn(command, ['-e', 'process.exit(17)']);
      }`,
    );
    const child = spawn(
      process.execPath,
      [
        '--import',
        './scripts/node-ts-hooks.mjs',
        '--import',
        pathToFileURL(hook).href,
        'backend/scripts/owner-ai-local.ts',
      ],
      {
        env: {
          ...process.env,
          OWNER_AI_LOCAL_MOCK: 'true',
          OWNER_AI_OPENAI_API_KEY: 'sk-proj-fake-test-key',
          OWNER_AI_OPENAI_PROJECT_ID: 'proj_test',
        },
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
    const [code] = await once(child, 'close');
    assert.doesNotMatch(output, /Bearer|sk-proj-/);
    assert.equal(code, 17, output);
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
