import { describe, expect, it } from 'vitest';
import { OwnerWorkspaceResponseSchema } from './owner-workspace';

const actorId = '11111111-1111-4111-8111-111111111111';
const venue = {
  venueId: '22222222-2222-4222-8222-222222222222',
  name: 'Synthetic restaurant',
  permission: 'owner',
};

describe('owner workspace contract', () => {
  it('accepts empty access and owner/editor restaurants only', () => {
    expect(OwnerWorkspaceResponseSchema.parse({ actorId, venues: [] }).venues).toEqual([]);
    expect(OwnerWorkspaceResponseSchema.safeParse({ actorId, venues: [venue] }).success).toBe(true);
    expect(
      OwnerWorkspaceResponseSchema.safeParse({
        actorId,
        venues: [{ ...venue, permission: 'editor' }],
      }).success,
    ).toBe(true);
    expect(
      OwnerWorkspaceResponseSchema.safeParse({
        actorId,
        venues: [{ ...venue, permission: 'viewer' }],
      }).success,
    ).toBe(false);
  });
  it('rejects duplicate venues and invented setup or authority fields', () => {
    expect(
      OwnerWorkspaceResponseSchema.safeParse({ actorId, venues: [venue, venue] }).success,
    ).toBe(false);
    expect(
      OwnerWorkspaceResponseSchema.safeParse({ actorId, venues: [{ ...venue, published: true }] })
        .success,
    ).toBe(false);
    expect(
      OwnerWorkspaceResponseSchema.safeParse({ actorId, venues: [], token: 'not-a-contract-field' })
        .success,
    ).toBe(false);
  });
});
