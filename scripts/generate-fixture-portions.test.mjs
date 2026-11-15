import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

test('PR147 preview manifests preserve all six transparent source photos and exact bytes', () => {
  execFileSync(process.execPath, ['scripts/generate-fixture-portions.mjs', '--check']);
});
