import { createHash, randomUUID } from 'node:crypto';
import {
  type OwnerDishFields,
  OwnerDishFieldsSchema,
  type SaveOwnerDishDraft,
} from '@peekaplate/contracts';
import type { Client } from 'pg';
import { CommandError } from './dish-command';
import { type DishDraftRow, IngestionError } from './ingestion/repository';
import { authorizeStaffVenue } from './staff-venue';

export async function withOwnerMenuTransaction<T>(
  client: Client,
  actorId: string,
  venueId: string,
  work: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await authorizeStaffVenue(client, actorId, venueId, true);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* Preserve the command failure. */
    }
    throw error;
  }
}

export async function saveOwnerDishDraft(
  client: Client,
  actorId: string,
  venueId: string,
  draftId: string,
  input: SaveOwnerDishDraft,
): Promise<DishDraftRow> {
  return withOwnerMenuTransaction(client, actorId, venueId, async () => {
    const payload = { commandType: 'owner.draft.save.v1', draftId, ...input };
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `command:${venueId}:${actorId}:${input.commandId}`,
    ]);
    const receipt = await client.query<{ request_hash: string; result: DishDraftRow }>(
      `SELECT request_hash, result FROM app_private.es_command WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3`,
      [venueId, actorId, input.commandId],
    );
    if (receipt.rows[0]) {
      if (receipt.rows[0].request_hash !== hash) throw new CommandError('command_conflict', 409);
      return receipt.rows[0].result;
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `owner-draft:${venueId}:${draftId}`,
    ]);
    const current = await client.query<DishDraftRow>(
      'SELECT * FROM app_private.dish_drafts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [venueId, draftId],
    );
    const draft = current.rows[0];
    if ((draft?.draft_version ?? 0) !== input.expectedVersion)
      throw new CommandError('version_conflict', 409);
    if (draft && (draft.origin !== 'manual' || draft.review_status !== 'pending'))
      throw new IngestionError('draft_not_editable', 409);
    const fields = OwnerDishFieldsSchema.parse(input.fields);
    if (fields.photoId !== null) {
      const photo = await client.query(
        'SELECT id FROM app_private.dish_draft_photo WHERE tenant_id=$1 AND draft_id=$2 AND id=$3',
        [venueId, draftId, fields.photoId],
      );
      if (photo.rowCount !== 1) throw new IngestionError('photo_not_found', 404);
    }
    const version = input.expectedVersion + 1;
    const result = await client.query<DishDraftRow>(
      `INSERT INTO app_private.dish_drafts
        (id,tenant_id,job_id,draft_id,draft_index,name,description,category,price_amount,price_currency,ingredients,source_id,source_text,evidence,origin,draft_version,manual_fields)
       VALUES ($1::uuid,$2,NULL,($1::uuid)::text,0,$3,$4,$5,$6,$7,$8::jsonb,NULL,NULL,'{}'::jsonb,'manual',$9,$10::jsonb)
       ON CONFLICT (id) DO UPDATE SET name=$3,description=$4,category=$5,price_amount=$6,price_currency=$7,ingredients=$8::jsonb,draft_version=$9,manual_fields=$10::jsonb,verification_status='not_verified',updated_at=now()
       WHERE app_private.dish_drafts.tenant_id=$2 RETURNING *`,
      [
        draftId,
        venueId,
        fields.name,
        fields.description,
        fields.category,
        fields.priceAmount,
        fields.priceCurrency,
        JSON.stringify(fields.ingredients.items),
        version,
        JSON.stringify(fields),
      ],
    );
    const saved = result.rows[0];
    if (!saved) throw new IngestionError('draft_not_found', 404);
    const eventId = randomUUID();
    await client.query(
      `INSERT INTO app_private.es_event(id,tenant_id,stream_type,stream_id,version,schema_version,event_type,payload,metadata)
       VALUES ($1,$2,'owner_draft',$3,$4,1,'owner.draft.saved',$5::jsonb,$6::jsonb)`,
      [
        eventId,
        venueId,
        draftId,
        version,
        JSON.stringify({ draftId, version, fields }),
        JSON.stringify({ actorId }),
      ],
    );
    await client.query(
      `INSERT INTO app_private.es_command(id,tenant_id,actor_id,command_type,idempotency_key,payload,request_hash,result)
       VALUES ($1,$2,$3,'owner.draft.save.v1',$4,$5::jsonb,$6,$7::jsonb)`,
      [
        randomUUID(),
        venueId,
        actorId,
        input.commandId,
        JSON.stringify(payload),
        hash,
        JSON.stringify(saved),
      ],
    );
    await client.query(
      `INSERT INTO app_private.outbox(id,tenant_id,event_id,topic,payload) VALUES ($1,$2,$3,'owner.draft.saved',$4::jsonb)`,
      [randomUUID(), venueId, eventId, JSON.stringify({ draftId, version })],
    );
    return saved;
  });
}

