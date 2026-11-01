import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
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
process.exitCode = result.error || result.signal ? 1 : (result.status ?? 1);
