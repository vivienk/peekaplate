import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BundleProducerError, produceMenuBundle, type VerifiedT0Asset } from './produce';
import {
  admitMenuBundleHandoff,
  loadApprovedDishSources,
  type MenuBundleHandoff,
} from './repository';
import { MenuBundleRequestSchema, T0AssetManifestSchema } from './request';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;
if (!runtimeUrl || !adminUrl)
  throw new Error('Run pnpm verify test:db with its disposable database');

const admin = new Client({ connectionString: adminUrl });
const runtime = new Client({ connectionString: runtimeUrl });
const venue = crypto.randomUUID();
const otherVenue = crypto.randomUUID();
const reviewer = crypto.randomUUID();

async function seedDish(tenant: string, name = 'Charred Leeks', description = 'Grilled leeks.') {
  const dishId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  await admin.query(
    `INSERT INTO app_private.dish_current (tenant_id, dish_id, version, revision_id, name, description)
     VALUES ($1, $2, 1, $3, $4, $5)`,
    [tenant, dishId, revisionId, name, description],
  );
  return { dishId, revisionId };
}

async function seedJob(tenant: string) {
  const jobId = crypto.randomUUID();
  await admin.query(
    `INSERT INTO app_private.menu_ingestion_jobs (id, tenant_id, source_type, idempotency_key)
     VALUES ($1, $2, 'text', $3)`,
    [jobId, tenant, `bundle-producer-${jobId}`],
  );
  return jobId;
}

let draftIndex = 0;
async function seedDraft(
  tenant: string,
  jobId: string,
  draft: {
    reviewStatus: 'pending' | 'accepted' | 'rejected' | 'edited' | 'superseded';
    publishedDishId?: string | null;
    candidateId?: string | null;
    priceAmount?: string | null;
    priceText?: string | null;
  },
) {
  draftIndex += 1;
  const reviewed = draft.reviewStatus !== 'pending';
  await admin.query(
    `INSERT INTO app_private.dish_drafts
       (id, tenant_id, job_id, draft_id, candidate_id, draft_index, name, price_text, price_amount,
        price_currency, ingredients, source_id, source_text, evidence, review_status, reviewed_by,
        reviewed_at, published_dish_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'Draft name', $7, $8, 'USD', $9::jsonb, 'source-1',
             'Leeks 14.5 private source text', '{"page": 1}'::jsonb, $10, $11, $12, $13)`,
    [
      crypto.randomUUID(),
      tenant,
      jobId,
      `draft-${draftIndex}`,
      draft.candidateId ?? null,
      draftIndex,
      draft.priceText ?? null,
      draft.priceAmount ?? '14.5',
      JSON.stringify(['Leeks', 'Hazelnut romesco']),
      draft.reviewStatus,
      reviewed ? reviewer : null,
      reviewed ? new Date().toISOString() : null,
      draft.publishedDishId ?? null,
    ],
  );
}

async function seedCandidateReview(
  tenant: string,
  jobId: string,
  candidateId: string,
  status: 'corrected' | 'rejected' | 'incomplete',
  corrected: Record<string, unknown> = {},
) {
  const extractionId = `extraction-${crypto.randomUUID()}`;
  const sha = 'c'.repeat(64);
  await admin.query(
    `INSERT INTO app_private.extraction_review_session
       (tenant_id, extraction_id, schema_version, pipeline_version, extraction_status, source_id,
        source_sha256, job_id, payload, created_by)
     VALUES ($1, $2, 2, '3', 'complete', $3, $4, $5, '{}'::jsonb, $6)`,
    [tenant, extractionId, `sha256:${sha}`, sha, jobId, reviewer],
  );
  await admin.query(
    `INSERT INTO app_private.candidate_review_current
       (tenant_id, extraction_id, candidate_id, stream_id, version, revision_id, review_status,
        corrected_fields, edited_fields, incomplete_fields, review_note, reviewed_by)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7::jsonb, $8, $9, 'private reviewer note', $10)`,
    [
      tenant,
      extractionId,
      candidateId,
      crypto.randomUUID(),
      crypto.randomUUID(),
      status,
      JSON.stringify(corrected),
      status === 'corrected' ? Object.keys(corrected) : [],
      status === 'incomplete' ? ['price_amount'] : [],
      reviewer,
    ],
  );
}

