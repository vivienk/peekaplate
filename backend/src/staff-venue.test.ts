import { describe, expect, it, vi } from 'vitest';
import { CommandError } from './command-error';
import { authorizeStaffVenue } from './staff-venue';

const actor = '11111111-1111-4111-8111-111111111111';
const venue = '22222222-2222-4222-8222-222222222222';

function database(permission: string | null = 'owner') {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => ({
    rows: sql.includes('SELECT permission') && permission ? [{ permission }] : [],
  }));
  return { query };
}

describe('shared staff venue authorization', () => {
  it.each(['owner', 'editor'])(
    'owns and commits its transaction for %s membership',
    async (permission) => {
      const db = database(permission);
      await authorizeStaffVenue(db as never, actor, venue);
      expect(db.query.mock.calls.map(([sql]) => sql)).toEqual([
        'BEGIN',
        "SET LOCAL statement_timeout = '5s'",
        "SET LOCAL lock_timeout = '3s'",
        "SELECT set_config('app.actor_id', $1, true)",
        expect.stringContaining('FOR SHARE'),
        'COMMIT',
      ]);
      expect(db.query).toHaveBeenCalledWith("SELECT set_config('app.actor_id', $1, true)", [actor]);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE tenant_id=$1 AND actor_id=$2 FOR SHARE'),
        [venue, actor],
      );
    },
  );

  it('leaves a caller-owned transaction open with the membership lock held', async () => {
    const db = database();
    await authorizeStaffVenue(db as never, actor, venue, true);
    expect(db.query.mock.calls.some(([sql]) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql))).toBe(
      false,
    );
    expect(db.query.mock.calls.at(-1)?.[0]).toContain('FOR SHARE');
  });

  it.each([null, 'viewer', 'revoked'])(
    'rejects missing or unauthorized membership %s and rolls back its own transaction',
    async (permission) => {
      const db = database(permission);
      await expect(authorizeStaffVenue(db as never, actor, venue)).rejects.toMatchObject({
        code: 'forbidden',
        status: 403,
      });
      expect(db.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
      expect(db.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    },
  );

  it('rechecks membership on every call and lets the caller roll back a revoked membership', async () => {
    const db = database();
    await authorizeStaffVenue(db as never, actor, venue, true);
    db.query.mockResolvedValue({ rows: [] });
    await expect(authorizeStaffVenue(db as never, actor, venue, true)).rejects.toBeInstanceOf(
      CommandError,
    );
    expect(db.query.mock.calls.filter(([sql]) => sql.includes('SELECT permission'))).toHaveLength(
      2,
    );
    expect(db.query.mock.calls.some(([sql]) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql))).toBe(
      false,
    );
  });

  it('preserves the authorization failure when rollback also fails', async () => {
    const db = database(null);
    const query = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (sql, values) => {
      if (sql === 'ROLLBACK') throw new Error('Synthetic rollback failure');
      return query(sql, values);
    });
    await expect(authorizeStaffVenue(db as never, actor, venue)).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
  });
});
