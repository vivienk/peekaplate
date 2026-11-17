import { z } from 'zod';

export const SYNTHETIC_REPORT_VENUE_ALLOWLIST: readonly [string, ...string[]] = [
  '00000000-0000-4000-8000-000000000123',
  '1ea97f31-bce5-4b8a-99f0-588afed9102e',
  'f31ec4b4-59f3-49da-9b9d-408abebef143',
];

type SyntheticReportConfig = {
  SYNTHETIC_REPORT_VENUE_ID?: string;
  SYNTHETIC_REPORT_VENUE_IDS?: string;
};

export function configuredSyntheticReportVenues(
  env: SyntheticReportConfig,
  approvedVenues: readonly string[] = SYNTHETIC_REPORT_VENUE_ALLOWLIST,
): string[] {
  const values = [
    ...(env.SYNTHETIC_REPORT_VENUE_ID === undefined ? [] : [env.SYNTHETIC_REPORT_VENUE_ID]),
    ...(env.SYNTHETIC_REPORT_VENUE_IDS === undefined
      ? []
      : env.SYNTHETIC_REPORT_VENUE_IDS.split(',')),
  ];
  const parsed = z
    .array(z.uuid().transform((id) => id.toLowerCase()))
    .max(4)
    .safeParse(values);
  if (!parsed.success || parsed.data.some((id) => !approvedVenues.includes(id))) return [];
  return [...new Set(parsed.data)];
}

// The reserved fixture predates test tokens; preserve its live-class evidence without relabelling it.
export function syntheticReportTrafficClass(venueId: string): 'live' | 'test' {
  return venueId.toLowerCase() === SYNTHETIC_REPORT_VENUE_ALLOWLIST[0] ? 'live' : 'test';
}
