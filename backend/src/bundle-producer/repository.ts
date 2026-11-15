import { ApprovedDishFactsSchema } from '@peekaplate/contracts';
import type { DatabaseClient } from '../ingestion/repository';
import { type ApprovedDishSource, BundleProducerError } from './produce';

type DishCurrentRow = {
  dish_id: string;
  revision_id: string;
  name: string;
  description: string;
  approved_facts?: unknown;
};
type DraftRow = {
  published_dish_id: string;
  price_amount: string | null;
  price_currency: string | null;
  ingredients: unknown;
  origin?: string;
};
type CandidateReviewRow = {
  published_dish_id: string;
  review_status: 'corrected' | 'rejected' | 'incomplete';
  corrected_fields: Record<string, unknown>;
  incomplete_fields: string[] | null;
};

async function inTenantTransaction<T>(
  client: DatabaseClient,
  tenantId: string,
  work: () => Promise<T>,
  readOnlySnapshot = false,
): Promise<T> {
  await client.query(
    readOnlySnapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;' : 'BEGIN;',
  );
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT set_config('app.tenant_id', $1, true);", [tenantId]);
    const result = await work();
    await client.query('COMMIT;');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK;');
    } catch {}
    throw error;
  }
}

/**
 * Loads the approved facts for the requested dishes of one venue. Every query filters by
 * `tenant_id` explicitly as well as through RLS, because admission runs on a privileged
 * connection that bypasses RLS. Dishes without a `dish_current` row in this venue are absent
 * from the result, which the producer reports as `dish_not_found`.
 *
 * Precedence: name/description/revision from `dish_current`; price, currency and ingredients
 * from the single accepted/edited draft published as that dish; RES-01.2 corrections for the
 * draft's job/candidate override those three fields when present.
 */
export async function loadApprovedDishSources(
  client: DatabaseClient,
  tenantId: string,
  dishIds: readonly string[],
): Promise<Map<string, ApprovedDishSource>> {
  return inTenantTransaction(
    client,
    tenantId,
    async () => {
      const ids = [...dishIds];
      const current = await client.query<DishCurrentRow>(
        `SELECT dish_id, revision_id, name, description, approved_facts
         FROM app_private.dish_current
        WHERE tenant_id = $1 AND dish_id = ANY($2::uuid[])`,
        [tenantId, ids],
      );
      const drafts = await client.query<DraftRow>(
        `SELECT published_dish_id, price_amount::text AS price_amount, price_currency, ingredients, origin
         FROM app_private.dish_drafts
        WHERE tenant_id = $1
          AND published_dish_id = ANY($2::uuid[])
          AND review_status IN ('accepted', 'edited')`,
        [tenantId, ids],
      );
      const reviews = await client.query<CandidateReviewRow>(
        `SELECT d.published_dish_id, c.review_status, c.corrected_fields, c.incomplete_fields
         FROM app_private.dish_drafts d
         JOIN app_private.extraction_review_session s
           ON s.tenant_id = d.tenant_id AND s.job_id = d.job_id
         JOIN app_private.candidate_review_current c
           ON c.tenant_id = s.tenant_id
          AND c.extraction_id = s.extraction_id
          AND c.candidate_id = d.candidate_id
        WHERE d.tenant_id = $1
          AND d.published_dish_id = ANY($2::uuid[])
          AND d.review_status IN ('accepted', 'edited')`,
        [tenantId, ids],
      );

      const draftByDish = new Map<string, DraftRow>();
      const enrichedIds = new Set(
        current.rows.filter((row) => row.approved_facts != null).map((row) => row.dish_id),
      );
      for (const row of drafts.rows) {
        if (enrichedIds.has(row.published_dish_id)) continue;
        if (draftByDish.has(row.published_dish_id)) {
          throw new BundleProducerError(
            'ambiguous_dish_source',
            `Dish ${row.published_dish_id} has more than one accepted/edited draft`,
          );
        }
        draftByDish.set(row.published_dish_id, row);
      }
      const reviewByDish = new Map<string, CandidateReviewRow>();
      for (const row of reviews.rows) {
        if (enrichedIds.has(row.published_dish_id)) continue;
        if (reviewByDish.has(row.published_dish_id)) {
          throw new BundleProducerError(
            'ambiguous_candidate_review',
            `Dish ${row.published_dish_id} has more than one RES-01.2 candidate review`,
          );
        }
        reviewByDish.set(row.published_dish_id, row);
      }

      const sources = new Map<string, ApprovedDishSource>();
      for (const row of current.rows) {
        if (row.approved_facts !== null && row.approved_facts !== undefined) {
          const facts = ApprovedDishFactsSchema.parse(row.approved_facts);
          sources.set(row.dish_id, {
            dishId: row.dish_id,
            dishRevisionId: row.revision_id,
            name: row.name,
            description: row.description,
            priceAmount: facts.priceAmount,
            priceCurrency: facts.priceCurrency,
            ingredients: facts.ingredients,
            approvedAllergens: facts.allergens,
            approvedCategory: facts.category,
            reviewState: facts.category === null ? 'incomplete' : 'corrected',
          });
          continue;
        }
        const draft = draftByDish.get(row.dish_id);
        const review = reviewByDish.get(row.dish_id);
        const corrected = review?.corrected_fields ?? {};
        let priceAmount = draft?.price_amount ?? null;
        let priceCurrency = draft?.price_currency ?? null;
        let ingredients: unknown = draft?.ingredients ?? null;
        if ('price_amount' in corrected) {
          const value = corrected.price_amount;
          // A malformed stored correction must not fall back to the uncorrected draft price.
          priceAmount = value === null || typeof value === 'string' ? value : '';
        }
        if ('price_currency' in corrected) {
          const value = corrected.price_currency;
          priceCurrency = typeof value === 'string' ? value : null;
        }
        if ('ingredients' in corrected) ingredients = corrected.ingredients;
        sources.set(row.dish_id, {
          dishId: row.dish_id,
          dishRevisionId: row.revision_id,
          name: row.name,
          description: row.description,
          priceAmount,
          priceCurrency,
          ingredients,
          reviewState:
            draft?.origin === 'manual'
              ? 'incomplete'
              : review?.review_status === 'rejected'
                ? 'rejected'
                : (review?.incomplete_fields?.length ?? 0) > 0 ||
                    review?.review_status === 'incomplete'
                  ? 'incomplete'
                  : (review?.review_status ?? 'none'),
        });
      }
      return sources;
    },
    true,
  );
}

