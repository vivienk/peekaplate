import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const fixtures = JSON.parse(
  await readFile(
    new URL('../processing/tests/fixtures/source-spans.json', import.meta.url),
    'utf8',
  ),
);

for (const fixture of fixtures) {
  test(`shared source span reconstructs ${fixture.segment_id}`, () => {
    const {
      text,
      evidence_text: expected,
      code_point_span: codePoint,
      utf16_span: utf16,
    } = fixture;
    assert.equal(text.slice(utf16.start, utf16.end), expected);
    assert.equal(Array.from(text).slice(codePoint.start, codePoint.end).join(''), expected);
    assert.notEqual(text.slice(codePoint.start, codePoint.end), expected);
  });
}
