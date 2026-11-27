#!/usr/bin/env node
/**
 * Track 2B held-out camera & turntable renderer for Food3D PBR GLBs.
 *
 * Renders a packed PBR GLB at exact pinhole held-out camera intrinsics/extrinsics
 * (no re-normalization) in both `albedo` (unlit baseColor) and `lit` (studio PBR)
 * modes on transparent background, plus optional studio turntable (textured & clay),
 * relit pair, and 216-pose grid for qa_gate.py.
 *
 * Every output stays private R&D (publication_eligible: false, ADR 0004).
 */

import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..');

function findRepoPackageDir(pkgName) {
  const direct = [
    resolve(REPO_ROOT, 'node_modules', pkgName),
    resolve(REPO_ROOT, 'frontend/diner/node_modules', pkgName),
  ];
  for (const cand of direct) {
    if (existsSync(cand)) return cand;
  }
  const pnpmDir = resolve(REPO_ROOT, 'node_modules/.pnpm');
  if (existsSync(pnpmDir)) {
    const prefix = `${pkgName}@`;
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith(prefix)) {
        const cand = join(pnpmDir, entry, 'node_modules', pkgName);
        if (existsSync(cand)) return cand;
      }
    }
  }
  return direct[0];
}

const DEFAULT_THREE_DIR = findRepoPackageDir('three');
const DEFAULT_PLAYWRIGHT = join(findRepoPackageDir('playwright'), 'index.mjs');
const DEFAULT_CHROMIUM =
  '/home/yacine105/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

const EVAL_VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  canvas { display: block; }
</style>
<script type="importmap">
{
  "imports": {
    "three": "./_three/build/three.module.js",
    "three/addons/": "./_three/examples/jsm/"
  }
}
</script>
</head>
<body>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const params = new URLSearchParams(location.search);
const glbUrl = params.get('glb');
const lightingPreset = (params.get('lighting') || 'studio').toLowerCase();
const useLegacyLighting = lightingPreset === 'legacy';
const exposureParam = Number(params.get('exposure'));
const defaultExposure = useLegacyLighting ? 0.96 : 1.04;
const targetExposure = Number.isFinite(exposureParam) && exposureParam > 0 ? exposureParam : defaultExposure;

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  preserveDrawingBuffer: true,
  alpha: true,
});
renderer.setPixelRatio(1);
renderer.setSize(512, 512, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 0);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = null;

function createStudioEnvironment(webglRenderer, legacy = false) {
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(legacy ? 0x1b1a18 : 0xc8c7c4);
  const addPanel = (colorHex, intensity, w, h, pos, target) => {
    const color = new THREE.Color(colorHex).multiplyScalar(intensity);
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.lookAt(target[0], target[1], target[2]);
    envScene.add(mesh);
  };
  if (legacy) {
    addPanel(0xffe1be, 3.2, 5.2, 3.8, [1.4, 4.6, 2.4], [0, 0, 0]);
    addPanel(0xfff1e0, 1.3, 6.5, 6.5, [0.0, 5.5, 0.0], [0, 0, 0]);
    addPanel(0xd4e8ff, 1.55, 5.0, 3.6, [-4.8, 2.1, 1.2], [0, 0, 0]);
    addPanel(0xffd7a8, 2.6, 3.6, 2.2, [-2.2, 2.5, -4.4], [0, 0.2, 0]);
    addPanel(0xf0e4d6, 0.75, 4.0, 2.5, [2.6, 1.8, -4.2], [0, 0, 0]);
  } else {
    addPanel(0xfffcf7, 1.85, 5.5, 4.2, [1.4, 4.6, 2.4], [0, 0, 0]);
    addPanel(0xffffff, 1.15, 7.0, 7.0, [0.0, 5.5, 0.0], [0, 0, 0]);
    addPanel(0xf2f6ff, 1.45, 5.5, 4.2, [-4.8, 1.8, 1.2], [0, 0, 0]);
    addPanel(0xfff7ec, 1.45, 4.8, 3.4, [-2.2, 2.2, -4.4], [0, 0.2, 0]);
    addPanel(0xfaf8f5, 1.35, 5.2, 3.8, [2.8, 1.8, -4.0], [0, 0, 0]);
    addPanel(0xf7f7f7, 1.35, 5.2, 3.8, [4.6, 1.6, 1.6], [0, 0, 0]);
  }
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 18),
    new THREE.MeshBasicMaterial({ color: legacy ? 0x242220 : 0xa6a5a2, side: THREE.DoubleSide }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2.4;
  envScene.add(floor);
  const pmrem = new THREE.PMREMGenerator(webglRenderer);
  pmrem.compileEquirectangularShader();
  const envTex = pmrem.fromScene(envScene, legacy ? 0.035 : 0.04).texture;
  pmrem.dispose();
  return envTex;
}

