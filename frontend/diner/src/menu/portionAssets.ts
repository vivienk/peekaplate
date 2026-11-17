import type { PublicPortion } from '@peekaplate/contracts';

export async function readLayer(layer: PublicPortion['layers'][number], signal: AbortSignal) {
  const uploaded =
    import.meta.env.DEV && layer.url.startsWith('https://portion-ingestion.invalid/');
  const fixture =
    (import.meta.env.DEV || import.meta.env.VITE_PORTION_DEMO) &&
    layer.url.startsWith('https://portion-fixtures.invalid/');
  const url = uploaded
    ? `data:${layer.url.endsWith('/background.svg') ? 'image/svg+xml' : 'image/webp'};base64,${(await import('./portionUpload')).uploadedLayer(layer.url)}`
    : fixture
      ? (await import('./fixturePortions')).fixtureLayerUrl(layer.url)
      : (import.meta.env.DEV || import.meta.env.VITE_PORTION_DEMO) &&
          layer.url.startsWith('https://portion-demo.invalid/')
        ? await (await import('./portionDemo')).demoLayerUrl(layer.url, signal)
        : layer.url;
  const bundled =
    (import.meta.env.DEV || import.meta.env.VITE_PORTION_DEMO) &&
    (uploaded || fixture || layer.url.startsWith('https://portion-demo.invalid/')) &&
    /^data:image\/[^;]+;base64,/.test(url);
  const response = bundled
    ? new Response(
        Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0)),
        {
          headers: { 'Content-Type': url.slice(5, url.indexOf(';')) },
        },
      )
    : await fetch(url, {
        signal,
        cache: 'no-cache',
        credentials: 'omit',
        redirect: 'error',
      });
  if (!response.ok || !response.body) throw new Error('Layer unavailable');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(layer.size_bytes);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > bytes.length) throw new Error('Layer exceeds budget');
      bytes.set(value, length - value.length);
    }
  } finally {
    await reader.cancel();
  }
  if (length !== bytes.length) throw new Error('Layer size mismatch');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== layer.sha256) throw new Error('Layer hash mismatch');
  signal.throwIfAborted();
  // Published asset URLs are opaque hashes. Preserve a supported response MIME rather
  // than guessing from the URL; SVG blobs require it for browser image decoding.
  const type = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  return new Blob([bytes], {
    type: ['image/svg+xml', 'image/png', 'image/webp', 'image/jpeg'].includes(type) ? type : '',
  });
}

// PR25 permits one delayed retry before retaining the photo. Cancellation must stop the delay too.
export function retryDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 250);
    signal.addEventListener('abort', abort, { once: true });
  });
}
