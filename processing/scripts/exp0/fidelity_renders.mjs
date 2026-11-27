// Exp0 fidelity search (2026-11-24): render a GLB unlit on a transparent background over a
// grid of azimuth/elevation poses so fidelity.py can find the view that best matches the
// source photo cutout. Private R&D, publication_eligible: false.
//
// node fidelity_renders.mjs <exp0_dir> <out_subdir> <glb_rel_path>
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const PW = process.env.PLAYWRIGHT_MODULE || join(REPO, 'node_modules/.pnpm/playwright@1.64.0/node_modules/playwright/index.mjs');
const { chromium } = await import(PW);

const [root, outSub, glb] = process.argv.slice(2);
if (!root || !outSub || !glb) {
  console.error('usage: node fidelity_renders.mjs <exp0_dir> <out_subdir> <glb_rel_path>');
  process.exit(2);
}
const ROOT = resolve(root);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary' };
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

const SIZE = 256;
// TRELLIS.2 does not put the photo's view at az=0, so search the full circle.
const AZ = Array.from({ length: 24 }, (_, i) => -180 + i * 15);
const EL = [0, 10, 20, 30, 40, 50, 60, 70, 80];
const out = join(ROOT, outSub);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
await page.goto(`${base}/viewer.html?glb=${encodeURIComponent(glb)}&mode=unlit&bg=none&size=${SIZE}&az=0&el=35`);
const ready = await page.waitForFunction(() => window.__ready, null, { timeout: 600_000 }).then((h) => h.jsonValue());
if (ready.error) throw new Error(ready.error);
const poses = [];
for (const az of AZ) {
  for (const el of EL) {
    await page.evaluate(([a, e]) => window.__pose(a, e), [az, el]);
    const file = `az${az}_el${el}.png`;
    await page.locator('canvas').screenshot({ path: join(out, file), omitBackground: true });
    poses.push({ az, el, file });
  }
}
writeFileSync(join(out, 'poses.json'), JSON.stringify({ glb, tris: ready.tris, size: SIZE, poses }, null, 2));
console.log(outSub, poses.length, 'poses');
await browser.close();
server.close();
