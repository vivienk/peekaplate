// PR25 harness input reconciliation: clamp combined input, not an unbounded key accumulator.
export function createPortionMotion() {
  let pointerX = 0;
  let pointerY = 0;
  let keyX = 0;
  let keyY = 0;
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  const value = () => ({ x: clamp(pointerX + keyX), y: clamp(pointerY + keyY) });
  return {
    value,
    pointer(x: number, y: number) {
      pointerX = clamp(x);
      pointerY = clamp(y);
      keyX = clamp(pointerX + keyX) - pointerX;
      keyY = clamp(pointerY + keyY) - pointerY;
      return value();
    },
    key(key: string) {
      const current = value();
      if (key === 'Home') {
        pointerX = pointerY = keyX = keyY = 0;
      } else if (key === 'ArrowLeft') keyX = clamp(current.x - 1 / 6) - pointerX;
      else if (key === 'ArrowRight') keyX = clamp(current.x + 1 / 6) - pointerX;
      else if (key === 'ArrowUp') keyY = clamp(current.y - 1 / 6) - pointerY;
      else if (key === 'ArrowDown') keyY = clamp(current.y + 1 / 6) - pointerY;
      else return null;
      return value();
    },
  };
}
