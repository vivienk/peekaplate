import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadOwnerRestaurant } from './restaurant';

const bytes = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAJElEQVR4nO3MMQEAAAgDoEU0ju01hIcPBCABADiarrkeAEA+LbVgAsefyYE+AAAAAElFTkSuQmCC',
    'base64',
  ),
);
const venue = '11111111-1111-4111-8111-111111111111';
const profile = {
  version: 1,
  status: 'submitted',
  fields: {
    name: 'Saved owner name',
    city: 'Private city',
    street: 'Private street',
    line2: '',
    phone: '1234567890',
    email: '',
    photoId: '22222222-2222-4222-8222-222222222222',
  },
};
describe('Screen 5 to public bundle', () => {
  it('copies only saved public branding and exact hash-verified logo bytes', async () => {
    const image = bytes;
    const hash = createHash('sha256').update(image).digest('hex');
    const send = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ profile }))
      .mockResolvedValueOnce(
        new Response(image, {
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': String(image.length),
            'X-Content-SHA256': hash,
          },
        }),
      );
    const result = await loadOwnerRestaurant(
      'https://api.example.test',
      'test-token',
      venue,
      'https://assets.example.test',
      send,
    );
    expect(result.restaurant.logo?.url).toBe(
      `https://assets.example.test/restaurant-logos/${venue}/${hash}.png`,
    );
    expect(result.logoFile?.bytes).toEqual(image);
    expect(result.restaurant.logo).toMatchObject({ width: 32, height: 32 });
    expect(send.mock.calls[0]?.[0]).toBe(`https://api.example.test/venues/${venue}/profile`);
    expect(send.mock.calls[1]?.[0]).toBe(
      `https://api.example.test/venues/${venue}/profile/photos/${profile.fields.photoId}`,
    );
    expect(result.restaurant.name).toBe(profile.fields.name);
    expect(JSON.stringify(result)).not.toContain('Private');
    expect(send.mock.calls[1]?.[1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
  });
  it('refuses changed, missing, oversized and truncated owner image bytes', async () => {
    for (const response of [
      new Response(bytes, {
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(bytes.length),
          'X-Content-SHA256': 'a'.repeat(64),
        },
      }),
      new Response(new Uint8Array(46)),
      new Response(new Uint8Array(45)),
      new Response('', { status: 404 }),
    ]) {
      const send = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ profile }))
        .mockResolvedValueOnce(response);
      await expect(
        loadOwnerRestaurant(
          'https://api.example.test',
          'test-token',
          venue,
          'https://assets.example.test',
          send,
        ),
      ).rejects.toThrow();
    }
  });
  it('keeps absent logos absent', async () => {
    const send = vi
      .fn()
      .mockResolvedValue(
        Response.json({ profile: { ...profile, fields: { ...profile.fields, photoId: null } } }),
      );
    const result = await loadOwnerRestaurant(
      'https://api.example.test',
      'test-token',
      venue,
      'https://assets.example.test',
      send,
    );
    expect(result.restaurant.logo).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
