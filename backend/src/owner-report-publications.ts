import { MenuPublicationSchema } from '@peekaplate/contracts';
import type { Client } from 'pg';
import { AuthUnavailableError } from './auth';
import { type PreparedStorage, verifyPublishedSnapshot } from './owner-prepare';
import {
  type OwnerReportLiveEvidence,
  PRODUCTION_REPORT_FILTER,
  TODAY_REPORT_EVIDENCE,
} from './owner-report-evidence';

const MAX_PUBLICATIONS = 16;

export type ReportPublication = {
  publicationId: string;
  dishes: { id: string; revision: string; has_portion: boolean }[];
};

/** Caller already owns the authorized restaurant's reporting transaction. */
export async function readReportPublications(
  client: Client,
  storage: PreparedStorage,
  origin: string,
  venueId: string,
  now: Date,
  { start, events }: OwnerReportLiveEvidence,
  earliest: Date,
): Promise<ReportPublication[]> {
  const wanted = await client.query<{ publicationId: string }>(
    `WITH ${TODAY_REPORT_EVIDENCE}
     SELECT DISTINCT obs.authorized_publication_id AS "publicationId"
     FROM app_private.owner_observation_v1 obs
     WHERE obs.tenant_id=$1 AND obs.occurred_at >= $2 AND obs.occurred_at < $3
     ${PRODUCTION_REPORT_FILTER}
     ORDER BY "publicationId" LIMIT ${MAX_PUBLICATIONS + 1}`,
    [venueId, earliest, now, start, JSON.stringify(events)],
  );
  if (wanted.rows.length === 0) return [];
  if (wanted.rows.length > MAX_PUBLICATIONS) throw new AuthUnavailableError();

  const ids = new Set(wanted.rows.map((row) => row.publicationId));
  const published = await client.query<{
    payload: unknown;
    version: number;
    menuId: string;
    revision: string;
    hash: string;
    url: string;
  }>(
    `SELECT e.payload, e.version, e.stream_id AS "menuId",
       a.menu_revision_id AS revision, a.content_hash AS hash, b.bundle_url AS url
     FROM app_private.es_event e
     JOIN app_private.menu_approval a
       ON (a.tenant_id,a.menu_id)=(e.tenant_id,e.stream_id)
      AND a.approval_id::text=e.payload->>'approvalId'
     JOIN app_private.public_menu_bundle b
       ON (b.tenant_id,b.menu_id,b.menu_revision_id)=(a.tenant_id,a.menu_id,a.menu_revision_id)
     WHERE e.tenant_id=$1 AND e.stream_type='menu_publication'
       AND e.event_type='menu.published' AND e.schema_version=1
       AND e.payload->>'publicationId'=ANY($2::text[])`,
    [venueId, [...ids]],
  );
  const approved: ReportPublication[] = [];
  for (const row of published.rows) {
    const event = MenuPublicationSchema.safeParse(row.payload);
    if (
      !event.success ||
      !ids.delete(event.data.publicationId) ||
      event.data.status !== 'published' ||
      event.data.version !== row.version ||
      event.data.menuId !== row.menuId ||
      !row.url.startsWith(`${origin}/`)
    )
      throw new AuthUnavailableError();
    const snapshot = await verifyPublishedSnapshot(storage, {
      venueId,
      menuId: row.menuId,
      menuRevisionId: row.revision,
      bundle: { url: row.url, contentHash: row.hash },
    });
    if (!snapshot) throw new AuthUnavailableError();
    approved.push({
      publicationId: event.data.publicationId,
      dishes: snapshot.content.categories.flatMap((category) =>
        category.dishes
          .filter((dish) => dish.complete && dish.ingredients.length > 0)
          .map((dish) => ({
            id: dish.dish_id,
            revision: dish.dish_revision_id,
            has_portion: dish.complete && Boolean(dish.portion),
          })),
      ),
    });
  }
  if (ids.size > 0) throw new AuthUnavailableError();
  return approved;
}
