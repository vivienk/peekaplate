import { describe, expect, it } from 'vitest';
import operator from './backfill';

describe('private staging backfill operator entrypoint', () => {
  it('rejects other environments and missing or invalid operator credentials before opening a database', async () => {
    const base = {
      APP_ENV: 'staging',
      BACKFILL_SECRET: 'local-fixture',
      BACKFILL_TENANT: crypto.randomUUID(),
    };
    for (const [environment, secret] of [
      ['production', 'local-fixture'],
      ['staging', 'wrong'],
      ['staging', ''],
    ] as const) {
      const response = await operator.fetch(
        new Request('http://localhost/', { headers: { 'x-backfill-secret': secret } }),
        { ...base, APP_ENV: environment } as Parameters<typeof operator.fetch>[1],
      );
      expect(response.status).toBe(404);
    }
  });
  it('does not expose a writable operation through any method except POST', async () => {
    const response = await operator.fetch(
      new Request('http://localhost/', {
        method: 'DELETE',
        headers: { 'x-backfill-secret': 'local-fixture' },
      }),
      { APP_ENV: 'staging', BACKFILL_SECRET: 'local-fixture' } as Parameters<
        typeof operator.fetch
      >[1],
    );
    expect(response.status).toBe(405);
  });
});
