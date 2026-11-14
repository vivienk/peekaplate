import {
  type DiningMenu,
  DiningMenuSchema,
  OrderReceiptSchema,
  type OrderRequest,
} from '@peekaplate/contracts';
export function createDiningCart() {
  let menu: DiningMenu | undefined;
  let pending: OrderRequest | undefined;
  const quantities = new Map<string, number>();
  return {
    setMenu(next: DiningMenu) {
      menu = DiningMenuSchema.parse(next);
      quantities.clear();
      pending = undefined;
    },
    set(id: string, quantity: number) {
      if (!menu?.items.some((item) => item.id === id)) throw new Error('Unknown dish');
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 20)
        throw new Error('Invalid quantity');
      if (!quantities.has(id) && quantities.size >= 20 && quantity) throw new Error('Cart is full');
      if (quantity) quantities.set(id, quantity);
      else quantities.delete(id);
      pending = undefined;
    },
    quantity: (id: string) => quantities.get(id) ?? 0,
    lines: () =>
      [...quantities].map(([id, quantity]) => ({
        item: menu!.items.find((i) => i.id === id)!,
        quantity,
      })),
    request() {
      if (!menu || !quantities.size || !menu.acceptingOrders) throw new Error('Orders unavailable');
      pending ??= {
        commandId: crypto.randomUUID(),
        publicationId: menu.publicationId,
        fulfillment: 'pickup',
        lines: [...quantities].map(([id, quantity]) => ({
          dishId: id,
          revisionId: menu!.items.find((i) => i.id === id)!.revisionId,
          quantity,
        })),
      };
      return pending;
    },
    async submit(endpoint: string, send: typeof fetch = fetch) {
      const body = this.request();
      const response = await send(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? 'The menu changed. Reload the menu before ordering.'
            : 'Order not confirmed. Retry with the same cart.',
        );
      const receipt = OrderReceiptSchema.parse(await response.json());
      if (receipt.locationId !== menu!.locationId || receipt.status !== 'submitted')
        throw new Error('Order receipt did not match. Retry without changing the cart.');
      quantities.clear();
      pending = undefined;
      return receipt;
    },
  };
}
