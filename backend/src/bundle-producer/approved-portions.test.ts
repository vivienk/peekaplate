import { createHash } from 'node:crypto';
import { type PlateCalibration, PublicPortionSchema } from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import {
  matchesApprovedOwnerPortion,
  prepareApprovedPortion,
  verifyHostedPortionFiles,
} from './approved-portions';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const venueId = id(1);
const dishId = id(2);
const dishRevisionId = id(3);
const draftId = id(4);
const photoId = id(5);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const calibration: PlateCalibration = {
  shape: 'round',
  width_mm: 240,
  depth_mm: 240,
  source_sha256: 'a'.repeat(64),
  source_width_px: 800,
  source_height_px: 800,
  boundary: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
  confirmed: true,
};

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
  it.each([undefined, 3])(
    'attaches approved physical dimensions without changing reviewed layers (count %s)',
    (servingCount) => {
      const { exportValue, expected } = fixture();
      const before = structuredClone(exportValue);
      const prepared = prepareApprovedPortion(exportValue, {
        ...expected,
        sourceHash: calibration.source_sha256,
        sourceDimensions: { width: 800, height: 800 },
        portionCalibration: calibration,
        ...(servingCount === undefined ? {} : { servingCount }),
      });
      expect(prepared.portion.physical_size).toEqual({
        plate: calibration,
        foreground_sha256: exportValue.portion.layers[1]!.sha256,
        source: 'owner',
        validation_status: 'pending',
        ...(servingCount === undefined ? {} : { serving_count: servingCount }),
      });
      expect(exportValue).toEqual(before);
      expect(prepared.portion.layers.map((layer) => layer.sha256)).toEqual(
        exportValue.portion.layers.map((layer) => layer.sha256),
      );
      expect(
        matchesApprovedOwnerPortion(prepared, photoId, calibration.source_sha256, prepared.portion),
      ).toBe(true);
    },
  );

  it.each([
    { portionCalibration: { ...calibration, source_sha256: 'b'.repeat(64) } },
    { portionCalibration: { ...calibration, source_width_px: 801 } },
  ])(
    'rejects calibration without exact authenticated source dimensions and hash: %j',
    (override) => {
      const { exportValue, expected } = fixture();
      expect(() =>
        prepareApprovedPortion(exportValue, {
          ...expected,
          sourceHash: calibration.source_sha256,
          sourceDimensions: { width: 800, height: 800 },
          ...override,
        }),
      ).toThrow();
    },
  );

  it.each(['sourceDimensions', 'sourceHash'] as const)(
    'requires authenticated source evidence: %s',
    (field) => {
      const { exportValue, expected } = fixture();
      const evidence: Parameters<typeof prepareApprovedPortion>[1] = {
        ...expected,
        sourceHash: calibration.source_sha256,
        sourceDimensions: { width: 800, height: 800 },
        portionCalibration: calibration,
      };
      delete evidence[field];
      expect(() => prepareApprovedPortion(exportValue, evidence)).toThrow();
    },
  );

  it('rejects provider-supplied physical metadata even when the private visual approval matches', () => {
    const { exportValue, expected } = fixture();
    const portion = PublicPortionSchema.parse({
      ...exportValue.portion,
      physical_size: {
        plate: calibration,
        foreground_sha256: exportValue.portion.layers[1]!.sha256,
        source: 'owner',
        validation_status: 'pending',
      },
    });
    const supplied = {
      ...exportValue,
      portion,
      approval: {
        ...exportValue.approval,
        portion_sha256: hash(new TextEncoder().encode(JSON.stringify(portion))),
      },
    };
    expect(() => prepareApprovedPortion(supplied, expected)).toThrow();
  });

  it('binds owner producer authority to exact validated output and source photo hash', () => {
    const { exportValue, expected } = fixture();
    const prepared = prepareApprovedPortion(exportValue, {
      ...expected,
      sourceHash: 'a'.repeat(64),
    });
    expect(matchesApprovedOwnerPortion(prepared, photoId, 'a'.repeat(64), prepared.portion)).toBe(
      true,
    );
    expect(
      matchesApprovedOwnerPortion({ ...prepared }, photoId, 'a'.repeat(64), prepared.portion),
    ).toBe(false);
    expect(matchesApprovedOwnerPortion(prepared, photoId, 'b'.repeat(64), prepared.portion)).toBe(
      false,
    );
    expect(
      matchesApprovedOwnerPortion(prepared, photoId, 'a'.repeat(64), {
        ...prepared.portion,
        dish_revision_id: id(99),
      }),
    ).toBe(false);
    expect(() =>
      prepareApprovedPortion(exportValue, { ...expected, sourceHash: 'b'.repeat(64) }),
    ).toThrow();
  });
  it('rebinds only an owner-approved private photo to the exact published dish revision', () => {
    const { exportValue, expected } = fixture();
    const prepared = prepareApprovedPortion(exportValue, expected);
    expect(prepared.portion.dish_id).toBe(dishId);
    expect(prepared.portion.dish_revision_id).toBe(dishRevisionId);
    expect(prepared.files).toHaveLength(2);
    expect(prepared.portion.layers[0]?.url).toContain(`/portions/${dishId}/${dishRevisionId}/`);
    expect(prepared.portion.layers[1]?.sha256).toBe(
      hash(new TextEncoder().encode('synthetic-foreground-for-contract-test')),
    );
  });

  it('rejects cross-dish or stale-revision export data', () => {
    const { exportValue, expected } = fixture();
    expect(() => prepareApprovedPortion({ ...exportValue, dishId: id(99) }, expected)).toThrow();
    expect(() =>
      prepareApprovedPortion({ ...exportValue, dishRevisionId: id(99) }, expected),
    ).toThrow();
    expect(() => prepareApprovedPortion(exportValue, { ...expected, photoId: id(98) })).toThrow();
  });

  it('rejects an unapproved, corrupted or externally relabelled cutout', () => {
    const { exportValue, expected } = fixture();
    expect(() => prepareApprovedPortion({ ...exportValue, approval: null }, expected)).toThrow();
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