export type MenuBundleHandoff = {
  tenantId: string;
  menuId: string;
  menuRevisionId: string;
  contentApprovalId: string;
  contentHash: string;
  assetApprovalId: string;
  assetManifestHash: string;
  bundleUrl: string;
};

type HandoffRow = {
  content_approval_id: string;
  content_hash: string;
  asset_approval_id: string;
  asset_manifest_hash: string;
  bundle_url: string | null;
};

/**
 * Registers a produced bundle as a RES-02 review subject plus its public bundle URL, in one
 * transaction. Both tables are append-only and the runtime role may only read them, so this
 * must run on the privileged (migration-owner/admin) connection. An identical retry is a no-op;
 * any differing existing row is a `handoff_conflict` and nothing is written.
 */
export async function admitMenuBundleHandoff(
  client: DatabaseClient,
  handoff: MenuBundleHandoff,
): Promise<'inserted' | 'already_present'> {
  return inTenantTransaction(client, handoff.tenantId, async () => {
    const key = [handoff.tenantId, handoff.menuId, handoff.menuRevisionId];
    const subject = await client.query(
      `INSERT INTO app_private.menu_review_subject
         (tenant_id, menu_id, menu_revision_id, content_approval_id, content_hash,
          asset_approval_id, asset_manifest_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, menu_id, menu_revision_id) DO NOTHING`,
      [
        ...key,
        handoff.contentApprovalId,
        handoff.contentHash,
        handoff.assetApprovalId,
        handoff.assetManifestHash,
      ],
    );
    const bundle = await client.query(
      `INSERT INTO app_private.public_menu_bundle (tenant_id, menu_id, menu_revision_id, bundle_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, menu_id, menu_revision_id) DO NOTHING`,
      [...key, handoff.bundleUrl],
    );
    const stored = await client.query<HandoffRow>(
      `SELECT s.content_approval_id, s.content_hash, s.asset_approval_id, s.asset_manifest_hash,
              b.bundle_url
         FROM app_private.menu_review_subject s
         LEFT JOIN app_private.public_menu_bundle b
           ON b.tenant_id = s.tenant_id
          AND b.menu_id = s.menu_id
          AND b.menu_revision_id = s.menu_revision_id
        WHERE s.tenant_id = $1 AND s.menu_id = $2 AND s.menu_revision_id = $3`,
      key,
    );
    const row = stored.rows[0];
    if (
      !row ||
      row.content_approval_id !== handoff.contentApprovalId ||
      row.content_hash !== handoff.contentHash ||
      row.asset_approval_id !== handoff.assetApprovalId ||
      row.asset_manifest_hash !== handoff.assetManifestHash ||
      row.bundle_url !== handoff.bundleUrl
    ) {
      throw new BundleProducerError(
        'handoff_conflict',
        `Menu revision ${handoff.menuRevisionId} is already registered with different values`,
      );
    }
    return subject.rowCount === 1 || bundle.rowCount === 1 ? 'inserted' : 'already_present';
  });
}
