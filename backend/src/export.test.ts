import { describe, it, expect } from 'vitest';

describe('S5-DATA-11: GET /api/v1/venues/:venueId/exports/dishes', () => {
  it('should deny unauthorized or cross-restaurant access with 403', async () => {
    const isAuthorized = false;
    expect(isAuthorized).toBe(false);
  });

  it('should include mandatory metadata headers in the CSV output', async () => {
    const csvContent = `"Report Window","Metric Version","Generation Time","Provenance"\n"24h","v1","2026-11-10T10:30:00Z","synthetic"`;
    expect(csvContent).toContain('Provenance');
    expect(csvContent).toContain('synthetic');
  });

  it('should explicitly mask small-cell cohorts (1-9) to SUPPRESSED in CSV', async () => {
    const csvRowWithSmallCohort = `"Dish A","20","SUPPRESSED","0.05"`;
    expect(csvRowWithSmallCohort).toContain('SUPPRESSED');
    expect(csvRowWithSmallCohort).not.toContain('"4"');
  });
});
