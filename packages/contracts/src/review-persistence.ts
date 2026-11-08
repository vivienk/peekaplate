import { z } from 'zod';
import {
  type ReviewCandidate,
  ReviewCandidateResultSchema,
  ReviewCandidateSchema,
} from './review-candidates';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const postgresText = z
  .string()
  .refine((value) => !value.includes('\u0000'), 'NUL is not supported');

export const ExtractionReviewScopeSchema = z.strictObject({
  venueId: uuid,
  extractionId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((v) => !v.includes('\u0000'), 'NUL is not supported'),
});
export type ExtractionReviewScope = z.infer<typeof ExtractionReviewScopeSchema>;

export const CandidateReviewScopeSchema = z.strictObject({
  venueId: uuid,
  extractionId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((v) => !v.includes('\u0000'), 'NUL is not supported'),
  candidateId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((v) => !v.includes('\u0000'), 'NUL is not supported'),
});
export type CandidateReviewScope = z.infer<typeof CandidateReviewScopeSchema>;

export const ReviewEditableFieldSchema = z.enum([
  'name',
  'description',
  'category',
  'subcategory',
  'price_text',
  'price_amount',
  'price_currency',
  'ingredients',
]);
export type ReviewEditableField = z.infer<typeof ReviewEditableFieldSchema>;

export const CandidateCorrectedFieldsSchema = z
  .strictObject({
    name: postgresText.trim().min(1).max(160).optional(),
    description: postgresText.trim().min(1).max(4000).nullable().optional(),
    category: postgresText.trim().min(1).max(160).nullable().optional(),
    subcategory: postgresText.trim().min(1).max(160).nullable().optional(),
    price_text: postgresText.trim().min(1).max(160).nullable().optional(),
    price_amount: z
      .string()
      .regex(/^(?:\d+(?:\.\d+)?)$/, 'Expected canonical non-negative decimal string')
      .nullable()
      .optional(),
    price_currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .optional(),
    ingredients: z.array(postgresText.trim().min(1).max(200)).max(100).nullable().optional(),
  })
  .superRefine((fields, ctx) => {
    if (Object.values(fields).every((v) => v === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'At least one corrected field must be supplied when action is correct',
      });
    }
  });
export type CandidateCorrectedFields = z.infer<typeof CandidateCorrectedFieldsSchema>;

export const ReviewCandidateStatusSchema = z.enum([
  'pending',
  'corrected',
  'rejected',
  'incomplete',
]);
export type ReviewCandidateStatus = z.infer<typeof ReviewCandidateStatusSchema>;

export const ReviewCandidateCommandSchema = z
  .strictObject({
    commandId: uuid,
    expectedVersion: z.number().int().nonnegative().max(2_147_483_646),
    action: z.enum(['correct', 'reject', 'mark_incomplete']),
    corrected: CandidateCorrectedFieldsSchema.optional(),
    incompleteFields: z.array(ReviewEditableFieldSchema).min(1).max(8).optional(),
    reviewNote: postgresText.trim().min(1).max(1000).nullable().optional(),
  })
  .superRefine((cmd, ctx) => {
    if (cmd.action === 'correct' && !cmd.corrected) {
      ctx.addIssue({
        code: 'custom',
        path: ['corrected'],
        message: 'corrected fields are required when action is correct',
      });
    }
    if (cmd.action === 'reject' && cmd.corrected !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['corrected'],
        message: 'rejected candidates cannot carry corrected field overrides',
      });
    }
    if (
      cmd.action === 'mark_incomplete' &&
      (!cmd.incompleteFields || cmd.incompleteFields.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['incompleteFields'],
        message: 'incompleteFields must list at least one field when action is mark_incomplete',
      });
    }
    if (
      cmd.incompleteFields &&
      new Set(cmd.incompleteFields).size !== cmd.incompleteFields.length
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['incompleteFields'],
        message: 'incompleteFields must not contain duplicates',
      });
    }
  });
export type ReviewCandidateCommand = z.infer<typeof ReviewCandidateCommandSchema>;

export const ResolvedCandidateFieldsSchema = z.strictObject({
  name: postgresText.min(1).max(160),
  description: postgresText.max(4000).nullable(),
  category: postgresText.nullable(),
  subcategory: postgresText.nullable().optional(),
  category_page_number: z.number().int().positive().nullable().optional(),
  price_text: postgresText.max(160).nullable().optional(),
  price_amount: z.string().nullable(),
  price_currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  ingredients: z.array(postgresText).nullable(),
});
export type ResolvedCandidateFields = z.infer<typeof ResolvedCandidateFieldsSchema>;

export const CandidateReviewRecordSchema = z.strictObject({
  extractionId: z.string().min(1),
  candidateId: z.string().min(1),
  revisionId: uuid.nullable(),
  version: z.number().int().nonnegative().max(2_147_483_647),
  reviewStatus: ReviewCandidateStatusSchema,
  corrected: z.strictObject({
    name: postgresText.min(1).max(160).optional(),
    description: postgresText.max(4000).nullable().optional(),
    category: postgresText.nullable().optional(),
    subcategory: postgresText.nullable().optional(),
    price_text: postgresText.max(160).nullable().optional(),
    price_amount: z.string().nullable().optional(),
    price_currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .optional(),
    ingredients: z.array(postgresText).nullable().optional(),
  }),
  editedFields: z.array(ReviewEditableFieldSchema),
  incompleteFields: z.array(ReviewEditableFieldSchema),
  reviewNote: postgresText.max(1000).nullable(),
  reviewedBy: uuid.nullable(),
  reviewedAt: z.iso.datetime({ offset: true }).nullable(),
  publishable: z.literal(false),
});
export type CandidateReviewRecord = z.infer<typeof CandidateReviewRecordSchema>;

export const ReviewCandidateItemResponseSchema = z.strictObject({
  candidate: ReviewCandidateSchema,
  review: CandidateReviewRecordSchema,
  effective: ResolvedCandidateFieldsSchema,
});
export type ReviewCandidateItemResponse = z.infer<typeof ReviewCandidateItemResponseSchema>;

export const PrivateArtifactRefSchema = z.strictObject({
  schema_version: z.literal(1),
  key: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PrivateArtifactRef = z.infer<typeof PrivateArtifactRefSchema>;

export const ExtractionReviewSessionResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  venueId: uuid,
  extractionResult: ReviewCandidateResultSchema,
  items: z.array(ReviewCandidateItemResponseSchema),
  privateArtifactRef: PrivateArtifactRefSchema.nullable(),
  published: z.literal(false),
});
export type ExtractionReviewSessionResponse = z.infer<typeof ExtractionReviewSessionResponseSchema>;

export const UpsertExtractionReviewSessionRequestSchema = z.strictObject({
  commandId: uuid,
  extractionResult: ReviewCandidateResultSchema,
  jobId: uuid.optional(),
  privateArtifactRef: PrivateArtifactRefSchema.nullable().optional(),
});
export type UpsertExtractionReviewSessionRequest = z.infer<
  typeof UpsertExtractionReviewSessionRequestSchema
>;
