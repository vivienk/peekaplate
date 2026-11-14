import { createHash, randomUUID } from 'node:crypto';
import {
  type ArtworkCommand,
  ArtworkCommandSchema,
  type ArtworkState,
  ArtworkStateSchema,
} from '@peekaplate/contracts';
import type { Client } from 'pg';
import { CommandError, ReplayError } from './dish-command';
import { IngestionError } from './ingestion/repository';
import { withOwnerMenuTransaction } from './owner-menu';

export const artworkKey = (venue: string, sha: string) => `ingredient-artwork/${venue}/${sha}.png`;
export type ArtworkStorage = { put(key: string, bytes: ArrayBuffer): Promise<unknown> };

export function reviewedPng(input: Extract<ArtworkCommand, { status: 'approved' }>): Uint8Array {
  const data = Buffer.from(input.pngBase64, 'base64');
  if (
    data.toString('base64') !== input.pngBase64 ||
    data.length > 1_000_000 ||
    data.length < 45 ||
    !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    data.toString('ascii', 12, 16) !== 'IHDR' ||
    data.readUInt32BE(8) !== 13 ||
    data.readUInt32BE(16) !== data.readUInt32BE(20) ||
    data.readUInt32BE(16) < 16 ||
    data.readUInt32BE(16) > 2048 ||
    ![0, 2, 3, 4, 6].includes(data[25] ?? -1) ||
    createHash('sha256').update(data).digest('hex') !== input.sha256
  ) {
    throw new IngestionError('invalid_artwork', 400);
  }
  // Pillow preserves palette/grayscale/RGB PNGs using tRNS transparency. Accept
  // their exact reviewed bytes too; do not silently re-encode after approval.
  let hasAlpha = [4, 6].includes(data[25] ?? -1);
  let hasData = false;
  let ended = false;
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    if (length > data.length - offset - 12) break;
    const chunk = data.toString('ascii', offset + 4, offset + 8);
    if (chunk === 'tRNS' && length > 0) hasAlpha = true;
    if (chunk === 'IDAT') hasData = true;
    offset += length + 12;
    if (chunk === 'IEND') {
      ended = length === 0 && offset === data.length;
      break;
    }
  }
  if (!hasAlpha || !hasData || !ended) throw new IngestionError('invalid_artwork', 400);
  // Bounds/format defense here; the operator reviews the exact hash and the
  // generator's importer performs full image decoding and alpha validation.
  return data;
}

type ArtEvent = {
  tenant_id: string;
  stream_id: string;
  version: number;
  schema_version: number;
  event_type: string;
  payload: unknown;
};
export function replayArtwork(events: readonly ArtEvent[]): ArtworkState | null {
  let state: ArtworkState | null = null;
  for (const event of events) {
    const next = ArtworkStateSchema.parse(event.payload);
    if (
      event.tenant_id !== events[0]?.tenant_id ||
      event.stream_id !== events[0]?.stream_id ||
      event.schema_version !== 1 ||
      event.event_type !== 'ingredient.artwork.reviewed' ||
      event.version !== (state?.version ?? 0) + 1 ||
      next.version !== event.version ||
      (state && next.label !== state.label) ||
      (next.status === 'approved') !== (next.sha256 !== null)
    ) {
      throw new ReplayError('Invalid artwork stream');
    }
    state = next;
  }
  return state;
}

export async function reviewArtwork(
  client: Client,
  actor: string,
  venue: string,
  raw: ArtworkCommand,
  storage: ArtworkStorage,
): Promise<ArtworkState> {
  const input = ArtworkCommandSchema.parse(raw);
  const bytes = input.status === 'approved' ? reviewedPng(input) : null;
  const { pngBase64: _bytes, ...metadata } = { pngBase64: undefined, ...input };
  const hash = createHash('sha256')
    .update(JSON.stringify({ type: 'ingredient.artwork.review', ...metadata }))
    .digest('hex');
  return withOwnerMenuTransaction(client, actor, venue, async () => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `command:${venue}:${actor}:${input.commandId}`,
    ]);
    const receipt = await client.query<{ request_hash: string; result: unknown }>(
      'SELECT request_hash,result FROM app_private.es_command WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3',
      [venue, actor, input.commandId],
    );
    if (receipt.rows[0]) {
      if (receipt.rows[0].request_hash !== hash) throw new CommandError('command_conflict', 409);
      return ArtworkStateSchema.parse(receipt.rows[0].result);
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `ingredient-artwork:${venue}:${input.label}`,
    ]);
    const current = await client.query<{ stream_id: string; version: number }>(
      'SELECT stream_id,version FROM app_private.ingredient_artwork_current WHERE tenant_id=$1 AND label=$2',
      [venue, input.label],
    );
    if ((current.rows[0]?.version ?? 0) !== input.expectedVersion)
      throw new CommandError('version_conflict', 409);
    const stream = current.rows[0]?.stream_id ?? randomUUID();
    const state: ArtworkState = {
      label: input.label,
      version: input.expectedVersion + 1,
      status: input.status,
      sha256: input.status === 'approved' ? input.sha256 : null,
    };
    // Store immutable bytes before exposing the pointer. A rollback may leave an
    // unreachable content object; retries never expose it without a committed review.
    if (bytes && input.status === 'approved')
      await storage.put(artworkKey(venue, input.sha256), Uint8Array.from(bytes).buffer);
    const event = randomUUID();
    await client.query(
      `INSERT INTO app_private.es_event(id,tenant_id,stream_type,stream_id,version,schema_version,event_type,payload,metadata)
      VALUES($1,$2,'ingredient_artwork',$3,$4,1,'ingredient.artwork.reviewed',$5::jsonb,$6::jsonb)`,
      [
        event,
        venue,
        stream,
        state.version,
        JSON.stringify(state),
        JSON.stringify({ actorId: actor, ...metadata }),
      ],
    );
    await client.query(
      `INSERT INTO app_private.ingredient_artwork_current(tenant_id,label,stream_id,version,status,sha256)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,label) DO UPDATE SET version=$4,status=$5,sha256=$6`,
      [venue, state.label, stream, state.version, state.status, state.sha256],
    );
    await client.query(
      `INSERT INTO app_private.es_command(id,tenant_id,actor_id,command_type,idempotency_key,payload,request_hash,result)
      VALUES($1,$2,$3,'ingredient.artwork.review',$4,$5::jsonb,$6,$7::jsonb)`,
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
      `INSERT INTO app_private.outbox(id,tenant_id,event_id,topic,payload)
      VALUES($1,$2,$3,'ingredient.artwork.reviewed',$4::jsonb)`,
      [randomUUID(), venue, event, JSON.stringify(state)],
    );
    return state;
  });
}

export async function readArtwork(
  client: Client,
  venue: string,
  labels: string[],
): Promise<ArtworkState[]> {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venue]);
    const result = await client.query(
      'SELECT label,version,status,sha256 FROM app_private.ingredient_artwork_current WHERE tenant_id=$1 AND label=ANY($2::text[])',
      [venue, labels],
    );
    const states = result.rows.map((r) => ArtworkStateSchema.parse(r));
    await client.query('COMMIT');
    return states;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
