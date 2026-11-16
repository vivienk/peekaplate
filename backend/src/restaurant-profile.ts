import { createHash, randomUUID } from 'node:crypto';
import {
  type RestaurantProfile,
  RestaurantProfileSchema,
  type SaveRestaurantProfile,
  SaveRestaurantProfileSchema,
} from '@peekaplate/contracts';
import type { Client } from 'pg';
import { CommandError } from './dish-command';
import { IngestionError } from './ingestion/repository';
import type { ArtworkStorage } from './ingredient-artwork';
import { withOwnerMenuTransaction } from './owner-menu';

export const restaurantLogoKey = (venue: string, sha: string) =>
  `restaurant-logos/${venue}/${sha}.png`;
// Browser decodes and bounds uploaded JPEG/PNG before this PNG-only storage boundary.
export function parseRestaurantLogo(base64: string) {
  const bytes = Buffer.from(base64, 'base64');
  if (
    bytes.toString('base64') !== base64 ||
    bytes.length < 45 ||
    bytes.length > 1_000_000 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    bytes.readUInt32BE(8) !== 13
  )
    throw new IngestionError('invalid_logo', 400);
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!width || !height || width > 2048 || height > 2048)
    throw new IngestionError('invalid_logo', 400);
  let offset = 8,
    hasData = false,
    ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) break;
    const chunk = bytes.toString('ascii', offset + 4, offset + 8);
    if (chunk === 'IDAT') hasData = true;
    offset += length + 12;
    if (chunk === 'IEND') {
      ended = length === 0 && offset === bytes.length;
      break;
    }
  }
  if (!hasData || !ended) throw new IngestionError('invalid_logo', 400);
  return {
    bytes,
    logo: {
      width,
      height,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}

export async function readRestaurantProfile(
  client: Client,
  venue: string,
): Promise<RestaurantProfile | null> {
  const row = (
    await client.query(
      'SELECT version,details,logo FROM app_private.restaurant_profile_current WHERE tenant_id=$1',
      [venue],
    )
  ).rows[0];
  return row ? RestaurantProfileSchema.parse(row) : null;
}

export function replayRestaurantProfile(
  events: readonly {
    tenant_id: string;
    stream_id: string;
    version: number;
    event_type: string;
    schema_version: number;
    payload: unknown;
  }[],
) {
  let state: RestaurantProfile | null = null;
  for (const event of events) {
    const next = RestaurantProfileSchema.parse(event.payload);
    if (
      event.tenant_id !== events[0]?.tenant_id ||
      event.stream_id !== events[0]?.stream_id ||
      event.event_type !== 'restaurant.profile.saved' ||
      event.schema_version !== 1 ||
      event.version !== (state?.version ?? 0) + 1 ||
      next.version !== event.version
    )
      throw new Error('Invalid restaurant profile stream');
    state = next;
  }
  return state;
}

export async function saveRestaurantProfile(
  client: Client,
  actor: string,
  venue: string,
  raw: SaveRestaurantProfile,
  storage: ArtworkStorage,
): Promise<RestaurantProfile> {
  const input = SaveRestaurantProfileSchema.parse(raw);
  const uploaded = input.logoPngBase64 ? parseRestaurantLogo(input.logoPngBase64) : null;
  const { logoPngBase64: _bytes, ...command } = input;
  const metadata = {
    type: 'restaurant.profile.save',
    ...command,
    logo: uploaded?.logo ?? (input.logoPngBase64 === null ? null : 'preserve'),
  };
  const hash = createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
  return withOwnerMenuTransaction(client, actor, venue, async () => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `command:${venue}:${actor}:${input.commandId}`,
    ]);
    const receipt = (
      await client.query(
        'SELECT request_hash,result FROM app_private.es_command WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3',
        [venue, actor, input.commandId],
      )
    ).rows[0];
    if (receipt) {
      if (receipt.request_hash !== hash) throw new CommandError('command_conflict', 409);
      return RestaurantProfileSchema.parse(receipt.result);
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `restaurant-profile:${venue}`,
    ]);
    const previous = await readRestaurantProfile(client, venue);
    if ((previous?.version ?? 0) !== input.expectedVersion)
      throw new CommandError('version_conflict', 409);
    if (uploaded) {
      // Immutable content-addressed bytes; a failed DB commit can leave only a private orphan.
      await storage.put(
        restaurantLogoKey(venue, uploaded.logo.sha256),
        Uint8Array.from(uploaded.bytes).buffer,
        { sha256: uploaded.logo.sha256 },
      );
    }
    const state: RestaurantProfile = {
      version: input.expectedVersion + 1,
      details: input.details,
      logo: uploaded?.logo ?? (input.logoPngBase64 === null ? null : (previous?.logo ?? null)),
    };
    const event = randomUUID();
    await client.query(
      `INSERT INTO app_private.es_event(id,tenant_id,stream_type,stream_id,version,schema_version,event_type,payload,metadata)
      VALUES($1,$2,'restaurant_profile',$2,$3,1,'restaurant.profile.saved',$4::jsonb,$5::jsonb)`,
      [event, venue, state.version, JSON.stringify(state), JSON.stringify({ actorId: actor })],
    );
    await client.query(
      `INSERT INTO app_private.restaurant_profile_current(tenant_id,version,details,logo) VALUES($1,$2,$3::jsonb,$4::jsonb)
      ON CONFLICT(tenant_id) DO UPDATE SET version=$2,details=$3::jsonb,logo=$4::jsonb`,
      [venue, state.version, JSON.stringify(state.details), JSON.stringify(state.logo)],
    );
    await client.query(
      `INSERT INTO app_private.es_command(id,tenant_id,actor_id,command_type,idempotency_key,payload,request_hash,result)
      VALUES($1,$2,$3,'restaurant.profile.save',$4,$5::jsonb,$6,$7::jsonb)`,
      [
        randomUUID(),
        venue,
        actor,
        input.commandId,
        JSON.stringify(metadata),
        hash,
        JSON.stringify(state),
      ],
    );
    await client.query(
      `INSERT INTO app_private.outbox(id,tenant_id,event_id,topic,payload) VALUES($1,$2,$3,'restaurant.profile.saved',$4::jsonb)`,
      [randomUUID(), venue, event, JSON.stringify({ version: state.version })],
    );
    return state;
  });
}