export function replayOwnerDraft(
  events: readonly {
    version: number;
    schema_version: number;
    event_type: string;
    payload: unknown;
  }[],
): OwnerDishFields | null {
  let fields: OwnerDishFields | null = null;
  for (const [index, event] of events.entries()) {
    const payload = event.payload as {
      version?: number;
      fields?: unknown;
    } | null;
    if (
      event.version !== index + 1 ||
      event.schema_version !== 1 ||
      event.event_type !== 'owner.draft.saved' ||
      payload?.version !== event.version
    )
      throw new Error('invalid_owner_draft_stream');
    if (event.event_type === 'owner.draft.saved') {
      fields = OwnerDishFieldsSchema.parse(payload.fields);
    }
  }
  return fields;
}

export function replayOwnerDraftVerification(
  events: readonly {
    version: number;
    schema_version: number;
    event_type: string;
    payload: unknown;
  }[],
  currentDraftVersion: number,
): 'not_verified' | 'verified' {
  let verificationStatus: 'not_verified' | 'verified' = 'not_verified';

  for (const [index, event] of events.entries()) {
    const payload = event.payload as {
      version?: number;
      draftVersion?: number;
      verificationStatus?: string;
    } | null;
    if (
      event.version !== index + 1 ||
      event.schema_version !== 1 ||
      event.event_type !== 'owner.draft.verified' ||
      payload?.version !== event.version ||
      !Number.isInteger(payload.draftVersion) ||
      payload.draftVersion! < 1 ||
      !['verified', 'not_verified'].includes(payload.verificationStatus ?? '')
    )
      throw new Error('invalid_owner_draft_stream');

    verificationStatus =
      payload.draftVersion === currentDraftVersion && payload.verificationStatus === 'verified'
        ? 'verified'
        : 'not_verified';
  }

  return verificationStatus;
}

export type DraftPhoto = {
  id: string;
  draft_id: string;
  content_type: string;
  size_bytes: number;
  source_hash: string;
  storage_key: string;
  verification_status?: 'not_verified' | 'verified' | 'rejected';
  promoted_storage_key?: string | null;
};
export async function storeDraftPhoto(
  client: Client,
  actorId: string,
  venueId: string,
  draftId: string,
  upload: { bytes: Uint8Array; sourceHash: string; idempotencyKey: string },
  type: string,
  put: (key: string, bytes: ArrayBuffer) => Promise<unknown>,
): Promise<DraftPhoto> {
  return withOwnerMenuTransaction(client, actorId, venueId, async () => {
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          commandType: 'owner.photo.upload.v1',
          draftId,
          sourceHash: upload.sourceHash,
          type,
          size: upload.bytes.length,
        }),
      )
      .digest('hex');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `command:${venueId}:${actorId}:${upload.idempotencyKey}`,
    ]);
    const receipt = await client.query<{ request_hash: string; result: DraftPhoto }>(
      'SELECT request_hash,result FROM app_private.es_command WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3',
      [venueId, actorId, upload.idempotencyKey],
    );
    if (receipt.rows[0] && receipt.rows[0].request_hash !== hash)
      throw new CommandError('command_conflict', 409);
    if (receipt.rows[0]) return receipt.rows[0].result;
    const draft = await client.query<DishDraftRow>(
      'SELECT * FROM app_private.dish_drafts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [venueId, draftId],
    );
    if (!draft.rows[0]) throw new IngestionError('draft_not_found', 404);
    if (draft.rows[0].review_status !== 'pending')
      throw new IngestionError('draft_not_editable', 409);
    const key = `menu-staging/${venueId}/${draftId}/${upload.sourceHash}`;
    if (createHash('sha256').update(upload.bytes).digest('hex') !== upload.sourceHash)
      throw new IngestionError('upload_scope_mismatch', 409);
    await put(key, upload.bytes.buffer as ArrayBuffer);
    const result = await client.query<DraftPhoto>(
      `INSERT INTO app_private.dish_draft_photo(tenant_id,draft_id,id,source_hash,storage_key,content_type,size_bytes,verification_status)
       VALUES($1,$2,$3,$4,$5,$6,$7,'not_verified') ON CONFLICT(tenant_id,draft_id,source_hash) DO NOTHING RETURNING *`,
      [venueId, draftId, randomUUID(), upload.sourceHash, key, type, upload.bytes.length],
    );
    const existing = await client.query<DraftPhoto>(
      'SELECT * FROM app_private.dish_draft_photo WHERE tenant_id=$1 AND draft_id=$2 AND source_hash=$3',
      [venueId, draftId, upload.sourceHash],
    );
    const photo = result.rows[0] ?? existing.rows[0];
    if (!photo) throw new IngestionError('photo_not_found', 404);
    await client.query(
      `INSERT INTO app_private.es_command(id,tenant_id,actor_id,command_type,idempotency_key,payload,request_hash,result) VALUES($1,$2,$3,'owner.photo.upload.v1',$4,$5::jsonb,$6,$7::jsonb)`,
      [
        randomUUID(),
        venueId,
        actorId,
        upload.idempotencyKey,
        JSON.stringify({ draftId, photoId: photo.id }),
        hash,
        JSON.stringify(photo),
      ],
    );
    return photo;
  });
}

