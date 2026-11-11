import background from './fixture-assets/portion-demo/background.webp?url';
import foreground from './fixture-assets/portion-demo/dish.webp?url';
import layers from './fixture-assets/portion-demo/layers.json';
import photo from './fixture-assets/portion-demo/photo.jpg?url';

// This module is dynamically imported behind DEV guards. Never a publication source.
export function demoLayerUrl(url: string): string {
  if (url === 'https://portion-demo.invalid/background.webp') return background;
  if (url === 'https://portion-demo.invalid/dish.webp') return foreground;
  throw new Error('Unknown demo layer');
}

export { layers, photo };
