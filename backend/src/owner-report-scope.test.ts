import { describe, expect, it } from 'vitest';
import {
  configuredSyntheticReportVenues,
  SYNTHETIC_REPORT_VENUE_ALLOWLIST,
  syntheticReportTrafficClass,
} from './owner-report-scope';

describe('configured synthetic report venues', () => {
  it('preserves the reserved live-class fixture and isolates new venues to test facts', () => {
    expect(SYNTHETIC_REPORT_VENUE_ALLOWLIST.map(syntheticReportTrafficClass)).toEqual([
      'live',
      'test',
      'test',
    ]);
  });
  it('retains the single venue and allows the three confirmed venues together', () => {
    const [legacy, ...additional] = SYNTHETIC_REPORT_VENUE_ALLOWLIST;
    expect(configuredSyntheticReportVenues({ SYNTHETIC_REPORT_VENUE_ID: legacy })).toEqual([
      legacy,
    ]);
    expect(
      configuredSyntheticReportVenues({
        SYNTHETIC_REPORT_VENUE_ID: legacy,
        SYNTHETIC_REPORT_VENUE_IDS: additional.join(','),
      }),
    ).toEqual([...SYNTHETIC_REPORT_VENUE_ALLOWLIST]);
  });

  it.each([
    'bad',
    '',
    `${SYNTHETIC_REPORT_VENUE_ALLOWLIST[0]},`,
    '00000000-0000-4000-8000-000000000999',
  ])('fails closed for invalid config %j', (value) => {
    expect(
      configuredSyntheticReportVenues({
        SYNTHETIC_REPORT_VENUE_ID: SYNTHETIC_REPORT_VENUE_ALLOWLIST[0],
        SYNTHETIC_REPORT_VENUE_IDS: value,
      }),
    ).toEqual([]);
  });
});
