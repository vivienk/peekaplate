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

const MetricValueSchema = z.strictObject({
	value: z.number().int().nonnegative().nullable(),
	status: MetricStatusSchema
}).refine(
	(data) => (data.status === 'normal' || data.status === 'valid_zero' ? data.value !== null : data.value === null),
	{ message: 'Value must be null unless status is normal or valid_zero' }
);

const RateValueSchema = z.strictObject({
	value: z.number().min(0).max(1).nullable(),
	status: MetricStatusSchema
}).refine(
	(data) => (data.status === 'normal' || data.status === 'valid_zero' ? data.value !== null : data.value === null),
	{ message: 'Rate must be null unless status is normal or valid_zero' }
);

// Trend series wrapper for overview and dish detail sections
const HistoricalTrendSchema = z.strictObject({
	weeks_ordered: z.array(z.number().int().nonnegative()),
	opens_by_day: z.array(z.number().int().nonnegative())
});

export const OwnerDishReportSchema = z.strictObject({
	schema_version: z.literal('owner_report.v1'),
	venue_id: z.uuid(), // Updated to Zod 4 shared helper format
	source: z.enum(['synthetic', 'production']),
	report_metadata: z.strictObject({
		calculation_version: z.string(),
		generated_at: z.iso.datetime({ offset: true }), // Updated to Zod 4 iso helper
		date_window: z.strictObject({
			start_time: z.iso.datetime({ offset: true }),
			end_time: z.iso.datetime({ offset: true }),
			duration_hours: z.number().int().nonnegative()
		}),
		coverage: z.strictObject({
			total_dishes_monitored: z.number().int().nonnegative(),
			measurable_dishes_count: z.number().int().nonnegative()
		}),
		freshness: z.strictObject({
			last_event_ingested_at: z.iso.datetime({ offset: true }),
			is_stale: z.boolean()
		}),
		report_status: z.enum(['NORMAL', 'EMPTY', 'STALE', 'ERROR'])
	}),
	overview_totals: z.strictObject({
		menu_sessions: z.number().int().nonnegative(),
		total_dish_opens: z.number().int().nonnegative()
	}),
	dishes: z.array(
		z.strictObject({
			dish_id: z.uuid(),
			name: z.string(),
			evidence_state: z.enum(['NORMAL', 'SUPPRESSED', 'NOT_MEASURABLE']),
			first_opens_count: z.number().int().nonnegative().nullable(),
			repeat_opens_count: z.number().int().nonnegative().nullable(),
			trends: HistoricalTrendSchema.nullable(),
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
