import { z } from 'zod';

const MetricStatusSchema = z.enum([
	'normal',
	'valid_zero',
	'not_measurable',
	'suppressed',
	'missing',
	'stale',
	'evidence_check_failed'
]);

// Rule: Value MUST be null if status is suppressed, missing, stale, failed or not_measurable
const MetricValueSchema = z.strictObject({
	value: z.number().int().nonnegative().nullable(),
	status: MetricStatusSchema
}).refine(
	(data) => {
		if (data.status === 'normal' || data.status === 'valid_zero') {
			return data.value !== null;
		}
		return data.value === null;
	},
	{ message: 'Value must be null unless status is normal or valid_zero (ADR 0015)' }
);

// Rate Rule: Must be a fraction between 0 and 1, and NULL if suppressed
const RateValueSchema = z.strictObject({
	value: z.number().min(0).max(1).nullable(),
	status: MetricStatusSchema
}).refine(
	(data) => {
		if (data.status === 'normal' || data.status === 'valid_zero') {
			return data.value !== null;
		}
		return data.value === null;
	},
	{ message: 'Rate value must be null unless status is normal or valid_zero (ADR 0015)' }
);

export const OwnerDishReportSchema = z.strictObject({
	schema_version: z.literal('owner_report.v1'),
	venue_id: z.string().uuid(),
	source: z.enum(['synthetic', 'production']),
	report_metadata: z.strictObject({
		calculation_version: z.string(),
		generated_at: z.string().datetime({ offset: true }),
		date_window: z.strictObject({
			start_time: z.string().datetime({ offset: true }),
			end_time: z.string().datetime({ offset: true }),
			duration_hours: z.number().int().nonnegative()
		}),
		coverage: z.strictObject({
			total_dishes_monitored: z.number().int().nonnegative(),
			measurable_dishes_count: z.number().int().nonnegative()
		}),
		freshness: z.strictObject({
			last_event_ingested_at: z.string().datetime({ offset: true }),
			is_stale: z.boolean()
		}),
		report_status: z.enum(['NORMAL', 'EMPTY', 'STALE', 'ERROR'])
	}),
	dishes: z.array(
		z.strictObject({
			dish_id: z.string().uuid(),
			name: z.string(),
			evidence_state: z.enum(['NORMAL', 'SUPPRESSED', 'NOT_MEASURABLE']),
			metrics: z.strictObject({
				active_sessions: MetricValueSchema,
				avg_interaction_time_seconds: MetricValueSchema,
				timing_coverage: RateValueSchema,
				open_rate: RateValueSchema,
				engagement_rate: RateValueSchema,
				save_rate: RateValueSchema
			})
		})
	)
});

export type OwnerDishReport = z.infer<typeof OwnerDishReportSchema>;
