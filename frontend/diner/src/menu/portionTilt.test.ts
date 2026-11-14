import { afterEach, expect, it, vi } from 'vitest';
import { bindPortionTilt, tiltAngles } from './portionTilt';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup() {
  vi.useFakeTimers();
  const media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('matchMedia', () => media);
  vi.stubGlobal('requestAnimationFrame', (fn: (t: number) => void) =>
    setTimeout(() => fn(performance.now()), 16),
  );
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  const captured = new Set<number>();
  const host = Object.assign(new EventTarget(), {
    classList: { add: vi.fn(), remove: vi.fn() },
    focus: vi.fn(),
    getBoundingClientRect: () => ({ width: 390, height: 844 }),
    hasPointerCapture: (id: number) => captured.has(id),
    setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  });
  const apply = vi.fn();
  let enabled = true;
  const controller = bindPortionTilt(host as unknown as HTMLElement, () => enabled, apply);
  const event = (name: string, data: object) =>
    host.dispatchEvent(Object.assign(new Event(name, { cancelable: true }), data));
  const pointer = (name: string, x: number, id = 1) =>
    event(name, { clientX: x, clientY: 100, pointerId: id, isPrimary: id === 1, button: 0 });
  return {
    media,
    host,
    apply,
    controller,
    pointer,
    event,
    disable: () => {
      enabled = false;
    },
  };
}
it('bounds image tilt without changing physical dimensions', () => {
  expect(tiltAngles(20, -20)).toEqual({ pitch: -24, yaw: 10, roll: 12 });
  expect(tiltAngles(0, 0)).toEqual({ pitch: 0, yaw: 0, roll: 0 });
});
it('ignores secondary pointers, stops a cancelled drag and disposes pending animation', () => {
  const s = setup();
  s.pointer('pointerdown', 100);
  s.pointer('pointermove', 180, 2);
  expect(s.apply).not.toHaveBeenCalled();
  s.pointer('pointermove', 180);
  vi.advanceTimersByTime(500);
  expect(s.apply.mock.lastCall?.[0]).toBeGreaterThan(0);
  s.pointer('pointercancel', 180);
  s.apply.mockClear();
  s.pointer('pointermove', 220);
  vi.advanceTimersByTime(500);
  expect(s.apply).not.toHaveBeenCalled();
  s.controller.reset();
  s.controller.dispose();
  vi.advanceTimersByTime(500);
  expect(s.apply).not.toHaveBeenCalled();
});
it('uses immediate keyboard/reset updates, responds to reduced motion and respects disabled mode', () => {
  const s = setup();
  s.event('keydown', { key: 'ArrowRight' });
  expect(s.apply).toHaveBeenLastCalledWith(0.1, 0);
  s.media.matches = true;
  s.media.dispatchEvent(new Event('change'));
  expect(s.apply).toHaveBeenLastCalledWith(0, 0);
  s.event('keydown', { key: 'ArrowDown' });
  expect(s.apply).toHaveBeenLastCalledWith(0, 0.025);
  s.disable();
  s.apply.mockClear();
  s.event('keydown', { key: 'Home' });
  expect(s.apply).not.toHaveBeenCalled();
  s.controller.dispose();
});

it('stops in-flight easing when a touch gesture is cancelled', () => {
  const s = setup();
  s.pointer('pointerdown', 100);
  s.pointer('pointermove', 180);
  vi.advanceTimersByTime(32);
  expect(s.apply).toHaveBeenCalled();
  s.pointer('pointercancel', 180);
  s.apply.mockClear();
  vi.advanceTimersByTime(500);
  expect(s.apply).not.toHaveBeenCalled();
  s.controller.dispose();
});
