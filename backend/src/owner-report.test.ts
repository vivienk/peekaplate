import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { CommandError } from './dish-command';
import { readOwnerReport } from './owner-report';

const venueId = 'e2a66159-bd14-44cb-8217-36d001a12676';

// A stand-in for pg's Client: records every statement and answers the membership lookup.
function fakeClient(permission: string | null) {
  const statements: string[] = [];
  const query = vi.fn(async (text: string) => {
    // Keep the whole statement on one line so later checks can find any part of it.
    statements.push(text.trim().replace(/\s+/g, ' '));
    if (text.includes('app_private.staff_membership')) {
      return { rows: permission === null ? [] : [{ permission }] };
    }
    return { rows: [] };
  });
  return { client: { query } as unknown as Client, statements, query };
}

describe('readOwnerReport ownership check', () => {
  it('lets an owner read, inside one read-only transaction with the actor set first', async () => {
    const { client, statements } = fakeClient('owner');
    await readOwnerReport(client, 'actor-1', venueId, new Date('2026-11-04T10:00:00Z'));
    expect(statements[0]).toBe('BEGIN READ ONLY');
    const actorAt = statements.findIndex((s) => s.includes("set_config('app.actor_id'"));
    const membershipAt = statements.findIndex((s) => s.startsWith('SELECT permission'));
    const tenantAt = statements.findIndex((s) => s.includes("set_config('app.tenant_id'"));
    const reportAt = statements.findIndex((s) => s.includes('owner_observation_v1'));
    expect(actorAt).toBeGreaterThan(0);
    expect(membershipAt).toBeGreaterThan(actorAt);
    // The tenant is set only after ownership is confirmed, and before anything is read.
    expect(tenantAt).toBeGreaterThan(membershipAt);
    expect(reportAt).toBeGreaterThan(tenantAt);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  for (const permission of ['editor', 'viewer', null]) {
    it(`refuses ${permission ?? 'a non-member'} with 403 and reads nothing`, async () => {
      const { client, statements } = fakeClient(permission);
      const attempt = readOwnerReport(client, 'actor-1', venueId, new Date());
      await expect(attempt).rejects.toBeInstanceOf(CommandError);
      await expect(attempt).rejects.toMatchObject({ code: 'forbidden', status: 403 });
      expect(statements.some((s) => s.includes('owner_observation_v1'))).toBe(false);
      expect(statements.some((s) => s.includes("set_config('app.tenant_id'"))).toBe(false);
      expect(statements.at(-1)).toBe('ROLLBACK');
    });
  }
});
