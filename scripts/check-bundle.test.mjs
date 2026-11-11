import assert from 'node:assert/strict';
import test from 'node:test';
import { checkInitialBundle, checkPortionBundle } from './check-bundle.mjs';

const chunk = (fileName, isEntry = false) => ({
  type: 'chunk',
  fileName,
  isEntry,
  modules: {},
  imports: [],
  dynamicImports: [],
  code: 'console.log("ready")',
});

test('counts shared initial chunks once and leaves lazy renderer out', () => {
  const entry = chunk('index.js', true);
  entry.imports = ['shared.js'];
  entry.dynamicImports = ['viewer.js'];
  const shared = chunk('shared.js');
  shared.imports = ['index.js'];
  const viewer = chunk('viewer.js');
  viewer.modules['/node_modules/three/build/three.module.js'] = {};
  assert.equal(
    checkInitialBundle({ 'index.js': entry, 'shared.js': shared, 'viewer.js': viewer }).chunks,
    2,
  );
});

test('rejects initial renderer imports, missing entry and budget overruns', () => {
  const entry = chunk('index.js', true);
  entry.modules['/node_modules/three/build/three.module.js'] = {};
  assert.throws(() => checkInitialBundle({ 'index.js': entry }), /Renderer/);
  assert.throws(() => checkInitialBundle({}), /No diner/);
  assert.throws(() => checkInitialBundle({ 'index.js': chunk('index.js', true) }, 1), /exceeds/);
});

test('rejects unaccounted initial imports instead of silently undercounting JavaScript', () => {
  const entry = chunk('index.js', true);
  entry.imports = ['https://cdn.example/viewer.js'];
  assert.throws(() => checkInitialBundle({ 'index.js': entry }), /Missing initial JS chunk/);
});

test('T1 counts renderer imports plus manifest and asset allowance', () => {
  const renderer = chunk('portion.js');
  renderer.modules['/src/menu/portionRenderer.ts'] = {};
  renderer.imports = ['shared.js'];
  const shared = chunk('shared.js');
  const bundle = { 'portion.js': renderer, 'shared.js': shared };
  const result = checkPortionBundle(bundle);
  assert.ok(result.total > 200_000);
  assert.throws(() => checkPortionBundle(bundle, 200_000), /exceeds/);
  assert.throws(() => checkPortionBundle({ 'portion.js': renderer }), /Missing portion/);
  assert.equal(checkPortionBundle({}), null);
});
