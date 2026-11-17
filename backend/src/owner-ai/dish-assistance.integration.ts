import { OwnerDishFieldsSchema, ReviewCandidateResultSchema } from '@peekaplate/contracts';
import { Hono } from 'hono';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import extraction from '../../../processing/tests/fixtures/review-candidates/representative-candidates-v2.json';
import type { Bindings } from '../index';
import { saveOwnerDishDraft, setDraftRemoval } from '../owner-menu';
import { authorizeStaffVenue } from '../staff-venue';
import { registerDishAssistanceRoutes } from './dish-assistance';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;

describe.skipIf(!runtimeUrl || !adminUrl)('saved ingredient assistance (real database)', () => {
  const admin = new Client({ connectionString: adminUrl });
  const runtime = new Client({ connectionString: runtimeUrl });
  const venue = crypto.randomUUID();
  const other = crypto.randomUUID();
  const owner = crypto.randomUUID();
  const outsider = crypto.randomUUID();
  const provider = vi.fn<typeof fetch>();
  const app = new Hono<{ Bindings: Bindings }>();
  const env: Bindings = {
    APP_ENV: 'local',
    OWNER_AI_DISH_ASSISTANCE_ENABLED: 'true',
    SYNTHETIC_REPORT_VENUE_IDS: `${venue},${other}`,
  };
  app.onError((error, c) =>
    c.json({ error: 'denied' }, ('status' in error ? error.status : 500) as 403),
  );
  registerDishAssistanceRoutes(app, {
    verify: async (authorization) => authorization.slice('Bearer '.length),
    authorizeVenue: (actor, tenant) => authorizeStaffVenue(runtime, actor, tenant),
    database: async (_env, work) => work(runtime),
    approvedVenues: [venue, other],
    allowedOrigins: ['http://127.0.0.1:5174'],
    fetchImpl: provider,
  });

  beforeAll(async () => {
    await admin.connect();
    await runtime.connect();
    await admin.query(
      `INSERT INTO app_private.venues(id,name) VALUES
       ($1,'Synthetic ingredient fixture'),($2,'Other synthetic ingredient fixture')`,
      [venue, other],
    );
    await admin.query(
      `INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission)
       VALUES($1,$3,'owner'),($2,$3,'owner')`,
      [venue, other, owner],
    );
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
    expect(provider).not.toHaveBeenCalled();
  });

  const request = (draft: string, tenant = venue, actor = owner) =>
    app.request(
      `/venues/${tenant}/drafts/${draft}/ai/assist`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${actor}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'ingredients',
          requestId: crypto.randomUUID(),
          expectedVersion: 1,
          facts: {},
        }),
      },
      env,
    );

  async function manual() {
    const id = crypto.randomUUID();
    await saveOwnerDishDraft(runtime, owner, venue, id, {
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      fields: OwnerDishFieldsSchema.parse({
        name: 'Synthetic rice bowl',
        ingredients: { status: 'confirmed', items: ['Rice', 'Tomato'] },
      }),
    });
    return id;
  }

  // Only synthetic fixture setup uses the admin connection. The route reads with runtime RLS.
  async function extracted(correction?: string[], rejected = false) {
    const payload = ReviewCandidateResultSchema.parse(structuredClone(extraction));
    payload.extraction_id = `extraction:${crypto.randomUUID().replaceAll('-', '')}`;
    const candidate = payload.candidates[0]!;
    candidate.original.ingredients = ['Rice', 'Tomato'];
    candidate.missing_fields = candidate.missing_fields.filter((field) => field !== 'ingredients');
    const job = crypto.randomUUID();
    const draft = crypto.randomUUID();
    await admin.query(
      `INSERT INTO app_private.menu_ingestion_jobs
       (id,tenant_id,source_type,source_hash,idempotency_key,status,finished_at,active_review_extraction_id)
       VALUES($1,$2,'pdf',$3,$1::text,'complete',now(),$4)`,
      [job, venue, payload.source.sha256, payload.extraction_id],
    );
    await admin.query(
      `INSERT INTO app_private.extraction_review_session
       (tenant_id,extraction_id,schema_version,pipeline_version,extraction_status,
        source_id,source_sha256,job_id,payload,created_by)
       VALUES($1,$2,2,'3',$3,$4,$5,$6,$7::jsonb,$8)`,
      [
        venue,
        payload.extraction_id,
        payload.status,
        payload.source.source_id,
        payload.source.sha256,
        job,
        JSON.stringify(payload),
        owner,
      ],
    );
    await admin.query(
      `INSERT INTO app_private.dish_drafts
       (id,tenant_id,job_id,draft_id,candidate_id,draft_index,name,source_id,source_text,evidence,draft_version)
       VALUES($1,$2,$3,$1::text,$4,0,'Synthetic extracted bowl',$5,'Synthetic rice and tomato','{}',1)`,
      [draft, venue, job, candidate.candidate_id, payload.source.source_id],
    );
    if (correction !== undefined || rejected)
      await admin.query(
        `INSERT INTO app_private.candidate_review_current
         (tenant_id,extraction_id,candidate_id,stream_id,version,revision_id,
          review_status,corrected_fields,edited_fields,reviewed_by)
         VALUES($1,$2,$3,$4,1,$5,$6,$7::jsonb,$8::text[],$9)`,
        [
          venue,
          payload.extraction_id,
          candidate.candidate_id,
          crypto.randomUUID(),
          crypto.randomUUID(),
          rejected ? 'rejected' : 'corrected',
          JSON.stringify(rejected ? {} : { ingredients: correction }),
          rejected ? [] : ['ingredients'],
          owner,
        ],
      );
    return { draft, job };
  }

  it('reads saved manual proposals without changing their owner confirmation', async () => {
    const draft = await manual();
    const response = await request(draft);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'review',
      ingredients: ['Rice', 'Tomato'],
      evidence: { source: 'saved_manual_draft' },
      provenance: 'unverified',
      publishable: false,
      approvalRequired: true,
    });
    const saved = await admin.query(
      'SELECT manual_fields FROM app_private.dish_drafts WHERE id=$1',
      [draft],
    );
    expect(saved.rows[0].manual_fields.ingredients.status).toBe('confirmed');
  });

  it('joins the completed job to its source-bound extraction and current correction', async () => {
    const original = await extracted();
    expect(await (await request(original.draft)).json()).toMatchObject({
      status: 'review',
      ingredients: ['Rice', 'Tomato'],
      evidence: { source: 'saved_extraction' },
    });
    const corrected = await extracted(['Rice']);
    expect(await (await request(corrected.draft)).json()).toMatchObject({
      status: 'review',
      ingredients: ['Rice'],
      evidence: { source: 'saved_owner_correction', reviewVersion: 1 },
    });
    const cleared = await extracted([]);
    expect(await (await request(cleared.draft)).json()).toMatchObject({
      status: 'abstained',
      ingredients: [],
      evidence: null,
    });
  });

  it('withholds rejected and source-mismatched extraction proposals', async () => {
    const rejected = await extracted(undefined, true);
    expect(await (await request(rejected.draft)).json()).toMatchObject({
      status: 'abstained',
      ingredients: [],
    });
    const mismatch = await extracted();
    await admin.query('UPDATE app_private.menu_ingestion_jobs SET source_hash=$2 WHERE id=$1', [
      mismatch.job,
      'a'.repeat(64),
    ]);
    expect(await (await request(mismatch.draft)).json()).toMatchObject({
      status: 'abstained',
      ingredients: [],
    });
  });

  it('withholds an old same-hash session when the active extraction is absent', async () => {
    const { draft, job } = await extracted();
    await admin.query(
      'UPDATE app_private.menu_ingestion_jobs SET active_review_extraction_id=$2 WHERE id=$1',
      [job, `extraction:${crypto.randomUUID().replaceAll('-', '')}`],
    );
    const response = await request(draft);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'abstained',
      ingredients: [],
      evidence: null,
    });
  });

  it('denies foreign drafts, removed drafts and identities without current membership', async () => {
    const draft = await manual();
    expect((await request(draft, other)).status).toBe(409);
    expect((await request(draft, venue, outsider)).status).toBe(403);
    await setDraftRemoval(runtime, owner, venue, draft, {
      commandId: crypto.randomUUID(),
      expectedDraftVersion: 1,
      expectedRemovalVersion: 0,
      removed: true,
    });
    expect((await request(draft)).status).toBe(409);
  });
});
