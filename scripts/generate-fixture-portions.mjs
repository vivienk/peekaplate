// Reproducible preview manifests. Preserve PR147 WebP bytes and transparency exactly.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../frontend/diner/src/menu/fixture-assets/', import.meta.url);
const names = [
  'avocado-toast',
  'harvest-power-bowl',
  'classic-eggs-benedict',
  'garden-avocado-salad',
  'berry-pancake-stack',
  'salmon-poke-bowl',
];
const background = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"></svg>';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const prefix = 'https://portion-fixtures.invalid/';
const entries = names.map((name, index) => {
  const bytes = readFileSync(new URL(`${name}.webp`, root));
  if (
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 16) !== 'WEBPVP8X' ||
    !(bytes[20] & 0x10) ||
    bytes.readUIntLE(24, 3) + 1 !== 640 ||
    bytes.readUIntLE(27, 3) + 1 !== 640
  ) {
    throw new Error(`Expected transparent 640px WebP: ${name}`);
  }
  if (bytes.length + Buffer.byteLength(background) > 180000)
    throw new Error(`Asset budget: ${name}`);
  const suffix = String(index + 1).padStart(12, '0');
  return {
    schema_version: 1,
    dish_id: `a1000000-0000-4000-8000-${suffix}`,
    dish_revision_id: `a2000000-0000-4000-8000-${suffix}`,
    width: 640,
    height: 640,
    motion: { max_yaw_degrees: 3, max_pitch_degrees: 3 },
    layers: [
      {
        url: `${prefix}background.svg`,
        sha256: hash(background),
        size_bytes: Buffer.byteLength(background),
        depth: 0,
      },
      { url: `${prefix}${name}.webp`, sha256: hash(bytes), size_bytes: bytes.length, depth: 1 },
    ],
  };
});
const output =
  JSON.stringify(
    {
      source_pr: 147,
      source_commit: 'd8e186b450845f5f6035eb32ab1858d9c7a7a3ce',
      preview_only: true,
      background,
      entries,
    },
    null,
    2,
  ) + '\n';
const target = new URL('portion-fixtures.json', root);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('Fixture manifests are stale');
} else writeFileSync(target, output);
console.log(`Validated ${entries.length} dish-specific 2.5D fixtures: ${fileURLToPath(target)}`);
