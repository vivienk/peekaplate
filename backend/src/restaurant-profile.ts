import { createHash, randomUUID } from 'node:crypto';
import {
  type RestaurantProfile,
  RestaurantProfileSchema,
  RestaurantSetupSchema,
  type SaveRestaurantProfile,
} from '@peekaplate/contracts';
import type { Client } from 'pg';
import { CommandError } from './dish-command';
import { IngestionError } from './ingestion/repository';
import { withOwnerMenuTransaction } from './owner-menu';

export async function readRestaurantProfile(client: Client, actor: string, venue: string) {
  return withOwnerMenuTransaction(client, actor, venue, async () => {
    const result = await client.query(
      'SELECT version,fields,status FROM app_private.restaurant_profile WHERE tenant_id=$1',
      [venue],
    );
    return result.rows[0] ? RestaurantProfileSchema.parse(result.rows[0]) : null;
  });
}

export async function readRestaurantSetup(client: Client, actor: string, venue: string) {
  return withOwnerMenuTransaction(client, actor, venue, async () => {
    const result = await client.query(
      `SELECT v.id AS "venueId",COALESCE(p.fields->>'name',v.name) AS "restaurantName",
         COALESCE(p.status,'missing') AS "detailsStatus",
         EXISTS(SELECT 1 FROM app_private.dish_drafts d WHERE d.tenant_id=v.id AND d.removed_at IS NULL AND d.review_status NOT IN ('rejected','superseded')) AS "menuAdded",
         NOT EXISTS(SELECT 1 FROM app_private.dish_drafts d WHERE d.tenant_id=v.id AND d.removed_at IS NULL AND d.review_status NOT IN ('rejected','superseded') AND d.verification_status <> 'verified')
           AND EXISTS(SELECT 1 FROM app_private.dish_drafts d WHERE d.tenant_id=v.id AND d.removed_at IS NULL AND d.review_status NOT IN ('rejected','superseded')) AS "menuVerified",
         EXISTS(SELECT 1 FROM app_private.menu_publication_current m WHERE m.tenant_id=v.id AND m.status='published') AS published
       FROM app_private.venues v LEFT JOIN app_private.restaurant_profile p ON p.tenant_id=v.id WHERE v.id=$1`,
      [venue],
    );
    if (!result.rows[0]) throw new IngestionError('not_found', 404);
    return RestaurantSetupSchema.parse(result.rows[0]);
  });
}

export async function saveRestaurantProfile(
  client: Client,
  actor: string,
  venue: string,
  input: SaveRestaurantProfile,
): Promise<RestaurantProfile> {
  return withOwnerMenuTransaction(client, actor, venue, async () => {
    const payload = { commandType: 'restaurant.profile.save.v1', ...input };
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `command:${venue}:${actor}:${input.commandId}`,
    ]);
    const receipt = await client.query(
      'SELECT request_hash,result FROM app_private.es_command WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3',
      [venue, actor, input.commandId],
    );
    if (receipt.rows[0]) {
      if (receipt.rows[0].request_hash !== hash) throw new CommandError('command_conflict', 409);
      return RestaurantProfileSchema.parse(receipt.rows[0].result);
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `restaurant-profile:${venue}`,
    ]);
    const current = await client.query(
      'SELECT version FROM app_private.restaurant_profile WHERE tenant_id=$1 FOR UPDATE',
      [venue],
    );
    if ((current.rows[0]?.version ?? 0) !== input.expectedVersion)
      throw new CommandError('version_conflict', 409);
    if (input.fields.photoId) {
      const photo = await client.query(
        'SELECT id FROM app_private.restaurant_profile_photo WHERE tenant_id=$1 AND id=$2',
        [venue, input.fields.photoId],
      );
      if (photo.rowCount !== 1) throw new IngestionError('photo_not_found', 404);
    }
    const version = input.expectedVersion + 1;
    const saved = await client.query(
      `INSERT INTO app_private.restaurant_profile(tenant_id,version,fields) VALUES($1,$2,$3::jsonb)
       ON CONFLICT(tenant_id) DO UPDATE SET version=$2,fields=$3::jsonb,updated_at=now() RETURNING version,fields,status`,
      [venue, version, JSON.stringify(input.fields)],
    );
    const result = RestaurantProfileSchema.parse(saved.rows[0]);
    const event = randomUUID();
    await client.query(
      `INSERT INTO app_private.es_event(id,tenant_id,stream_type,stream_id,version,schema_version,event_type,payload,metadata)
      VALUES($1,$2,'restaurant_profile',$2,$3,1,'restaurant.profile.saved',$4::jsonb,$5::jsonb)`,
      [event, venue, version, JSON.stringify(result), JSON.stringify({ actorId: actor })],
    );
    await client.query(
      `INSERT INTO app_private.es_command(id,tenant_id,actor_id,command_type,idempotency_key,payload,request_hash,result)
      VALUES($1,$2,$3,'restaurant.profile.save.v1',$4,$5::jsonb,$6,$7::jsonb)`,
      [
        randomUUID(),
        venue,
        actor,
        input.commandId,
        JSON.stringify(payload),
        hash,
        JSON.stringify(result),
      ],
    );
    await client.query(
      `INSERT INTO app_private.outbox(id,tenant_id,event_id,topic,payload) VALUES($1,$2,$3,'restaurant.profile.saved',$4::jsonb)`,
      [randomUUID(), venue, event, JSON.stringify({ version })],
    );
    return result;
  });
}

