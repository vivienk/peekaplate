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

export const VenueScopeSchema = z.strictObject({ venueId: uuid });
export const DishRevisionScopeSchema = z.strictObject({ venueId: uuid, dishId: uuid });
export const JobScopeSchema = z.strictObject({ venueId: uuid, jobId: uuid });
export const DraftScopeSchema = z.strictObject({ venueId: uuid, draftId: uuid });

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

// S3-VIS-04: Menu Source Discovery and Bounded Evidence Retrieval Contract
export const MAX_PASSAGE_CHARS = 2000;
export const MAX_PASSAGES = 10;
export const MAX_AGGREGATE_PASSAGE_CHARS = 16000;

export const SourceReferenceSchema = z.strictObject({
  source_id: z.string().min(1),
  segment_id: z.string().min(1),
  source_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  original_url: z.string().url().optional(),
  final_url: z.string().url().optional(),
  retrieved_at: z.iso.datetime({ offset: true }).optional(),
});

export const EvidencePassageSchema = z
  .strictObject({
    passage_id: z.string().min(1),
    source: SourceReferenceSchema,
    text: z.string().min(1).max(MAX_PASSAGE_CHARS),
    start_offset: z.number().int().min(0),
    end_offset: z.number().int().positive(),
    rank: z.number().int().min(1).max(MAX_PASSAGES),
    score: z.number().min(0).max(1).optional(),
  })
  .superRefine((passage, ctx) => {
    if (passage.start_offset >= passage.end_offset) {
      ctx.addIssue({
        code: 'custom',
        path: ['end_offset'],
        message: 'end_offset must be strictly greater than start_offset',
      });
    }
    if (passage.text.length !== passage.end_offset - passage.start_offset) {
      ctx.addIssue({
        code: 'custom',
        path: ['text'],
        message: 'text length must match end_offset - start_offset',
      });
    }
  });

export const BoundedRetrievalStatusSchema = z.enum(['success', 'no_result', 'ambiguous', 'failed']);

export const BoundedRetrievalResultSchema = z
  .strictObject({
    schema_version: z.literal(1),
    status: BoundedRetrievalStatusSchema,
    passages: z.array(EvidencePassageSchema).max(MAX_PASSAGES),
    warnings: z.array(z.string()),
  })
  .superRefine((result, ctx) => {
    const totalChars = result.passages.reduce((sum, p) => sum + p.text.length, 0);
    if (totalChars > MAX_AGGREGATE_PASSAGE_CHARS) {
      ctx.addIssue({
        code: 'custom',
        path: ['passages'],
        message: `Total passage context (${totalChars} chars) exceeds maximum aggregate limit of ${MAX_AGGREGATE_PASSAGE_CHARS}`,
      });
    }

    const seenIds = new Set<string>();
    for (let i = 0; i < result.passages.length; i++) {
      const passage = result.passages[i];
      if (!passage) continue;
      if (passage.rank !== i + 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['passages', i, 'rank'],
          message: `Passage rank at index ${i} must be sequential ${i + 1}, got ${passage.rank}`,
        });
      }
      if (seenIds.has(passage.passage_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['passages', i, 'passage_id'],
          message: `Duplicate passage_id: ${passage.passage_id}`,
        });
      }
      seenIds.add(passage.passage_id);
    }

    if (result.status === 'success' && result.passages.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['passages'],
        message: "Status 'success' requires at least one retrieved evidence passage",
      });
    }

    if (result.status === 'no_result' && result.passages.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['passages'],
        message: "Status 'no_result' must not contain passages",
      });
    }
  });

export const SourceInputSegmentSchema = z.strictObject({
  segment_id: z.string().min(1),
  text: z.string(),
  page_number: z.number().int().positive().optional(),
  method: z.enum(['text', 'html', 'pdf_native', 'ocr', 'ocr_space_engine3']).optional(),
  status: z.enum(['ready', 'skipped', 'failed']).optional(),
  error: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const SourceInputSchema = z.strictObject({
  source_id: z.string().min(1),
  kind: z.enum(['url', 'html', 'text', 'pdf', 'image', 'website']),
  location: z.string().min(1).optional(),
  content: z.string().optional(),
  segments: z.array(SourceInputSegmentSchema).optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  retrieved_at: z.iso.datetime({ offset: true }).optional(),
  size_bytes: z.number().int().positive().max(12_000_000).optional(),
  snapshot_base64: z.string().optional(),
});

export const RetrievalRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(500),
  venue_id: uuid.optional(),
  candidate_urls: z.array(z.string().url()).max(5).optional(),
  sources: z.array(SourceInputSchema).max(5).optional(),
  max_passages: z.number().int().min(1).max(MAX_PASSAGES).default(MAX_PASSAGES),
  max_context_chars: z
    .number()
    .int()
    .min(100)
    .max(MAX_AGGREGATE_PASSAGE_CHARS)
    .default(MAX_AGGREGATE_PASSAGE_CHARS),
});

