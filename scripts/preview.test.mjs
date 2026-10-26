import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deploymentIds, manage, projects, sanitize, validateProject } from './preview.mjs';

const project = (name) => ({
  name,
  production_branch: 'unused-production',
  domains: [`${name}.pages.dev`],
  deployment_configs: { preview: { build_image_major_version: 3, env_vars: {}, d1_databases: {} } },
});
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'preview-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const app of ['diner', 'console']) {
    await mkdir(join(dir, app));
    await writeFile(join(dir, app, 'index.html'), '<h1>Fixture</h1>');
  }
  return dir;
}
test('static output gets a policy blocking APIs, analytics, forms and frames', async (t) => {
  const dir = await fixture(t);
  await sanitize(dir);
  assert.match(await readFile(join(dir, 'diner/_headers'), 'utf8'), /connect-src 'none'/);
});
for (const entry of [
  '_worker.js',
  '_redirects',
  '_headers',
  'wrangler.toml',
  '.env',
  'package.json',
]) {
  test(`rejects executable or routing configuration ${entry}`, async (t) => {
    const dir = await fixture(t);
    await writeFile(join(dir, 'diner', entry), 'bad');
    await assert.rejects(sanitize(dir));
  });
}
test('rejects artifact symlinks', async (t) => {
  const dir = await fixture(t);
  await symlink('/etc/passwd', join(dir, 'diner/leak.txt'));
  await assert.rejects(sanitize(dir), /symlinks/);
});
test('rejects production branches, Git sources, custom domains and bindings', () => {
  const name = projects[0];
  validateProject(project(name), name);
  for (const changes of [
    { production_branch: 'pr-37' },
    { source: { type: 'github' } },
    { domains: ['staging.example.com'] },
    { deployment_configs: { preview: { env_vars: { SECRET: {} } } } },
    { name: 'peekaplate-diner-staging' },
  ]) {
    assert.throws(() => validateProject({ ...project(name), ...changes }, name));
  }
});
const row = (environment, branch, id = '12345678-1234-1234-1234-123456789abc') => ({
  environment,
  deployment_trigger: { metadata: { branch } },
  id,
});
test('cleanup selects only exact PR preview deployments', () => {
  assert.equal(
    deploymentIds(
      [row('production', 'pr-37'), row('preview', 'pr-370'), row('preview', 'pr-37')],
      '37',
    ).length,
    1,
  );
  assert.throws(() => deploymentIds([], '../37'));
});
test('API failure fails closed; redirects cannot forward token', async () => {
  await assert.rejects(
    manage(
      'preflight',
      { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'test', PR: '37' },
      async (_, opts) => {
        assert.equal(opts.redirect, 'error');
        return { ok: true, json: async () => ({ success: false, result: [] }) };
      },
    ),
    /not successful/,
  );
});
test('cleanup collects every page before deleting and preserves other PRs', async () => {
  const calls = [];
  await manage(
    'cleanup',
    { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'test', PR: '37' },
    async (url, opts) => {
      calls.push([url, opts.method]);
      const name = projects.find((p) => url.includes(p));
      const result = !url.includes('/deployments')
        ? project(name)
        : opts.method === 'DELETE'
          ? null
          : url.endsWith('page=1')
            ? Array.from({ length: 25 }, (_, i) => row('preview', i === 0 ? 'pr-37' : 'pr-38'))
            : [];
      return { ok: true, json: async () => ({ success: true, result }) };
    },
  );
  assert.equal(calls.filter(([, method]) => method === 'DELETE').length, 2);
  for (const name of projects)
    assert.ok(
      calls.findIndex(([u]) => u.includes(name) && u.endsWith('page=2')) <
        calls.findIndex(([u, m]) => u.includes(name) && m === 'DELETE'),
    );
});
test('workflow executes base deployment code with isolated credential-free PR build', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/deploy-preview.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /pull_request_target:/);
  const build = workflow.split('  build:')[1].split('  deploy:')[0];
  assert.doesNotMatch(build, /secrets\.|environment: preview/);
  assert.match(build, /persist-credentials: false/);
  assert.match(build, /head.repo.full_name == github.repository/);
  assert.match(build, /PREVIEW_DEPLOYMENT_ENABLED == 'true'/);
  const cleanup = workflow.split('  cleanup:')[1];
  assert.doesNotMatch(cleanup, /PREVIEW_DEPLOYMENT_ENABLED/);
  assert.match(cleanup, /ref: \$\{\{ github.sha \}\}/);
});