const studioEnvTex = createStudioEnvironment(renderer, useLegacyLighting);
const keyLight = new THREE.DirectionalLight(
  useLegacyLighting ? 0xfff0dc : 0xfffaf2,
  useLegacyLighting ? 2.55 : 1.48,
);
keyLight.position.set(3.8 * Math.sin(0.52), 4.1, 3.8 * Math.cos(0.52));
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(
  useLegacyLighting ? 0xd8eaff : 0xf2f6ff,
  useLegacyLighting ? 0.42 : 0.38,
);
fillLight.position.set(3.6 * Math.sin(0.52 - Math.PI * 0.62), 2.2, 3.6 * Math.cos(0.52 - Math.PI * 0.62));
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(
  useLegacyLighting ? 0xffdfb8 : 0xfff6ea,
  useLegacyLighting ? 0.65 : 0.45,
);
rimLight.position.set(3.4 * Math.sin(0.52 + Math.PI * 0.92), 2.6, 3.4 * Math.cos(0.52 + Math.PI * 0.92));
scene.add(rimLight);

const camera = new THREE.PerspectiveCamera(45, 1, 0.005, 50);
camera.matrixAutoUpdate = false;

const originalMaterials = new WeakMap();
const albedoMaterials = new WeakMap();
let loadedRoot = null;
let triCount = 0;

function setRenderMode(mode) {
  const isLit = mode === 'lit';
  renderer.toneMapping = isLit ? THREE.NeutralToneMapping : THREE.NoToneMapping;
  renderer.toneMappingExposure = targetExposure;
  scene.environment = isLit ? studioEnvTex : null;
  scene.environmentIntensity = useLegacyLighting ? 0.78 : 0.82;
  keyLight.visible = isLit;
  fillLight.visible = isLit;
  rimLight.visible = isLit;
  if (!loadedRoot) return;
  loadedRoot.traverse((o) => {
    if (!o.isMesh) return;
    const orig = originalMaterials.get(o);
    if (!orig) return;
    if (isLit) {
      o.material = orig;
    } else {
      let mat = albedoMaterials.get(o);
      if (!mat) {
        mat = new THREE.MeshBasicMaterial({
          map: orig.map || null,
          color: orig.map ? 0xffffff : (orig.color ? orig.color.clone() : new THREE.Color(0xffffff)),
          side: THREE.DoubleSide,
        });
        albedoMaterials.set(o, mat);
      }
      o.material = mat;
    }
  });
}

window.__renderCamera = ({ w, h, fl_x, fl_y, cx, cy, transform_matrix, mode, near = 0.005, far = 50.0 }) => {
  renderer.setSize(w, h, false);
  const m = new THREE.Matrix4();
  const sx = (2.0 * fl_x) / w;
  const sy = (2.0 * fl_y) / h;
  const ox = 1.0 - (2.0 * cx) / w;
  const oy = (2.0 * cy) / h - 1.0;
  const a = -(far + near) / (far - near);
  const b = -(2.0 * far * near) / (far - near);
  m.set(
    sx, 0, ox, 0,
    0, sy, oy, 0,
    0, 0, a, b,
    0, 0, -1, 0,
  );
  camera.projectionMatrix.copy(m);
  camera.projectionMatrixInverse.copy(m).invert();

  const t = transform_matrix;
  camera.matrixWorld.set(
    t[0][0], t[0][1], t[0][2], t[0][3],
    t[1][0], t[1][1], t[1][2], t[1][3],
    t[2][0], t[2][1], t[2][2], t[2][3],
    t[3][0], t[3][1], t[3][2], t[3][3],
  );
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

  setRenderMode(mode || 'albedo');
  renderer.clear();
  renderer.render(scene, camera);
  return true;
};

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
loader.load(
  glbUrl,
  (gltf) => {
    loadedRoot = gltf.scene;
    loadedRoot.traverse((o) => {
      if (!o.isMesh) return;
      originalMaterials.set(o, o.material);
      const geom = o.geometry;
      triCount += (geom.index ? geom.index.count : geom.attributes.position.count) / 3;
    });
    scene.add(loadedRoot);
    window.__ready = { tris: Math.round(triCount), publication_eligible: false };
  },
  undefined,
  (err) => {
    window.__ready = { error: String(err), publication_eligible: false };
  },
);
</script>
</body>
</html>
`;

function parseArgs(argv) {
  const opts = {
    glb: null,
    cameras: null,
    outDir: null,
    modes: ['albedo', 'lit'],
    skipTurntable: false,
    renderPoses: false,
    movingLight: false,
    movingLightAz: 0,
    movingLightEl: 55,
    movingLightSteps: [0, 90, 180, 270],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--glb') opts.glb = resolve(argv[++i]);
    else if (arg === '--cameras') opts.cameras = resolve(argv[++i]);
    else if (arg === '--out-dir') opts.outDir = resolve(argv[++i]);
    else if (arg === '--modes')
      opts.modes = argv[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else if (arg === '--skip-turntable') opts.skipTurntable = true;
    else if (arg === '--render-poses') opts.renderPoses = true;
    else if (arg === '--moving-light') opts.movingLight = true;
    else if (arg === '--moving-light-az') opts.movingLightAz = Number(argv[++i]);
    else if (arg === '--moving-light-el') opts.movingLightEl = Number(argv[++i]);
    else if (arg === '--moving-light-steps') {
      opts.movingLightSteps = argv[++i]
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!opts.glb || !opts.outDir) {
    throw new Error(
      'Usage: node render_track2b_eval.mjs --glb <glb> --out-dir <dir> [--cameras <json>] [--modes albedo,lit] [--skip-turntable] [--render-poses]',
    );
  }
  if (!opts.cameras && opts.skipTurntable && !opts.renderPoses && !opts.movingLight) {
    throw new Error(
      'Nothing to render: pass --cameras, turntable, --render-poses, or --moving-light',
    );
  }
  return opts;
}

function startServer(glbPath, threeDir) {
  const glbDir = dirname(glbPath);
  const glbName = basename(glbPath);
  const server = createServer((req, res) => {
    const rawPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const rel = normalize(rawPath).replace(/^\/+/, '');
    if (rel.startsWith('..') || rel.includes('/../')) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (rel === 'eval_viewer.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(EVAL_VIEWER_HTML);
      return;
    }
    let filePath;
    if (rel === '_three' || rel.startsWith('_three/')) {
      filePath = join(threeDir, rel.slice('_three/'.length));
    } else if (rel === 'viewer.html') {
      filePath = join(SCRIPT_DIR, 'viewer.html');
    } else if (rel === glbName) {
      filePath = glbPath;
    } else {
      filePath = join(glbDir, rel);
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
      resolvePromise({ server, baseUrl: `http://127.0.0.1:${port}`, glbName });
    });
  });
}

