import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadOwnerRestaurant } from './restaurant';

const bytes = new Uint8Array([1, 2, 3, 4]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const venue = '11111111-1111-4111-8111-111111111111';
const profile = {
  version: 1,
  details: {
    name: 'Saved owner name',
    city: 'Private city',
    street: 'Private street',
    line2: '',
    phone: '1234567890',
    email: '',
  },
  logo: { sha256, sizeBytes: 45, width: 80, height: 20 },
};
describe('Screen 5 to public bundle', () => {
  it('copies only saved public branding and exact hash-verified logo bytes', async () => {
    const image = new Uint8Array(45).fill(7);
    const hash = createHash('sha256').update(image).digest('hex');
    const send = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ profile: { ...profile, logo: { ...profile.logo, sha256: hash } } }),
      )
      .mockResolvedValueOnce(new Response(image));
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
    expect(result.restaurant.name).toBe(profile.details.name);
    expect(JSON.stringify(result)).not.toContain('Private');
    expect(send.mock.calls[1]?.[1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
  });
  it('refuses changed, missing, oversized and truncated owner image bytes', async () => {
    for (const response of [
      new Response(bytes),
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
    const send = vi.fn().mockResolvedValue(Response.json({ profile: { ...profile, logo: null } }));
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
