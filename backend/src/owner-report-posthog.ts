import { ObservationTypeSchema } from '@peekaplate/contracts';
import { z } from 'zod';

const MAX_EVENTS = 5_000;
const MAX_RESPONSE_BYTES = 576_000;
const QUERY_TIMEOUT_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const uuid = z
  .string()
  .length(36)
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  .transform((value) => value.toLowerCase());
const reportEventType = ObservationTypeSchema.extract([
  'menu_viewed',
  'dish_viewed',
  'dish_detail_opened',
  'dish_activity_checkpoint',
  'dish_compared',
  'dish_portion_opened',
  'dish_saved',
]);

// shortcut: one bounded result for the owner pilot, use a provider endpoint with a stable snapshot if this cap is reached.
const query = `
SELECT DISTINCT toString(uuid) AS event_id,
  toString(properties.publication_revision_id) AS publication_id,
  event AS event_type
FROM events
WHERE event IN (
  ${reportEventType.options.map((type) => `'${type}'`).join(', ')}
)
  AND properties.environment = 'production'
  AND properties.venue_id = {venue_id}
  AND timestamp >= toDateTime64({window_start}, 3, 'UTC')
  AND timestamp < toDateTime64({window_end}, 3, 'UTC')
  AND properties.event_id = toString(uuid)
LIMIT ${MAX_EVENTS + 1}
`;

const queryResult = z.object({
  results: z.array(z.tuple([uuid, uuid, reportEventType])).max(MAX_EVENTS),
  columns: z
    .tuple([z.literal('event_id'), z.literal('publication_id'), z.literal('event_type')])
    .nullish(),
  hasMore: z.literal(false).nullish(),
  warnings: z.array(z.unknown()).max(0).nullish(),
  query_status: z.null().optional(),
  error: z.null().optional(),
});

export class OwnerReportPostHogUnavailableError extends Error {
  constructor() {
    super('Live owner report source unavailable');
    this.name = 'OwnerReportPostHogUnavailableError';
  }
}

type LiveOwnerEventScope = {
  projectId: string;
  readKey: string;
  venueId: string;
  windowStart: string;
  windowEnd: string;
};

export type LivePostHogOwnerEvent = {
  eventId: string;
  publicationId: string;
  eventType: z.infer<typeof reportEventType>;
};

function utcMilliseconds(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new OwnerReportPostHogUnavailableError();
  }
  return timestamp;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new OwnerReportPostHogUnavailableError();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new OwnerReportPostHogUnavailableError();
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function readLivePostHogOwnerEvents(
  { projectId, readKey, venueId, windowStart, windowEnd }: LiveOwnerEventScope,
  fetcher: typeof fetch = fetch,
): Promise<LivePostHogOwnerEvent[]> {
  const projectNumber = Number(projectId);
  const starts = utcMilliseconds(windowStart);
  const ends = utcMilliseconds(windowEnd);
  if (
    !Number.isSafeInteger(projectNumber) ||
    projectNumber <= 0 ||
    String(projectNumber) !== projectId ||
    !/^ph[xs]_[A-Za-z0-9_-]+$/.test(readKey) ||
    readKey !== readKey.trim() ||
    !uuid.safeParse(venueId).success ||
    starts % DAY_MS !== 0 ||
    ends < starts ||
    ends - starts > DAY_MS
  ) {
    throw new OwnerReportPostHogUnavailableError();
  }
  if (starts === ends) return [];

  try {
    const signal = AbortSignal.timeout(QUERY_TIMEOUT_MS);
    const response = await fetcher(`https://us.posthog.com/api/projects/${projectId}/query/`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${readKey}`, 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        refresh: 'force_blocking',
        query: {
          kind: 'HogQLQuery',
          name: 'Live owner report event eligibility',
          query,
          values: {
            venue_id: venueId.toLowerCase(),
            window_start: windowStart.slice(0, -1).replace('T', ' '),
            window_end: windowEnd.slice(0, -1).replace('T', ' '),
          },
        },
      }),
    });
    const result = queryResult.safeParse(await readBoundedJson(response));
    if (signal.aborted || !result.success) throw new OwnerReportPostHogUnavailableError();
    const events = new Map<string, LivePostHogOwnerEvent>();
    for (const [eventId, publicationId, eventType] of result.data.results) {
      const existing = events.get(eventId);
      if (existing) {
        if (existing.publicationId !== publicationId || existing.eventType !== eventType) {
          throw new OwnerReportPostHogUnavailableError();
        }
      } else {
        events.set(eventId, { eventId, publicationId, eventType });
      }
    }
    return [...events.values()];
  } catch {
    // Provider details can contain private query output and must stay out of logs and responses.
    throw new OwnerReportPostHogUnavailableError();
  }
}
