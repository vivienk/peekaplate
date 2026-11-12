import type { CreateOwnerInsightActionRequest } from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import {
  createOwnerInsightAction,
  listOwnerInsightActions,
  OwnerInsightActionError,
  updateOwnerInsightAction,
} from './owner-insight-actions';

type Query = { text: string; values?: unknown[] };
type Response = { rows: unknown[]; rowCount?: number | null };

class ScriptedClient {
  readonly queries: Query[] = [];

  constructor(private readonly responses: Response[]) {}

  async query(text: string, values?: unknown[]) {
    this.queries.push(values ? { text, values } : { text });
    return this.responses.shift() ?? { rows: [], rowCount: 0 };
  }
}

const actorId = '00000000-0000-4000-8000-000000000101';
const venueId = '00000000-0000-4000-8000-000000000102';
const otherVenueId = '00000000-0000-4000-8000-000000000103';
const menuId = '00000000-0000-4000-8000-000000000104';
const menuRevisionId = '00000000-0000-4000-8000-000000000105';
const actionId = '00000000-0000-4000-8000-000000000106';
const commandId = '00000000-0000-4000-8000-000000000107';

const action = {
  actionId,
  venueId,
  insightKey: 'dish.low_conversion',
  menuId,
  menuRevisionId,
  category: 'description_update',
  status: 'planned',
  note: 'Check the current description',
  version: 1,
  createdBy: actorId,
  updatedBy: actorId,
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
};

const createInput: CreateOwnerInsightActionRequest = {
  commandId,
  insightKey: 'dish.low_conversion',
  menuId,
  menuRevisionId,
  category: 'description_update',
  note: 'Check the current description',
};

function authorizationResponses(permission = 'owner'): Response[] {
  return [
    { rows: [] }, // BEGIN
    { rows: [] }, // statement timeout
    { rows: [] }, // lock timeout
    { rows: [] }, // actor context
    { rows: [{ permission }] },
    { rows: [] }, // tenant context, when authorized
  ];
}

function receiptLookup(requestHash = 'a'.repeat(64), result: unknown = null): Response {
  return {
    rows: [{ request_hash: requestHash, result }],
    rowCount: 1,
  };
}

describe('owner insight action authorization', () => {
  it('denies non-owners before receipt lookup and rolls back', async () => {
    const client = new ScriptedClient([
      ...authorizationResponses('editor').slice(0, 5),
      { rows: [] }, // ROLLBACK
    ]);

    await expect(
      createOwnerInsightAction(client as never, actorId, venueId, createInput),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });

    expect(client.queries.some((query) => query.text.includes('app_private.es_command'))).toBe(
      false,
    );
    expect(client.queries.at(-1)?.text).toBe('ROLLBACK');
  });
});

