import { PublicPortionSchema } from '@peekaplate/contracts';
import background from './fixture-assets/portion-demo/background.webp?url';
import demo from './fixture-assets/portion-demo/demo.json';
import foreground from './fixture-assets/portion-demo/dish.webp?url';
import photo from './fixture-assets/portion-demo/photo.jpg?url';

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
  if (state === 'fallback' || state === 'failed') throw new Error('Demo layer unavailable');
  if (url === 'https://portion-demo.invalid/background.webp') return background;
  if (url === 'https://portion-demo.invalid/dish.webp') return foreground;
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
