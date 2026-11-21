import { createHash, randomUUID } from 'node:crypto';
import {
  type CreateOwnerInsightActionRequest,
  type OwnerInsightAction,
  type OwnerInsightActionListQuery,
  type OwnerInsightActionListResponse,
  OwnerInsightActionListResponseSchema,
  type OwnerInsightActionResponse,
  OwnerInsightActionResponseSchema,
  OwnerInsightActionSchema,
  type UpdateOwnerInsightActionRequest,
} from '@peekaplate/contracts';
import { Client } from 'pg';

type ActionRow = {
  actionId: string;
  venueId: string;
  insightKey: string;
  menuId: string;
  menuRevisionId: string;
  category: string;
  status: string;
  note: string | null;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export class OwnerInsightActionError extends Error {
  constructor(
    readonly code:
      | 'forbidden'
      | 'command_conflict'
      | 'menu_revision_not_found'
      | 'not_found'
      | 'version_conflict',
    readonly status: 403 | 404 | 409,
  ) {
    super(code);
    this.name = 'OwnerInsightActionError';
  }
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseAction(row: ActionRow): OwnerInsightAction {
  return OwnerInsightActionSchema.parse({
    ...row,
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
  });
}

function requestHash(commandType: string, payload: unknown): string {
  return createHash('sha256').update(JSON.stringify({ commandType, payload })).digest('hex');
}

async function withAuthorizedOwner<T>(
  client: Client,
  actorId: string,
  venueId: string,
  run: () => Promise<T>,
): Promise<T> {
  let started = false;

  try {
    await client.query('BEGIN');
    started = true;
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

    if (membership.rows[0]?.permission !== 'owner') {
      throw new OwnerInsightActionError('forbidden', 403);
    }

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);

    const result = await run();
    await client.query('COMMIT');
    started = false;
    return result;
  } catch (error) {
    if (started) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original command error.
      }
    }
    throw error;
  }
}

async function findReceipt<T>(
  client: Client,
  venueId: string,
  actorId: string,
  commandId: string,
  hash: string,
  parse: (value: unknown) => T,
): Promise<T | undefined> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `command:${venueId}:${actorId}:${commandId}`,
  ]);

  const receipt = await client.query<{ request_hash: string; result: unknown }>(
    `SELECT request_hash, result
     FROM app_private.es_command
     WHERE tenant_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
    [venueId, actorId, commandId],
  );

  const existing = receipt.rows[0];
  if (!existing) return undefined;

  if (existing.request_hash !== hash) {
    throw new OwnerInsightActionError('command_conflict', 409);
  }

  return parse(existing.result);
}

async function recordReceipt(
  client: Client,
  input: {
    venueId: string;
    actorId: string;
    commandId: string;
    commandType: string;
    payload: Record<string, unknown>;
    hash: string;
    result: OwnerInsightActionResponse;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO app_private.es_command
      (id, tenant_id, actor_id, command_type, idempotency_key, payload, request_hash, result)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)`,
    [
      randomUUID(),
      input.venueId,
      input.actorId,
      input.commandType,
      input.commandId,
      JSON.stringify(input.payload),
      input.hash,
      JSON.stringify(input.result),
    ],
  );
}

