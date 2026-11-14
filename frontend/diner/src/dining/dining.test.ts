import type { DiningMenu } from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import { createDiningCart } from './cart';
import { shouldOpenDining } from './entry';
import locations from './locations.json';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const menu: DiningMenu = {
  locationId: 'noka-oakland',
  venueId: id(1),
  menuId: id(2),
  publicationId: id(3),
  availabilityVersion: 1,
  currency: 'USD',
  acceptingOrders: true,
  items: [
    {
      id: id(4),
      revisionId: id(5),
      name: 'Test dish',
      description: 'Synthetic test only',
      unitCents: 2100,
      image: null,
    },
  ],
};
describe('Quest dining routing and directory', () => {
  it('only replaces opted-in home, preserves phone and direct menu links', () => {
    expect(shouldOpenDining('/', '', 'OculusBrowser', true)).toBe(true);
    expect(shouldOpenDining('/', '', 'iPhone', true)).toBe(false);
    expect(shouldOpenDining('/', '', 'OculusBrowser', false)).toBe(false);
    expect(shouldOpenDining('/', '?experience=menu', 'OculusBrowser', true)).toBe(false);
    expect(shouldOpenDining('/venues/a/menus/b', '?experience=quest', 'OculusBrowser', true)).toBe(
      false,
    );
    expect(shouldOpenDining('/', '?experience=quest', 'Chrome', true)).toBe(true);
  });
  it('has distinct location identities and sourced coordinates for the three named brands', () => {
    expect(locations).toHaveLength(11);
    expect(new Set(locations.map((l) => l.id)).size).toBe(11);
    expect(new Set(locations.map((l) => l.brand)).size).toBe(3);
    for (const l of locations) {
      expect(l.latitude).toBeGreaterThan(30);
      expect(l.longitude).toBeLessThan(-110);
      expect(l.website).toMatch(/^https:/);
    }
  });
});
describe('unpaid cart', () => {
  it('retains the command id after a failed submission, clears only on matching server receipt', async () => {
    const cart = createDiningCart();
    cart.setMenu(menu);
    cart.set(id(4), 2);
    const first = cart.request();
    await expect(
      cart.submit('/orders', async () => new Response('', { status: 503 })),
    ).rejects.toThrow();
    expect(cart.request().commandId).toBe(first.commandId);
    expect(cart.lines()).toHaveLength(1);
    const receipt = {
      orderId: id(9),
      locationId: 'noka-oakland',
      status: 'submitted',
      paymentStatus: 'unpaid',
      fulfillment: 'pickup',
      currency: 'USD',
      subtotalCents: 4200,
      createdAt: new Date().toISOString(),
    };
    await cart.submit('/orders', async () => Response.json(receipt));
    expect(cart.lines()).toHaveLength(0);
  });
  it('rejects false or mismatched confirmations and keeps the cart', async () => {
    const cart = createDiningCart();
    cart.setMenu(menu);
    cart.set(id(4), 1);
    await expect(cart.submit('/orders', async () => Response.json({ ok: true }))).rejects.toThrow();
    expect(cart.lines()).toHaveLength(1);
  });
  it('does not mix restaurant carts, stale identities or non-integer quantities', () => {
    const cart = createDiningCart();
    cart.setMenu(menu);
    expect(() => cart.set(id(99), 1)).toThrow();
    expect(() => cart.set(id(4), 1.5)).toThrow();
    cart.set(id(4), 1);
    const command = cart.request().commandId;
    cart.set(id(4), 2);
    expect(cart.request().commandId).not.toBe(command);
    cart.setMenu({ ...menu, locationId: 'son-garden-menlo-park' });
    expect(cart.lines()).toHaveLength(0);
  });
});
