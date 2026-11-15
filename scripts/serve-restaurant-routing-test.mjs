import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAppSite } from './prepare-app-site.mjs';

// Real local Pages routing; API/bundle responses remain intercepted synthetic fixtures.
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(resolve(root, 'work'), { recursive: true });
const temporary = await mkdtemp(resolve(root, 'work/restaurant-routing-'));
const buildDirectory = resolve(temporary, 'build');
const build = spawnSync(
  process.execPath,
  [
    resolve(root, 'frontend/diner/node_modules/vite/bin/vite.js'),
    'build',
    '--base=/diner/',
    '--outDir',
    buildDirectory,
  ],
  {
    cwd: resolve(root, 'frontend/diner'),
    encoding: 'utf8',
    timeout: 45_000,
    env: {
      ...process.env,
      VITE_MENU_SOURCE: 'live',
      VITE_PUBLIC_API_URL: 'http://127.0.0.1:5186',
      VITE_POSTHOG_KEY: '',
    },
  },
);
if (build.error || build.status !== 0) throw new Error(build.stderr || 'Diner build failed');
const site = await prepareAppSite(buildDirectory, resolve(temporary, 'site'));
const child = spawn(
  process.execPath,
  [
    resolve(root, 'backend/node_modules/wrangler/bin/wrangler.js'),
    'pages',
    'dev',
    site,
    '--ip',
    '127.0.0.1',
    '--port',
    '5186',
    '--compatibility-date',
    '2026-10-13',
    '--log-level',
    'warn',
  ],
  { cwd: root, stdio: 'inherit', env: { ...process.env, CLOUDFLARE_SEND_METRICS: 'false' } },
);
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
