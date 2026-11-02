import { createHash, randomUUID } from 'node:crypto';
import {
  type ApproveMenuRevision,
  type MenuApproval,
  MenuApprovalSchema,
  type MenuPublication,
  MenuPublicationSchema,
  type PublishMenu,
  type WithdrawMenu,
} from '@peekaplate/contracts';
import type { Client } from 'pg';

export type ApproveMenuRevisionInput = ApproveMenuRevision & { menuId: string };
export type PublishMenuInput = PublishMenu & { menuId: string };
export type WithdrawMenuInput = WithdrawMenu & { menuId: string };

export type PublicationEvent = {
  tenantId: string;
  streamType: string;
  streamId: string;
  version: number;
  schemaVersion: number;
  eventType: string;
  payload: unknown;
  metadata: unknown;
};

export type PublicationProjection = MenuPublication & { tenantId: string };
export type ReviewProjection = MenuApproval & { tenantId: string };

export class PublicationCommandError extends Error {
  constructor(
    readonly code:
      | 'forbidden'
      | 'version_conflict'
      | 'command_conflict'
      | 'review_subject_not_found'
      | 'approval_not_found'
      | 'not_published',
    readonly status: 403 | 409,
  ) {
    super(code);
    this.name = 'PublicationCommandError';
  }
}

export class PublicationReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicationReplayError';
  }
}

function hashRequest(commandType: string, payload: Record<string, unknown>) {
  return createHash('sha256')
    .update(JSON.stringify({ commandType, ...payload }))
    .digest('hex');
}

function publicationHash(
  menuId: string,
  approval: {
    approval_id: string;
    menu_revision_id: string;
    content_hash: string;
    asset_manifest_hash: string;
  },
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        menuId,
        menuRevisionId: approval.menu_revision_id,
        contentHash: approval.content_hash,
        assetManifestHash: approval.asset_manifest_hash,
      }),
    )
    .digest('hex');
}