function manifestFor(dishId: string, revisionId: string, n: number): VerifiedT0Asset {
  return {
    manifest: T0AssetManifestSchema.parse({
      schema_version: 1,
      asset_id: `t0_${String(n).padStart(32, '0')}`,
      tier: 'T0',
      dish: { dish_id: dishId, revision_id: revisionId },
      variants: (['card-480', 'detail-1280'] as const).flatMap((name, index) =>
        (['webp', 'jpeg'] as const).map((format) => ({
          name,
          format,
          path: `${name}.${format === 'webp' ? 'webp' : 'jpg'}`,
          sha256: `${index}${format}`.padEnd(64, '0').replace(/[^0-9a-f]/g, 'e'),
          size_bytes: 1000,
          width: index === 0 ? 480 : 1280,
          height: index === 0 ? 360 : 960,
        })),
      ),
    }),
  };
}

function bundleRequest(dishes: { dishId: string; assetId: string | null }[]) {
  return MenuBundleRequestSchema.parse({
    schema_version: 1,
    venue_id: venue,
    menu_id: crypto.randomUUID(),
    restaurant: { name: 'Synthetic Bistro', logo: null },
    bundle_base_url: 'https://bundles.example.test/menus',
    asset_base_url: 'https://assets.example.test/t0',
    categories: [
      {
        category_id: crypto.randomUUID(),
        name: 'Starters',
        dishes: dishes.map(({ dishId, assetId }) => ({
          dish_id: dishId,
          allergens: null,
          dietary: [],
          image_alt: 'Synthetic dish photo',
          t0_asset_id: assetId,
        })),
      },
    ],
  });
}

async function producerCode(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  if (!(error instanceof BundleProducerError)) throw error;
  return error.code;
}

async function handoffRows(menuId: string) {
  const result = await admin.query<{ subjects: number; bundles: number }>(
    `SELECT
       (SELECT count(*)::int FROM app_private.menu_review_subject WHERE menu_id = $1) AS subjects,
       (SELECT count(*)::int FROM app_private.public_menu_bundle WHERE menu_id = $1) AS bundles`,
    [menuId],
  );
  return result.rows[0];
}

beforeAll(async () => {
  await admin.connect();
  await runtime.connect();
  await admin.query('INSERT INTO app_private.venues (id, name) VALUES ($1, $3), ($2, $3)', [
    venue,
    otherVenue,
    'Synthetic bundle producer venue',
  ]);
});

afterAll(async () => {
  await runtime.end();
  await admin.end();
});

