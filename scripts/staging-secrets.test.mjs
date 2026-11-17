import assert from 'node:assert/strict';
import test from 'node:test';
import { stagingSecrets } from './staging-secrets.mjs';

test('ordinary staging releases do not provision or expose AI credentials', () => {
  assert.deepEqual(
    stagingSecrets({ TEAM_GITHUB_TOKEN: 'fixture', OWNER_AI_OPENAI_API_KEY: 'unused' }),
    { TEAM_GITHUB_TOKEN: 'fixture' },
  );
});
test('explicit provisioning requires all three server credentials without changing flags', () => {
  const env = {
    TEAM_GITHUB_TOKEN: 'fixture',
    CONFIGURE_OWNER_AI: 'true',
    OWNER_AI_OPENAI_API_KEY: 'test-only',
    OWNER_AI_OPENAI_PROJECT_ID: 'proj_testonly',
    OWNER_AI_REPORT_REFERENCE_SECRET: 'f'.repeat(48),
  };
  assert.deepEqual(Object.keys(stagingSecrets(env)), [
    'TEAM_GITHUB_TOKEN',
    'OWNER_AI_OPENAI_API_KEY',
    'OWNER_AI_OPENAI_PROJECT_ID',
    'OWNER_AI_REPORT_REFERENCE_SECRET',
  ]);
  for (const key of [
    'OWNER_AI_OPENAI_API_KEY',
    'OWNER_AI_OPENAI_PROJECT_ID',
    'OWNER_AI_REPORT_REFERENCE_SECRET',
  ]) {
    assert.throws(() => stagingSecrets({ ...env, [key]: '' }), /missing or invalid/);
  }
  assert.throws(
    () => stagingSecrets({ ...env, OWNER_AI_OPENAI_PROJECT_ID: 'Project display name' }),
    /missing or invalid/,
  );
});
