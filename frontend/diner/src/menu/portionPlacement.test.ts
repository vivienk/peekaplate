import { expect, it } from 'vitest';
import { cameraPlacement } from './portionPlacement';

const portrait = { width: 390, height: 844, top: 66, bottom: 64 };
const landscape = { width: 844, height: 390, top: 66, bottom: 64 };
it('retains visual width and placement across rotation when the dish fits', () => {
  const position = { x: 0.8, y: 0.3 };
  const first = cameraPlacement(portrait, 0.6, undefined, 1, position);
  const rotated = cameraPlacement(landscape, 0.6, first.initialWidth, 1, position);
  expect(rotated.width).toBe(first.width);
  expect(
    (rotated.x - rotated.left - rotated.width / 2) / (rotated.right - rotated.left - rotated.width),
  ).toBeCloseTo(0.8);
  expect(cameraPlacement(portrait, 0.6, first.initialWidth, 1, position)).toEqual(first);
});
it('keeps the complete image inside the safe area at maximum zoom and edge placement', () => {
  for (const viewport of [portrait, landscape]) {
    for (const aspect of [0.4, 1, 2.5]) {
      for (const position of [
        { x: -1, y: -1 },
        { x: 2, y: 2 },
      ]) {
        const result = cameraPlacement(viewport, aspect, 400, 1.5, position);
        expect(result.x - result.width / 2).toBeGreaterThanOrEqual(result.left - 0.001);
        expect(result.x + result.width / 2).toBeLessThanOrEqual(result.right + 0.001);
        expect(result.y - result.height / 2).toBeGreaterThanOrEqual(result.top - 0.001);
        expect(result.y + result.height / 2).toBeLessThanOrEqual(result.bottom + 0.001);
        expect(result.height / result.width).toBeCloseTo(aspect);
      }
    }
  }
});
it('retains preferred size when a smaller viewport temporarily constrains the image', () => {
  const position = { x: 0.5, y: 0.5 };
  const first = cameraPlacement(portrait, 2, undefined, 1, position);
  const rotated = cameraPlacement(landscape, 2, first.initialWidth, 1, position);
  expect(rotated.width).toBeLessThan(first.width);
  expect(rotated.initialWidth).toBe(first.initialWidth);
  expect(cameraPlacement(portrait, 2, rotated.initialWidth, 1, position).width).toBe(first.width);
});