export type SourceReference = z.infer<typeof SourceReferenceSchema>;
export type EvidencePassage = z.infer<typeof EvidencePassageSchema>;
export type BoundedRetrievalStatus = z.infer<typeof BoundedRetrievalStatusSchema>;
export type BoundedRetrievalResult = z.infer<typeof BoundedRetrievalResultSchema>;
export type SourceInputSegment = z.infer<typeof SourceInputSegmentSchema>;
export type SourceInput = z.infer<typeof SourceInputSchema>;
export type RetrievalRequestInput = z.input<typeof RetrievalRequestSchema>;
export type RetrievalRequest = z.infer<typeof RetrievalRequestSchema>;

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

// ============================================================================
// S3-VIS-01 / VIS-02: Menu Extraction & Structured Draft Ingestion Contracts
// ============================================================================

export const ExtractionSourceSpanSchema = z
  .strictObject({
    segment_id: z.string().min(1),
    start: z.number().int().min(0),
    end: z.number().int().positive(),
  })
  .superRefine((span, ctx) => {
    if (span.start >= span.end) {
      ctx.addIssue({
        code: 'custom',
        path: ['end'],
        message: 'end must be strictly greater than start',
      });
    }
  });

export const ExtractionDraftEvidenceSchema = z.strictObject({
  draft_id: z.string().min(1),
  draft_index: z.number().int().min(0),
  spans: z.array(ExtractionSourceSpanSchema).min(1),
});

export const ExtractionDishDraftSchema = z.strictObject({
  draft_id: z.string().min(1).optional(),
  candidate_id: z.string().min(1).optional(),
  draft_index: z.number().int().min(0).optional(),
  name: z
    .string()
    .trim()
    .min(1)
    .refine((val) => Array.from(val).length <= 160, 'name must be at most 160 code points'),
  description: z
    .string()
    .trim()
    .min(1)
    .refine((val) => Array.from(val).length <= 4000, 'description must be at most 4000 code points')
    .nullable()
    .default(null),
  category: z.string().trim().min(1).nullable().default(null),
  subcategory: z.string().trim().min(1).nullable().optional(),
  category_page_number: z.number().int().min(1).nullable().optional(),
  price_text: z
    .string()
    .trim()
    .min(1)
    .refine((val) => Array.from(val).length <= 160, 'price_text must be at most 160 code points')
    .nullable()
    .optional(),
  price_amount: z
    .union([
      z.string().regex(/^\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^\d+(\.\d+)?$/),
      z
        .number()
        .nonnegative()
        .transform((n) => n.toString()),
    ])
    .nullable()
    .default(null),
  price_currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .default(null),
  ingredients: z.array(z.string().trim().min(1)).nullable().default(null),
  source_id: z.string().min(1),
  source_text: z.string().min(1),
  image_id: z.string().trim().min(1).nullable().default(null),
  review_warnings: z.array(z.string().trim().min(1)).default([]),
  status: z.literal('needs_review').default('needs_review'),
});

export const ExtractionSourceRecordSchema = z.strictObject({
  source_id: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.enum(['pdf', 'image', 'website', 'text']),
  location: z.string().min(1),
  retrieved_at: z.iso.datetime({ offset: true }),
  size_bytes: z.number().int().min(1).max(12_000_000),
  snapshot_base64: z.string().min(1),
});

