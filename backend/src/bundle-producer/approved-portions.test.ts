import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prepareApprovedPortion, verifyHostedPortionFiles } from './approved-portions';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const venueId = id(1);
const dishId = id(2);
const dishRevisionId = id(3);
const draftId = id(4);
const photoId = id(5);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function fixture() {
  const background = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const foreground = new TextEncoder().encode('synthetic-foreground-for-contract-test');
  const portions = [
    { name: 'background.svg', bytes: background, depth: 0 },
    { name: 'dish.webp', bytes: foreground, depth: 1 },
  ];
  const portion = {
    schema_version: 1,
    dish_id: draftId,
    dish_revision_id: photoId,
    width: 128,
    height: 128,
    motion: { max_yaw_degrees: 3, max_pitch_degrees: 3 },
    layers: portions.map((item) => ({
      url: `https://portion-ingestion.invalid/fixture/${item.name}`,
      sha256: hash(item.bytes),
      size_bytes: item.bytes.byteLength,
      depth: item.depth,
    })),
  };
  const exportValue = {
    portion,
    layers: portions.map((item) => ({
      name: item.name,
      sha256: hash(item.bytes),
      size_bytes: item.bytes.byteLength,
      base64: encode(item.bytes),
    })),
    approval: {
      schema_version: 1,
      status: 'approved',
      source_sha256: 'a'.repeat(64),
      portion_sha256: hash(new TextEncoder().encode(JSON.stringify(portion))),
      approved_by: id(10),
      approved_at: '2026-11-16T20:00:00.000Z',
    },
    venueId,
    dishId,
    dishRevisionId,
    publicationEligible: false,
  };
  const expected = {
    venueId,
    dishId,
    dishRevisionId,
    draftId,
    photoId,
    assetBaseUrl: 'https://assets.example.test/t0',
  };
  return { exportValue, expected };
}

describe('approved private 2.5D to public bundle handoff', () => {
  it('rebinds only an owner-approved private photo to the exact published dish revision', () => {
    const { exportValue, expected } = fixture();
    const prepared = prepareApprovedPortion(exportValue, expected);
    expect(prepared.portion.dish_id).toBe(dishId);
    expect(prepared.portion.dish_revision_id).toBe(dishRevisionId);
    expect(prepared.files).toHaveLength(2);
    expect(prepared.portion.layers[0]?.url).toContain(
      `/portions/${dishId}/${dishRevisionId}/`,
    );
    expect(prepared.portion.layers[1]?.sha256).toBe(
      hash(new TextEncoder().encode('synthetic-foreground-for-contract-test')),
    );
  });

  it('rejects cross-dish or stale-revision export data', () => {
    const { exportValue, expected } = fixture();
    expect(() =>
      prepareApprovedPortion({ ...exportValue, dishId: id(99) }, expected),
    ).toThrow();
    expect(() =>
      prepareApprovedPortion({ ...exportValue, dishRevisionId: id(99) }, expected),
    ).toThrow();
    expect(() =>
      prepareApprovedPortion(exportValue, { ...expected, photoId: id(98) }),
    ).toThrow();
  });

  it('rejects an unapproved, corrupted or externally relabelled cutout', () => {
    const { exportValue, expected } = fixture();
    expect(() =>
      prepareApprovedPortion({ ...exportValue, approval: null }, expected),
    ).toThrow();
    expect(() =>
      prepareApprovedPortion(
        { ...exportValue, approval: { ...exportValue.approval, portion_sha256: 'b'.repeat(64) } },
        expected,
      ),
    ).toThrow();
    const corrupt = structuredClone(exportValue);
    corrupt.layers[1]!.base64 = encode(new TextEncoder().encode('different-image'));
    expect(() => prepareApprovedPortion(corrupt, expected)).toThrow();
  });

  it('requires byte-for-byte public hosting before producer admission', async () => {
    const { exportValue, expected } = fixture();
    const prepared = prepareApprovedPortion(exportValue, expected);
    const goodFetch = (async (url: string | URL | Request) => {
      const match = prepared.files.find((item) => item.url === String(url));
      return new Response(match?.bytes ?? new Uint8Array(), { status: match ? 200 : 404 });
    }) as typeof fetch;
    await expect(verifyHostedPortionFiles(prepared.files, goodFetch)).resolves.toBeUndefined();
    const badFetch = (async () => new Response('tampered')) as typeof fetch;
    await expect(verifyHostedPortionFiles(prepared.files, badFetch)).rejects.toThrow();
  });
});