describe('owner insight action creation', () => {
  it('checks the exact venue revision, inserts the action and records its receipt', async () => {
    const client = new ScriptedClient([
      ...authorizationResponses(),
      { rows: [] }, // advisory lock
      { rows: [] }, // no existing receipt
      { rows: [{ '?column?': 1 }], rowCount: 1 }, // menu revision exists
      { rows: [action], rowCount: 1 }, // action insert
      { rows: [] }, // receipt insert
      { rows: [] }, // COMMIT
    ]);

    const result = await createOwnerInsightAction(client as never, actorId, venueId, createInput);

    expect(result).toEqual({ schemaVersion: 1, action });

    const membershipIndex = client.queries.findIndex((query) =>
      query.text.includes('FROM app_private.staff_membership'),
    );
    const tenantContextIndex = client.queries.findIndex((query) =>
      query.text.includes("set_config('app.tenant_id'"),
    );
    const receiptIndex = client.queries.findIndex((query) =>
      query.text.includes('FROM app_private.es_command'),
    );
    const subjectIndex = client.queries.findIndex((query) =>
      query.text.includes('FROM app_private.menu_review_subject'),
    );
    const insertIndex = client.queries.findIndex((query) =>
      query.text.includes('INSERT INTO app_private.owner_insight_action_current'),
    );
    const recordIndex = client.queries.findIndex((query) =>
      query.text.includes('INSERT INTO app_private.es_command'),
    );

    expect(membershipIndex).toBeLessThan(tenantContextIndex);
    expect(tenantContextIndex).toBeLessThan(receiptIndex);
    expect(receiptIndex).toBeLessThan(subjectIndex);
    expect(subjectIndex).toBeLessThan(insertIndex);
    expect(insertIndex).toBeLessThan(recordIndex);
    expect(client.queries.at(-1)?.text).toBe('COMMIT');

    expect(client.queries[subjectIndex]?.values).toEqual([venueId, menuId, menuRevisionId]);
    expect(client.queries[insertIndex]?.values?.[0]).toBe(venueId);
  });

  it('returns the stored result on an identical command retry without inserting again', async () => {
    const storedResult = {
      schemaVersion: 1,
      action,
    };
    const client = new ScriptedClient([
      ...authorizationResponses(),
      { rows: [] }, // advisory lock
      {
        rows: [
          {
            request_hash: 'placeholder',
            result: storedResult,
          },
        ],
      },
      { rows: [] }, // COMMIT
    ]);

    // Use the same deterministic payload hash as the service.
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          commandType: 'owner.insight_action.create',
          payload: {
            insightKey: createInput.insightKey,
            menuId: createInput.menuId,
            menuRevisionId: createInput.menuRevisionId,
            category: createInput.category,
            note: createInput.note,
          },
        }),
      )
      .digest('hex');

    client['responses'].splice(7, 1, {
      rows: [{ request_hash: hash, result: storedResult }],
    });

    const result = await createOwnerInsightAction(client as never, actorId, venueId, createInput);

    expect(result).toEqual(storedResult);
    expect(
      client.queries.some((query) =>
        query.text.includes('INSERT INTO app_private.owner_insight_action_current'),
      ),
    ).toBe(false);
    expect(client.queries.at(-1)?.text).toBe('COMMIT');
  });

  it('rejects reuse of a command ID with a different payload', async () => {
    const client = new ScriptedClient([
      ...authorizationResponses(),
      { rows: [] }, // advisory lock
      { rows: [{ request_hash: 'f'.repeat(64), result: {} }] },
      { rows: [] }, // ROLLBACK
    ]);

    await expect(
      createOwnerInsightAction(client as never, actorId, venueId, createInput),
    ).rejects.toMatchObject({
      code: 'command_conflict',
      status: 409,
    });

    expect(
      client.queries.some((query) =>
        query.text.includes('INSERT INTO app_private.owner_insight_action_current'),
      ),
    ).toBe(false);
    expect(client.queries.at(-1)?.text).toBe('ROLLBACK');
  });
});

describe('owner insight action updates', () => {
  it('rejects a stale expected version without updating or recording a receipt', async () => {
    const client = new ScriptedClient([
      ...authorizationResponses(),
      { rows: [] }, // advisory lock
      { rows: [] }, // no existing receipt
      { rows: [{ version: 2 }], rowCount: 1 }, // current action
      { rows: [] }, // ROLLBACK
    ]);

    await expect(
      updateOwnerInsightAction(client as never, actorId, venueId, actionId, {
        commandId,
        expectedVersion: 1,
        status: 'active',
      }),
    ).rejects.toMatchObject({
      code: 'version_conflict',
      status: 409,
    });

    expect(
      client.queries.some((query) =>
        query.text.includes('UPDATE app_private.owner_insight_action_current'),
      ),
    ).toBe(false);
    expect(
      client.queries.some((query) => query.text.includes('INSERT INTO app_private.es_command')),
    ).toBe(false);
    expect(client.queries.at(-1)?.text).toBe('ROLLBACK');
  });
});

