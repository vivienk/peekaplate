import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { unstable_dev } from 'wrangler';

it.skipIf(!process.env.TEST_WORKERD)(
  'enforces the durable provider cap under concurrency, SQL failure and process restart',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'peekaplate-budget-'));
    const config = join(directory, 'wrangler.json');
    await writeFile(
      config,
      JSON.stringify({
        name: 'synthetic-provider-budget-test',
        compatibility_date: '2026-10-01',
        compatibility_flags: ['nodejs_compat'],
        durable_objects: { bindings: [{ name: 'EXTRACTOR', class_name: 'BudgetTest' }] },
        migrations: [{ tag: 'test-v1', new_sqlite_classes: ['BudgetTest'] }],
        vars: { APP_ENV: 'local', EXTRACTION_SOURCE_ORIGIN: 'https://source.example.test' },
      }),
    );
    let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;
    const start = async () => {
      worker = await unstable_dev(
        fileURLToPath(new URL('../tests/provider-budget-worker.ts', import.meta.url)),
        {
          config,
          local: true,
          ip: '127.0.0.1',
          port: 0,
          inspectorPort: 0,
          logLevel: 'error',
          persist: true,
          persistTo: join(directory, 'state'),
          experimental: {
            forceLocal: true,
            watch: false,
            disableDevRegistry: true,
            disableExperimentalWarning: true,
          },
        },
      );
    };
    const tenant = randomUUID();
    const job = randomUUID();
    const reserve = async (key: string, jobId = job) => {
      const response = await worker!.fetch('/_budget/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenant, 'x-job-id': jobId },
        body: JSON.stringify({ reservation_key: key, provider: 'synthetic', max_calls: 99999 }),
      });
      return {
        status: response.status,
        body: (await response.json()) as {
          granted: boolean;
          used_calls: number;
          max_calls: number;
        },
      };
    };
    try {
      await start();
      const keys = Array.from({ length: 12 }, () => randomUUID());
      const replies = await Promise.all(keys.map((key) => reserve(key)));
      const grants = replies.flatMap((reply, index) => (reply.status === 200 ? [index] : []));
      expect(grants).toHaveLength(2);
      expect(replies.filter((reply) => reply.status === 429)).toHaveLength(10);
      expect(grants.map((index) => replies[index]!.body.used_calls).sort()).toEqual([1, 2]);
      for (const reply of replies) expect(reply.body.max_calls).toBe(2);
      const grantKey = keys[grants[0]!]!;
      expect(await reserve(grantKey)).toEqual(replies[grants[0]!]!);
      const deniedIndex = replies.findIndex((reply) => reply.status === 429);
      expect(await reserve(keys[deniedIndex]!)).toEqual(replies[deniedIndex]!);
      const newJob = randomUUID();
      expect((await reserve(grantKey, newJob)).status).toBe(403);

      await worker!.stop();
      worker = undefined;
      await start();
      expect((await reserve(randomUUID())).status).toBe(429);
      expect(await reserve(grantKey)).toEqual(replies[grants[0]!]!);
      expect((await reserve(randomUUID(), newJob)).body.used_calls).toBe(1);
      expect((await reserve(randomUUID(), newJob)).body.used_calls).toBe(2);

      expect((await worker!.fetch('/test/fail-reservation')).status).toBe(204);
      const rollbackJob = randomUUID();
      const failed = await worker!.fetch('/_budget/reserve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': tenant,
          'x-job-id': rollbackJob,
        },
        body: JSON.stringify({ reservation_key: randomUUID(), provider: 'synthetic' }),
      });
      expect(failed.status).toBe(500);
      await failed.body?.cancel();
      expect((await worker!.fetch('/test/clear-failure')).status).toBe(204);
      expect((await reserve(randomUUID(), rollbackJob)).body.used_calls).toBe(1);
    } finally {
      try {
        await worker?.stop();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  60_000,
);
