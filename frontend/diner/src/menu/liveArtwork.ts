import { ArtworkLabelSchema, artworkLabel, PublicArtworkSchema } from '@peekaplate/contracts';
import { ingredientIcon } from './icons';
import type { CompleteDish } from './types';

export type LiveArtworkOptions = { apiBase: string; venueId: string; fetcher?: typeof fetch };

// Decoration only: callers supply already-published ingredient names. Never
// mutate dishes, facts, tracking identity, or the verified publication bundle.
export function mountLiveArtwork(
  container: HTMLElement,
  dish: CompleteDish,
  options: LiveArtworkOptions,
): () => void {
  const base = options.apiBase.replace(/\/+$/, '');
  const endpoint = `${base}/public/venues/${encodeURIComponent(options.venueId)}/ingredient-icons`;
  const labels = [
    ...new Set(
      dish.ingredients
        .map((i) => artworkLabel(i.name))
        .filter((n) => ArtworkLabelSchema.safeParse(n).success),
    ),
  ];
  const fetcher = options.fetcher ?? fetch;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const apply = (icons: Map<string, string>) => {
    container.querySelectorAll<HTMLElement>('.pp-ingredient').forEach((tile, index) => {
      const ingredient = dish.ingredients[index];
      if (!ingredient) return;
      const fallback = ingredientIcon(ingredient.name);
      const url = icons.get(artworkLabel(ingredient.name)) ?? fallback;
      const old = tile.querySelector<HTMLImageElement>('img.pp-ingredient__icon');
      if (old?.getAttribute('src') === url) return;
      old?.remove();
      if (!url) return;
      const img = document.createElement('img');
      img.className = 'pp-ingredient__icon';
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      img.width = 36;
      img.height = 36;
      img.addEventListener('error', () => {
        if (fallback && img.getAttribute('src') !== fallback) img.src = fallback;
        else img.remove();
      });
      img.src = url;
      tile.prepend(img);
    });
  };
  const refresh = async () => {
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 8000);
    const icons = new Map<string, string>();
    try {
      // Bound each request, including unusually large approved ingredient lists.
      for (let start = 0; start < labels.length; start += 20) {
        const batch = labels.slice(start, start + 20);
        const query = new URLSearchParams(batch.map((label) => ['label', label]));
        const response = await fetcher(`${endpoint}?${query}`, {
          credentials: 'omit',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Artwork unavailable');
        const text = await response.text();
        if (text.length > 32_768) throw new Error('Artwork response too large');
        const result = PublicArtworkSchema.parse(JSON.parse(text));
        for (const art of result.icons) {
          if (!batch.includes(art.label) || icons.has(art.label))
            throw new Error('Artwork identity mismatch');
          icons.set(
            art.label,
            `${endpoint}/image?${new URLSearchParams({ label: art.label, sha256: art.sha256! })}`,
          );
        }
      }
      if (!stopped) apply(icons);
    } catch {
      // Do not keep a possibly revoked image when current approval is unknown.
      if (!stopped) apply(new Map());
    } finally {
      clearTimeout(timeout);
      if (!stopped) timer = setTimeout(refresh, 30_000);
    }
  };
  if (labels.length) void refresh();
  return () => {
    stopped = true;
    controller?.abort();
    clearTimeout(timer);
  };
}