export type StorageBinding = {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size?: number } | null>;
  put(key: string, value: ArrayBuffer, options?: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
};

export async function promoteDraftPhoto(
  client: Client,
  actorId: string,
  venueId: string,
  draftId: string,
  photoId: string,
  commandId: string,
  storage: StorageBinding,
): Promise<{ photo: DraftPhoto; stagingKeyToDelete: string | null }> {
  return withOwnerMenuTransaction(client, actorId, venueId, async () => {
    const payload = { commandType: 'owner.photo.approve.v1', draftId, photoId, commandId };
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `command:${venueId}:${actorId}:${commandId}`,
    ]);
    const receipt = await client.query<{
      request_hash: string;
      result: { photo: DraftPhoto; stagingKeyToDelete: string | null };
    }>(
      'SELECT request_hash,result FROM app_private.es_command WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3',
      [venueId, actorId, commandId],
    );
    if (receipt.rows[0] && receipt.rows[0].request_hash !== hash)
      throw new CommandError('command_conflict', 409);
    if (receipt.rows[0]) return { ...receipt.rows[0].result, stagingKeyToDelete: null };

    const photoRes = await client.query<DraftPhoto>(
      'SELECT * FROM app_private.dish_draft_photo WHERE tenant_id=$1 AND draft_id=$2 AND id=$3 FOR UPDATE',
      [venueId, draftId, photoId],
    );
    const photo = photoRes.rows[0];
    if (!photo) throw new IngestionError('photo_not_found', 404);

    const destKey = `menu-assets/${venueId}/${photoId}/${photo.source_hash}`;
    const sourceKey = photo.storage_key;

    // 1. Fetch source object and verify integrity
    const srcObj = await storage.get(sourceKey);
    if (!srcObj) throw new IngestionError('source_photo_missing', 404);
    const srcBytes = await srcObj.arrayBuffer();
    if (srcBytes.byteLength !== photo.size_bytes)
      throw new IngestionError('checksum_mismatch', 409);
    const computedSrcHash = createHash('sha256').update(Buffer.from(srcBytes)).digest('hex');
    if (computedSrcHash !== photo.source_hash) throw new IngestionError('checksum_mismatch', 409);

    // 2. Destination check / write
    const existingDest = await storage.get(destKey);
    let destNeedsWrite = true;
    if (existingDest) {
      const destBytes = await existingDest.arrayBuffer();
      if (
        destBytes.byteLength === photo.size_bytes &&
        createHash('sha256').update(Buffer.from(destBytes)).digest('hex') === photo.source_hash
      ) {
        destNeedsWrite = false;
      }
    }

    if (destNeedsWrite) {
      await storage.put(destKey, srcBytes, {
        httpMetadata: { contentType: photo.content_type },
      });
      const destObj = await storage.get(destKey);
      if (!destObj) throw new IngestionError('destination_write_failed', 500);
      const destBytes = await destObj.arrayBuffer();
      if (
        destBytes.byteLength !== photo.size_bytes ||
        createHash('sha256').update(Buffer.from(destBytes)).digest('hex') !== photo.source_hash
      ) {
        throw new IngestionError('destination_verification_failed', 500);
      }
    }

    // 3. Update database references
    const updatedRes = await client.query<DraftPhoto>(
      `UPDATE app_private.dish_draft_photo
       SET storage_key=$1, promoted_storage_key=$1, verification_status='verified', updated_at=now()
       WHERE tenant_id=$2 AND id=$3 RETURNING *`,
      [destKey, venueId, photoId],
    );
    const updatedPhoto = updatedRes.rows[0];
    if (!updatedPhoto) throw new IngestionError('photo_not_found', 404);

    // 4. Record event, command receipt, and outbox
    const eventId = randomUUID();
    await client.query(
      `INSERT INTO app_private.es_event(id,tenant_id,stream_type,stream_id,version,schema_version,event_type,payload,metadata)
       VALUES($1,$2,'owner_photo',$3,(SELECT coalesce(max(version),0)+1 FROM app_private.es_event WHERE tenant_id=$2 AND stream_type='owner_photo' AND stream_id=$3),1,'owner.photo.approved',$4::jsonb,$5::jsonb)`,
      [
        eventId,
        venueId,
        photoId,
        JSON.stringify({ draftId, photoId, promotedKey: destKey, sourceHash: photo.source_hash }),
        JSON.stringify({ actorId }),
      ],
    );

    const stagingKeyToDelete = sourceKey !== destKey ? sourceKey : null;
    const finalResult = { photo: updatedPhoto, stagingKeyToDelete };

    await client.query(
      `INSERT INTO app_private.es_command(id,tenant_id,actor_id,command_type,idempotency_key,payload,request_hash,result)
       VALUES($1,$2,$3,'owner.photo.approve.v1',$4,$5::jsonb,$6,$7::jsonb)`,
      [
        randomUUID(),
        venueId,
        actorId,
        commandId,
        JSON.stringify(payload),
        hash,
        JSON.stringify(finalResult),
      ],
    );

    await client.query(
      `INSERT INTO app_private.outbox(id,tenant_id,event_id,topic,payload)
       VALUES($1,$2,$3,'owner.photo.approved',$4::jsonb)`,
      [randomUUID(), venueId, eventId, JSON.stringify({ draftId, photoId, destKey })],
    );

    return finalResult;
  });
}

