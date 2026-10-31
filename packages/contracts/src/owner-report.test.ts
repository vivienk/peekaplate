import { describe, it, expect } from 'vitest';
import { OwnerDishReportSchema } from './owner-report';

describe('OwnerDishReportSchema - ADR 0015 Strict Bounds', () => {
	it('should parse a valid synthetic report payload with fractional rates', () => {
		const validPayload = {
			schema_version: 'owner_report.v1',
			venue_id: 'e2a66159-bd14-44cb-8217-36d001a12676',
			source: 'synthetic',
			report_metadata: {
				calculation_version: 'v1.2.0',
				generated_at: new Date().toISOString(),
				date_window: {
					start_time: new Date().toISOString(),
					end_time: new Date().toISOString(),
					duration_hours: 24
				},
				coverage: { total_dishes_monitored: 1, measurable_dishes_count: 1 },
				freshness: { last_event_ingested_at: new Date().toISOString(), is_stale: false },
				report_status: 'NORMAL'
			},
			dishes: [
				{
					dish_id: '45806808-4376-46ff-912b-ab8a5519881a',
					name: 'Thiéboudienne Penda Mbaye',
					evidence_state: 'NORMAL',
					metrics: {
						active_sessions: { value: 10, status: 'normal' },
						avg_interaction_time_seconds: { value: 45.05, status: 'normal' },
						timing_coverage: { value: 1.0, status: 'normal' },
						open_rate: { value: 0.845, status: 'normal' },
						engagement_rate: { value: 0.621, status: 'normal' },
						save_rate: { value: 0.154, status: 'normal' }
					}
				}
			]
		};
		const result = OwnerDishReportSchema.safeParse(validPayload);
		expect(result.success).toBe(true);
	});

	it('should fail validation if a suppressed metric contains a non-null numerical value', () => {
		const invalidSuppressedPayload = {
			schema_version: 'owner_report.v1',
			venue_id: 'e2a66159-bd14-44cb-8217-36d001a12676',
			source: 'synthetic',
			report_metadata: {
				calculation_version: 'v1.2.0',
				generated_at: new Date().toISOString(),
				date_window: { start_time: new Date().toISOString(), end_time: new Date().toISOString(), duration_hours: 24 },
				coverage: { total_dishes_monitored: 1, measurable_dishes_count: 0 },
				freshness: { last_event_ingested_at: new Date().toISOString(), is_stale: false },
				report_status: 'NORMAL'
			},
			dishes: [
				{
					dish_id: 'e446b736-9107-4202-81a3-bb80ddf1ac12',
					name: 'Yassa Poulet',
					evidence_state: 'SUPPRESSED',
					metrics: {
						active_sessions: { value: 9, status: 'suppressed' }, // Fails: value must be null when suppressed
						avg_interaction_time_seconds: { value: null, status: 'suppressed' },
						timing_coverage: { value: null, status: 'suppressed' },
						open_rate: { value: null, status: 'suppressed' },
						engagement_rate: { value: null, status: 'suppressed' },
						save_rate: { value: null, status: 'suppressed' }
					}
				}
			]
		};
		const result = OwnerDishReportSchema.safeParse(invalidSuppressedPayload);
		expect(result.success).toBe(false);
	});

	it('should fail validation if a conversion rate is outside the fractional 0-1 boundary', () => {
		const invalidRatePayload = {
			schema_version: 'owner_report.v1',
			venue_id: 'e2a66159-bd14-44cb-8217-36d001a12676',
			source: 'synthetic',
			report_metadata: {
				calculation_version: 'v1.2.0',
				generated_at: new Date().toISOString(),
				date_window: { start_time: new Date().toISOString(), end_time: new Date().toISOString(), duration_hours: 24 },
				coverage: { total_dishes_monitored: 1, measurable_dishes_count: 1 },
				freshness: { last_event_ingested_at: new Date().toISOString(), is_stale: false },
				report_status: 'NORMAL'
			},
			dishes: [
				{
					dish_id: '45806808-4376-46ff-912b-ab8a5519881a',
					name: 'Thiéboudienne',
					evidence_state: 'NORMAL',
					metrics: {
						active_sessions: { value: 11, status: 'normal' },
						avg_interaction_time_seconds: { value: 30, status: 'normal' },
						timing_coverage: { value: 1.0, status: 'normal' },
						open_rate: { value: 84.5, status: 'normal' }, // Fails: must be between 0 and 1 (fraction)
						engagement_rate: { value: 0.5, status: 'normal' },
						save_rate: { value: 0.1, status: 'normal' }
					}
				}
			]
		};
		const result = OwnerDishReportSchema.safeParse(invalidRatePayload);
		expect(result.success).toBe(false);
	});
});
