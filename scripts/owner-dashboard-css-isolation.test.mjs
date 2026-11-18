import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const consoleRequire = createRequire(new URL('../frontend/console/package.json', import.meta.url));
const require = createRequire(consoleRequire.resolve('vite'));
const { parse } = require('postcss');
const source = new URL('../frontend/console/src/', import.meta.url);

test('main authored performance primitives stay confined to their own screen', async () => {
  const css = parse(await readFile(new URL('owner-dashboard/performance.css', source), 'utf8'));
  const scope = css.nodes.find((node) => node.type === 'atrule' && node.name === 'scope');
  assert.equal(scope?.params, '(.performance-page)');
  css.walkRules((rule) => {
    let parent = rule.parent;
    while (parent && parent !== scope) parent = parent.parent;
    assert.equal(parent, scope, `Unscoped performance selector: ${rule.selector}`);
  });
});

test('authored dashboard rules are isolated to live content and original demo roots', async () => {
  const css = parse(await readFile(new URL('owner-dashboard/owner-dashboard.css', source), 'utf8'));
  const scope = css.nodes.find((node) => node.type === 'atrule' && node.name === 'scope');
  assert.equal(scope?.params, '(.owner-dashboard-content, .owner-dashboard-demo)');
  css.walkRules((rule) => {
    let parent = rule.parent;
    while (parent && parent !== scope) {
      if (parent.type === 'atrule' && parent.name.endsWith('keyframes')) return;
      parent = parent.parent;
    }
    assert.equal(parent, scope, `Unscoped dashboard selector: ${rule.selector}`);
    assert.doesNotMatch(rule.selector, /:root|#root|\b(?:html|body)\b/);
  });
  assert.ok(scope.nodes.some((node) => node.selector === ':scope'));
  for (const entry of [
    'owner-dashboard/main.tsx',
    'owner/review/menuReviewDemo.tsx',
    'onboarding/demo.tsx',
  ]) {
    assert.match(
      await readFile(new URL(entry, source), 'utf8'),
      /document\.body\.classList\.add\('owner-dashboard-demo'\)/,
    );
  }
});
