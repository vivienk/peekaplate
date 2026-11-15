import avocado from './fixture-assets/avocado-toast.webp?inline';
import pancakes from './fixture-assets/berry-pancake-stack.webp?inline';
import eggs from './fixture-assets/classic-eggs-benedict.webp?inline';
import salad from './fixture-assets/garden-avocado-salad.webp?inline';
import harvest from './fixture-assets/harvest-power-bowl.webp?inline';
import metadata from './fixture-assets/portion-fixtures.json';
import salmon from './fixture-assets/salmon-poke-bowl.webp?inline';

const assets: Record<string, string> = {
  'avocado-toast.webp': avocado,
  'berry-pancake-stack.webp': pancakes,
  'classic-eggs-benedict.webp': eggs,
  'garden-avocado-salad.webp': salad,
  'harvest-power-bowl.webp': harvest,
  'salmon-poke-bowl.webp': salmon,
};
export function fixtureLayerUrl(url: string): string {
  if (!(import.meta.env.DEV || import.meta.env.VITE_PORTION_DEMO))
    throw new Error('Preview disabled');
  const prefix = 'https://portion-fixtures.invalid/';
  if (!url.startsWith(prefix)) throw new Error('Unknown preview asset');
  const name = url.slice(prefix.length);
  if (name === 'background.svg') return `data:image/svg+xml;base64,${btoa(metadata.background)}`;
  const asset = assets[name];
  if (!asset) throw new Error('Unknown preview asset');
  return asset;
}
