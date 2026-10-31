import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The synthetic console foundations demo is built only for PR previews (PEEKAPLATE_PREVIEW_DEMOS),
// never for staging or production. Agreed with Sai and Jeffin.
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
  assert.ok(files.includes('index.html'));
  assert.ok(!files.includes('foundations.html'));
  for (const asset of await readdir(join(dir, 'assets'))) assert.doesNotMatch(asset, /foundations/);
});

test('a preview build adds the demo page, labelled synthetic, noindex and without analytics', async (t) => {
  const dir = await build(t, true);
  const files = await readdir(dir);
  assert.ok(files.includes('index.html'));
  assert.ok(files.includes('foundations.html'));
  const html = await readFile(join(dir, 'foundations.html'), 'utf8');
  assert.match(html, /<meta name="robots" content="noindex"/);
  const scripts = (await pageScripts(dir, 'foundations.html')).join('\n');
  assert.match(scripts, /Synthetic demo/);
  assert.doesNotMatch(scripts, /posthog/i);
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
