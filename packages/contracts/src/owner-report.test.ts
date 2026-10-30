import { describe, it, expect } from 'vitest';
import { OwnerDishReportSchema } from './owner-report';

describe('OwnerDishReportSchema', () => {
	it('should parse a valid report payload', () => {
		const validPayload = {
			restaurant_id: 'e2a66159-bd14-44cb-8217-36d001a12676',
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
			dishes: []
		};
		const result = OwnerDishReportSchema.safeParse(validPayload);
		expect(result.success).toBe(true);
	});

	it('should fail validation on invalid payload data', () => {
		const badPayload = {
			restaurant_id: 'invalid-uuid-format',
			source: 'synthetic'
		};
		const result = OwnerDishReportSchema.safeParse(badPayload);
		expect(result.success).toBe(false);
	});
});
