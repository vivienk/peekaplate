import { describe, expect, it } from 'vitest';
import {
  CreateOwnerInsightActionRequestSchema,
  OwnerInsightActionListQuerySchema,
  OwnerInsightActionListResponseSchema,
  OwnerInsightActionResponseSchema,
  UpdateOwnerInsightActionRequestSchema,
} from './owner-actions';

const venueId = '00000000-0000-4000-8000-000000000001';
const menuId = '00000000-0000-4000-8000-000000000002';
const revisionId = '00000000-0000-4000-8000-000000000003';
const commandId = '00000000-0000-4000-8000-000000000004';
const actionId = '00000000-0000-4000-8000-000000000005';
const actorId = '00000000-0000-4000-8000-000000000006';

describe('owner insight action contracts', () => {
  it('normalizes UUIDs and accepts a valid create request', () => {
    const parsed = CreateOwnerInsightActionRequestSchema.parse({
      commandId: commandId.toUpperCase(),
      insightKey: 'insight-2026-11-09-v1',
      menuId,
      menuRevisionId: revisionId,
      category: 'description_update',
      note: 'Check the seasonal menu.',
    });

    expect(parsed.commandId).toBe(commandId);
  });

  it('rejects unknown create fields and malformed UUIDs', () => {
    expect(
      CreateOwnerInsightActionRequestSchema.safeParse({
        commandId,
        insightKey: 'insight-1',
        menuId,
        menuRevisionId: revisionId,
        category: 'description_update',
        venueId,
      }).success,
    ).toBe(false);

    expect(
      CreateOwnerInsightActionRequestSchema.safeParse({
        commandId: 'not-a-uuid',
        insightKey: 'insight-1',
        menuId,
        menuRevisionId: revisionId,
        category: 'description_update',
      }).success,
    ).toBe(false);
  });

  it('rejects invalid insight keys, categories, and note values', () => {
    const base = {
      commandId,
      menuId,
      menuRevisionId: revisionId,
      category: 'description_update',
    };

    expect(
      CreateOwnerInsightActionRequestSchema.safeParse({
        ...base,
        insightKey: '   ',
      }).success,
    ).toBe(false);

    expect(
      CreateOwnerInsightActionRequestSchema.safeParse({
        ...base,
        insightKey: 'valid-insight',
        category: 'Review Menu',
      }).success,
    ).toBe(false);

    expect(
      CreateOwnerInsightActionRequestSchema.safeParse({
        ...base,
        insightKey: 'valid-insight',
        note: 'contains\u0000nul',
      }).success,
    ).toBe(false);

    expect(
      CreateOwnerInsightActionRequestSchema.safeParse({
        ...base,
        insightKey: 'valid-insight',
        note: 'x'.repeat(501),
      }).success,
    ).toBe(false);
  });

  it('requires a non-empty update patch', () => {
    expect(
      UpdateOwnerInsightActionRequestSchema.safeParse({
        commandId,
        expectedVersion: 1,
      }).success,
    ).toBe(false);
  });

  it('requires a positive expected version and valid status', () => {
    expect(
      UpdateOwnerInsightActionRequestSchema.safeParse({
        commandId,
        expectedVersion: 0,
        status: 'active',
      }).success,
    ).toBe(false);

    expect(
      UpdateOwnerInsightActionRequestSchema.safeParse({
        commandId,
        expectedVersion: 1,
        status: 'open',
      }).success,
    ).toBe(false);
  });

  it('accepts note clearing and status updates', () => {
    expect(
      UpdateOwnerInsightActionRequestSchema.parse({
        commandId,
        expectedVersion: 1,
        status: 'active',
        note: null,
      }),
    ).toMatchObject({
      expectedVersion: 1,
      status: 'active',
      note: null,
    });
  });

  it('validates list filters and applies the default limit', () => {
    expect(
      OwnerInsightActionListQuerySchema.parse({
        insightKey: 'insight-1',
      }),
    ).toMatchObject({
      insightKey: 'insight-1',
      limit: 50,
    });

    expect(
      OwnerInsightActionListQuerySchema.safeParse({
        limit: '101',
      }).success,
    ).toBe(false);
  });

  it('validates the versioned action response shape', () => {
    const action = {
      actionId,
      venueId,
      insightKey: 'insight-1',
      menuId,
      menuRevisionId: revisionId,
      category: 'description_update',
      status: 'planned',
      note: null,
      version: 1,
      createdBy: actorId,
      updatedBy: actorId,
      createdAt: '2026-11-09T12:00:00.000Z',
      updatedAt: '2026-11-09T12:00:00.000Z',
    };

    expect(
      OwnerInsightActionResponseSchema.parse({
        schemaVersion: 1,
        action,
      }).action.actionId,
    ).toBe(actionId);

    expect(
      OwnerInsightActionListResponseSchema.parse({
        schemaVersion: 1,
        actions: [action],
      }).actions,
    ).toHaveLength(1);

    expect(
      OwnerInsightActionResponseSchema.safeParse({
        schemaVersion: 2,
        action,
      }).success,
    ).toBe(false);
  });
});
