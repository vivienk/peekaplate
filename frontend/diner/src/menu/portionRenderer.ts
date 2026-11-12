import type { PublicPortion } from '@peekaplate/contracts';
import { readLayer, retryDelay } from './portionAssets';
export type PortionRenderer = {
  update(x: number, y: number, durationMs?: number): void;
  dispose(): void;
};

// PR25 review_preview_html.py presentation: warm card, 900px perspective, 5px/3px cutout translation.
export async function mount(
  element: HTMLElement,
  manifest: PublicPortion,
  signal: AbortSignal,
): Promise<PortionRenderer> {
  signal.throwIfAborted();
  if (!CSS.supports('transform', 'rotateY(1deg)')) throw new Error('CSS tilt unavailable');
  const card = document.createElement('div');
  card.className = 'pp-portion__css';
  card.setAttribute('aria-hidden', 'true');
  const images: { image: HTMLImageElement; depth: number }[] = [];
  const urls = new Set<string>();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', dispose);
    card.remove();
    for (const { image } of images) image.removeAttribute('src');
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    for (const [rank, layer] of [...manifest.layers].sort((a, b) => a.depth - b.depth).entries()) {
      let image: HTMLImageElement | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        let url: string | undefined;
        try {
          const bytes = await readLayer(layer, signal);
          signal.throwIfAborted();
          url = URL.createObjectURL(new Blob([bytes]));
          urls.add(url);
          const candidate = new Image();
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              signal.removeEventListener('abort', abort);
              candidate.onload = null;
              candidate.onerror = null;
            };
            const abort = () => {
              cleanup();
              candidate.removeAttribute('src');
              reject(signal.reason);
            };
            candidate.onload = () => {
              cleanup();
              resolve();
            };
            candidate.onerror = () => {
              cleanup();
              reject(new Error('Cutout unavailable'));
            };
            signal.addEventListener('abort', abort, { once: true });
            candidate.src = url!;
          });
          signal.throwIfAborted();
          if (
            candidate.naturalWidth !== manifest.width ||
            candidate.naturalHeight !== manifest.height
          ) {
            throw new Error('Layer dimensions mismatch');
          }
          image = candidate;
          break;
        } catch (error) {
          if (url) {
            URL.revokeObjectURL(url);
            urls.delete(url);
          }
          signal.throwIfAborted();
          if (attempt === 1) throw error;
          await retryDelay(signal);
        }
      }
      if (!image) throw new Error('Cutout unavailable');
      image.alt = '';
      image.draggable = false;
      image.style.zIndex = String(rank + 1);
      // The review viewer supplies its own gradient instead of the spatial bundle backdrop.
      // Validate every delivered layer, but display only the cutout foregrounds.
      if (layer.depth > 0) card.append(image);
      images.push({ image, depth: layer.depth });
    }
    signal.throwIfAborted();
    element.append(card);
    const update: PortionRenderer['update'] = (x, y, durationMs = 0) => {
      if (disposed) return;
      const nx = Math.max(-1, Math.min(1, x));
      const ny = Math.max(-1, Math.min(1, y));
      const yaw = manifest.motion?.max_yaw_degrees ?? 3;
      const pitch = manifest.motion?.max_pitch_degrees ?? 3;
      const easing = durationMs === 55 ? 'linear' : 'ease-out';
      card.style.transition = `transform ${durationMs}ms ${easing}`;
      card.style.transform = `perspective(900px) rotateX(${-ny * pitch}deg) rotateY(${nx * yaw}deg)`;
      for (const { image } of images) {
        image.style.transition = `transform ${durationMs}ms ${easing}`;
        image.style.transform = `translate(${(yaw ? nx : 0) * 5}px, ${(pitch ? ny : 0) * 3}px)`;
      }
    };
    update(0, 0);
    return { update, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