async function beginAuthorizedOwner(
  client: Client,
  actorId: string,
  venueId: string,
): Promise<void> {
  await client.query('BEGIN');
  try {
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
      throw new PublicationCommandError('forbidden', 403);
    }
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function existingReceipt<T>(
  client: Client,
  venueId: string,
  actorId: string,
  commandId: string,
  requestHash: string,
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
  if (existing.request_hash !== requestHash) {
    throw new PublicationCommandError('command_conflict', 409);
  }
  return parse(existing.result);
}

async function recordCommandAndOutbox(
  client: Client,
  input: {
    venueId: string;
    actorId: string;
    commandId: string;
    commandType: string;
    payload: Record<string, unknown>;
    requestHash: string;
    result: unknown;
    eventId: string;
    topic: string;
    outboxPayload: Record<string, unknown>;
  },
) {
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
      input.requestHash,
      JSON.stringify(input.result),
    ],
  );
  await client.query(
    `INSERT INTO app_private.outbox (id, tenant_id, event_id, topic, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [randomUUID(), input.venueId, input.eventId, input.topic, JSON.stringify(input.outboxPayload)],
  );
}

export async function approveMenuRevision(
  client: Client,
  actorId: string,
  venueId: string,
  input: ApproveMenuRevisionInput,
): Promise<MenuApproval> {
  let started = false;
  try {
    await beginAuthorizedOwner(client, actorId, venueId);
    started = true;
    const commandType = 'menu.review.approve';
    const payload = {
      menuId: input.menuId,
      expectedVersion: input.expectedVersion,
      menuRevisionId: input.menuRevisionId,
      contentApprovalId: input.contentApprovalId,
      assetApprovalId: input.assetApprovalId,
    };
    const requestHash = hashRequest(commandType, payload);
    const receipt = await existingReceipt(
      client,
      venueId,
      actorId,
      input.commandId,
      requestHash,
      (value) => MenuApprovalSchema.parse(value),
    );
    if (receipt) {
      await client.query('COMMIT');
      started = false;
      return receipt;
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `menu-review:${venueId}:${input.menuId}`,
    ]);
    const current = await client.query<{ version: number }>(
      `SELECT version FROM app_private.menu_review_current
       WHERE tenant_id = $1 AND menu_id = $2`,
      [venueId, input.menuId],
    );
    const currentVersion = current.rows[0]?.version ?? 0;
    if (input.expectedVersion !== currentVersion) {
      throw new PublicationCommandError('version_conflict', 409);
    }
    const subject = await client.query<{
      content_hash: string;
      asset_manifest_hash: string;
    }>(
      `SELECT content_hash, asset_manifest_hash
       FROM app_private.menu_review_subject
       WHERE tenant_id = $1
         AND menu_id = $2
         AND menu_revision_id = $3
         AND content_approval_id = $4
         AND asset_approval_id = $5`,
      [venueId, input.menuId, input.menuRevisionId, input.contentApprovalId, input.assetApprovalId],
    );
    const approvedSubject = subject.rows[0];
    if (!approvedSubject) {
      throw new PublicationCommandError('review_subject_not_found', 409);
    }

    const version = currentVersion + 1;
    const approvalId = randomUUID();
    const eventId = randomUUID();
    const result: MenuApproval = {
      menuId: input.menuId,
      approvalId,
      version,
      menuRevisionId: input.menuRevisionId,
      contentApprovalId: input.contentApprovalId,
      contentHash: approvedSubject.content_hash,
      assetApprovalId: input.assetApprovalId,
      assetManifestHash: approvedSubject.asset_manifest_hash,
      status: 'approved',
    };
    await client.query(
      `INSERT INTO app_private.es_event
        (id, tenant_id, stream_type, stream_id, version, schema_version, event_type, payload, metadata)
       VALUES ($1, $2, 'menu_review', $3, $4, 1, 'menu.review.approved', $5::jsonb, $6::jsonb)`,
      [
        eventId,
        venueId,
        input.menuId,
        version,
        JSON.stringify(result),
        JSON.stringify({ actorId }),
      ],
    );
    await client.query(
      `INSERT INTO app_private.menu_approval
        (tenant_id, approval_id, menu_id, review_version, menu_revision_id,
         content_approval_id, content_hash, asset_approval_id, asset_manifest_hash, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        venueId,
        approvalId,
        input.menuId,
        version,
        input.menuRevisionId,
        input.contentApprovalId,
        approvedSubject.content_hash,
        input.assetApprovalId,
        approvedSubject.asset_manifest_hash,
        actorId,
      ],
    );
    await client.query(
      `INSERT INTO app_private.menu_review_current (tenant_id, menu_id, version, approval_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, menu_id) DO UPDATE
       SET version = EXCLUDED.version, approval_id = EXCLUDED.approval_id, updated_at = now()`,
      [venueId, input.menuId, version, approvalId],
    );
    await recordCommandAndOutbox(client, {
      venueId,
      actorId,
      commandId: input.commandId,
      commandType,
      payload,
      requestHash,
      result,
      eventId,
      topic: 'menu.review.approved',
      outboxPayload: { eventId, menuId: input.menuId, approvalId },
    });
    await client.query('COMMIT');
    started = false;
    return result;
  } catch (error) {
    if (started) await client.query('ROLLBACK');
    throw error;
  }
}

