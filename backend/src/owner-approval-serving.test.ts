import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import {
  type CandidateCorrectedFields,
  OwnerDishFieldsSchema,
  type PlateCalibration,
  type ReviewEditableField,
} from '@peekaplate/contracts';
import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { type DishEvent, replayDish } from './dish-command';
import { approveDishDraftAtomic } from './index';
import { saveOwnerDishDraft } from './owner-menu';
import { saveCandidateReviewCommand } from './review-command';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const venue = id(1),
  actor = id(2),
  draftId = id(3),
  photoId = id(4);
const extraction = JSON.parse(
  readFileSync(
    new URL(
      '../../processing/tests/fixtures/review-candidates/representative-candidates-v2.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const extractionId: string = extraction.extraction_id;
const candidateId: string = extraction.candidates[0].candidate_id;
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
  let corrected: CandidateCorrectedFields = {
    serving_size: evidence.legacySize,
    ...(evidence.count === undefined ? {} : { serving_count: evidence.count }),
    ...(evidence.calibrated ? { photo_id: photoId, portion_calibration: plate } : {}),
  };
  let reviewVersion = 1;
  let reviewStatus = 'corrected';
  let incompleteFields: ReviewEditableField[] = [];
  const draft = {
    id: draftId,
    tenant_id: venue,
    origin,
    draft_id: candidateId,
    candidate_id: candidateId,
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
    if (sql.startsWith('SELECT id,removed_at,review_status FROM app_private.dish_drafts'))
      return { rows: [structuredClone(draft)] };
    if (sql.includes('FROM app_private.extraction_review_session'))
      return { rows: [{ extraction_id: extractionId, job_id: draft.job_id, payload: extraction }] };
    if (sql.includes('FROM app_private.candidate_review_current'))
      return {
        rows: [
          {
            version: reviewVersion,
            review_status: reviewStatus,
            corrected_fields: corrected,
            incomplete_fields: incompleteFields,
          },
        ],
      };
    if (sql.includes('FROM app_private.dish_draft_photo')) {
      const selected = sql.includes('JOIN app_private.dish_drafts') ? params[1] : params[2];
      const rows = [photoId, id(8)].includes(selected as string)
        ? [
            {
              id: selected,
              source_hash: selected === photoId ? plate.source_sha256 : 'b'.repeat(64),
            },
          ]
        : [];
      return { rowCount: rows.length, rows };
    }
    if (sql.includes('FROM app_private.dish_current')) return { rows: [] };
    if (sql.startsWith('INSERT INTO app_private.es_event')) {
      if (!sql.includes("'dish.revision.created'")) return { rows: [] };
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
    if (sql.startsWith('INSERT INTO app_private.dish_drafts')) {
      draft.manual_fields = OwnerDishFieldsSchema.parse(JSON.parse(params[9] as string));
      draft.draft_version = params[8] as number;
      draft.verification_status = 'not_verified';
      return { rows: [structuredClone(draft)] };
    }
    if (sql.startsWith('UPDATE app_private.candidate_review_current')) {
      reviewVersion = params[3] as number;
      reviewStatus = params[5] as string;
      corrected = JSON.parse(params[6] as string);
      incompleteFields = params[8] as ReviewEditableField[];
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE app_private.dish_drafts SET draft_version=draft_version+1')) {
      draft.draft_version++;
      draft.verification_status = 'not_verified';
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE app_private.dish_drafts')) {
      draft.review_status = 'accepted';
      return { rows: [{ ...draft, published_dish_id: params[1] }] };
    }
    throw new Error(`Unexpected synthetic approval query: ${sql.slice(0, 80)}`);
  });
  const client = { query } as unknown as Client;
  const approve = (prepared = true) =>
    approveDishDraftAtomic(client, actor, venue, draftId, {
      commandId: id(6),
      expectedDraftVersion: draft.draft_version,
      confirmed: true,
      ...(prepared ? { preparedDishId: id(7) } : {}),
      ...(origin === 'extracted' ? { extractionId, expectedReviewVersion: reviewVersion } : {}),
    });
  return {
    approve,
    events,
    draft,
    get corrected() {
      return corrected;
    },
    client,
    query,
    facts: () => approvedFacts,
  };
}

describe.each(['manual', 'extracted'] as const)(
  '%s legacy serving count at explicit approval',
  (origin) => {
    it.each(['withdraw', 'replace_photo'] as const)(
      'keeps calibrated legacy text unknown through %s, approval and replay',
      async (change) => {
        const db = database(origin, { legacySize: '28', calibrated: true });
        if (origin === 'manual') {
          const fields = { ...db.draft.manual_fields! };
          delete fields.portionCalibration;
          if (change === 'withdraw') fields.portionCalibration = null;
          else fields.photoId = id(8);
          await saveOwnerDishDraft(db.client, actor, venue, draftId, {
            commandId: id(10),
            expectedVersion: 1,
            fields,
          });
        } else {
          await saveCandidateReviewCommand(db.client, actor, venue, extractionId, candidateId, {
            commandId: id(10),
            expectedVersion: 1,
            action: 'correct',
            corrected: change === 'withdraw' ? { portion_calibration: null } : { photo_id: id(8) },
          });
        }
        const approved = await db.approve(false);
        expect(approved.publishedRevision.facts).toMatchObject({
          servingSize: '28',
          servingCount: null,
        });
        expect(replayDish(db.events)?.facts).toMatchObject({
          servingSize: '28',
          servingCount: null,
        });
        expect(await db.approve(false)).toEqual(approved);
        expect(db.events).toHaveLength(1);
      },
    );

    it('accepts an explicit people count when withdrawing old measurements', async () => {
      const db = database(origin, { legacySize: '28', calibrated: true });
      if (origin === 'manual') {
        await saveOwnerDishDraft(db.client, actor, venue, draftId, {
          commandId: id(10),
          expectedVersion: 1,
          fields: { ...db.draft.manual_fields!, servingCount: 2, portionCalibration: null },
        });
      } else {
        await saveCandidateReviewCommand(db.client, actor, venue, extractionId, candidateId, {
          commandId: id(10),
          expectedVersion: 1,
          action: 'correct',
          corrected: { portion_calibration: null, serving_count: 2 },
        });
      }
      const approved = await db.approve(false);
      expect(approved.publishedRevision.facts?.servingCount).toBe(2);
    });

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

describe('calibrated legacy count through incomplete extracted review', () => {
  it('keeps the count unknown when incomplete measurements are explicitly withdrawn before approval', async () => {
    const db = database('extracted', { legacySize: '28', calibrated: true });
    const incomplete = await saveCandidateReviewCommand(
      db.client,
      actor,
      venue,
      extractionId,
      candidateId,
      {
        commandId: id(10),
        expectedVersion: 1,
        action: 'mark_incomplete',
        incompleteFields: ['portion_calibration'],
      },
    );
    expect(incomplete.review.corrected).not.toHaveProperty('portion_calibration');
    expect(incomplete.review.incompleteFields).toEqual(['portion_calibration']);
    await expect(db.approve(false)).rejects.toMatchObject({ code: 'draft_incomplete' });
    await saveCandidateReviewCommand(db.client, actor, venue, extractionId, candidateId, {
      commandId: id(11),
      expectedVersion: 2,
      action: 'correct',
      corrected: { portion_calibration: null },
    });
    const approved = await db.approve(false);
    expect(approved.publishedRevision.facts?.servingCount).toBeNull();
    expect(replayDish(db.events)?.facts?.servingCount).toBeNull();
    expect(await db.approve(false)).toEqual(approved);
  });

  it('retains unknown count provenance after both incomplete markers are removed', async () => {
    const db = database('extracted', { legacySize: '28', calibrated: true });
    const incomplete = await saveCandidateReviewCommand(
      db.client,
      actor,
      venue,
      extractionId,
      candidateId,
      {
        commandId: id(10),
        expectedVersion: 1,
        action: 'mark_incomplete',
        incompleteFields: ['serving_count', 'portion_calibration'],
      },
    );
    expect(incomplete.review.corrected).not.toHaveProperty('serving_count');
    expect(incomplete.review.corrected).not.toHaveProperty('portion_calibration');
    expect(incomplete.review.incompleteFields).toEqual(['serving_count', 'portion_calibration']);
    const next = await saveCandidateReviewCommand(
      db.client,
      actor,
      venue,
      extractionId,
      candidateId,
      {
        commandId: id(11),
        expectedVersion: 2,
        action: 'mark_incomplete',
        incompleteFields: ['description'],
      },
    );
    expect(next.review.corrected).not.toHaveProperty('description');
    expect(next.review.incompleteFields).toEqual(['description']);
    await saveCandidateReviewCommand(db.client, actor, venue, extractionId, candidateId, {
      commandId: id(12),
      expectedVersion: 3,
      action: 'correct',
      corrected: { description: 'Reviewed description.' },
    });
    const approved = await db.approve(false);
    expect(approved.publishedRevision.facts?.servingCount).toBeNull();
    expect(replayDish(db.events)?.facts?.servingCount).toBeNull();
    expect(await db.approve(false)).toEqual(approved);
  });
});
