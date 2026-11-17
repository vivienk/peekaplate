import { expect, it } from 'vitest';
import { logoDimensions } from './logo-image';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAJElEQVR4nO3MMQEAAAgDoEU0ju01hIcPBCABADiarrkeAEA+LbVgAsefyYE+AAAAAElFTkSuQmCC',
  'base64',
);
it('reads original dimensions and rejects incomplete or oversized PNG bytes', () => {
  expect(logoDimensions(png, 'image/png')).toEqual({ width: 32, height: 32, extension: 'png' });
  for (const invalid of [
    png.subarray(0, 24),
    png.subarray(0, png.length - 1),
    Buffer.from('not an image'),
  ])
    expect(() => logoDimensions(invalid, 'image/png')).toThrow();
  const huge = Buffer.from(png);
  huge.writeUInt32BE(20000, 16);
  expect(() => logoDimensions(huge, 'image/png')).toThrow();
  expect(() => logoDimensions(png, 'image/svg+xml')).toThrow();
});
it('reads a JPEG frame and rejects missing or invalid dimensions', () => {
  const jpeg = Uint8Array.from([255, 216, 255, 192, 0, 11, 8, 0, 40, 0, 80, 1, 1, 17, 0, 255, 217]);
  expect(logoDimensions(jpeg, 'image/jpeg')).toEqual({ width: 80, height: 40, extension: 'jpg' });
  expect(() => logoDimensions(jpeg.subarray(0, 10), 'image/jpeg')).toThrow();
  const zero = jpeg.slice();
  zero[8] = 0;
  zero[10] = 0;
  expect(() => logoDimensions(zero, 'image/jpeg')).toThrow();
});