export function replayRestaurantProfile(
  events: readonly {
    version: number;
    schema_version: number;
    event_type: string;
    payload: unknown;
  }[],
): RestaurantProfile | null {
  let profile: RestaurantProfile | null = null;
  for (const [index, event] of events.entries()) {
    const parsed = RestaurantProfileSchema.safeParse(event.payload);
    if (
      event.version !== index + 1 ||
      event.schema_version !== 1 ||
      event.event_type !== 'restaurant.profile.saved' ||
      !parsed.success ||
      parsed.data.version !== event.version
    )
      throw new Error('invalid_restaurant_profile_stream');
    profile = parsed.data;
  }
  return profile;
}

export async function storeRestaurantPhoto(
  client: Client,
  actor: string,
  venue: string,
  upload: { bytes: Uint8Array; sourceHash: string; idempotencyKey: string },
  contentType: string,
  put: (key: string, bytes: ArrayBuffer) => Promise<unknown>,
  read?: (key: string) => Promise<ArrayBuffer | null>,
) {
  const bytes = upload.bytes;
  const png = bytes.length > 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n);
  const jpeg = bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!(contentType === 'image/png' && png) && !(contentType === 'image/jpeg' && jpeg))
    throw new IngestionError('invalid_photo', 400);
  if (
    bytes.length > 12_000_000 ||
    createHash('sha256').update(bytes).digest('hex') !== upload.sourceHash
  )
    throw new IngestionError('upload_scope_mismatch', 409);
  return withOwnerMenuTransaction(client, actor, venue, async () => {
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          commandType: 'restaurant.photo.upload.v1',
          sourceHash: upload.sourceHash,
          contentType,
          size: bytes.length,
        }),
      )
      .digest('hex');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `command:${venue}:${actor}:${upload.idempotencyKey}`,
    ]);
    const receipt = await client.query(
      'SELECT request_hash,result FROM app_private.es_command WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3',
      [venue, actor, upload.idempotencyKey],
    );
    const key = `restaurant-profile/${venue}/${upload.sourceHash}`;
    const ensureStored = async () => {
      const current = await read?.(key);
      if (
        current &&
        current.byteLength === bytes.length &&
        createHash('sha256').update(new Uint8Array(current)).digest('hex') === upload.sourceHash
      )
        return;
      // Repair only the exact authenticated, hash-bound bytes; never change the photo ID/history.
      await put(
        key,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
    };
    if (receipt.rows[0]) {
      if (receipt.rows[0].request_hash !== hash) throw new CommandError('command_conflict', 409);
      await ensureStored();
      return receipt.rows[0].result as { id: string };
    }
    const existing = await client.query(
      'SELECT id FROM app_private.restaurant_profile_photo WHERE tenant_id=$1 AND source_hash=$2',
      [venue, upload.sourceHash],
    );
    const remember = async (id: string) => {
      const result = { id };
      await client.query(
        `INSERT INTO app_private.es_command(id,tenant_id,actor_id,command_type,idempotency_key,payload,request_hash,result)
        VALUES($1,$2,$3,'restaurant.photo.upload.v1',$4,$5::jsonb,$6,$7::jsonb)`,
        [
          randomUUID(),
          venue,
          actor,
          upload.idempotencyKey,
          JSON.stringify({ sourceHash: upload.sourceHash }),
          hash,
          JSON.stringify(result),
        ],
      );
      return result;
    };
    await ensureStored();
    if (existing.rows[0]) return remember(existing.rows[0].id);
    const stored = await client.query(
      `INSERT INTO app_private.restaurant_profile_photo(tenant_id,id,source_hash,storage_key,content_type,size_bytes)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,source_hash) DO NOTHING RETURNING id`,
      [venue, randomUUID(), upload.sourceHash, key, contentType, bytes.length],
    );
    const row =
      stored.rows[0] ??
      (
        await client.query(
          'SELECT id FROM app_private.restaurant_profile_photo WHERE tenant_id=$1 AND source_hash=$2',
          [venue, upload.sourceHash],
        )
      ).rows[0];
    if (!row) throw new IngestionError('photo_not_found', 404);
    return remember(row.id);
  });
}

export async function restaurantPhoto(client: Client, actor: string, venue: string, photo: string) {
  return withOwnerMenuTransaction(client, actor, venue, async () => {
    const row = (
      await client.query(
        'SELECT storage_key,content_type,size_bytes,source_hash FROM app_private.restaurant_profile_photo WHERE tenant_id=$1 AND id=$2',
        [venue, photo],
      )
    ).rows[0];
    if (!row) throw new IngestionError('not_found', 404);
    return row as {
      storage_key: string;
      content_type: string;
      size_bytes: number;
      source_hash: string;
    };
  });
}
