import { expect, it } from 'vitest';
import { cameraGrabOffset, cameraPlacement, rotatedCameraBounds } from './portionPlacement';

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

it('keeps the grab point attached and only centers a background tap', () => {
  const rect = { x: 200, y: 160, width: 100, height: 80 };
  const offset = cameraGrabOffset(rect, { x: 240, y: 180 });
  expect(offset).toEqual({ x: 40, y: 20 });
  expect({ x: 250 - offset.x, y: 185 - offset.y }).toEqual({ x: 210, y: 165 });
  expect(cameraGrabOffset(rect, { x: 350, y: 180 })).toEqual({ x: 0, y: 0 });
});
it('fits the active model bounds even when rotation exposes its longer depth', () => {
  const dimensions = { x: 0.1, y: 0.2, z: 0.4 };
  const front = rotatedCameraBounds(dimensions, 0);
  const side = rotatedCameraBounds(dimensions, 90);
  expect(front.width).toBeCloseTo(0.1);
  expect(side.width).toBeCloseTo(0.4);
  expect(side.height).toBe(front.height);
  const placed = cameraPlacement(landscape, side.height / side.width, 280, 1.5, { x: 0.5, y: 0 });
  expect(placed.y - placed.height / 2).toBeCloseTo(placed.top);
});
