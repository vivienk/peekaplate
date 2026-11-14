import { z } from 'zod';
import { PublicPortionSchema } from './portion';

export const DiningItemSchema = z
  .strictObject({
    id: z.uuid(),
    revisionId: z.uuid(),
    name: z.string().min(1).max(160),
    description: z.string().max(4000),
    unitCents: z.number().int().min(0).max(1000000),
    image: z
      .url()
      .refine((s) => s.startsWith('https://'))
      .nullable(),
    portion: PublicPortionSchema.optional(),
  })
  .refine(
    (item) =>
      !item.portion ||
      (item.portion.dish_id === item.id && item.portion.dish_revision_id === item.revisionId),
    'Portion must belong to this dish revision',
  );
export const DiningMenuSchema = z
  .strictObject({
    locationId: z.string().regex(/^[a-z0-9-]{1,80}$/),
    venueId: z.uuid(),
    menuId: z.uuid(),
    publicationId: z.uuid(),
    availabilityVersion: z.number().int().positive().max(2147483647),
    currency: z.literal('USD'),
    acceptingOrders: z.boolean(),
    items: z.array(DiningItemSchema).max(500),
  })
  .refine((m) => new Set(m.items.map((i) => i.id)).size === m.items.length);
export const OrderRequestSchema = z
  .strictObject({
    commandId: z.uuid(),
    publicationId: z.uuid(),
    availabilityVersion: z.number().int().positive().max(2147483647),
    fulfillment: z.literal('pickup'),
    lines: z
      .array(
        z.strictObject({
          dishId: z.uuid(),
          revisionId: z.uuid(),
          quantity: z.number().int().min(1).max(20),
        }),
      )
      .min(1)
      .max(20),
  })
  .refine((r) => new Set(r.lines.map((i) => i.dishId)).size === r.lines.length);
export const OrderReceiptSchema = z.strictObject({
  orderId: z.uuid(),
  locationId: z.string(),
  status: z.enum(['submitted', 'accepted', 'declined']),
  paymentStatus: z.literal('unpaid'),
  fulfillment: z.literal('pickup'),
  currency: z.literal('USD'),
  subtotalCents: z.number().int().min(0),
  createdAt: z.iso.datetime(),
});
export type DiningMenu = z.infer<typeof DiningMenuSchema>;
export type OrderRequest = z.infer<typeof OrderRequestSchema>;
export type OrderReceipt = z.infer<typeof OrderReceiptSchema>;

export const OrderSubmittedPayloadSchema = OrderReceiptSchema.extend({
  publicationId: z.uuid(),
  availabilityVersion: z.number().int().positive().max(2147483647),
  lines: z
    .array(
      z.strictObject({
        dishId: z.uuid(),
        revisionId: z.uuid(),
        quantity: z.number().int().min(1).max(20),
        name: z.string().min(1).max(160),
        unitCents: z.number().int().min(0).max(1000000),
      }),
    )
    .min(1)
    .max(20),
}).refine(
  (p) =>
    p.status === 'submitted' &&
    p.subtotalCents === p.lines.reduce((s, l) => s + l.quantity * l.unitCents, 0) &&
    new Set(p.lines.map((l) => l.dishId)).size === p.lines.length,
);
