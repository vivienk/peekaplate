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

const MetricValueSchema = z.object({
	value: z.number().nullable(),
	status: MetricStatusSchema
});

export const OwnerDishReportSchema = z.object({
	restaurant_id: z.string().uuid(),
	source: z.enum(['synthetic', 'production']),
	report_metadata: z.object({
		calculation_version: z.string(),
		generated_at: z.string().datetime(),
		date_window: z.object({
			start_time: z.string().datetime(),
			end_time: z.string().datetime(),
			duration_hours: z.number()
		}),
		coverage: z.object({
			total_dishes_monitored: z.number(),
			measurable_dishes_count: z.number()
		}),
		freshness: z.object({
			last_event_ingested_at: z.string().datetime(),
			is_stale: z.boolean()
		}),
		report_status: z.enum(['NORMAL', 'EMPTY', 'STALE', 'ERROR'])
	}),
	dishes: z.array(
		z.object({
			dish_id: z.string().uuid(),
			name: z.string(),
			evidence_state: z.enum(['NORMAL', 'SUPPRESSED', 'NOT_MEASURABLE']),
			metrics: z.object({
				active_sessions: MetricValueSchema,
				avg_interaction_time_seconds: MetricValueSchema,
				open_rate: MetricValueSchema,
				engagement_rate: MetricValueSchema,
				save_rate: MetricValueSchema
			})
		})
	)
});

export type OwnerDishReport = z.infer<typeof OwnerDishReportSchema>;
