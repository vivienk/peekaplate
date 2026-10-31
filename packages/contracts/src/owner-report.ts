import { z } from 'zod';

// Granular metric status enum per ADR 0015
const MetricStatusSchema = z.enum([
	'normal',
	'valid_zero',
	'not_measurable',
	'suppressed',
	'missing',
	'stale',
	'evidence_check_failed'
]);

// Strict value container ensuring value is null unless status is normal or valid_zero
const MetricValueSchema = z.strictObject({
	value: z.number().min(0).nullable(),
	status: MetricStatusSchema
}).refine(
	(data) => {
		if (data.status === 'normal' || data.status === 'valid_zero') {
			return data.value !== null;
		}
		return data.value === null;
	},
	{ message: 'Value must be null whenever status is not normal or valid_zero per ADR 0015' }
);

// Rate metric container ensuring values are floating fractions between 0 and 1
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
	{ message: 'Rate value must be null whenever status is not normal or valid_zero per ADR 0015' }
);

export const OwnerDishReportSchema = z.strictObject({
	schema_version: z.literal('owner_report.v1'),
	venue_id: z.string().uuid(), // Renamed from restaurant_id to match repo routing
	source: z.enum(['synthetic', 'production']),
	report_metadata: z.strictObject({
		calculation_version: z.string(),
		generated_at: z.string().datetime({ offset: true }),
		date_window: z.strictObject({
			start_time: z.string().datetime({ offset: true }),
			end_time: z.string().datetime({ offset: true }),
			duration_hours: z.number().nonnegative()
		}),
		coverage: z.strictObject({
			total_dishes_monitored: z.number().nonnegative(),
			measurable_dishes_count: z.number().nonnegative()
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
				timing_coverage: RateValueSchema, // Fraction metric added per implementation plan
				open_rate: RateValueSchema,       // Fraction 0 to 1
				engagement_rate: RateValueSchema, // Fraction 0 to 1
				save_rate: RateValueSchema        // Fraction 0 to 1
			})
		})
	)
});

export type OwnerDishReport = z.infer<typeof OwnerDishReportSchema>;