async function waitForReady(page, label) {
  const ready = await page
    .waitForFunction(() => window.__ready, null, { timeout: 300_000 })
    .then((h) => h.jsonValue());
  if (ready?.error) {
    throw new Error(`Viewer load failed (${label}): ${ready.error}`);
  }
  return ready;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const threeDir = process.env.THREE_DIR || DEFAULT_THREE_DIR;
  const playwrightPath = process.env.PLAYWRIGHT_MODULE || DEFAULT_PLAYWRIGHT;
  const chromiumPath = process.env.CHROMIUM_PATH || DEFAULT_CHROMIUM;
  const { chromium } = await import(playwrightPath);

  let cameras = [];
  if (args.cameras) {
    const camPayload = JSON.parse(readFileSync(args.cameras, 'utf8'));
    cameras = camPayload.cameras || [];
    if (cameras.length === 0) {
      throw new Error(`No cameras in ${args.cameras}`);
    }
  }

  mkdirSync(args.outDir, { recursive: true });
  const { server, baseUrl, glbName } = await startServer(args.glb, threeDir);

  const launchOpts = {
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  };
  if (existsSync(chromiumPath)) {
    launchOpts.executablePath = chromiumPath;
  }

  const browser = await chromium.launch(launchOpts);
  try {
    const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
    let ready = { tris: null };
    const rendered = {};
    if (cameras.length > 0) {
      await page.goto(`${baseUrl}/eval_viewer.html?glb=${encodeURIComponent(glbName)}`);
      ready = await waitForReady(page, 'eval_viewer');
      const canvas = page.locator('canvas');

      for (const mode of args.modes) {
        const modeDir = join(args.outDir, `heldout_${mode}`);
        mkdirSync(modeDir, { recursive: true });
        rendered[mode] = [];
        for (const cam of cameras) {
          await page.setViewportSize({ width: cam.w, height: cam.h });
          await page.evaluate((payload) => window.__renderCamera(payload), { ...cam, mode });
          const outPng = join(modeDir, `${cam.frame_stem}.png`);
          await canvas.screenshot({ path: outPng, omitBackground: true });
          rendered[mode].push(relative(args.outDir, outPng));
        }
        console.log(
          `[render_track2b_eval] rendered ${cameras.length} held-out views (${mode}, tris=${ready.tris})`,
        );
      }
    } else {
      console.log('[render_track2b_eval] no --cameras provided; skipping held-out camera renders');
    }

    const turntableFiles = [];
    if (!args.skipTurntable) {
      const ttDir = join(args.outDir, 'turntable');
      mkdirSync(ttDir, { recursive: true });
      const views = [0, 90, 180, 270];
      for (const mode of ['lit', 'clay']) {
        const size = 512;
        await page.setViewportSize({ width: size, height: size });
        await page.goto(
          `${baseUrl}/viewer.html?glb=${encodeURIComponent(glbName)}&mode=${mode}&az=0&el=35&lightAz=0&size=${size}`,
        );
        const ttReady = await waitForReady(page, `turntable_${mode}`);
        if (ready.tris === null && ttReady?.tris !== undefined) ready.tris = ttReady.tris;
        const ttCanvas = page.locator('canvas');
        for (let idx = 0; idx < views.length; idx += 1) {
          const az = views[idx];
          if (idx > 0) {
            await page.evaluate(([a, e, l]) => window.__pose(a, e, l), [az, 35, az]);
          }
          const outPng = join(ttDir, `${mode}_az${az}.png`);
          await ttCanvas.screenshot({ path: outPng });
          turntableFiles.push(relative(args.outDir, outPng));
        }
      }
      // Transparent dish-only relit pair for qa_gate.py
      const size = 512;
      await page.setViewportSize({ width: size, height: size });
      await page.goto(
        `${baseUrl}/viewer.html?glb=${encodeURIComponent(glbName)}&mode=lit&bg=transparent&shadows=0&az=0&el=35&lightAz=0&size=${size}`,
      );
      await waitForReady(page, 'relit_pair');
      const rCanvas = page.locator('canvas');
      await rCanvas.screenshot({ path: join(args.outDir, 'relit_0.png'), omitBackground: true });
      await page.evaluate(() => window.__pose(0, 35, 120));
      await rCanvas.screenshot({ path: join(args.outDir, 'relit_120.png'), omitBackground: true });
      console.log('[render_track2b_eval] rendered turntable (lit + clay) and relit_0/relit_120');
    }

    const movingLightFiles = [];
    if (args.movingLight) {
      // Fixed close-up camera, rotating key light: shows specular highlights sweeping across glossy food.
      const mlDir = join(args.outDir, 'moving_light');
      mkdirSync(mlDir, { recursive: true });
      const size = 512;
      await page.setViewportSize({ width: size, height: size });
      await page.goto(
        `${baseUrl}/viewer.html?glb=${encodeURIComponent(glbName)}&mode=lit&az=${args.movingLightAz}&el=${args.movingLightEl}&lightAz=${args.movingLightSteps[0]}&size=${size}`,
      );
      await waitForReady(page, 'moving_light');
      const mlCanvas = page.locator('canvas');
      for (const lightAz of args.movingLightSteps) {
        await page.evaluate(
          ([a, e, l]) => window.__pose(a, e, l),
          [args.movingLightAz, args.movingLightEl, lightAz],
        );
        const outPng = join(mlDir, `light_az${lightAz}.png`);
        await mlCanvas.screenshot({ path: outPng });
        movingLightFiles.push(relative(args.outDir, outPng));
      }
      console.log(
        `[render_track2b_eval] rendered moving-light close-up (az=${args.movingLightAz}, el=${args.movingLightEl}, lightAz=${args.movingLightSteps.join('/')})`,
      );
    }

    if (args.renderPoses) {
      const sourceDigest = createHash('sha256').update(readFileSync(args.glb)).digest('hex');
      const posesDir = join(args.outDir, 'poses');
      mkdirSync(posesDir, { recursive: true });
      const size = 256;
      await page.setViewportSize({ width: size, height: size });
      await page.goto(
        `${baseUrl}/viewer.html?glb=${encodeURIComponent(glbName)}&mode=unlit&bg=none&az=-180&el=0&lightAz=0&size=${size}`,
      );
      const pReady = await waitForReady(page, 'poses_grid');
      const pCanvas = page.locator('canvas');
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
          await pCanvas.screenshot({ path: join(posesDir, fileName), omitBackground: true });
          poses.push({ az, el, file: fileName });
        }
      }
      const meta = {
        schema_version: 1,
        publication_eligible: false,
        glb: basename(args.glb),
        source_glb_sha256: sourceDigest,
        expected_poses: 216,
        size,
        tris: pReady.tris,
        count: poses.length,
        elapsed_ms: Date.now() - tStart,
        poses,
      };
      writeFileSync(join(posesDir, 'poses.json'), `${JSON.stringify(meta, null, 2)}\n`);
      console.log(`[render_track2b_eval] rendered ${poses.length} poses in ${meta.elapsed_ms}ms`);
    }

    writeFileSync(
      join(args.outDir, 'eval_render_manifest.json'),
      `${JSON.stringify(
        {
          schema_version: 1,
          publication_eligible: false,
          glb: args.glb,
          tris: ready.tris,
          rendered,
          turntable: turntableFiles,
          moving_light: movingLightFiles,
        },
        null,
        2,
      )}\n`,
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
