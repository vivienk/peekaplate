import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { Bindings } from '../src/index';
import { registerOwnerAnalysisRoutes } from '../src/owner-ai/routes';
import { LOCAL_AI_DISH, LOCAL_AI_VENUE, localOwnerAiReport } from './owner-ai-local-fixture';

const mocked = process.env.OWNER_AI_LOCAL_MOCK === 'true';
const key = process.env.OWNER_AI_OPENAI_API_KEY;
const project = process.env.OWNER_AI_OPENAI_PROJECT_ID;
delete process.env.OWNER_AI_OPENAI_API_KEY;
delete process.env.OWNER_AI_OPENAI_PROJECT_ID;
if (!mocked && (!key || !project)) throw new Error('Private OpenAI configuration is required.');
const token = randomBytes(32).toString('hex');
const origin = 'http://127.0.0.1:5174';
const env: Bindings = {
  APP_ENV: 'local',
  SYNTHETIC_REPORT_VENUE_ID: LOCAL_AI_VENUE,
  OWNER_AI_RESPONSES_ENABLED: 'true',
  OWNER_AI_OPENAI_API_KEY: key ?? 'synthetic-only',
  OWNER_AI_OPENAI_PROJECT_ID: project ?? 'proj_synthetic',
};
const app = new Hono<{ Bindings: Bindings }>();
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
app.onError(
  () =>
    new Response('{"error":"service_unavailable"}', {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    }),
);
app.get('/session', (c) => {
  if (
    c.req.header('X-Owner-AI-Local') !== '1' ||
    (c.req.header('Origin') && c.req.header('Origin') !== origin)
  )
    return c.json({ error: 'forbidden' }, 403);
  return c.json({ token, venueId: LOCAL_AI_VENUE, dishId: LOCAL_AI_DISH, mocked });
});
registerOwnerAnalysisRoutes(app, {
  verify: async (authorization) => {
    if (authorization !== `Bearer ${token}`) throw new Error('Invalid local session');
    return 'synthetic-local-owner';
  },
  readReport: async (actor, venue, now) => {
    if (actor !== 'synthetic-local-owner' || venue !== LOCAL_AI_VENUE) throw new Error('Forbidden');
    return localOwnerAiReport(now);
  },
  allowedOrigins: [origin],
  syntheticVenues: [LOCAL_AI_VENUE],
  ...(mocked
    ? {
        fetchImpl: (async () =>
          Response.json({
            status: 'completed',
            model: 'gpt-6-luna',
            output: [
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: '{"metric":"open_rate"}' }],
              },
            ],
            usage: { input_tokens: 50, output_tokens: 8, total_tokens: 58 },
          })) as typeof fetch,
      }
    : {}),
});
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== '127.0.0.1:8792') {
      res.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (typeof value === 'string') headers.set(name, value);
    const response = await app.fetch(
      new Request(`http://127.0.0.1:8792${req.url}`, {
        method: req.method ?? 'GET',
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      }),
      env,
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(503).end();
  }
});
server.listen(8792, '127.0.0.1', () => {
  console.log(
    `Owner AI local ${mocked ? 'MOCK' : 'Responses API'} preview: ${origin}/owner-dashboard.html`,
  );
  console.log(
    'Synthetic data only. At most ten requests per run; 128 output tokens each. Ctrl+C stops both servers.',
  );
});
// Only an explicit small environment reaches the frontend dev server. Never inherit the key.
const frontend = spawn(
  'pnpm',
  ['exec', 'vite', '--host', '127.0.0.1', '--port', '5174', '--strictPort'],
  {
    cwd: fileURLToPath(new URL('../../frontend/console/', import.meta.url).href),
    stdio: 'inherit',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      OWNER_AI_LOCAL_PREVIEW: 'true',
      NODE_ENV: 'development',
    },
  },
);
const stop = (code = 0) => {
  frontend.kill('SIGTERM');
  server.close();
  process.exit(code);
};
process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
frontend.once('exit', (code, signal) => stop(code ?? (signal ? 1 : 0)));
frontend.once('error', () => {
  console.error('Dashboard could not start. Check the local dependencies.');
  stop(1);
});
server.once('error', () => {
  console.error('Local server port unavailable.');
  stop(1);
});
