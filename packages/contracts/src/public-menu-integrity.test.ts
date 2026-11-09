import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  PublicMenuIntegrityError,
  sha256,
  verifyPublicMenuContentBytes,
} from './index';

const fixtureDir = new URL('../fixtures/public-menu-bundle.v1/', import.meta.url);
const bundleBytes = new Uint8Array(readFileSync(new URL('bundle.json', fixtureDir)));
const tamperedBytes = new Uint8Array(readFileSync(new URL('tampered.json', fixtureDir)));
const { contentHash } = JSON.parse(readFileSync(new URL('expected.json', fixtureDir), 'utf8')) as {
  contentHash: string;
};

async function expectIntegrityError(bytes: Uint8Array, hash: string, code: string) {
  const error = await verifyPublicMenuContentBytes(bytes, hash).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PublicMenuIntegrityError);
  expect((error as PublicMenuIntegrityError).code).toBe(code);
}

describe('public menu bundle integrity', () => {
  it('verifies the shared fixture and round-trips to the exact same bytes', async () => {
    const parsed = await verifyPublicMenuContentBytes(bundleBytes, contentHash);
    const text = new TextDecoder().decode(bundleBytes);
    expect(text.endsWith('\n')).toBe(false);
    expect(canonicalJson(parsed)).toBe(text);
    expect(parsed.categories.flatMap((category) => category.dishes)).toHaveLength(3);
  });

  it('rejects tampered bytes before parsing', async () => {
    await expectIntegrityError(tamperedBytes, contentHash, 'content_hash_mismatch');
  });

  it('rejects bytes that are not UTF-8 even when the hash matches', async () => {
    const bytes = new Uint8Array([0xff, 0xfe]);
    await expectIntegrityError(bytes, await sha256(bytes), 'invalid_utf8');
  });

  it('rejects bytes that are not JSON even when the hash matches', async () => {
    const bytes = new TextEncoder().encode('{');
    await expectIntegrityError(bytes, await sha256(bytes), 'invalid_json');
  });

  it('rejects JSON that is not a v1 bundle even when the hash matches', async () => {
    const bytes = new TextEncoder().encode('{"x":1}');
    await expectIntegrityError(bytes, await sha256(bytes), 'invalid_bundle');
  });
});
