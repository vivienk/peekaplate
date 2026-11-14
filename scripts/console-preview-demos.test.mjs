import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The synthetic console demos are built only for PR previews (PEEKAPLATE_PREVIEW_DEMOS), never for
// staging or production. Agreed with Sai and Jeffin.
const DEMOS = [
  {
    page: 'first-dashboard.html',
    asset: /firstDashboard/,
    label: /Synthetic demo/,
  },
  { page: 'foundations.html', asset: /foundations/, label: /Synthetic demo/ },
  { page: 'owner-dashboard.html', asset: /ownerDashboard/, label: /Sample restaurant/ },
  // S4-FE-04: the owner sign-in demo answers with a synthetic service, so it never reaches staging.
  { page: 'owner-sign-in.html', asset: /ownerSignIn/, label: /Synthetic demo/ },
];
// Normal builds carry the provider-backed sign-in pages instead; preview builds do not.
const LIVE_AUTH = ['owner-auth.html', 'auth-confirm.html', 'auth-reset.html'];
const consoleDir = fileURLToPath(new URL('../frontend/console/', import.meta.url));
const vite = join(consoleDir, 'node_modules/vite/bin/vite.js');

async function build(t, previewDemos) {
  const dir = await mkdtemp(join(tmpdir(), 'console-build-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.PEEKAPLATE_PREVIEW_DEMOS;
  if (previewDemos) env.PEEKAPLATE_PREVIEW_DEMOS = 'true';
  execFileSync(
    process.execPath,
    [vite, 'build', '--outDir', dir, '--emptyOutDir', '--logLevel', 'error'],
    {
      cwd: consoleDir,
      env,
      stdio: 'pipe',
    },
  );
  return dir;
}

// Every script a page loads, following its module preloads.
async function pageScripts(dir, page) {
  const html = await readFile(join(dir, page), 'utf8');
  const files = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map(
    (match) => match[1],
  );
  return Promise.all(files.map((file) => readFile(join(dir, file), 'utf8')));
}

test('a normal console build contains no demo page', async (t) => {
  const dir = await build(t, false);
  const files = await readdir(dir);
  const assets = await readdir(join(dir, 'assets'));
  assert.ok(files.includes('index.html'));
  for (const page of LIVE_AUTH) assert.ok(files.includes(page), page);
  for (const demo of DEMOS) {
    assert.ok(!files.includes(demo.page), demo.page);
    for (const asset of assets) assert.doesNotMatch(asset, demo.asset);
  }
});

test('a preview build adds the demo pages, labelled synthetic, noindex and without analytics', async (t) => {
  const dir = await build(t, true);
  const files = await readdir(dir);
  assert.ok(files.includes('index.html'));
  for (const page of LIVE_AUTH) assert.ok(!files.includes(page), page);
  for (const demo of DEMOS) {
    assert.ok(files.includes(demo.page), demo.page);
    const html = await readFile(join(dir, demo.page), 'utf8');
    assert.match(html, /<meta name="robots" content="noindex"/);
    const scripts = (await pageScripts(dir, demo.page)).join('\n');
    assert.match(scripts, demo.label);
    if (demo.page === 'first-dashboard.html') assert.match(scripts, /Illustrative sample data/);
    assert.doesNotMatch(scripts, /posthog/i);
  }
});

test('only the preview workflow turns the demo flag on', async () => {
  const read = (path) => readFile(new URL(`../.github/workflows/${path}`, import.meta.url), 'utf8');
  const preview = await read('deploy-preview.yml');
  const build = preview.split('  build:')[1].split('  deploy:')[0];
  assert.match(build, /PEEKAPLATE_PREVIEW_DEMOS: 'true'/);
  assert.equal(preview.match(/PEEKAPLATE_PREVIEW_DEMOS/g)?.length, 1);
  for (const other of ['deploy-staging.yml', 'ci.yml']) {
    assert.doesNotMatch(await read(other), /PEEKAPLATE_PREVIEW_DEMOS/);
  }
});

// The FE-06.1 owner menu integration harness calls the real staging API with a pasted token. It is
// for the local dev server only (the API allows that origin), so no build ever contains it.
test('no console build contains the owner menu integration harness', async (t) => {
  for (const previewDemos of [false, true]) {
    const dir = await build(t, previewDemos);
    const files = await readdir(dir);
    assert.ok(!files.includes('owner-menu-harness.html'));
    for (const asset of await readdir(join(dir, 'assets'))) assert.doesNotMatch(asset, /harness/);
    const scripts = (await pageScripts(dir, 'index.html')).join('\n');
    assert.doesNotMatch(scripts, /Integration harness/);
  }
});
