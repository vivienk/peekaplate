// PR25 review_preview_html.py: pointer replaces x/y; keys adjust that same clamped state.
export function createPortionMotion() {
  let x = 0;
  let y = 0;
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  const value = () => ({ x, y });
  return {
    value,
    pointer(nextX: number, nextY: number) {
      x = clamp(nextX);
      y = clamp(nextY);
      return value();
    },
    key(key: string) {
      if (key === 'Home') x = y = 0;
      else if (key === 'ArrowLeft') x = clamp(x - 1 / 6);
      else if (key === 'ArrowRight') x = clamp(x + 1 / 6);
      else if (key === 'ArrowUp') y = clamp(y - 1 / 6);
      else if (key === 'ArrowDown') y = clamp(y + 1 / 6);
      else return null;
      return value();
    },
  };
}
