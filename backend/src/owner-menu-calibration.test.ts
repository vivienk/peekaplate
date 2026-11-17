import {
  type OwnerDishFields,
  OwnerDishFieldsSchema,
  type PlateCalibration,
} from '@peekaplate/contracts';
import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { replayOwnerDraft, saveOwnerDishDraft } from './owner-menu';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const venue = id(1);
const actor = id(2);
const draft = id(3);
const photo = id(4);
const calibration: PlateCalibration = {
  shape: 'round',
  width_mm: 240,
  depth_mm: 240,
  source_sha256: 'a'.repeat(64),
  source_width_px: 800,
  source_height_px: 600,
  boundary: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
  confirmed: true,
};

function database(previous: Partial<OwnerDishFields> = {}, sourceHash = calibration.source_sha256) {
  const events: Parameters<typeof replayOwnerDraft>[0][number][] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM app_private.staff_membership'))
      return { rows: [{ permission: 'owner' }] };
    if (sql.includes('FROM app_private.es_command')) return { rows: [] };
    if (sql.includes('SELECT * FROM app_private.dish_drafts'))
      return {
        rows: [
          {
            id: draft,
            origin: 'manual',
            review_status: 'pending',
            removed_at: null,
            draft_version: 1,
            manual_fields: OwnerDishFieldsSchema.parse(previous),
          },
        ],
      };
    if (sql.includes('FROM app_private.dish_draft_photo'))
      return {
        rowCount: 1,
        rows: [{ id: params[2], source_hash: sourceHash }],
      };
    if (sql.includes('INSERT INTO app_private.dish_drafts'))
      return {
        rows: [
          { id: draft, draft_version: params[8], manual_fields: JSON.parse(params[9] as string) },
        ],
      };
    if (sql.includes('INSERT INTO app_private.es_event'))
      events.push({
        version: params[3] as number,
        schema_version: 1,
        event_type: 'owner.draft.saved',
        payload: JSON.parse(params[4] as string),
      });
    return { rows: [] };
  });
  return { client: { query } as unknown as Client, query, events };
}

async function save(db: ReturnType<typeof database>, fields: Partial<OwnerDishFields>) {
  return saveOwnerDishDraft(db.client, actor, venue, draft, {
    commandId: id(5),
    expectedVersion: 1,
    fields: OwnerDishFieldsSchema.parse(fields),
  });
}

describe('manual owner calibration persistence', () => {
  it('retains omitted calibration on unrelated edits and records it in the event snapshot', async () => {
    const db = database({ photoId: photo, servingSize: '24', portionCalibration: calibration });
    const saved = await save(db, { photoId: photo, name: 'Renamed dish', servingCount: null });
    expect(saved.manual_fields).toMatchObject({
      servingSize: '24',
      portionCalibration: calibration,
      servingCount: null,
    });
    expect(db.events[0]?.payload).toMatchObject({ fields: { portionCalibration: calibration } });
  });

  it.each([{ photoId: photo, servingSize: '28' }, { photoId: id(6) }, { photoId: null }])(
    'clears old measurement evidence when the photo or physical size changes: %j',
    async (fields) => {
      const db = database({ photoId: photo, servingSize: '24', portionCalibration: calibration });
      expect((await save(db, fields)).manual_fields).toMatchObject({ portionCalibration: null });
    },
  );

  it.each([
    {
      fields: { photoId: photo, servingSize: '24', portionCalibration: calibration },
      hash: 'b'.repeat(64),
    },
    {
      fields: { photoId: photo, servingSize: '28', portionCalibration: calibration },
      hash: calibration.source_sha256,
    },
    {
      fields: { photoId: null, servingSize: '24', portionCalibration: calibration },
      hash: calibration.source_sha256,
    },
  ])(
    'rejects measurements that do not match the selected photo and size before saving',
    async ({ fields, hash }) => {
      const db = database({}, hash);
      await expect(save(db, fields)).rejects.toMatchObject({
        code: 'portion_calibration_mismatch',
        status: 409,
      });
      expect(db.events).toHaveLength(0);
      expect(
        db.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO app_private.dish_drafts')),
      ).toBe(false);
    },
  );
});
