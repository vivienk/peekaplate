import { OwnerDishFieldsSchema, type PlateCalibration } from '@peekaplate/contracts';
import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { type DishEvent, replayDish } from './dish-command';
import { approveDishDraftAtomic } from './index';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const venue = id(1),
  actor = id(2),
  draftId = id(3),
  photoId = id(4);
const extractionId = 'synthetic-legacy-review';
const plate: PlateCalibration = {
  shape: 'round',
  width_mm: 280,
  depth_mm: 280,
  source_sha256: 'a'.repeat(64),
  source_width_px: 800,
  source_height_px: 600,
  boundary: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
  confirmed: true,
};
type ServingEvidence = { legacySize: string; count?: number | null; calibrated?: boolean };

// Exercise the real approval, revision creation and replay functions. Only PostgreSQL I/O is
// replaced, so the same freshness checks and facts passed to event/projection writes execute.
function database(origin: 'manual' | 'extracted', evidence: ServingEvidence) {
  const events: DishEvent[] = [];
  const commands = new Map<string, { request_hash: string; result: unknown }>();
  let approvedFacts: unknown;
  const corrected = {
    serving_size: evidence.legacySize,
    ...(evidence.count === undefined ? {} : { serving_count: evidence.count }),
    ...(evidence.calibrated ? { photo_id: photoId, portion_calibration: plate } : {}),
  };
  const draft = {
    id: draftId,
    tenant_id: venue,
    origin,
    draft_id: 'synthetic-candidate',
    candidate_id: 'synthetic-candidate',
    job_id: origin === 'extracted' ? id(5) : null,
    draft_version: 1,
    verification_status: 'verified',
    review_status: 'pending',
    removed_at: null,
    name: 'Synthetic soup',
    description: 'Synthetic reviewed dish.',
    category: 'Soups',
    price_amount: '9',
    price_currency: 'USD',
    ingredients: ['lentils'],
    manual_fields:
      origin === 'manual'
        ? OwnerDishFieldsSchema.parse({
            name: 'Synthetic soup',
            category: 'Soups',
            priceAmount: '9',
            priceCurrency: 'USD',
            servingSize: evidence.legacySize,
            ...(evidence.count === undefined ? {} : { servingCount: evidence.count }),
            ...(evidence.calibrated ? { photoId, portionCalibration: plate } : {}),
          })
        : null,
  };
  const query = vi.fn(async (statement: string, params: unknown[] = []) => {
    const sql = statement.replace(/\s+/g, ' ').trim();
    if (
      /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql) ||
      sql.includes('set_config') ||
      sql.includes('pg_advisory_xact_lock')
    )
      return { rows: [] };
    if (sql.includes('FROM app_private.staff_membership'))
      return { rows: [{ permission: 'owner' }] };
    if (sql.startsWith('SELECT request_hash, result')) {
      const receipt = commands.get(params[2] as string);
      return { rows: receipt ? [receipt] : [] };
    }
    if (sql.startsWith('SELECT job_id FROM app_private.dish_drafts'))
      return { rows: [{ job_id: draft.job_id }] };
    if (sql.includes('FROM app_private.menu_ingestion_jobs'))
      return {
        rows: [
          {
            status: 'complete',
            active_review_extraction_id: extractionId,
            result_storage_key: 'synthetic/report',
            review_result_storage_key: 'synthetic/report',
          },
        ],
      };
    if (sql.startsWith('SELECT * FROM app_private.dish_drafts'))
      return { rows: [structuredClone(draft)] };
    if (sql.includes('FROM app_private.extraction_review_session'))
      return { rows: [{ extraction_id: extractionId }] };
    if (sql.includes('FROM app_private.candidate_review_current'))
      return {
        rows: [
          {
            version: 1,
            review_status: 'corrected',
            corrected_fields: corrected,
            incomplete_fields: [],
          },
        ],
      };
    if (sql.includes('FROM app_private.dish_draft_photo'))
      return { rowCount: 1, rows: [{ id: photoId, source_hash: plate.source_sha256 }] };
    if (sql.includes('FROM app_private.dish_current')) return { rows: [] };
    if (sql.startsWith('INSERT INTO app_private.es_event')) {
      events.push({
        tenantId: params[1] as string,
        streamType: 'dish',
        streamId: params[2] as string,
        version: params[3] as number,
        schemaVersion: params[6] as number,
        eventType: 'dish.revision.created',
        payload: JSON.parse(params[4] as string),
        metadata: JSON.parse(params[5] as string),
      });
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO app_private.dish_current')) {
      approvedFacts = JSON.parse(params[6] as string);
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO app_private.es_command')) {
      commands.set(params[3] as string, {
        request_hash: params[5] as string,
        result: JSON.parse(params[6] as string),
      });
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO app_private.outbox')) return { rows: [] };
    if (sql.startsWith('UPDATE app_private.dish_drafts')) {
      draft.review_status = 'accepted';
      return { rows: [{ ...draft, published_dish_id: params[1] }] };
    }
    throw new Error(`Unexpected synthetic approval query: ${sql.slice(0, 80)}`);
  });
  const approve = () =>
    approveDishDraftAtomic({ query } as unknown as Client, actor, venue, draftId, {
      commandId: id(6),
      expectedDraftVersion: 1,
      confirmed: true,
      preparedDishId: id(7),
      ...(origin === 'extracted' ? { extractionId, expectedReviewVersion: 1 } : {}),
    });
  return { approve, events, draft, corrected, query, facts: () => approvedFacts };
}

describe.each(['manual', 'extracted'] as const)(
  '%s legacy serving count at explicit approval',
  (origin) => {
    it('publishes the numeric legacy count seen in review without reopening or resaving the draft', async () => {
      const db = database(origin, { legacySize: '2' });
      const approved = await db.approve();
      expect(approved.publishedRevision.facts?.servingCount).toBe(2);
      expect(db.facts()).toMatchObject({ servingCount: 2, servingSize: '2' });
      expect(replayDish(db.events)?.facts).toEqual(approved.publishedRevision.facts);
      expect(await db.approve()).toEqual(approved);
      expect(db.events).toHaveLength(1);
      if (origin === 'manual') expect(db.draft.manual_fields).not.toHaveProperty('servingCount');
      else expect(db.corrected).not.toHaveProperty('serving_count');
    });

    it.each([
      { evidence: { legacySize: '2', count: null }, expected: null },
      { evidence: { legacySize: '2', count: 3 }, expected: 3 },
      { evidence: { legacySize: '28', calibrated: true }, expected: undefined },
      { evidence: { legacySize: '2 bowls' }, expected: undefined },
      { evidence: { legacySize: '2.5' }, expected: undefined },
    ])(
      'preserves explicit counts and unknown legacy evidence: %j',
      async ({ evidence, expected }) => {
        const db = database(origin, evidence);
        const approved = await db.approve();
        expect(approved.publishedRevision.facts?.servingCount).toBe(expected);
        if (expected === undefined) expect(db.facts()).not.toHaveProperty('servingCount');
        if (evidence.calibrated)
          expect(approved.publishedRevision.facts?.portionCalibration).toEqual(plate);
      },
    );
  },
);
