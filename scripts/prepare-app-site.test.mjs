import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { APP_REDIRECTS, prepareAppSite } from './prepare-app-site.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'peekaplate-app-site-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  const diner = join(root, 'build');
  await mkdir(diner);
  await writeFile(join(diner, 'index.html'), '<script src="/diner/assets/app.js"></script>');
  return { root, diner, output: join(root, 'app-site') };
}

test('creates a prefixed static artifact with only bounded diner rules', async (t) => {
  const { diner, output } = await fixture(t);
  await prepareAppSite(diner, output);
  assert.equal(
    await readFile(join(output, 'diner/index.html'), 'utf8'),
    await readFile(join(diner, 'index.html'), 'utf8'),
  );
  assert.equal(await readFile(join(output, '_redirects'), 'utf8'), APP_REDIRECTS);
  assert.doesNotMatch(APP_REDIRECTS, /\*|owner|https:|token/);
  assert.match(await readFile(join(output, '404.html'), 'utf8'), /Page not found/);
});

test('refuses to overwrite an existing homepage or output tree', async (t) => {
  const { diner, output } = await fixture(t);
  await mkdir(output);
  await writeFile(join(output, 'index.html'), 'existing homepage');
  await prepareAppSite(diner, output).then(
    () => assert.fail('must refuse existing output'),
    (error) => assert.equal(error.code, 'EEXIST'),
  );
  assert.equal(await readFile(join(output, 'index.html'), 'utf8'), 'existing homepage');
});

test('rejects an unprefixed build and source/output overlap', async (t) => {
  const { diner, output } = await fixture(t);
  await assert.rejects(prepareAppSite(diner, join(diner, 'nested')), /separate/);
  await writeFile(join(diner, 'index.html'), '<script src="/assets/app.js"></script>');
  await assert.rejects(prepareAppSite(diner, output), /base/);
});
