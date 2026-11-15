// Screen-space placement is deliberately approximate, never a physical measurement.
export function cameraPlacement(
  viewport: { width: number; height: number; top: number; bottom: number },
  aspect: number,
  preferredWidth: number | undefined,
  zoom: number,
  position: { x: number; y: number },
) {
  const left = 24;
  const right = Math.max(left + 1, viewport.width - 24);
  const top = viewport.top + 20;
  const bottom = Math.max(top + 1, viewport.height - viewport.bottom - 20);
  const availableWidth = right - left;
  const availableHeight = bottom - top;
  const initialWidth =
    preferredWidth ?? Math.min(availableWidth * 0.7, (availableHeight / aspect) * 0.7);
  const width = Math.min(initialWidth * zoom, availableWidth, availableHeight / aspect);
  const height = width * aspect;
  const x = left + width / 2 + Math.max(0, Math.min(1, position.x)) * (availableWidth - width);
  const y = top + height / 2 + Math.max(0, Math.min(1, position.y)) * (availableHeight - height);
  return { width, height, x, y, initialWidth, left, right, top, bottom };
}
