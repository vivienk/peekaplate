import { createHash } from 'node:crypto';
import { type ApprovedDishFacts, ApprovedDishFactsSchema } from '@peekaplate/contracts';
import { exportJWK, generateKeyPair } from 'jose';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../ingestion/repository';
import { createPublicMenuResponse, readPublicMenu } from '../public-menu';
import { approveMenuRevision, publishMenu, withdrawMenu } from '../publication-command';
import {
  BundleProducerError,
  type ProducedMenuBundle,
  produceMenuBundle,
  type VerifiedT0Asset,
} from './produce';
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

async function seedDish(
  tenant: string,
  name = 'Charred Leeks',
  description = 'Grilled leeks.',
  facts?: ApprovedDishFacts,
) {
  const dishId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  await admin.query(
    `INSERT INTO app_private.dish_current (tenant_id, dish_id, version, revision_id, name, description, approved_facts)
     VALUES ($1, $2, 1, $3, $4, $5, $6::jsonb)`,
    [
      tenant,
      dishId,
      revisionId,
      name,
      description,
      facts ? JSON.stringify(ApprovedDishFactsSchema.parse(facts)) : null,
    ],
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
      source: {
        sha256: 'b'.repeat(64),
        capture_evidence: 'Synthetic fixture; not a real restaurant capture.',
      },
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
  it('uses immutable approved facts after later draft and candidate changes', async () => {
    for (const allergens of [null, [], ['sesame']] as ApprovedDishFacts['allergens'][]) {
      const facts = ApprovedDishFactsSchema.parse({
        category: 'Starters',
        priceAmount: '15.25',
        priceCurrency: 'USD',
        ingredients: ['Reviewed leeks'],
        allergens,
        photoId: null,
      });
      const { dishId, revisionId } = await seedDish(
        venue,
        'Charred Leeks',
        'Grilled leeks.',
        facts,
      );
      const jobId = await seedJob(venue);
      const candidateId = `candidate-${crypto.randomUUID()}`;
      await seedDraft(venue, jobId, {
        reviewStatus: 'accepted',
        publishedDishId: dishId,
        candidateId,
      });
      await seedCandidateReview(venue, jobId, candidateId, 'corrected', {
        price_amount: '29.99',
        ingredients: ['Unapproved ingredients'],
      });
      const assetId = 't0_00000000000000000000000000000001';
      const request = bundleRequest([{ dishId, assetId }]);
      request.categories[0]!.dishes[0]!.allergens = allergens === null ? ['wheat'] : null;
      const assets = new Map([[assetId, manifestFor(dishId, revisionId, 1)]]);
      const before = await produceMenuBundle(
        request,
        await loadApprovedDishSources(runtime, venue, [dishId]),
        assets,
      );
      const dish = before.bundle.categories[0]!.dishes[0]!;
      expect(dish).toMatchObject({
        complete: true,
        price: { amount: '15.25', currency: 'USD' },
        allergens,
      });
      expect(JSON.stringify(dish)).toContain('Reviewed leeks');
      await admin.query(
        `UPDATE app_private.dish_drafts SET price_amount = 99, ingredients = '["Changed draft"]'::jsonb WHERE tenant_id = $1 AND published_dish_id = $2`,
        [venue, dishId],
      );
      await admin.query(
        `UPDATE app_private.candidate_review_current SET corrected_fields = '{"price_amount":"88","ingredients":["Changed candidate"]}'::jsonb WHERE tenant_id = $1 AND candidate_id = $2`,
        [venue, candidateId],
      );
      for (const client of [runtime, admin]) {
        const after = await produceMenuBundle(
          request,
          await loadApprovedDishSources(client, venue, [dishId]),
          assets,
        );
        expect(after.bytes).toEqual(before.bytes);
        expect(after.contentHash).toBe(before.contentHash);
        expect(after.menuRevisionId).toBe(before.menuRevisionId);
      }
    }
  });

  it('loads dish and draft from one snapshot during concurrent changes', async () => {
    const { dishId } = await seedDish(venue);
    const jobId = await seedJob(venue);
    await seedDraft(venue, jobId, { reviewStatus: 'accepted', publishedDishId: dishId });
    const intercepted: DatabaseClient = {
      async query<R = Record<string, unknown>>(text: string, values?: unknown[]) {
        const result = await runtime.query(text, values);
        if (text.includes('FROM app_private.dish_current')) {
          await admin.query(
            'UPDATE app_private.dish_drafts SET price_amount = 99 WHERE published_dish_id = $1',
            [dishId],
          );
        }
        return { rows: result.rows as R[], rowCount: result.rowCount };
      },
    };
    const snapshot = await loadApprovedDishSources(intercepted, venue, [dishId]);
    expect(snapshot.get(dishId)?.priceAmount).toBe('14.5');
    expect((await loadApprovedDishSources(runtime, venue, [dishId])).get(dishId)?.priceAmount).toBe(
      '99',
    );
  });

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

  it('keeps a corrected candidate with remaining incomplete fields as a placeholder', async () => {
    const { dishId, revisionId } = await seedDish(venue);
    const jobId = await seedJob(venue);
    await seedDraft(venue, jobId, {
      reviewStatus: 'accepted',
      publishedDishId: dishId,
      candidateId: 'cand-partial-correction',
    });
    await seedCandidateReview(venue, jobId, 'cand-partial-correction', 'corrected', {
      ingredients: ['Corrected ingredient'],
    });
    await admin.query(
      `UPDATE app_private.candidate_review_current SET incomplete_fields = ARRAY['price_amount']
       WHERE tenant_id = $1 AND candidate_id = $2`,
      [venue, 'cand-partial-correction'],
    );
    const loaded = await loadApprovedDishSources(admin, venue, [dishId]);
    expect(loaded.get(dishId)?.reviewState).toBe('incomplete');
    const produced = await produceMenuBundle(
      bundleRequest([{ dishId, assetId: 't0_00000000000000000000000000000001' }]),
      loaded,
      new Map([['t0_00000000000000000000000000000001', manifestFor(dishId, revisionId, 1)]]),
    );
    expect(produced.bundle.categories[0]?.dishes).toEqual([
      { dish_id: dishId, dish_revision_id: revisionId, complete: false },
    ]);
    expect(produced.diagnostics).toContainEqual({ dishId, code: 'review_incomplete' });
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

describe('S6-RES-04 synthetic publication handoff', () => {
  it('delivers produced T0 revisions through approval publication replacement and withdrawal', async () => {
    const owner = crypto.randomUUID();
    const foreignOwner = crypto.randomUUID();
    await admin.query(
      `INSERT INTO app_private.staff_membership (tenant_id, actor_id, permission)
       VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
      [venue, owner, otherVenue, foreignOwner],
    );
    const facts = ApprovedDishFactsSchema.parse({
      category: 'Starters',
      priceAmount: '15.25',
      priceCurrency: 'USD',
      ingredients: ['Reviewed leeks'],
      allergens: null,
      photoId: null,
    });
    const { dishId, revisionId } = await seedDish(venue, 'Charred Leeks', 'Grilled leeks.', facts);
    const jobId = await seedJob(venue);
    const candidateId = `private-candidate-${crypto.randomUUID()}`;
    await seedDraft(venue, jobId, {
      reviewStatus: 'accepted',
      publishedDishId: dishId,
      candidateId,
    });
    await seedCandidateReview(venue, jobId, candidateId, 'corrected', { price_amount: '99' });
    const assetId = 't0_00000000000000000000000000000001';
    const request = bundleRequest([{ dishId, assetId }]);
    request.categories[0]!.dishes[0]!.dietary = ['vegetarian'];
    const makeBundle = async (revision: string) =>
      produceMenuBundle(
        request,
        await loadApprovedDishSources(runtime, venue, [dishId]),
        new Map([[assetId, manifestFor(dishId, revision, 1)]]),
      );
    const admit = async (produced: ProducedMenuBundle) =>
      admitMenuBundleHandoff(admin, {
        tenantId: venue,
        menuId: request.menu_id,
        menuRevisionId: produced.menuRevisionId,
        contentApprovalId: produced.contentApprovalId,
        contentHash: produced.contentHash,
        assetApprovalId: produced.assetApprovalId,
        assetManifestHash: produced.assetManifestHash,
        bundleUrl: produced.bundleUrl,
      });
    const approve = async (produced: ProducedMenuBundle, expectedVersion: number) =>
      approveMenuRevision(runtime, owner, venue, {
        menuId: request.menu_id,
        commandId: crypto.randomUUID(),
        expectedVersion,
        menuRevisionId: produced.menuRevisionId,
        contentApprovalId: produced.contentApprovalId,
        assetApprovalId: produced.assetApprovalId,
      });
    const keys = await generateKeyPair('ES256', { extractable: true });
    const config = {
      issuer: 'https://api.example.test',
      signingJwk: JSON.stringify({
        ...(await exportJWK(keys.privateKey)),
        kid: 'synthetic',
        alg: 'ES256',
        use: 'sig',
      }),
      trafficClass: 'test' as const,
    };
    const a = await makeBundle(revisionId);
    expect(await readPublicMenu(runtime, venue, request.menu_id)).toBeUndefined();
    expect(await admit(a)).toBe('inserted');
    expect(await readPublicMenu(runtime, venue, request.menu_id)).toBeUndefined();
    const approvalA = await approve(a, 0);
    expect(await readPublicMenu(runtime, venue, request.menu_id)).toBeUndefined();
    const publicationA = await publishMenu(runtime, owner, venue, {
      menuId: request.menu_id,
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      approvalId: approvalA.approvalId,
    });
    const retainedA = new Uint8Array(a.bytes);
    const hostedBytes = new Map([[a.bundleUrl, new Uint8Array(a.bytes)]]);
    let servedBytes: Uint8Array | undefined;
    let pointerOverride: { menuRevisionId?: string; contentHash?: string } = {};
    let bundleFetches = 0;
    const deliveries: string[] = [];
    // Load the browser adapter at runtime without adding DOM globals to the Worker typecheck.
    const dinerAdapterPath = '../../../frontend/diner/src/menu/published';
    const { createPublishedMenuSource } = await import(dinerAdapterPath);
    const fetcher = async (input: string | URL | Request) => {
      if (String(input).startsWith('https://api.example.test/')) {
        const pointer = await readPublicMenu(runtime, venue, request.menu_id);
        if (!pointer) return new Response(null, { status: 404 });
        const response = await createPublicMenuResponse(pointer, config);
        return Response.json({
          ...response,
          menuRevisionId: pointerOverride.menuRevisionId ?? response.menuRevisionId,
          bundle: {
            ...response.bundle,
            contentHash: pointerOverride.contentHash ?? response.bundle.contentHash,
          },
        });
      }
      bundleFetches++;
      const bytes = servedBytes ?? hostedBytes.get(String(input));
      return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
    };
    const source = createPublishedMenuSource({
      apiBase: 'https://api.example.test',
      venueId: venue,
      menuId: request.menu_id,
      onDelivery: (delivery: { publicationId: string }) => deliveries.push(delivery.publicationId),
      fetcher,
    });
    const loadedA = await source.load();
    expect(loadedA.status).toBe('ready');
    if (loadedA.status !== 'ready') throw new Error('Expected published menu A');
    expect(loadedA.menu).toMatchObject({
      venueId: venue,
      menuId: request.menu_id,
      menuRevisionId: a.menuRevisionId,
      publicationRevisionId: publicationA.publicationId,
      categories: [
        {
          dishes: [
            {
              name: 'Charred Leeks',
              price: { amount: '15.25', currency: 'USD' },
              ingredients: [{ name: 'Reviewed leeks' }],
              allergens: [],
              dietary: ['Vegetarian'],
              images: {
                card: {
                  url: `https://assets.example.test/t0/${assetId}/card-480.webp`,
                  width: 480,
                  height: 360,
                  alt: 'Synthetic dish photo',
                },
                detail: {
                  url: `https://assets.example.test/t0/${assetId}/detail-1280.webp`,
                  width: 1280,
                  height: 960,
                  alt: 'Synthetic dish photo',
                },
              },
            },
          ],
        },
      ],
    });
    expect(a.bundle.categories[0]?.dishes[0]).toMatchObject({ allergens: null });
    expect(JSON.stringify(loadedA.menu)).not.toMatch(/private source text|private reviewer note/);
    expect(deliveries).toEqual([publicationA.publicationId]);
    expect(new TextDecoder().decode(a.bytes)).not.toMatch(
      /private source text|private reviewer note/,
    );
    const nextRevision = crypto.randomUUID();
    await admin.query(
      `UPDATE app_private.dish_current SET version = version + 1, revision_id = $3, name = 'Roasted Leeks', approved_facts = $4::jsonb
       WHERE tenant_id = $1 AND dish_id = $2`,
      [
        venue,
        dishId,
        nextRevision,
        JSON.stringify({
          ...facts,
          priceAmount: '18.75',
          ingredients: ['New leeks'],
          allergens: ['sesame'],
        }),
      ],
    );
    const b = await makeBundle(nextRevision);
    hostedBytes.set(b.bundleUrl, new Uint8Array(b.bytes));
    expect(b.menuRevisionId).not.toBe(a.menuRevisionId);
    expect(b.bundleUrl).not.toBe(a.bundleUrl);
    expect(b.contentHash).not.toBe(a.contentHash);
    expect(await admit(b)).toBe('inserted');
    const approvalB = await approve(b, approvalA.version);
    const publicationB = await publishMenu(runtime, owner, venue, {
      menuId: request.menu_id,
      commandId: crypto.randomUUID(),
      expectedVersion: publicationA.version,
      approvalId: approvalB.approvalId,
    });
    expect(publicationB.publicationId).not.toBe(publicationA.publicationId);
    servedBytes = a.bytes;
    deliveries.length = 0;
    expect(await source.load()).toEqual({ status: 'error' });
    expect(deliveries).toEqual([]);
    servedBytes = new TextEncoder().encode(`${new TextDecoder().decode(b.bytes)} `);
    expect(await source.load()).toEqual({ status: 'error' });
    expect(deliveries).toEqual([]);
    const wrong = { ...b.bundle, menu_revision_id: crypto.randomUUID() };
    servedBytes = new TextEncoder().encode(JSON.stringify(wrong));
    pointerOverride = { contentHash: createHash('sha256').update(servedBytes).digest('hex') };
    expect(await source.load()).toEqual({ status: 'error' });
    expect(deliveries).toEqual([]);
    servedBytes = undefined;
    pointerOverride = {};
    const loadedB = await source.load();
    expect(loadedB.status).toBe('ready');
    if (loadedB.status !== 'ready') throw new Error('Expected published menu B');
    expect(loadedB.menu).toMatchObject({
      menuRevisionId: b.menuRevisionId,
      publicationRevisionId: publicationB.publicationId,
      categories: [
        {
          dishes: [
            {
              name: 'Roasted Leeks',
              price: { amount: '18.75', currency: 'USD' },
              ingredients: [{ name: 'New leeks' }],
              allergens: ['Sesame'],
              dietary: ['Vegetarian'],
            },
          ],
        },
      ],
    });
    expect(deliveries).toEqual([publicationB.publicationId]);
    expect(new Uint8Array(await (await fetcher(a.bundleUrl)).arrayBuffer())).toEqual(retainedA);
    const pointerBeforeDenial = await readPublicMenu(runtime, venue, request.menu_id);
    const forbiddenApproval = {
      menuId: request.menu_id,
      commandId: crypto.randomUUID(),
      expectedVersion: approvalB.version,
      menuRevisionId: b.menuRevisionId,
      contentApprovalId: b.contentApprovalId,
      assetApprovalId: b.assetApprovalId,
    };
    await expect(
      approveMenuRevision(runtime, foreignOwner, venue, forbiddenApproval),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(
      publishMenu(runtime, foreignOwner, venue, {
        menuId: request.menu_id,
        commandId: crypto.randomUUID(),
        expectedVersion: publicationB.version,
        approvalId: approvalB.approvalId,
      }),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(
      withdrawMenu(runtime, foreignOwner, venue, {
        menuId: request.menu_id,
        commandId: crypto.randomUUID(),
        expectedVersion: publicationB.version,
      }),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(await readPublicMenu(runtime, venue, request.menu_id)).toEqual(pointerBeforeDenial);
    expect(await readPublicMenu(runtime, otherVenue, request.menu_id)).toBeUndefined();
    await withdrawMenu(runtime, owner, venue, {
      menuId: request.menu_id,
      commandId: crypto.randomUUID(),
      expectedVersion: publicationB.version,
    });
    expect(await readPublicMenu(runtime, venue, request.menu_id)).toBeUndefined();
    const fetchedBeforeWithdrawal = bundleFetches;
    deliveries.length = 0;
    expect(await source.load()).toEqual({ status: 'unavailable' });
    expect(bundleFetches).toBe(fetchedBeforeWithdrawal);
    expect(deliveries).toEqual([]);
  });
});
