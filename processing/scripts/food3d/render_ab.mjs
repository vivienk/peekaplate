#!/usr/bin/env node
/**
 * Food3D V1 Stage 4a: headless A/B turntable, relighting, and 216-pose fidelity renderer.
 *
 * Usage:
 *   node render_ab.mjs <root_dir> <dish_subdir> \
 *     --v1-150k <rel_glb> --v1-35k <rel_glb> --raw-mobile <rel_glb> \
 *     [--exp0-150k <rel_glb>] [--skip-poses]
 *
 * Every output stays private R&D (publication_eligible: false, ADR 0004).
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const DEFAULT_THREE_DIR =
  '/home/yacine105/t3-code-handoff/peekaplate/node_modules/.pnpm/three@0.182.0/node_modules/three';
const DEFAULT_PLAYWRIGHT =
  '/home/yacine105/t3-code-handoff/peekaplate/node_modules/.pnpm/playwright@1.64.0/node_modules/playwright/index.mjs';
const DEFAULT_CHROMIUM =
  '/home/yacine105/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

function parseArgs(argv) {
  const positional = [];
  const opts = {
    v1_150k: null,
    v1_35k: null,
    raw_mobile: null,
    exp0_150k: null,
    skipPoses: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--v1-150k') {
      opts.v1_150k = argv[++i];
    } else if (arg === '--v1-35k') {
      opts.v1_35k = argv[++i];
    } else if (arg === '--raw-mobile') {
      opts.raw_mobile = argv[++i];
    } else if (arg === '--exp0-150k') {
      opts.exp0_150k = argv[++i];
    } else if (arg === '--skip-poses') {
      opts.skipPoses = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 2 || !opts.v1_150k || !opts.v1_35k || !opts.raw_mobile) {
    throw new Error(
      'Usage: node render_ab.mjs <root_dir> <dish_subdir> ' +
        '--v1-150k <rel_glb> --v1-35k <rel_glb> --raw-mobile <rel_glb> ' +
        '[--exp0-150k <rel_glb>] [--skip-poses]',
    );
  }

  return {
    rootDir: resolve(positional[0]),
    dishSubdir: positional[1],
    ...opts,
  };
}

function startStaticServer(rootDir, threeDir) {
  const server = createServer((req, res) => {
    const rawPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const rel = normalize(rawPath).replace(/^\/+/, '');
    if (rel.startsWith('..') || rel.includes('/../')) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let filePath;
    if (rel === '_three' || rel.startsWith('_three/')) {
      const sub = rel.slice('_three/'.length);
      filePath = join(threeDir, sub);
    } else if (rel === 'viewer.html') {
      const rootViewer = join(rootDir, 'viewer.html');
      filePath = existsSync(rootViewer) ? rootViewer : join(SCRIPT_DIR, 'viewer.html');
    } else {
      filePath = join(rootDir, rel);
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }

    const mime = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime });
    createReadStream(filePath).pipe(res);
  });

  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolvePromise({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function waitForViewerReady(page, label) {
  const ready = await page
    .waitForFunction(() => window.__ready, null, { timeout: 600_000 })
    .then((h) => h.jsonValue());
  if (ready?.error) {
    throw new Error(`Viewer load failed (${label}): ${ready.error}`);
  }
  return ready;
}

async function renderCondition(page, baseUrl, outFramesDir, cond, size = 512) {
  const initAz = cond.views[0];
  const initLight = cond.lightAz ?? (cond.mode === 'relit' ? 120 : 0);
  const url =
    `${baseUrl}/viewer.html?glb=${encodeURIComponent(cond.glb)}` +
    `&mode=${encodeURIComponent(cond.mode)}&az=${initAz}&el=35` +
    `&lightAz=${initLight}&size=${size}`;

  const tLoad = Date.now();
  await page.setViewportSize({ width: size, height: size });
  await page.goto(url);
  const ready = await waitForViewerReady(page, cond.id);
  const canvas = page.locator('canvas');

  const records = [];
  for (let idx = 0; idx < cond.views.length; idx += 1) {
    const az = cond.views[idx];
    const t0 = Date.now();
    if (idx > 0) {
      await page.evaluate(
        ([a, e, l]) => window.__pose(a, e, l),
        [az, 35, initLight],
      );
    }
    const fileName = `${cond.framePrefix ?? cond.id}_az${az}.png`;
    const filePath = join(outFramesDir, fileName);
    await canvas.screenshot({ path: filePath });
    const ms = idx === 0 ? Date.now() - tLoad : Date.now() - t0;
    records.push({
      condition: cond.id,
      glb: cond.glb,
      mode: cond.mode,
      az,
      el: 35,
      lightAz: initLight,
      tris: ready.tris,
      file: `frames/${fileName}`,
      ms,
    });
    console.log(`[render_ab] ${cond.id} az=${az} tris=${ready.tris} ${ms}ms`);
  }
  return records;
}

async function renderRelitPair(page, baseUrl, dishDir, glbRel, size = 512) {
  const url =
    `${baseUrl}/viewer.html?glb=${encodeURIComponent(glbRel)}` +
    `&mode=lit&bg=transparent&shadows=0&az=0&el=35&lightAz=0&size=${size}`;
  await page.setViewportSize({ width: size, height: size });
  await page.goto(url);
  const ready = await waitForViewerReady(page, 'relit_pair');
  const canvas = page.locator('canvas');

  const relit0 = join(dishDir, 'relit_0.png');
  await canvas.screenshot({ path: relit0, omitBackground: true });

  await page.evaluate(() => window.__pose(0, 35, 120));
  const relit120 = join(dishDir, 'relit_120.png');
  await canvas.screenshot({ path: relit120, omitBackground: true });

  console.log(`[render_ab] relit_0.png & relit_120.png rendered (tris=${ready.tris})`);
  return { relit_0: 'relit_0.png', relit_120: 'relit_120.png', tris: ready.tris };
}

async function renderPosesGrid(page, baseUrl, outDir, dishDir, glbRel) {
  const glbPath = join(outDir, glbRel);
  const sourceDigest = createHash('sha256').update(readFileSync(glbPath)).digest('hex');
  const posesDir = join(dishDir, 'poses');
  mkdirSync(posesDir, { recursive: true });
  const size = 256;
  const url =
    `${baseUrl}/viewer.html?glb=${encodeURIComponent(glbRel)}` +
    `&mode=unlit&bg=none&az=-180&el=0&lightAz=0&size=${size}`;

  await page.setViewportSize({ width: size, height: size });
  await page.goto(url);
  const ready = await waitForViewerReady(page, 'poses_grid');
  const canvas = page.locator('canvas');

  const poses = [];
  let first = true;
  const tStart = Date.now();
  for (let el = 0; el <= 80; el += 10) {
    for (let az = -180; az <= 165; az += 15) {
      if (!first) {
        await page.evaluate(([a, e]) => window.__pose(a, e, 0), [az, el]);
      }
      first = false;
      const fileName = `pose_az${az}_el${el}.png`;
      await canvas.screenshot({
        path: join(posesDir, fileName),
        omitBackground: true,
      });
      poses.push({ az, el, file: fileName });
    }
  }

  const meta = {
    schema_version: 1,
    publication_eligible: false,
    glb: glbRel,
    source_glb: relative(outDir, glbPath),
    source_glb_sha256: sourceDigest,
    expected_poses: 216,
    size,
    tris: ready.tris,
    count: poses.length,
    elapsed_ms: Date.now() - tStart,
    poses,
  };
  writeFileSync(join(posesDir, 'poses.json'), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`[render_ab] ${poses.length} poses rendered in ${meta.elapsed_ms}ms`);
  return meta;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const threeDir = process.env.THREE_DIR || DEFAULT_THREE_DIR;
  const playwrightPath = process.env.PLAYWRIGHT_MODULE || DEFAULT_PLAYWRIGHT;
  const chromiumPath = process.env.CHROMIUM_PATH || DEFAULT_CHROMIUM;

  const { chromium } = await import(playwrightPath);

  const dishDir = join(args.rootDir, args.dishSubdir);
  const framesDir = join(dishDir, 'frames');
  mkdirSync(framesDir, { recursive: true });

  const { server, baseUrl } = await startStaticServer(args.rootDir, threeDir);
  const launchOpts = {
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  };
  if (existsSync(chromiumPath)) {
    launchOpts.executablePath = chromiumPath;
  }

  const browser = await chromium.launch(launchOpts);
  try {
    const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
    const views4 = [0, 90, 180, 270];

    const conditions = [
      { id: 'A_unlit_mobile', glb: args.raw_mobile, mode: 'unlit', views: views4 },
    ];
    if (args.exp0_150k) {
      conditions.push({
        id: 'C_exp0_clean_150k',
        glb: args.exp0_150k,
        mode: 'lit',
        views: views4,
      });
    }
    conditions.push(
      { id: 'E_v1_pbr_150k', glb: args.v1_150k, mode: 'lit', views: views4 },
      { id: 'Em_v1_pbr_35k', glb: args.v1_35k, mode: 'lit', views: views4 },
      {
        id: 'E_relit_120',
        framePrefix: 'E_v1_relit120_150k',
        glb: args.v1_150k,
        mode: 'relit',
        lightAz: 120,
        views: views4,
      },
      { id: 'E_clay_150k', glb: args.v1_150k, mode: 'clay', views: views4 },
      { id: 'E_roughness_150k', glb: args.v1_150k, mode: 'roughness', views: [0] },
      { id: 'E_clearcoat_150k', glb: args.v1_150k, mode: 'clearcoat', views: [0] },
    );

    const frames = [];
    for (const cond of conditions) {
      const recs = await renderCondition(page, baseUrl, framesDir, cond, 512);
      frames.push(...recs);
    }

    const relit = await renderRelitPair(page, baseUrl, dishDir, args.v1_150k, 512);
    let posesSummary = null;
    if (!args.skipPoses) {
      const posesMeta = await renderPosesGrid(page, baseUrl, args.rootDir, dishDir, args.v1_150k);
      posesSummary = {
        dir: 'poses',
        count: posesMeta.count,
        glb: posesMeta.glb,
        elapsed_ms: posesMeta.elapsed_ms,
      };
    }

    const manifest = {
      schema_version: 1,
      publication_eligible: false,
      dish: args.dishSubdir,
      frames,
      relit,
      poses: posesSummary,
    };
    writeFileSync(
      join(dishDir, 'render_manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
