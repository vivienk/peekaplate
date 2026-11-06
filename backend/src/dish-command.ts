import { createHash, randomUUID } from 'node:crypto';
import type { CreateDishRevision, DishRevision } from '@peekaplate/contracts';
import { DishRevisionSchema } from '@peekaplate/contracts';
import type { Client } from 'pg';

export type CreateDishRevisionInput = CreateDishRevision & Pick<DishRevision, 'dishId'>;
export type DishRevisionResult = DishRevision;

export type DishEvent = {
  tenantId: string;
  streamType: string;
  streamId: string;
  version: number;
  schemaVersion: number;
  eventType: string;
  payload: unknown;
  metadata: unknown;
};

export type DishProjection = DishRevisionResult & { tenantId: string };

export class CommandError extends Error {
  constructor(
    readonly code: 'forbidden' | 'version_conflict' | 'command_conflict',
    readonly status: 403 | 409,
  ) {
    super(code);
    this.name = 'CommandError';
  }
}

function requestHash(input: CreateDishRevisionInput) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        commandType: 'dish.revision.create',
        dishId: input.dishId,
        expectedVersion: input.expectedVersion,
        name: input.name,
        description: input.description,
      }),
    )
    .digest('hex');
}

function resultFrom(value: unknown): DishRevisionResult {
  return DishRevisionSchema.parse(value);
}

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayError';
  }
}

function eventResult(event: DishEvent): DishRevisionResult {
  if (event.schemaVersion !== 1 || event.eventType !== 'dish.revision.created') {
    throw new ReplayError('unsupported dish event');
  }
  if (!event.payload || typeof event.payload !== 'object') {
    throw new ReplayError('dish event payload is invalid');
  }
  const payload = event.payload as Record<string, unknown>;
  const parsed = DishRevisionSchema.safeParse({
    dishId: payload.dishId,
    revisionId: payload.revisionId,
    version: payload.version,
    name: payload.name,
    description: payload.description,
  });
  if (
    !parsed.success ||
    parsed.data.dishId !== event.streamId ||
    parsed.data.version !== event.version
  ) {
    throw new ReplayError('dish event payload does not match its stream');
  }
  return parsed.data;
}

export function replayDish(events: readonly DishEvent[]): DishProjection | null {
  if (events.length === 0) return null;
  const first = events[0];
  if (!first || first.streamType !== 'dish') throw new ReplayError('mixed stream replay');
  let projection: DishProjection | null = null;
  for (const event of events) {
    if (
      event.tenantId !== first.tenantId ||
      event.streamType !== 'dish' ||
      event.streamId !== first.streamId ||
      event.version !== (projection?.version ?? 0) + 1
    ) {
      throw new ReplayError('dish stream is not contiguous');
    }
    projection = { tenantId: event.tenantId, ...eventResult(event) };
  }
  return projection;
}

export type CreateDishRevisionOptions = {
  inTransaction?: boolean;
};

export async function createDishRevision(
  client: Client,
  actorId: string,
  venueId: string,
  input: CreateDishRevisionInput,
  options?: CreateDishRevisionOptions,
): Promise<DishRevisionResult> {
  const inTx = options?.inTransaction === true;
  let started = false;
  try {
    if (!inTx) {
      await client.query('BEGIN');
      started = true;
    }
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);

    const membership = await client.query<{ permission: string }>(
      `SELECT permission
       FROM app_private.staff_membership
       WHERE tenant_id = $1 AND actor_id = $2
       FOR SHARE`,
      [venueId, actorId],
    );
    if (!['owner', 'editor'].includes(membership.rows[0]?.permission ?? '')) {
      throw new CommandError('forbidden', 403);
    }

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);
    const hash = requestHash(input);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `command:${venueId}:${actorId}:${input.commandId}`,
    ]);

    const receipt = await client.query<{ request_hash: string; result: unknown }>(
      `SELECT request_hash, result
       FROM app_private.es_command
       WHERE tenant_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [venueId, actorId, input.commandId],
    );
    const existing = receipt.rows[0];
    if (existing) {
      if (existing.request_hash !== hash) throw new CommandError('command_conflict', 409);
      if (!inTx) {
        await client.query('COMMIT');
        started = false;
      }
      return resultFrom(existing.result);
    }

    // This also serializes first revisions, where there is no projection row to lock yet.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `dish:${venueId}:${input.dishId}`,
    ]);
    const current = await client.query<{ version: number }>(
      `SELECT version
       FROM app_private.dish_current
       WHERE tenant_id = $1 AND dish_id = $2`,
      [venueId, input.dishId],
    );
    const currentVersion = current.rows[0]?.version ?? 0;
    if (input.expectedVersion !== currentVersion) {
      throw new CommandError('version_conflict', 409);
    }

    const version = currentVersion + 1;
    const revisionId = randomUUID();
    const eventId = randomUUID();
    const commandResult: DishRevisionResult = {
      dishId: input.dishId,
      revisionId,
      version,
      name: input.name,
      description: input.description,
    };
    const eventPayload = JSON.stringify({ ...commandResult, commandId: input.commandId });
    const commandPayload = JSON.stringify({
      dishId: input.dishId,
      expectedVersion: input.expectedVersion,
      name: input.name,
      description: input.description,
    });

    await client.query(
      `INSERT INTO app_private.es_event
        (id, tenant_id, stream_type, stream_id, version, schema_version, event_type, payload, metadata)
       VALUES ($1, $2, 'dish', $3, $4, 1, 'dish.revision.created', $5::jsonb, $6::jsonb)`,
      [eventId, venueId, input.dishId, version, eventPayload, JSON.stringify({ actorId })],
    );
    if (current.rows[0]) {
      await client.query(
        `UPDATE app_private.dish_current
         SET version = $3, revision_id = $4, name = $5, description = $6, updated_at = now()
         WHERE tenant_id = $1 AND dish_id = $2`,
        [venueId, input.dishId, version, revisionId, input.name, input.description],
      );
    } else {
      await client.query(
        `INSERT INTO app_private.dish_current
          (tenant_id, dish_id, version, revision_id, name, description)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [venueId, input.dishId, version, revisionId, input.name, input.description],
      );
    }
    await client.query(
      `INSERT INTO app_private.es_command
        (id, tenant_id, actor_id, command_type, idempotency_key, payload, request_hash, result)
       VALUES ($1, $2, $3, 'dish.revision.create', $4, $5::jsonb, $6, $7::jsonb)`,
      [
        randomUUID(),
        venueId,
        actorId,
        input.commandId,
        commandPayload,
        hash,
        JSON.stringify(commandResult),
      ],
    );
    await client.query(
      `INSERT INTO app_private.outbox (id, tenant_id, event_id, topic, payload)
       VALUES ($1, $2, $3, 'dish.revision.created', $4::jsonb)`,
      [randomUUID(), venueId, eventId, JSON.stringify({ eventId, dishId: input.dishId })],
    );
    if (!inTx) {
      await client.query('COMMIT');
      started = false;
    }
    return commandResult;
  } catch (error) {
    if (started) await client.query('ROLLBACK');
    throw error;
  }
}
