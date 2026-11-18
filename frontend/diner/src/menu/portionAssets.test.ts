import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { readLayer } from './portionAssets';

vi.mock('./portionUpload', () => ({ uploadedLayer: () => Buffer.from(bytes).toString('base64') }));

const bytes = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#eee"/></svg>',
);
const layer = {
  url: 'https://api.example.test/public/prepared-assets/venue/photo/immutable-hash',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  size_bytes: bytes.byteLength,
  depth: 0,
};
afterEach(() => vi.unstubAllGlobals());

it('retains SVG MIME for the existing local uploaded background too', async () => {
  const image = await readLayer(
    {
      ...layer,
      url: `https://portion-ingestion.invalid/portion_${'a'.repeat(32)}/background.svg`,
    },
    new AbortController().signal,
  );
  expect(image.type).toBe('image/svg+xml');
});

it('retains the SVG response MIME for verified bytes at an extensionless published URL', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(bytes, {
          headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' },
        }),
    ),
  );
  const image = await readLayer(layer, new AbortController().signal);
  expect(image.type).toBe('image/svg+xml');
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
});

it('does not pass an unrelated response MIME to image decoding', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(bytes, {
          headers: { 'Content-Type': 'text/html' },
        }),
    ),
  );
  expect((await readLayer(layer, new AbortController().signal)).type).toBe('');
});

it('rejects changed layer bytes before exposing a decodable image', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(bytes, {
          headers: { 'Content-Type': 'image/svg+xml' },
        }),
    ),
  );
  await expect(
    readLayer({ ...layer, sha256: 'a'.repeat(64) }, new AbortController().signal),
  ).rejects.toThrow('Layer hash mismatch');
  await expect(
    readLayer({ ...layer, size_bytes: bytes.byteLength - 1 }, new AbortController().signal),
  ).rejects.toThrow('Layer exceeds budget');
});
