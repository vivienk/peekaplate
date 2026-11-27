// Exp0 (2026-11-24): render 4-view turntables of each dish under each condition with the
// three.js viewer in headless Chromium. Private R&D, publication_eligible: false.
//
// node render_turntables.mjs <exp0_dir> <dish> [<dish> ...]
// <exp0_dir> must contain viewer.html, _three -> three@0.182.0 and _src -> source run dir.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// playwright lives in the repo's pnpm store; allow an override for other checkouts.
const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const PW = process.env.PLAYWRIGHT_MODULE || join(REPO, 'node_modules/.pnpm/playwright@1.64.0/node_modules/playwright/index.mjs');
const { chromium } = await import(PW);

const [root, ...dishes] = process.argv.slice(2);
if (!root || dishes.length === 0) {
  console.error('usage: node render_turntables.mjs <exp0_dir> <dish>...');
  process.exit(2);
}
const ROOT = resolve(root);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary', '.png': 'image/png', '.json': 'application/json' };

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '');
  if (path.startsWith('..')) { res.writeHead(403).end(); return; }
  const file = join(ROOT, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

export const CONDITIONS = [
  { id: 'A_shared_mobile_unlit', glb: (d) => `_src/${d}/trellis2_4b_hires_mobile.glb`, mode: 'unlit' },
  { id: 'B_full_lit', glb: (d) => `_src/${d}/trellis2_4b_hires.glb`, mode: 'lit' },
  { id: 'C_clean_150k_lit', glb: (d) => `${d}/lod_150k_2048.glb`, mode: 'lit' },
  { id: 'Cm_clean_35k_lit', glb: (d) => `${d}/lod_35k_1024.glb`, mode: 'lit' },
  { id: 'D_clean_150k_coat', glb: (d) => `${d}/lod_150k_2048.glb`, mode: 'coat' },
  { id: 'C_meshopt_150k_lit', glb: (d) => `${d}/lod_150k_2048.meshopt.glb`, mode: 'lit' },
  { id: 'Cm_meshopt_35k_lit', glb: (d) => `${d}/lod_35k_1024.meshopt.glb`, mode: 'lit' },
  { id: 'clay_full', glb: (d) => `_src/${d}/trellis2_4b_hires.glb`, mode: 'clay' },
  { id: 'clay_150k', glb: (d) => `${d}/lod_150k_2048.glb`, mode: 'clay' },
];
const VIEWS = [0, 90, 180, 270];
const SIZE = 512;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
const log = [];
for (const dish of dishes) {
  const outDir = join(ROOT, dish, 'frames');
  mkdirSync(outDir, { recursive: true });
  const only = (process.env.ONLY || '').split(',').filter(Boolean);
  for (const c of CONDITIONS.filter((x) => only.length === 0 || only.includes(x.id))) {
    for (const az of VIEWS) {
      const url = `${base}/viewer.html?glb=${encodeURIComponent(c.glb(dish))}&mode=${c.mode}&az=${az}&el=35&size=${SIZE}`;
      const t0 = Date.now();
      await page.goto(url);
      const ready = await page.waitForFunction(() => window.__ready, null, { timeout: 600_000 }).then((h) => h.jsonValue());
      if (ready.error) throw new Error(`${dish} ${c.id} ${az}: ${ready.error}`);
      const file = join(outDir, `${c.id}_az${az}.png`);
      await page.locator('canvas').screenshot({ path: file });
      log.push({ dish, condition: c.id, az, tris: ready.tris, ms: Date.now() - t0 });
      console.log(dish, c.id, az, ready.tris, `${Date.now() - t0}ms`);
    }
  }
}
writeFileSync(join(ROOT, `render_log_${Date.now()}.json`), JSON.stringify(log, null, 2));
await browser.close();
server.close();
