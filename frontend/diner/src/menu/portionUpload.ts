import { type PublicPortion, PublicPortionSchema } from '@peekaplate/contracts';

// Local review only; bytes never become public menu data or durable browser storage.
const layers = new Map<string, { encoded: string; refs: number }>();
export function uploadedLayer(url: string): string {
  const encoded = layers.get(url);
  if (!encoded) throw new Error('Uploaded layer unavailable');
  return encoded.encoded;
}

export async function uploadPortion(
  file: File,
  dishId: string,
  revisionId: string,
  signal: AbortSignal,
): Promise<{ portion: PublicPortion | null; dispose: () => void }> {
  if (!file.size || file.size > 12_000_000) throw new Error('Choose a photo under 12 MB.');
  const response = await fetch(`/__local3d/v1/portion-uploads/${dishId}/${revisionId}`, {
    method: 'POST',
    body: file,
    signal,
    credentials: 'omit',
    redirect: 'error',
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!response.ok)
    throw new Error('Photo processing unavailable. Check the local preview service.');
  const result = await response.json();
  if (result.publication_eligible !== false || result.review_status !== 'needs_review') {
    throw new Error('Invalid review result');
  }
  if (result.status === 'fallback_retained' && result.portion === null) {
    return { portion: null, dispose: () => {} };
  }
  const portion = PublicPortionSchema.parse(result.portion);
  if (portion.dish_id !== dishId || portion.dish_revision_id !== revisionId) {
    throw new Error('Uploaded photo belongs to another dish revision');
  }
  const pending = new Map<string, string>();
  for (const layer of portion.layers) {
    const encoded = result.layers?.[layer.url];
    if (
      !/^https:\/\/portion-ingestion\.invalid\/portion_[a-f0-9]{32}\/(dish.webp|background.svg)$/.test(
        layer.url,
      ) ||
      typeof encoded !== 'string' ||
      encoded.length > 240_000
    )
      throw new Error('Invalid uploaded layer');
    pending.set(layer.url, encoded);
  }
  signal.throwIfAborted();
  for (const [url, encoded] of pending)
    layers.set(url, { encoded, refs: (layers.get(url)?.refs ?? 0) + 1 });
  return {
    portion,
    dispose: () => {
      for (const url of pending.keys()) {
        const entry = layers.get(url);
        if (entry && --entry.refs === 0) layers.delete(url);
      }
      pending.clear();
    },
  };
}
