import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CalibrationPhoto,
  calibrationMatchesPhoto,
  confirmedPhotoCalibration,
  readCalibrationPhoto,
} from './portionCalibration';
import { calibrationPhotoId, confirmedCalibration } from './portionCalibration.test-helpers';

const photo: CalibrationPhoto = {
  photoId: calibrationPhotoId,
  url: 'blob:authenticated-original',
  source_sha256: confirmedCalibration.source_sha256,
  source_width_px: confirmedCalibration.source_width_px,
  source_height_px: confirmedCalibration.source_height_px,
};

afterEach(() => vi.unstubAllGlobals());

describe('owner serving calibration evidence', () => {
  it('needs explicit physical dimensions, original-photo metadata, and an in-photo boundary', () => {
    const boundary = confirmedCalibration.boundary;
    expect(confirmedPhotoCalibration('28 cm', photo, boundary)).toEqual(confirmedCalibration);
    expect(confirmedPhotoCalibration('30 × 20', photo, boundary)).toMatchObject({
      shape: 'rectangular',
      width_mm: 300,
      depth_mm: 200,
    });
    expect(confirmedPhotoCalibration('1 bowl', photo, boundary)).toBeUndefined();
    expect(confirmedPhotoCalibration('28', undefined, boundary)).toBeUndefined();
    expect(confirmedPhotoCalibration('28', photo, { ...boundary, x: 0.5 })).toBeUndefined();
  });

  it('does not confuse a new blob URL with a changed original, but rejects other photo bytes', () => {
    expect(calibrationMatchesPhoto(confirmedCalibration, { ...photo, url: 'blob:reopened' })).toBe(
      true,
    );
    expect(
      calibrationMatchesPhoto(confirmedCalibration, { ...photo, source_sha256: 'b'.repeat(64) }),
    ).toBe(false);
    expect(calibrationMatchesPhoto(confirmedCalibration, { ...photo, source_width_px: 480 })).toBe(
      false,
    );
  });

  it('hashes the exact authenticated original and uses its decoded image dimensions', async () => {
    let cleared = false;
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 600;
        naturalHeight = 800;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
        removeAttribute() {
          cleared = true;
        }
      },
    );
    const bytes = 'synthetic original bytes, not the cutout';
    const result = await readCalibrationPhoto(
      new Blob([bytes], { type: 'image/png' }),
      calibrationPhotoId,
      photo.url,
      new AbortController().signal,
    );
    expect(result).toEqual({
      photoId: calibrationPhotoId,
      url: photo.url,
      source_sha256: createHash('sha256').update(bytes).digest('hex'),
      source_width_px: 600,
      source_height_px: 800,
    });
    expect(cleared).toBe(true);
  });

  it('rejects an abandoned decode and releases its image without returning stale metadata', async () => {
    const remove = vi.fn();
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src = '';
        removeAttribute = remove;
      },
    );
    const controller = new AbortController();
    const result = readCalibrationPhoto(
      new Blob(['first photo']),
      calibrationPhotoId,
      photo.url,
      controller.signal,
    );
    const abandoned = new Error('photo changed');
    controller.abort(abandoned);
    await expect(result).rejects.toBe(abandoned);
    expect(remove).toHaveBeenCalledWith('src');
  });

  it.each([0, 30_000_000])(
    'rejects an undecodable or over-budget original width %s',
    async (width) => {
      vi.stubGlobal(
        'Image',
        class {
          naturalWidth = width;
          naturalHeight = 1;
          onload: (() => void) | null = null;
          onerror: (() => void) | null = null;
          set src(_value: string) {
            queueMicrotask(() => this.onload?.());
          }
          removeAttribute() {}
        },
      );
      await expect(
        readCalibrationPhoto(
          new Blob(['invalid']),
          calibrationPhotoId,
          photo.url,
          new AbortController().signal,
        ),
      ).rejects.toThrow('dimensions unavailable');
    },
  );
});
