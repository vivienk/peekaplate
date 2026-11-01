import { describe, it, expect } from 'vitest';
import { OwnerDishReportSchema } from './owner-report';

describe('OwnerDishReportSchema - 10-Session Floor Enforcement', () => {
	it('should fail validation if a suppressed metric has a non-null value (Frontier 9 Breach)', () => {
		const brokenFloorPayload = {
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
						active_sessions: { value: 9, status: 'suppressed' }, // SHOULD FAIL: value must be null when suppressed!
						avg_interaction_time_seconds: { value: null, status: 'suppressed' },
						timing_coverage: { value: null, status: 'suppressed' },
						open_rate: { value: null, status: 'suppressed' },
						engagement_rate: { value: null, status: 'suppressed' },
						save_rate: { value: null, status: 'suppressed' }
					}
				}
			]
		};

		const result = OwnerDishReportSchema.safeParse(brokenFloorPayload);
		expect(result.success).toBe(false); // Validates the refinement constraint works
	});
});