export async function publishMenu(
  client: Client,
  actorId: string,
  venueId: string,
  input: PublishMenuInput,
): Promise<MenuPublication> {
  let started = false;
  try {
    await beginAuthorizedOwner(client, actorId, venueId);
    started = true;
    const commandType = 'menu.publish';
    const payload = {
      menuId: input.menuId,
      expectedVersion: input.expectedVersion,
      approvalId: input.approvalId,
    };
    const requestHash = hashRequest(commandType, payload);
    const receipt = await existingReceipt(
      client,
      venueId,
      actorId,
      input.commandId,
      requestHash,
      (value) => MenuPublicationSchema.parse(value),
    );
    if (receipt) {
      await client.query('COMMIT');
      started = false;
      return receipt;
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `menu-publication:${venueId}:${input.menuId}`,
    ]);
    const current = await client.query<{
      version: number;
      availability_version: number;
    }>(
      `SELECT version, availability_version
       FROM app_private.menu_publication_current
       WHERE tenant_id = $1 AND menu_id = $2`,
      [venueId, input.menuId],
    );
    const currentVersion = current.rows[0]?.version ?? 0;
    if (input.expectedVersion !== currentVersion) {
      throw new PublicationCommandError('version_conflict', 409);
    }
    const approval = await client.query<{
      approval_id: string;
      menu_revision_id: string;
      content_hash: string;
      asset_manifest_hash: string;
    }>(
      `SELECT approval_id, menu_revision_id, content_hash, asset_manifest_hash
       FROM app_private.menu_approval
       WHERE tenant_id = $1 AND menu_id = $2 AND approval_id = $3`,
      [venueId, input.menuId, input.approvalId],
    );
    const approved = approval.rows[0];
    if (!approved) throw new PublicationCommandError('approval_not_found', 409);

    const version = currentVersion + 1;
    const availabilityVersion = (current.rows[0]?.availability_version ?? 0) + 1;
    const publicationId = randomUUID();
    const eventId = randomUUID();
    const result: MenuPublication = {
      menuId: input.menuId,
      publicationId,
      version,
      approvalId: approved.approval_id,
      publicationHash: publicationHash(input.menuId, approved),
      availabilityVersion,
      status: 'published',
    };
    await client.query(
      `INSERT INTO app_private.es_event
        (id, tenant_id, stream_type, stream_id, version, schema_version, event_type, payload, metadata)
       VALUES ($1, $2, 'menu_publication', $3, $4, 1, 'menu.published', $5::jsonb, $6::jsonb)`,
      [
        eventId,
        venueId,
        input.menuId,
        version,
        JSON.stringify(result),
        JSON.stringify({ actorId }),
      ],
    );
    await client.query(
      `INSERT INTO app_private.menu_publication_current
        (tenant_id, menu_id, version, publication_id, approval_id,
         publication_hash, availability_version, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'published')
       ON CONFLICT (tenant_id, menu_id) DO UPDATE
       SET version = EXCLUDED.version,
           publication_id = EXCLUDED.publication_id,
           approval_id = EXCLUDED.approval_id,
           publication_hash = EXCLUDED.publication_hash,
           availability_version = EXCLUDED.availability_version,
           status = EXCLUDED.status,
           updated_at = now()`,
      [
        venueId,
        input.menuId,
        version,
        publicationId,
        approved.approval_id,
        result.publicationHash,
        availabilityVersion,
      ],
    );
    await recordCommandAndOutbox(client, {
      venueId,
      actorId,
      commandId: input.commandId,
      commandType,
      payload,
      requestHash,
      result,
      eventId,
      topic: 'menu.published',
      outboxPayload: { eventId, menuId: input.menuId, publicationId },
    });
    await client.query('COMMIT');
    started = false;
    return result;
  } catch (error) {
    if (started) await client.query('ROLLBACK');
    throw error;
  }
}

export async function withdrawMenu(
  client: Client,
  actorId: string,
  venueId: string,
  input: WithdrawMenuInput,
): Promise<MenuPublication> {
  let started = false;
  try {
    await beginAuthorizedOwner(client, actorId, venueId);
    started = true;
    const commandType = 'menu.withdraw';
    const payload = { menuId: input.menuId, expectedVersion: input.expectedVersion };
    const requestHash = hashRequest(commandType, payload);
    const receipt = await existingReceipt(
      client,
      venueId,
      actorId,
      input.commandId,
      requestHash,
      (value) => MenuPublicationSchema.parse(value),
    );
    if (receipt) {
      await client.query('COMMIT');
      started = false;
      return receipt;
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `menu-publication:${venueId}:${input.menuId}`,
    ]);
    const current = await client.query<{
      version: number;
      publication_id: string;
      approval_id: string;
      publication_hash: string;
      availability_version: number;
      status: string;
    }>(
      `SELECT version, publication_id, approval_id, publication_hash, availability_version, status
       FROM app_private.menu_publication_current
       WHERE tenant_id = $1 AND menu_id = $2`,
      [venueId, input.menuId],
    );
    const live = current.rows[0];
    const currentVersion = live?.version ?? 0;
    if (input.expectedVersion !== currentVersion) {
      throw new PublicationCommandError('version_conflict', 409);
    }
    if (!live || live.status !== 'published') {
      throw new PublicationCommandError('not_published', 409);
    }

    const eventId = randomUUID();
    const result: MenuPublication = {
      menuId: input.menuId,
      publicationId: live.publication_id,
      version: currentVersion + 1,
      approvalId: live.approval_id,
      publicationHash: live.publication_hash,
      availabilityVersion: live.availability_version + 1,
      status: 'withdrawn',
    };
    await client.query(
      `INSERT INTO app_private.es_event
        (id, tenant_id, stream_type, stream_id, version, schema_version, event_type, payload, metadata)
       VALUES ($1, $2, 'menu_publication', $3, $4, 1, 'menu.withdrawn', $5::jsonb, $6::jsonb)`,
      [
        eventId,
        venueId,
        input.menuId,
        result.version,
        JSON.stringify(result),
        JSON.stringify({ actorId }),
      ],
    );
    await client.query(
      `UPDATE app_private.menu_publication_current
       SET version = $3, availability_version = $4, status = 'withdrawn', updated_at = now()
       WHERE tenant_id = $1 AND menu_id = $2`,
      [venueId, input.menuId, result.version, result.availabilityVersion],
    );
    await recordCommandAndOutbox(client, {
      venueId,
      actorId,
      commandId: input.commandId,
      commandType,
      payload,
      requestHash,
      result,
      eventId,
      topic: 'menu.withdrawn',
      outboxPayload: {
        eventId,
        menuId: input.menuId,
        publicationId: result.publicationId,
      },
    });
    await client.query('COMMIT');
    started = false;
    return result;
  } catch (error) {
    if (started) await client.query('ROLLBACK');
    throw error;
  }
}

