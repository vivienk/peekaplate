import { afterEach, expect, it, vi } from 'vitest';
import { uploadedLayer, uploadPortion } from './portionUpload';

const dish = '11111111-1111-4111-8111-111111111111';
const revision = '22222222-2222-4222-8222-222222222222';
const prefix = `https://portion-ingestion.invalid/portion_${'a'.repeat(32)}/`;
const result = () => ({
  status: 'ready',
  review_status: 'needs_review',
  publication_eligible: false,
  portion: {
    schema_version: 1,
    dish_id: dish,
    dish_revision_id: revision,
    width: 80,
    height: 60,
    motion: { max_yaw_degrees: 3, max_pitch_degrees: 3 },
    layers: ['background.svg', 'dish.webp'].map((name, depth) => ({
      url: prefix + name,
      depth,
      size_bytes: 1,
      sha256: 'a'.repeat(64),
    })),
  },
  layers: { [prefix + 'background.svg']: 'AA==', [prefix + 'dish.webp']: 'AA==' },
});
const file = new File(['test-photo'], 'dish.jpg', { type: 'image/jpeg' });
const upload = () => uploadPortion(file, dish, revision, new AbortController().signal);
afterEach(() => vi.unstubAllGlobals());
it('keeps repeated upload layers alive until both consumers release them', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(result())),
  );
  const first = await upload();
  const second = await upload();
  first.dispose();
  first.dispose();
  expect(uploadedLayer(prefix + 'dish.webp')).toBe('AA==');
  second.dispose();
  expect(() => uploadedLayer(prefix + 'dish.webp')).toThrow();
});
it('rejects cross-dish results and retains a declared photo fallback', async () => {
  const bad = result();
  bad.portion.dish_id = revision;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(bad)),
  );
  await expect(upload()).rejects.toThrow('another dish');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        status: 'fallback_retained',
        portion: null,
        review_status: 'needs_review',
        publication_eligible: false,
      }),
    ),
  );
  expect((await upload()).portion).toBeNull();
});
it('does not upload oversized input or expose service errors', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    uploadPortion(
      new File([new Uint8Array(12_000_001)], 'large.jpg'),
      dish,
      revision,
      new AbortController().signal,
    ),
  ).rejects.toThrow('12 MB');
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValue(new Response('', { status: 503 }));
  await expect(upload()).rejects.toThrow('local preview service');
});

it('forwards owner dimensions and rejects nonphysical input before uploading', async () => {
  const fetch = vi.fn(async () => Response.json(result()));
  vi.stubGlobal('fetch', fetch);
  const uploaded = await uploadPortion(file, dish, revision, new AbortController().signal, 280);
  expect(fetch).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ headers: expect.objectContaining({ 'X-Serving-Width-Mm': '280' }) }),
  );
  uploaded.dispose();
  await expect(
    uploadPortion(file, dish, revision, new AbortController().signal, 0),
  ).rejects.toThrow('Serving width');
});