describe('owner insight action listing', () => {
  it('authorizes the owner and scopes the query to the route venue', async () => {
    const client = new ScriptedClient([
      ...authorizationResponses(),
      { rows: [action], rowCount: 1 },
      { rows: [] }, // COMMIT
    ]);

    const result = await listOwnerInsightActions(client as never, actorId, venueId, {
      insightKey: 'dish.low_conversion',
      limit: 10,
    });

    expect(result).toEqual({
      schemaVersion: 1,
      actions: [action],
    });

    const listQuery = client.queries.find((query) =>
      query.text.includes('ORDER BY updated_at DESC'),
    );

    expect(listQuery?.values).toEqual([venueId, 'dish.low_conversion', null, 10]);
    expect(listQuery?.text).toContain('WHERE tenant_id = $1');
    expect(client.queries.at(-1)?.text).toBe('COMMIT');
  });
});

describe('owner insight action access and revision validation', () => {
  it('denies a revoked member whose membership no longer exists', async () => {
    const client = new ScriptedClient([
      { rows: [] }, // BEGIN
      { rows: [] }, // statement timeout
      { rows: [] }, // lock timeout
      { rows: [] }, // actor context
      { rows: [] }, // revoked membership
      { rows: [] }, // ROLLBACK
    ]);

    await expect(
      listOwnerInsightActions(client as never, actorId, venueId, {
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });

    expect(client.queries.some((query) => query.text.includes("set_config('app.tenant_id'"))).toBe(
      false,
    );
    expect(client.queries.at(-1)?.text).toBe('ROLLBACK');
  });

  it('does not create an action for a missing menu revision', async () => {
    const client = new ScriptedClient([
      ...authorizationResponses(),
      { rows: [] }, // advisory lock
      { rows: [] }, // no existing receipt
      { rows: [], rowCount: 0 }, // revision does not exist
      { rows: [] }, // ROLLBACK
    ]);

    await expect(
      createOwnerInsightAction(client as never, actorId, venueId, createInput),
    ).rejects.toMatchObject({
      code: 'menu_revision_not_found',
      status: 404,
    });

    expect(
      client.queries.some((query) =>
        query.text.includes('INSERT INTO app_private.owner_insight_action_current'),
      ),
    ).toBe(false);
    expect(client.queries.at(-1)?.text).toBe('ROLLBACK');
  });
});

describe('owner insight action successful updates', () => {
  it('increments the version and records the update receipt', async () => {
    const updatedAction = {
      ...action,
      status: 'active',
      version: 2,
      updatedAt: '2026-11-10T00:05:00.000Z',
    };

    const client = new ScriptedClient([
      ...authorizationResponses(),
      { rows: [] }, // advisory lock
      { rows: [] }, // no existing receipt
      { rows: [{ version: 1 }], rowCount: 1 }, // current action
      { rows: [updatedAction], rowCount: 1 }, // update
      { rows: [] }, // receipt insert
      { rows: [] }, // COMMIT
    ]);

    const result = await updateOwnerInsightAction(client as never, actorId, venueId, actionId, {
      commandId,
      expectedVersion: 1,
      status: 'active',
    });

    expect(result).toEqual({
      schemaVersion: 1,
      action: updatedAction,
    });

    const updateIndex = client.queries.findIndex((query) =>
      query.text.includes('UPDATE app_private.owner_insight_action_current'),
    );
    const receiptIndex = client.queries.findIndex((query) =>
      query.text.includes('INSERT INTO app_private.es_command'),
    );

    expect(updateIndex).toBeGreaterThan(-1);
    expect(receiptIndex).toBeGreaterThan(updateIndex);
    expect(client.queries[updateIndex]?.values?.[0]).toBe(venueId);
    expect(client.queries[updateIndex]?.values?.[1]).toBe(actionId);
    expect(client.queries[updateIndex]?.values?.[7]).toBe(1);
    expect(client.queries.at(-1)?.text).toBe('COMMIT');
  });
});
