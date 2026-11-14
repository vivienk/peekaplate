import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { intersectTable, isQuestBrowser, portionXRSessionOptions } from './portionXR';

const polygon = [
  { x: -0.5, z: -0.5 },
  { x: 0.5, z: -0.5 },
  { x: 0.5, z: 0.5 },
  { x: -0.5, z: 0.5 },
];
describe('Quest portion placement', () => {
  it('does not require phone-only DOM overlay or hit-test features', () => {
    const options = portionXRSessionOptions({} as HTMLElement);
    expect(options.requiredFeatures ?? []).toEqual([]);
    expect(options.optionalFeatures).toContain('plane-detection');
    expect(options.optionalFeatures).toContain('hit-test');
  });
  it('recognizes Quest without treating iPhone as a headset', () => {
    expect(isQuestBrowser('Mozilla OculusBrowser/35')).toBe(true);
    expect(isQuestBrowser('Mozilla iPhone Safari')).toBe(false);
  });
  it('places in world metres inside the detected table polygon', () => {
    const transform = new THREE.Matrix4().makeTranslation(1, 0.8, -2);
    const ray = new THREE.Ray(new THREE.Vector3(1, 1.6, -2), new THREE.Vector3(0, -1, 0));
    expect(intersectTable(ray, transform, polygon)?.toArray()).toEqual([1, 0.8, -2]);
    ray.origin.x = 3;
    expect(intersectTable(ray, transform, polygon)).toBeNull();
  });
  it('rejects walls, behind-user intersections and distant surfaces', () => {
    const ray = new THREE.Ray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0));
    expect(intersectTable(ray, new THREE.Matrix4().makeRotationZ(Math.PI / 2), polygon)).toBeNull();
    expect(intersectTable(ray, new THREE.Matrix4().makeTranslation(0, 2, 0), polygon)).toBeNull();
    expect(intersectTable(ray, new THREE.Matrix4().makeTranslation(0, -5, 0), polygon)).toBeNull();
    expect(intersectTable(ray, new THREE.Matrix4(), [])).toBeNull();
  });
});
