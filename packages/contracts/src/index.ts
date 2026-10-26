import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const HealthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  service: z.literal('peekaplate-api'),
  stage: z.literal('foundation'),
});

// Initial dish-level contract. Broader event types require their own reviewed payload schemas.
export const DishIntentEventSchema = z
  .strictObject({
    eventId: z.uuid(),
    schemaVersion: z.literal(1),
    sessionId: z.uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    eventType: z.enum(['dish_open', 'portion_compare']),
    occurredAt: z.iso.datetime(),
    publicationHash: hash,
    dishRevisionHash: hash,
    displayedTier: z.enum(['T0', 'T1', 'T2']),
    rendererVersion: z.string().min(1).max(64).nullable(),
    manifestHash: hash.nullable(),
    availabilityVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    experimentAssignment: z
      .strictObject({
        experimentId: z.uuid(),
        blockId: z.string().min(1).max(64),
        arm: z.string().min(1).max(32),
      })
      .nullable(),
  })
  .superRefine((event, ctx) => {
    if (event.displayedTier !== 'T0' && (!event.rendererVersion || !event.manifestHash)) {
      ctx.addIssue({
        code: 'custom',
        path: ['displayedTier'],
        message: 'Enhanced exposures require renderer and manifest versions',
      });
    }
    if (event.displayedTier === 'T0' && event.rendererVersion !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['rendererVersion'],
        message: 'Photo exposures have no active renderer',
      });
    }
    if (event.displayedTier === 'T0' && event.manifestHash !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['manifestHash'],
        message: 'Photo exposures have no enhanced manifest',
      });
    }
  });

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type DishIntentEvent = z.infer<typeof DishIntentEventSchema>;

const uuid = z.uuid().transform((value) => value.toLowerCase());
const postgresText = z
  .string()
  .refine((value) => !value.includes('\u0000'), 'NUL is not supported');

export const DishRevisionScopeSchema = z.strictObject({ venueId: uuid, dishId: uuid });

export const CreateDishRevisionSchema = z.strictObject({
  commandId: uuid,
  expectedVersion: z.number().int().nonnegative().max(2_147_483_646),
  name: postgresText.trim().min(1).max(160),
  description: postgresText.trim().max(4000),
});

export const DishRevisionSchema = z.strictObject({
  dishId: uuid,
  revisionId: uuid,
  version: z.number().int().positive().max(2_147_483_647),
  name: postgresText.min(1).max(160),
  description: postgresText.max(4000),
});

export type CreateDishRevision = z.infer<typeof CreateDishRevisionSchema>;
export type DishRevision = z.infer<typeof DishRevisionSchema>;

export const TeamAnalyticsQuerySchema = z
  .strictObject({
    from: z.iso.datetime(),
    until: z.iso.datetime(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine(({ from, until }) => {
    const duration = Date.parse(until) - Date.parse(from);
    return duration > 0 && duration <= 7 * 24 * 60 * 60 * 1000;
  }, 'Use a positive window of at most seven days');

const analyticsEventName = z.enum(['app_shell_viewed', 'dish_open', 'portion_compare']);
const analyticsSurface = z.enum(['diner', 'console']);
const analyticsEvent = z.strictObject({
  id: z.string().min(1).max(200),
  event: analyticsEventName,
  timestamp: z.iso.datetime({ offset: true }),
  surface: analyticsSurface,
  properties: z.strictObject({
    schema_version: z.literal(1).optional(),
    event_id: z.uuid().optional(),
    publication_hash: hash.optional(),
    dish_revision_hash: hash.optional(),
    displayed_tier: z.enum(['T0', 'T1', 'T2']).optional(),
    manifest_hash: hash.optional(),
    availability_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }),
});
export const TeamAnalyticsResponseSchema = z.strictObject({
  source: z.literal('posthog_supabase_export'),
  environment: z.literal('staging'),
  projectId: z.number().int().positive(),
  from: z.iso.datetime({ offset: true }),
  until: z.iso.datetime({ offset: true }),
  computedAt: z.iso.datetime({ offset: true }),
  freshness: z.literal('hourly_export_delay'),
  kind: z.enum(['events', 'summary']),
  events: z.array(analyticsEvent).max(100),
  counts: z
    .array(
      z.strictObject({
        event: analyticsEventName,
        surface: analyticsSurface,
        count: z.number().int().nonnegative(),
      }),
    )
    .max(6),
  truncated: z.boolean(),
});
export type TeamAnalyticsQuery = z.infer<typeof TeamAnalyticsQuerySchema>;
export type TeamAnalyticsResponse = z.infer<typeof TeamAnalyticsResponseSchema>;

// Observation Queue contract (ADR 0015 / S3-DATA-01 -> S3-DATA-02).
// Internal queue message envelope format emitted by the observation producer onto Cloudflare Queues.
export const ObservationTypeSchema = z.enum([
  'menu_viewed',
  'dish_viewed',
  'dish_detail_opened',
  'dish_detail_closed',
  'dish_activity_checkpoint',
  'dish_compared',
  'dish_saved',
  'dish_unsaved',
  'shortlist_viewed',
]);

export const ObservationV2QueueEnvelopeSchema = z.strictObject({
  kind: z.literal('observation.v2').default('observation.v2'),
  tenantId: uuid,
  eventId: uuid,
  authorizedPublicationId: uuid,
  sessionId: z.string().min(1).max(200).optional(),
  schemaVersion: z.literal('observation.v2'),
  occurredAt: z.iso.datetime({ offset: true }),
  firstReceivedAt: z.iso.datetime({ offset: true }).optional(),
  type: ObservationTypeSchema,
  producerId: z.string().min(1).max(200).optional(),
  localSequence: z.number().int().nonnegative().optional(),
  payload: z.record(z.string(), z.unknown()),
});

const conflictCopySchema = z.strictObject({
  validation: z.enum(['valid', 'invalid']),
  canonicalChecksum: hash,
  event: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ObservationConflictV1QueueEnvelopeSchema = z.strictObject({
  kind: z.literal('observation_conflict.v1'),
  tenantId: uuid,
  eventId: uuid,
  authorizedPublicationId: uuid,
  sessionId: z.string().min(1).max(200).optional(),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  firstReceivedAt: z.iso.datetime({ offset: true }).optional(),
  receivedAt: z.iso.datetime({ offset: true }).optional(),
  type: z.string().min(1).max(64).optional(),
  incomingChecksum: hash.optional(),
  conflictReason: z.string().min(1).max(200).optional(),
  reasonCode: z.string().min(1).max(200).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  boundedMetadata: z.record(z.string(), z.unknown()).optional(),
  copies: z.array(conflictCopySchema).min(1).max(25).optional(),
});

export const ObservationQueueEnvelopeSchema = z.union([
  ObservationV2QueueEnvelopeSchema,
  ObservationConflictV1QueueEnvelopeSchema,
]);

export type ObservationType = z.infer<typeof ObservationTypeSchema>;
export type ObservationV2QueueEnvelope = z.infer<typeof ObservationV2QueueEnvelopeSchema>;
export type ObservationConflictV1QueueEnvelope = z.infer<
  typeof ObservationConflictV1QueueEnvelopeSchema
>;
export type ObservationQueueEnvelope = z.infer<typeof ObservationQueueEnvelopeSchema>;
