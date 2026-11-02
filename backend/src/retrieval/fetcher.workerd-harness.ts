import { Hono } from 'hono';
import { createApp } from '../index';
import { safeFetch } from './fetcher';
import { validateDestination } from './security';

const app = new Hono();

// Direct safeFetch endpoint for exercising the transport security boundary inside workerd
app.post('/test/safe-fetch', async (c) => {
  const body = (await c.req.json()) as { url: string; options?: Record<string, unknown> };
  try {
    const result = await safeFetch(body.url, body.options);
    return c.json({ ok: true, result });
  } catch (err: unknown) {
    return c.json(
      {
        ok: false,
        name: (err as Error).name,
        message: (err as Error).message,
        code: (err as { code?: string }).code,
      },
      400,
    );
  }
});

// Direct validateDestination endpoint for exercising DNS/IP validation inside workerd
app.post('/test/validate-destination', async (c) => {
  const body = (await c.req.json()) as { url: string; options?: Record<string, unknown> };
  try {
    const result = await validateDestination(body.url, body.options);
    return c.json({ ok: true, url: result.url.toString(), resolvedIPs: result.resolvedIPs });
  } catch (err: unknown) {
    return c.json(
      {
        ok: false,
        name: (err as Error).name,
        message: (err as Error).message,
        code: (err as { code?: string }).code,
      },
      400,
    );
  }
});

// Mounted production createApp router with staff verifier dependency injected (no DB dependency)
const api = createApp({
  verify: async () => '00000000-0000-4000-8000-000000000002',
  execute: async () => {
    throw new Error('unused in retrieval');
  },
  // authorizeVenue omitted (optional), allowing route to reach production retrieveMenuEvidence
});

app.route('/api', api);

export default app;