describe('S4-RES bundle producer database sources', () => {
  it('uses the accepted draft with its RES-01.2 correction and ignores unlinked drafts', async () => {
    const { dishId, revisionId } = await seedDish(venue);
    const jobId = await seedJob(venue);
    await seedDraft(venue, jobId, { reviewStatus: 'pending' });
    await seedDraft(venue, jobId, { reviewStatus: 'superseded' });
    await seedDraft(venue, jobId, { reviewStatus: 'rejected' });
    await seedDraft(venue, jobId, {
      reviewStatus: 'accepted',
      publishedDishId: dishId,
      candidateId: 'cand-leeks',
      priceText: '$14.50',
    });
    await seedCandidateReview(venue, jobId, 'cand-leeks', 'corrected', { price_amount: '15.25' });

    for (const client of [runtime, admin]) {
      const sources = await loadApprovedDishSources(client, venue, [dishId]);
      expect(sources.get(dishId)).toEqual({
        dishId,
        dishRevisionId: revisionId,
        name: 'Charred Leeks',
        description: 'Grilled leeks.',
        priceAmount: '15.25',
        priceCurrency: 'USD',
        ingredients: ['Leeks', 'Hazelnut romesco'],
        reviewState: 'corrected',
      });
    }

    const sources = await loadApprovedDishSources(admin, venue, [dishId]);
    const produced = await produceMenuBundle(
      bundleRequest([{ dishId, assetId: 't0_00000000000000000000000000000001' }]),
      sources,
      new Map([['t0_00000000000000000000000000000001', manifestFor(dishId, revisionId, 1)]]),
    );
    const text = new TextDecoder().decode(produced.bytes);
    expect(text).toContain('"amount":"15.25"');
    for (const forbidden of [
      'private source text',
      'private reviewer note',
      '$14.50',
      'cand-leeks',
      reviewer,
      jobId,
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('omits a dish whose RES-01.2 review rejected the candidate', async () => {
    const { dishId } = await seedDish(venue);
    const jobId = await seedJob(venue);
    await seedDraft(venue, jobId, {
      reviewStatus: 'accepted',
      publishedDishId: dishId,
      candidateId: 'cand-rejected',
    });
    await seedCandidateReview(venue, jobId, 'cand-rejected', 'rejected');

    const sources = await loadApprovedDishSources(runtime, venue, [dishId]);
    expect(sources.get(dishId)?.reviewState).toBe('rejected');
    const produced = await produceMenuBundle(
      bundleRequest([{ dishId, assetId: null }]),
      sources,
      new Map(),
    );
    expect(produced.bundle.categories[0]?.dishes).toEqual([]);
    expect(produced.diagnostics).toEqual([{ dishId, code: 'candidate_rejected' }]);
  });

  it("cannot read another venue's dish on either connection", async () => {
    const { dishId } = await seedDish(otherVenue, 'Other venue dish');
    for (const client of [runtime, admin]) {
      const sources = await loadApprovedDishSources(client, venue, [dishId]);
      expect(sources.size).toBe(0);
      expect(
        await producerCode(
          produceMenuBundle(bundleRequest([{ dishId, assetId: null }]), sources, new Map()),
        ),
      ).toBe('dish_not_found');
    }
  });

  it('refuses a dish published from two accepted drafts', async () => {
    const { dishId } = await seedDish(venue);
    const jobId = await seedJob(venue);
    await seedDraft(venue, jobId, { reviewStatus: 'accepted', publishedDishId: dishId });
    await seedDraft(venue, jobId, { reviewStatus: 'edited', publishedDishId: dishId });
    expect(await producerCode(loadApprovedDishSources(admin, venue, [dishId]))).toBe(
      'ambiguous_dish_source',
    );
  });
});

describe('S4-RES privileged handoff admission', () => {
  function handoff(overrides: Partial<MenuBundleHandoff> = {}): MenuBundleHandoff {
    const menuId = overrides.menuId ?? crypto.randomUUID();
    const menuRevisionId = overrides.menuRevisionId ?? crypto.randomUUID();
    return {
      tenantId: venue,
      menuId,
      menuRevisionId,
      contentApprovalId: crypto.randomUUID(),
      contentHash: 'd'.repeat(64),
      assetApprovalId: crypto.randomUUID(),
      assetManifestHash: 'e'.repeat(64),
      bundleUrl: `https://bundles.example.test/menus/${venue}/${menuId}/${menuRevisionId}.json`,
      ...overrides,
    };
  }

  it('inserts once, accepts an identical retry and rejects a conflicting one atomically', async () => {
    const first = handoff();
    expect(await admitMenuBundleHandoff(admin, first)).toBe('inserted');
    expect(await handoffRows(first.menuId)).toEqual({ subjects: 1, bundles: 1 });
    expect(await admitMenuBundleHandoff(admin, first)).toBe('already_present');

    expect(
      await producerCode(admitMenuBundleHandoff(admin, { ...first, contentHash: 'f'.repeat(64) })),
    ).toBe('handoff_conflict');
    expect(
      await producerCode(
        admitMenuBundleHandoff(admin, { ...first, bundleUrl: 'https://other.example.test/x.json' }),
      ),
    ).toBe('handoff_conflict');
    expect(await handoffRows(first.menuId)).toEqual({ subjects: 1, bundles: 1 });

    const stored = await admin.query(
      'SELECT content_hash FROM app_private.menu_review_subject WHERE menu_id = $1',
      [first.menuId],
    );
    expect(stored.rows).toEqual([{ content_hash: 'd'.repeat(64) }]);
  });

  it('is refused for the runtime role and writes nothing', async () => {
    const attempt = handoff();
    const error = await admitMenuBundleHandoff(runtime, attempt).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: '42501' });
    expect(await handoffRows(attempt.menuId)).toEqual({ subjects: 0, bundles: 0 });
  });
});
