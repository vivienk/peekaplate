import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  PublicMenuDeliverySchema,
  PublicMenuIntegrityError,
  PublicMenuResponseSchema,
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
  expect(error).toMatchObject({ code });
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

// Synthetic, proposed vectors from PR #117, not approved restaurant content:
// https://github.com/vivienk/peekaplate/pull/117#issuecomment-6736917117
describe('PR #117 proposed exact-byte vectors', () => {
  const directory = new URL('res02-review-vectors/', fixtureDir);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8')) as {
    responseIdentity: {
      venueId: string;
      menuId: string;
      menuRevisionId: string;
      publicationId: string;
    };
    originalContentHash: string;
    objectURL: string;
    files: { file: string; sha256: string }[];
  };
  const bytes = (name: string) => new Uint8Array(readFileSync(new URL(name, directory)));
  const response = PublicMenuResponseSchema.parse({
    schemaVersion: 1,
    ...manifest.responseIdentity,
    publicationHash: '0'.repeat(64),
    availabilityVersion: 1,
    tier: 'T0',
    bundle: {
      url: manifest.objectURL,
      contentHash: manifest.originalContentHash,
      assetManifestHash: '0'.repeat(64),
    },
    menuToken: 'synthetic-not-a-signed-token',
    tokenExpiresAt: '2030-01-01T00:30:00Z',
  });

  it('accepts original exact bytes with matching delivery identities', async () => {
    const content = await verifyPublicMenuContentBytes(
      bytes('bundle.original.json'),
      response.bundle.contentHash,
    );
    expect(PublicMenuDeliverySchema.parse({ response, content }).content).toEqual(content);
  });

  it('accepts repeated identical bytes with the same hash and identities', async () => {
    const original = bytes('bundle.original.json');
    const first = await verifyPublicMenuContentBytes(original, response.bundle.contentHash);
    const repeated = bytes('bundle.original.json');
    expect(await sha256(repeated)).toBe(response.bundle.contentHash);
    const content = await verifyPublicMenuContentBytes(repeated, response.bundle.contentHash);
    expect(content).toEqual(first);
    expect(PublicMenuDeliverySchema.parse({ response, content }).content).toEqual(first);
  });

  it('rejects differently formatted bytes despite equal JSON values', async () => {
    const original = bytes('bundle.original.json');
    const pretty = bytes('bundle.same-value-pretty.json');
    await expectIntegrityError(pretty, response.bundle.contentHash, 'content_hash_mismatch');
    expect(JSON.parse(new TextDecoder().decode(pretty))).toEqual(
      JSON.parse(new TextDecoder().decode(original)),
    );
  });

  it('rejects a changed name with the original digest', async () => {
    await expectIntegrityError(
      bytes('bundle.tampered-name.json'),
      response.bundle.contentHash,
      'content_hash_mismatch',
    );
  });

  it('rejects a wrong revision even when its digest matches', async () => {
    const name = 'bundle.wrong-revision.json';
    const digest = manifest.files.find((file) => file.file === name)!.sha256;
    const content = await verifyPublicMenuContentBytes(bytes(name), digest);
    const result = PublicMenuDeliverySchema.safeParse({
      response: { ...response, bundle: { ...response.bundle, contentHash: digest } },
      content,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('wrong revision unexpectedly accepted');
    expect(
      result.error.issues.some((issue) => issue.path.join('.') === 'content.menu_revision_id'),
    ).toBe(true);
  });
});
