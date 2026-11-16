import { describe, expect, it } from 'vitest';
import { createPortionMotion } from './portionMotion';

describe('PR25 review viewer input', () => {
  it('reverses immediately after repeated keys at the limit', () => {
    const motion = createPortionMotion();
    for (let n = 0; n < 40; n++) motion.key('ArrowRight');
    expect(motion.value().x).toBe(1);
    expect(motion.key('ArrowLeft')?.x).toBeCloseTo(5 / 6);
  });
  it('uses a shared position and pointer movement replaces keyboard offsets', () => {
    const motion = createPortionMotion();
    motion.pointer(0.5, -0.5);
    expect(motion.key('ArrowRight')?.x).toBeCloseTo(2 / 3);
    expect(motion.pointer(1, -1)).toEqual({ x: 1, y: -1 });
    expect(motion.key('ArrowLeft')?.x).toBeCloseTo(5 / 6);
    expect(motion.pointer(0, 0)).toEqual({ x: 0, y: 0 });
    expect(motion.key('Home')).toEqual({ x: 0, y: 0 });
    expect(motion.key('Tab')).toBeNull();
  });
});
