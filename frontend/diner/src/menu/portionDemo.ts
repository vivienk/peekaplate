import { type PublicPortion, PublicPortionSchema } from '@peekaplate/contracts';
import background from './fixture-assets/portion-demo/background.webp?inline';
import cutout from './fixture-assets/portion-demo/cutout.png?inline';
import demo from './fixture-assets/portion-demo/demo.json';
import foreground from './fixture-assets/portion-demo/dish.webp?inline';
import photo from './fixture-assets/portion-demo/photo.jpg?url';
import generated from './fixture-assets/portion-demo/presentation.png?inline';
import reviewImages from './fixture-assets/portion-demo/review-images.json';

// This module is dynamically imported behind DEV guards. Never a publication source.
export async function demoLayerUrl(url: string, signal: AbortSignal): Promise<string> {
  const state = new URLSearchParams(location.search).get('previewState');
  if (state === 'loading') {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, 3000);
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  if (state === 'photo' || state === 'failed') throw new Error('Demo layer unavailable');
  if (url === 'https://portion-demo.invalid/background.webp') return background;
  if (url === 'https://portion-demo.invalid/dish.webp') return foreground;
  if (url === 'https://portion-demo.invalid/cutout.png') return cutout;
  if (url === 'https://portion-demo.invalid/presentation.png') return generated;
  throw new Error('Unknown demo layer');
}

if (
  demo.review_manifest.review.status !== 'needs_review' ||
  demo.review_manifest.publication.eligible !== false ||
  demo.portion.dish_id !== demo.review_manifest.dish.dish_id ||
  demo.portion.dish_revision_id !== demo.review_manifest.dish.revision_id
) {
  throw new Error('Invalid local review fixture identity or publication boundary');
}

const portion = PublicPortionSchema.parse(demo.portion);

export { photo, portion };

// Private local review images retain their exact PNG bytes. They are intentionally NOT
// public delivery manifests: the 180 KB production contract stays unchanged.
export function originalReviewPortion(
  base: PublicPortion,
  visual: 'cutout' | 'generated',
): PublicPortion | null {
  if (
    !(import.meta.env.DEV || import.meta.env.VITE_PORTION_DEMO) ||
    base.dish_id !== reviewImages.dish.dish_id ||
    base.dish_revision_id !== reviewImages.dish.revision_id ||
    !base.layers.every((layer) => layer.url.startsWith('https://portion-demo.invalid/'))
  )
    return null;
  if (
    reviewImages.review.status !== 'needs_review' ||
    reviewImages.publication.eligible !== false
  ) {
    throw new Error('Invalid local review boundary');
  }
  const asset = reviewImages.variants[visual];
  if (
    asset.size_bytes > 10_000_000 ||
    asset.size_bytes <= 0 ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    asset.width <= 0 ||
    asset.height <= 0 ||
    Math.max(asset.width, asset.height) > 2048
  ) {
    throw new Error('Invalid local review image');
  }
  return {
    schema_version: 1,
    dish_id: base.dish_id,
    dish_revision_id: base.dish_revision_id,
    width: asset.width,
    height: asset.height,
    motion: base.motion,
    layers: [
      {
        url: `https://portion-demo.invalid/${asset.filename}`,
        sha256: asset.sha256,
        size_bytes: asset.size_bytes,
        depth: 1,
      },
    ],
  };
}
