// S3-RES-03: reads the owner dish report from the report API (#107) and turns every outcome into
// one screen state. The dashboard never calculates a metric: it shows the validated report, or a
// state that says why there is none. A failed request is never shown as a measured zero.
// Imports only the owner-report contract, so the rest of the contracts package (including its
// analytics export schemas) stays out of the dashboard bundle.
import { type OwnerDishReport, OwnerDishReportSchema } from '@peekaplate/contracts/owner-report';
import { PRODUCTION_OWNER_API_ORIGIN } from '../owner/api-origin';

export type ReportState =
  | { kind: 'loading' }
  | { kind: 'ready'; report: OwnerDishReport; reference?: string }
  // 401: no valid sign-in. Owner sign-in is S4-FE-04 (Ehab).
  | { kind: 'signed_out' }
  // 403: not a member of this restaurant, or membership was removed.
  | { kind: 'denied' }
  // 503: reporting or its required evidence source is unavailable.
  | { kind: 'unavailable' }
  // The response failed the owner_report.v1 check, or belongs to another restaurant.
  | { kind: 'invalid' }
  // Network failure, timeout or any other status: offer Retry.
  | { kind: 'error' };

export type ReportRequest = {
  apiBase: string;
  venueId: string;
  // The signed-in owner's access token, or null when nobody is signed in.
  accessToken: string | null;
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function reportUrl(apiBase: string, venueId: string): string {
  const base = apiBase.replace(/\/+$/, '');
  const query =
    base === PRODUCTION_OWNER_API_ORIGIN
      ? 'source=production&displayActions=true'
      : 'source=synthetic';
  return `${base}/api/v1/venues/${encodeURIComponent(venueId)}/analytics/dishes?${query}`;
}

export async function fetchOwnerReport({
  apiBase,
  venueId,
  accessToken,
  fetch: doFetch = fetch,
  signal,
}: ReportRequest): Promise<ReportState> {
  if (!accessToken) return { kind: 'signed_out' };
  if (!UUID.test(venueId)) return { kind: 'invalid' };
  let response: Response;
  try {
    response = await doFetch(reportUrl(apiBase, venueId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      // Reports are per owner and per restaurant: never reuse a cached copy.
      cache: 'no-store',
      credentials: 'omit',
      ...(signal ? { signal } : {}),
    });
  } catch {
    return { kind: 'error' };
  }
  if (response.status === 401) return { kind: 'signed_out' };
  if (response.status === 403) return { kind: 'denied' };
  if (response.status === 503) return { kind: 'unavailable' };
  if (!response.ok) return { kind: 'error' };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'invalid' };
  }
  const parsed = OwnerDishReportSchema.safeParse(body);
  // A report for another restaurant is never shown, even if it is otherwise valid.
  const production = apiBase.replace(/\/+$/, '') === PRODUCTION_OWNER_API_ORIGIN;
  if (
    !parsed.success ||
    parsed.data.venue_id.toLowerCase() !== venueId.toLowerCase() ||
    parsed.data.source !== (production ? 'production' : 'synthetic')
  ) {
    return { kind: 'invalid' };
  }
  const reference = response.headers.get('X-Owner-Report-Ref');
  return {
    kind: 'ready',
    report: parsed.data,
    ...(reference && reference.length <= 2048 && /^[\x21-\x7e]+$/.test(reference)
      ? { reference }
      : {}),
  };
}