export const ExtractionSourceSegmentSchema = z.strictObject({
  segment_id: z.string().min(1),
  page_number: z.number().int().min(1).nullable().default(null),
  method: z.enum(['text', 'html', 'pdf_native', 'ocr_space_engine3']),
  status: z.enum(['ready', 'skipped', 'failed']).default('ready'),
  text: z.string().default(''),
  native_text: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  warnings: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const ExtractionCaptureCandidateSchema = z.strictObject({
  asset_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  filename: z.string().min(1),
  restaurant_id: z.string().min(1),
  captured_at: z.iso.datetime({ offset: true }).nullable().default(null),
  uploaded_at: z.iso.datetime({ offset: true }),
  capture_evidence: z.string().min(1),
  rights_confirmed: z.literal(true),
  origin: z.literal('restaurant_capture'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  review_status: z.literal('needs_review').default('needs_review'),
  warnings: z.array(z.string()).default([]),
});

export const ExtractionCaptureRequestSchema = z.strictObject({
  draft_id: z.string().min(1),
  dish_name: z.string().min(1),
  status: z.enum(['capture_missing', 'needs_review']).default('capture_missing'),
  candidates: z.array(ExtractionCaptureCandidateSchema).default([]),
});

export const MenuExtractionResultSchema = z.strictObject({
  schema_version: z.union([z.literal(1), z.literal(2)]),
  pipeline_version: z.union([z.literal('2'), z.literal('3')]),
  status: z.enum(['complete', 'incomplete', 'failed']),
  source: ExtractionSourceRecordSchema.nullable().default(null),
  started_at: z.iso.datetime({ offset: true }),
  finished_at: z.iso.datetime({ offset: true }).nullable().default(null),
  extraction_mode: z.enum(['local', 'layout', 'ai']).default('layout'),
  extraction_model: z.string().nullable().default(null),
  ocr_engine: z.literal(3).default(3),
  library_versions: z.record(z.string(), z.string()).default({}),
  configuration: z.record(z.string(), z.unknown()).default({}),
  segments: z.array(ExtractionSourceSegmentSchema).default([]),
  drafts: z.array(ExtractionDishDraftSchema).default([]),
  evidence: z.array(ExtractionDraftEvidenceSchema).default([]),
  capture_requests: z.array(ExtractionCaptureRequestSchema).default([]),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
});

export const StructuredDishDraftSchema = z.strictObject({
  draft_id: z.string().min(1),
  candidate_id: z.string().min(1).nullable().optional(),
  draft_index: z.number().int().min(0),
  name: z
    .string()
    .trim()
    .min(1)
    .refine((val) => Array.from(val).length <= 160, 'name must be at most 160 code points'),
  description: z
    .string()
    .trim()
    .min(1)
    .refine((val) => Array.from(val).length <= 4000, 'description must be at most 4000 code points')
    .nullable(),
  category: z.string().trim().min(1).nullable(),
  subcategory: z.string().trim().min(1).nullable().optional(),
  category_page_number: z.number().int().min(1).nullable().optional(),
  price_text: z
    .string()
    .trim()
    .min(1)
    .refine((val) => Array.from(val).length <= 160, 'price_text must be at most 160 code points')
    .nullable()
    .optional(),
  price_amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .nullable(),
  price_currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  ingredients: z.array(z.string().trim().min(1)).nullable(),
  source_id: z.string().min(1),
  source_text: z.string().min(1),
  image_id: z.string().trim().min(1).nullable(),
  code_point_spans: z.array(ExtractionSourceSpanSchema).min(1),
  utf16_spans: z.array(ExtractionSourceSpanSchema).min(1),
  review_warnings: z.array(z.string()),
  status: z.literal('needs_review'),
});

export type ExtractionSourceSpan = z.infer<typeof ExtractionSourceSpanSchema>;
export type ExtractionDraftEvidence = z.infer<typeof ExtractionDraftEvidenceSchema>;
export type ExtractionDishDraft = z.infer<typeof ExtractionDishDraftSchema>;
export type ExtractionSourceRecord = z.infer<typeof ExtractionSourceRecordSchema>;
export type ExtractionSourceSegment = z.infer<typeof ExtractionSourceSegmentSchema>;
export type ExtractionCaptureCandidate = z.infer<typeof ExtractionCaptureCandidateSchema>;
export type ExtractionCaptureRequest = z.infer<typeof ExtractionCaptureRequestSchema>;
export type MenuExtractionResult = z.infer<typeof MenuExtractionResultSchema>;
export type StructuredDishDraft = z.infer<typeof StructuredDishDraftSchema>;

export const SubmitMenuIngestionRequestSchema = z.strictObject({
  sourceType: z.enum(['url', 'pdf', 'photo', 'text']),
  sourceUrl: z.string().url().optional(),
  sourceHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  sourceStorageKey: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
});
export type SubmitMenuIngestionRequest = z.infer<typeof SubmitMenuIngestionRequestSchema>;

export const ApproveDishDraftRequestSchema = z.strictObject({
  commandId: uuid,
  expectedVersion: z.number().int().nonnegative().default(0),
});
export type ApproveDishDraftRequest = z.infer<typeof ApproveDishDraftRequestSchema>;

export const MenuIngestionQueueMessageSchema = z.strictObject({
  version: z.literal(1),
  tenantId: uuid,
  jobId: uuid,
  queuedAt: z.string().datetime(),
});
export type MenuIngestionQueueMessage = z.infer<typeof MenuIngestionQueueMessageSchema>;