export async function rejectDraftPhoto(
  client: Client,
  actorId: string,
  venueId: string,
  draftId: string,
  photoId: string,
  commandId: string,
): Promise<{ photo: DraftPhoto }> {
  return withOwnerMenuTransaction(client, actorId, venueId, async () => {
    const payload = { commandType: 'owner.photo.reject.v1', draftId, photoId, commandId };
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `command:${venueId}:${actorId}:${commandId}`,
    ]);
    const receipt = await client.query<{ request_hash: string; result: { photo: DraftPhoto } }>(
      'SELECT request_hash,result FROM app_private.es_command WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3',
      [venueId, actorId, commandId],
    );
    if (receipt.rows[0] && receipt.rows[0].request_hash !== hash)
      throw new CommandError('command_conflict', 409);
    if (receipt.rows[0]) return receipt.rows[0].result;

    const photoRes = await client.query<DraftPhoto>(
      'SELECT * FROM app_private.dish_draft_photo WHERE tenant_id=$1 AND draft_id=$2 AND id=$3 FOR UPDATE',
      [venueId, draftId, photoId],
    );
    if (!photoRes.rows[0]) throw new IngestionError('photo_not_found', 404);

    const updated = await client.query<DraftPhoto>(
      `UPDATE app_private.dish_draft_photo
       SET verification_status='rejected', updated_at=now()
       WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [venueId, photoId],
    );
    const photo = updated.rows[0]!;

    const eventId = randomUUID();
    await client.query(
      `INSERT INTO app_private.es_event(id,tenant_id,stream_type,stream_id,version,schema_version,event_type,payload,metadata)
       VALUES($1,$2,'owner_photo',$3,(SELECT coalesce(max(version),0)+1 FROM app_private.es_event WHERE tenant_id=$2 AND stream_type='owner_photo' AND stream_id=$3),1,'owner.photo.rejected',$4::jsonb,$5::jsonb)`,
      [
        eventId,
        venueId,
        photoId,
        JSON.stringify({ draftId, photoId, sourceHash: photo.source_hash }),
        JSON.stringify({ actorId }),
      ],
    );

    const result = { photo };
    await client.query(
      `INSERT INTO app_private.es_command(id,tenant_id,actor_id,command_type,idempotency_key,payload,request_hash,result)
       VALUES($1,$2,$3,'owner.photo.reject.v1',$4,$5::jsonb,$6,$7::jsonb)`,
      [
        randomUUID(),
        venueId,
        actorId,
        commandId,
        JSON.stringify(payload),
        hash,
        JSON.stringify(result),
      ],
    );

    await client.query(
      `INSERT INTO app_private.outbox(id,tenant_id,event_id,topic,payload)
       VALUES($1,$2,$3,'owner.photo.rejected',$4::jsonb)`,
      [randomUUID(), venueId, eventId, JSON.stringify({ draftId, photoId })],
    );

    return result;
  });
}

export async function verifyOwnerDish(
  client: Client,
  actorId: string,
  venueId: string,
  draftId: string,
  commandId: string,
  verified: boolean,
  expectedVersion: number,
): Promise<{ draft: DishDraftRow }> {
  return withOwnerMenuTransaction(client, actorId, venueId, async () => {
    const payload = {
      commandType: 'owner.dish.verify.v1',
      draftId,
      commandId,
      verified,
      expectedVersion,
    };
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `command:${venueId}:${actorId}:${commandId}`,
    ]);
    const receipt = await client.query<{ request_hash: string; result: { draft: DishDraftRow } }>(
      'SELECT request_hash,result FROM app_private.es_command WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3',
      [venueId, actorId, commandId],
    );
    if (receipt.rows[0] && receipt.rows[0].request_hash !== hash)
      throw new CommandError('command_conflict', 409);
    if (receipt.rows[0]) return receipt.rows[0].result;

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `owner-draft:${venueId}:${draftId}`,
    ]);
    const draftRes = await client.query<DishDraftRow>(
      'SELECT * FROM app_private.dish_drafts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [venueId, draftId],
    );
    const draft = draftRes.rows[0];
    if (!draft) throw new IngestionError('draft_not_found', 404);
    if (draft.review_status !== 'pending') throw new IngestionError('draft_not_editable', 409);
    if (draft.draft_version !== expectedVersion) throw new CommandError('version_conflict', 409);

    const targetStatus = verified ? 'verified' : 'not_verified';
    const updatedDraftRes = await client.query<DishDraftRow>(
      `UPDATE app_private.dish_drafts
       SET verification_status=$1, updated_at=now()
       WHERE tenant_id=$2 AND id=$3 RETURNING *`,
      [targetStatus, venueId, draftId],
    );
    const updatedDraft = updatedDraftRes.rows[0]!;

    // Verification has its own stream; extraction retries have no owner-save history.
    const sequence = await client.query<{ version: number }>(
      "SELECT coalesce(max(version),0)+1 AS version FROM app_private.es_event WHERE tenant_id=$1 AND stream_type='owner_draft_verification' AND stream_id=$2",
      [venueId, draftId],
    );
    const nextVersion = sequence.rows[0]!.version;
    const eventId = randomUUID();
    await client.query(
      `INSERT INTO app_private.es_event(id,tenant_id,stream_type,stream_id,version,schema_version,event_type,payload,metadata)
       VALUES($1,$2,'owner_draft_verification',$3,$4,1,'owner.draft.verified',$5::jsonb,$6::jsonb)`,
      [
        eventId,
        venueId,
        draftId,
        nextVersion,
        JSON.stringify({
          draftId,
          version: nextVersion,
          draftVersion: expectedVersion,
          verificationStatus: targetStatus,
        }),
        JSON.stringify({ actorId }),
      ],
    );

    const finalResult = { draft: updatedDraft };
    await client.query(
      `INSERT INTO app_private.es_command(id,tenant_id,actor_id,command_type,idempotency_key,payload,request_hash,result)
       VALUES($1,$2,$3,'owner.dish.verify.v1',$4,$5::jsonb,$6,$7::jsonb)`,
      [
        randomUUID(),
        venueId,
        actorId,
        commandId,
        JSON.stringify(payload),
        hash,
        JSON.stringify(finalResult),
      ],
    );

    await client.query(
      `INSERT INTO app_private.outbox(id,tenant_id,event_id,topic,payload)
       VALUES($1,$2,$3,'owner.draft.verified',$4::jsonb)`,
      [
        randomUUID(),
        venueId,
        eventId,
        JSON.stringify({ draftId, version: nextVersion, verificationStatus: targetStatus }),
      ],
    );

    return finalResult;
  });
}