export function replayPublication(
  events: readonly PublicationEvent[],
): PublicationProjection | null {
  if (events.length === 0) return null;
  const first = events[0];
  if (!first || first.streamType !== 'menu_publication') {
    throw new PublicationReplayError('mixed publication stream');
  }
  let projection: PublicationProjection | null = null;
  for (const event of events) {
    if (
      event.tenantId !== first.tenantId ||
      event.streamType !== 'menu_publication' ||
      event.streamId !== first.streamId ||
      event.version !== (projection?.version ?? 0) + 1 ||
      event.schemaVersion !== 1
    ) {
      throw new PublicationReplayError('publication stream is not contiguous');
    }
    const parsed = MenuPublicationSchema.safeParse(event.payload);
    if (
      !parsed.success ||
      parsed.data.menuId !== event.streamId ||
      parsed.data.version !== event.version ||
      parsed.data.availabilityVersion !== (projection?.availabilityVersion ?? 0) + 1 ||
      (event.eventType === 'menu.published' && parsed.data.status !== 'published') ||
      (event.eventType === 'menu.withdrawn' && parsed.data.status !== 'withdrawn') ||
      !['menu.published', 'menu.withdrawn'].includes(event.eventType)
    ) {
      throw new PublicationReplayError('publication event payload is invalid');
    }
    if (
      event.eventType === 'menu.withdrawn' &&
      (!projection ||
        projection.status !== 'published' ||
        parsed.data.publicationId !== projection.publicationId ||
        parsed.data.approvalId !== projection.approvalId ||
        parsed.data.publicationHash !== projection.publicationHash ||
        parsed.data.availabilityVersion !== projection.availabilityVersion + 1)
    ) {
      throw new PublicationReplayError('withdrawal does not match the live publication');
    }
    projection = { tenantId: event.tenantId, ...parsed.data };
  }
  return projection;
}

export function replayReview(events: readonly PublicationEvent[]): ReviewProjection | null {
  if (events.length === 0) return null;
  const first = events[0];
  if (!first || first.streamType !== 'menu_review') {
    throw new PublicationReplayError('mixed review stream');
  }
  let projection: ReviewProjection | null = null;
  for (const event of events) {
    if (
      event.tenantId !== first.tenantId ||
      event.streamType !== 'menu_review' ||
      event.streamId !== first.streamId ||
      event.version !== (projection?.version ?? 0) + 1 ||
      event.schemaVersion !== 1 ||
      event.eventType !== 'menu.review.approved'
    ) {
      throw new PublicationReplayError('review stream is not contiguous');
    }
    const parsed = MenuApprovalSchema.safeParse(event.payload);
    if (
      !parsed.success ||
      parsed.data.menuId !== event.streamId ||
      parsed.data.version !== event.version
    ) {
      throw new PublicationReplayError('review event payload is invalid');
    }
    projection = { tenantId: event.tenantId, ...parsed.data };
  }
  return projection;
}
