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

// A rotated box must fit as a whole; the local model is not a measured food volume.
export function rotatedCameraBounds(dimensions: { x: number; y: number; z: number }, yaw: number) {
  const angle = (yaw * Math.PI) / 180;
  return {
    width: Math.max(
      0.001,
      Math.abs(dimensions.x * Math.cos(angle)) + Math.abs(dimensions.z * Math.sin(angle)),
    ),
    height: Math.max(0.001, dimensions.y),
  };
}

export function cameraGrabOffset(
  rect: { x: number; y: number; width: number; height: number },
  pointer: { x: number; y: number },
) {
  const x = pointer.x - rect.x;
  const y = pointer.y - rect.y;
  return Math.abs(x) <= rect.width / 2 && Math.abs(y) <= rect.height / 2
    ? { x, y }
    : { x: 0, y: 0 };
}
