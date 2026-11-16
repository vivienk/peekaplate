import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  parseRestaurantLogo,
  replayRestaurantProfile,
  saveRestaurantProfile,
} from './restaurant-profile';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAJElEQVR4nO3MMQEAAAgDoEU0ju01hIcPBCABADiarrkeAEA+LbVgAsefyYE+AAAAAElFTkSuQmCC';
const details = {
  name: 'Synthetic Bistro',
  city: 'Test city',
  street: 'Test street',
  line2: '',
  phone: '1234567890',
  email: '',
};
describe('restaurant profile', () => {
  it('bounds and validates normalized PNG bytes', () => {
    expect(parseRestaurantLogo(png).logo).toMatchObject({ width: 32, height: 32 });
    for (const bad of [
      '',
      png.slice(0, -8),
      png + ' ',
      Buffer.from('not an image').toString('base64'),
    ])
      expect(() => parseRestaurantLogo(bad)).toThrow();
    const oversized = Buffer.from(png, 'base64');
    oversized.writeUInt32BE(4096, 16);
    expect(() => parseRestaurantLogo(oversized.toString('base64'))).toThrow();
  });
  it('rejects missing membership before storage or writes', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const storage = { put: vi.fn() };
    await expect(
      saveRestaurantProfile(
        { query } as unknown as Client,
        crypto.randomUUID(),
        crypto.randomUUID(),
        { commandId: crypto.randomUUID(), expectedVersion: 0, details, logoPngBase64: png },
        storage,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(storage.put).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT'))).toBe(false);
  });
  it('replays only contiguous profile events without side effects', () => {
    const event = {
      tenant_id: crypto.randomUUID(),
      stream_id: crypto.randomUUID(),
      version: 1,
      schema_version: 1,
      event_type: 'restaurant.profile.saved',
      payload: { version: 1, details, logo: null },
    };
    expect(replayRestaurantProfile([event])?.details).toEqual(details);
    expect(() => replayRestaurantProfile([event, event])).toThrow();
    expect(() => replayRestaurantProfile([{ ...event, event_type: 'other' }])).toThrow();
  });
});