const actionReturning = `
  action_id AS "actionId",
  tenant_id AS "venueId",
  insight_key AS "insightKey",
  menu_id AS "menuId",
  menu_revision_id AS "menuRevisionId",
  category,
  status,
  note,
  version,
  created_by AS "createdBy",
  updated_by AS "updatedBy",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export async function createOwnerInsightAction(
  client: Client,
  actorId: string,
  venueId: string,
  input: CreateOwnerInsightActionRequest,
): Promise<OwnerInsightActionResponse> {
  return withAuthorizedOwner(client, actorId, venueId, async () => {
    const commandType = 'owner.insight_action.create';
    const payload = {
      insightKey: input.insightKey,
      menuId: input.menuId,
      menuRevisionId: input.menuRevisionId,
      category: input.category,
      note: input.note ?? null,
    };
    const hash = requestHash(commandType, payload);

    const replay = await findReceipt(client, venueId, actorId, input.commandId, hash, (value) =>
      OwnerInsightActionResponseSchema.parse(value),
    );
    if (replay) return replay;

    const subject = await client.query(
      `SELECT 1
       FROM app_private.menu_review_subject
       WHERE tenant_id = $1 AND menu_id = $2 AND menu_revision_id = $3`,
      [venueId, input.menuId, input.menuRevisionId],
    );
    if (subject.rowCount !== 1) {
      throw new OwnerInsightActionError('menu_revision_not_found', 404);
    }

    const inserted = await client.query<ActionRow>(
      `INSERT INTO app_private.owner_insight_action_current
        (tenant_id, action_id, insight_key, menu_id, menu_revision_id,
         category, status, note, version, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'planned', $7, 1, $8, $8)
       RETURNING ${actionReturning}`,
      [
        venueId,
        randomUUID(),
        input.insightKey,
        input.menuId,
        input.menuRevisionId,
        input.category,
        input.note ?? null,
        actorId,
      ],
    );

    const insertedRow = inserted.rows[0];
    if (!insertedRow) {
      throw new Error('Owner insight action insert returned no row');
    }

    const result = OwnerInsightActionResponseSchema.parse({
      schemaVersion: 1,
      action: parseAction(insertedRow),
    });

    await recordReceipt(client, {
      venueId,
      actorId,
      commandId: input.commandId,
      commandType,
      payload,
      hash,
      result,
    });

    return result;
  });
}

export async function updateOwnerInsightAction(
  client: Client,
  actorId: string,
  venueId: string,
  actionId: string,
  input: UpdateOwnerInsightActionRequest,
): Promise<OwnerInsightActionResponse> {
  return withAuthorizedOwner(client, actorId, venueId, async () => {
    const commandType = 'owner.insight_action.update';
    const payload = {
      actionId,
      expectedVersion: input.expectedVersion,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.note === undefined ? {} : { note: input.note }),
    };
    const hash = requestHash(commandType, payload);

    const replay = await findReceipt(client, venueId, actorId, input.commandId, hash, (value) =>
      OwnerInsightActionResponseSchema.parse(value),
    );
    if (replay) return replay;

    const current = await client.query<{ version: number }>(
      `SELECT version
       FROM app_private.owner_insight_action_current
       WHERE tenant_id = $1 AND action_id = $2
       FOR UPDATE`,
      [venueId, actionId],
    );

    if (!current.rows[0]) {
      throw new OwnerInsightActionError('not_found', 404);
    }
    if (current.rows[0].version !== input.expectedVersion) {
      throw new OwnerInsightActionError('version_conflict', 409);
    }

    const updated = await client.query<ActionRow>(
      `UPDATE app_private.owner_insight_action_current
       SET status = CASE WHEN $3::boolean THEN $4::text ELSE status END,
           note = CASE WHEN $5::boolean THEN $6::text ELSE note END,
           version = version + 1,
           updated_by = $7,
           updated_at = now()
       WHERE tenant_id = $1 AND action_id = $2 AND version = $8
       RETURNING ${actionReturning}`,
      [
        venueId,
        actionId,
        input.status !== undefined,
        input.status ?? null,
        input.note !== undefined,
        input.note ?? null,
        actorId,
        input.expectedVersion,
      ],
    );

    if (updated.rowCount !== 1) {
      throw new OwnerInsightActionError('version_conflict', 409);
    }

    const updatedRow = updated.rows[0];
    if (!updatedRow) {
      throw new Error('Owner insight action update returned no row');
    }

    const result = OwnerInsightActionResponseSchema.parse({
      schemaVersion: 1,
      action: parseAction(updatedRow),
    });

    await recordReceipt(client, {
      venueId,
      actorId,
      commandId: input.commandId,
      commandType,
      payload,
      hash,
      result,
    });

    return result;
  });
}

export async function listOwnerInsightActions(
  client: Client,
  actorId: string,
  venueId: string,
  query: OwnerInsightActionListQuery,
): Promise<OwnerInsightActionListResponse> {
  return withAuthorizedOwner(client, actorId, venueId, async () => {
    const result = await client.query<ActionRow>(
      `SELECT ${actionReturning}
       FROM app_private.owner_insight_action_current
       WHERE tenant_id = $1
         AND ($2::text IS NULL OR insight_key = $2)
         AND ($3::uuid IS NULL OR menu_revision_id = $3)
       ORDER BY updated_at DESC, action_id DESC
       LIMIT $4`,
      [venueId, query.insightKey ?? null, query.menuRevisionId ?? null, query.limit],
    );

    return OwnerInsightActionListResponseSchema.parse({
      schemaVersion: 1,
      actions: result.rows.map(parseAction),
    });
  });
}
