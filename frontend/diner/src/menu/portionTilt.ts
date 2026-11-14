// Direct manipulation; the reference's 450ms cubic-bezier(.22, 1, .36, 1)
// is used only to settle/reset. Keyboard and reduced-motion updates are immediate.
export function tiltAngles(x: number, y: number) {
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  return { pitch: clamp(y) * 24, yaw: clamp(x) * 10, roll: clamp(x) * 12 };
}
function settle(t: number) {
  let low = 0,
    high = 1;
  for (let i = 0; i < 12; i++) {
    const u = (low + high) / 2;
    const x = 3 * (1 - u) ** 2 * u * 0.22 + 3 * (1 - u) * u * u * 0.36 + u ** 3;
    if (x < t) low = u;
    else high = u;
  }
  const u = (low + high) / 2;
  return 1 - (1 - u) ** 3;
}
export function bindPortionTilt(
  host: HTMLElement,
  enabled: () => boolean,
  apply: (x: number, y: number) => void,
) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let x = 0,
    y = 0,
    frame = 0;
  let drag:
    | { id: number; x: number; y: number; startX: number; startY: number; span: number }
    | undefined;
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  const render = (nx: number, ny: number) => {
    x = clamp(nx);
    y = clamp(ny);
    apply(x, y);
  };
  const cancel = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };
  const end = () => {
    const id = drag?.id;
    drag = undefined;
    if (id !== undefined && host.hasPointerCapture(id)) host.releasePointerCapture(id);
    host.classList.remove('pp-ar__canvas--dragging');
  };
  const animateTo = (nx: number, ny: number, animate = true) => {
    cancel();
    const targetX = clamp(nx),
      targetY = clamp(ny);
    if (!animate || reduced.matches) {
      render(targetX, targetY);
      return;
    }
    const fromX = x,
      fromY = y,
      started = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / 450);
      const amount = t === 1 ? 1 : settle(t);
      render(fromX + (targetX - fromX) * amount, fromY + (targetY - fromY) * amount);
      if (t < 1) frame = requestAnimationFrame(step);
      else frame = 0;
    };
    frame = requestAnimationFrame(step);
  };
  const reset = (animate = true) => {
    end();
    animateTo(0, 0, animate);
  };
  const down = (event: PointerEvent) => {
    if (!enabled() || drag || !event.isPrimary || event.button !== 0) return;
    cancel();
    const bounds = host.getBoundingClientRect();
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: x,
      startY: y,
      span: Math.max(120, Math.min(bounds.width, bounds.height) * 0.45),
    };
    host.setPointerCapture(event.pointerId);
    host.focus({ preventScroll: true });
    host.classList.add('pp-ar__canvas--dragging');
    event.preventDefault();
  };
  const move = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId || !enabled()) return;
    const factor = reduced.matches ? 0.25 : 1;
    animateTo(
      drag.startX + ((event.clientX - drag.x) / drag.span) * factor,
      drag.startY + ((event.clientY - drag.y) / drag.span) * factor,
    );
  };
  const up = (event: PointerEvent) => {
    if (drag?.id === event.pointerId) end();
  };
  const key = (event: KeyboardEvent) => {
    if (!enabled()) return;
    const delta = reduced.matches ? 0.025 : 0.1;
    if (!['Home', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    cancel();
    end();
    if (event.key === 'Home') render(0, 0);
    else
      render(
        x + (event.key === 'ArrowRight' ? delta : event.key === 'ArrowLeft' ? -delta : 0),
        y + (event.key === 'ArrowDown' ? delta : event.key === 'ArrowUp' ? -delta : 0),
      );
  };
  const preference = () => reset(false);
  host.addEventListener('pointerdown', down);
  host.addEventListener('pointermove', move);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const)
    host.addEventListener(name, up);
  host.addEventListener('keydown', key);
  reduced.addEventListener('change', preference);
  return {
    reset,
    dispose() {
      cancel();
      end();
      host.removeEventListener('pointerdown', down);
      host.removeEventListener('pointermove', move);
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const)
        host.removeEventListener(name, up);
      host.removeEventListener('keydown', key);
      reduced.removeEventListener('change', preference);
    },
  };
}
