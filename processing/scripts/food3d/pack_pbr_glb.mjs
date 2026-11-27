#!/usr/bin/env node
/**
 * Food3D V1 Stage 3b: pack authored PBR WebP textures + Clearcoat/Sheen into a Meshopt GLB.
 *
 * Usage:
 *   node pack_pbr_glb.mjs <geom.glb> <pbr_maps_dir> <out.glb> \
 *     [--uncompressed-out <premeshopt.glb>] [--webp-quality 86]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');

function findPnpmSharp() {
  const pnpmDir = path.join(REPO_ROOT, 'node_modules/.pnpm');
  if (fs.existsSync(pnpmDir)) {
    for (const entry of fs.readdirSync(pnpmDir)) {
      if (entry.startsWith('sharp@')) {
        const cand = path.join(pnpmDir, entry, 'node_modules/sharp');
        if (fs.existsSync(cand)) return cand;
      }
    }
  }
  return path.join(REPO_ROOT, 'node_modules/sharp');
}

const DEFAULT_SHARP_PATH = findPnpmSharp();
const FALLBACK_GLTF_TRANSFORM_NODE_MODULES = '/home/yacine105/tools/gltf-transform/node_modules';
const DEFAULT_GLTF_TRANSFORM = path.join(
  FALLBACK_GLTF_TRANSFORM_NODE_MODULES,
  '.bin/gltf-transform',
);

function moduleSearchPaths() {
  const envPaths = (process.env.NODE_PATH || '')
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  return [
    ...envPaths,
    process.env.GLTF_TRANSFORM_NODE_MODULES,
    path.join(REPO_ROOT, 'node_modules'),
    path.join(process.cwd(), 'node_modules'),
    FALLBACK_GLTF_TRANSFORM_NODE_MODULES,
  ].filter(Boolean);
}

async function importGltfTransformPkg(pkgName) {
  try {
    return await import(pkgName);
  } catch {
    const resolved = require.resolve(pkgName, { paths: moduleSearchPaths() });
    return import(pathToFileURL(resolved).href);
  }
}

async function loadGltfTransform() {
  const [core, extensions, functions] = await Promise.all([
    importGltfTransformPkg('@gltf-transform/core'),
    importGltfTransformPkg('@gltf-transform/extensions'),
    importGltfTransformPkg('@gltf-transform/functions'),
  ]);
  return { ...core, ...extensions, ...functions };
}

function resolveGltfTransformCli() {
  if (process.env.GLTF_TRANSFORM) return process.env.GLTF_TRANSFORM;
  for (const base of moduleSearchPaths()) {
    const bin = path.join(base, '.bin/gltf-transform');
    if (fs.existsSync(bin)) return bin;
  }
  return fs.existsSync(DEFAULT_GLTF_TRANSFORM) ? DEFAULT_GLTF_TRANSFORM : 'gltf-transform';
}

function loadSharp() {
  const candidates = [process.env.SHARP_PATH, 'sharp', DEFAULT_SHARP_PATH].filter(Boolean);
  let lastErr;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      lastErr = err;
    }
  }
  try {
    return require(require.resolve('sharp', { paths: moduleSearchPaths() }));
  } catch (err) {
    lastErr = err;
  }
  throw new Error(`Unable to load sharp: ${lastErr?.message ?? 'unknown error'}`);
}

function parseArgs(argv) {
  const positional = [];
  let uncompressedOut = null;
  let pbrReportPath = null;
  let webpQuality = 86;
  let normalWebpQuality = 88;
  let ormMaxSize = 512;
  let occlusionStrength = 0.85;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--uncompressed-out') {
      if (i + 1 >= argv.length) throw new Error('--uncompressed-out requires a path');
      uncompressedOut = argv[++i];
    } else if (arg === '--pbr-report') {
      if (i + 1 >= argv.length) throw new Error('--pbr-report requires a path');
      pbrReportPath = argv[++i];
    } else if (arg === '--webp-quality') {
      if (i + 1 >= argv.length) throw new Error('--webp-quality requires an integer');
      webpQuality = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(webpQuality) || webpQuality < 1 || webpQuality > 100) {
        throw new Error(`Invalid --webp-quality: ${argv[i]}`);
      }
    } else if (arg === '--normal-webp-quality') {
      if (i + 1 >= argv.length) throw new Error('--normal-webp-quality requires an integer');
      normalWebpQuality = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(normalWebpQuality) || normalWebpQuality < 1 || normalWebpQuality > 100) {
        throw new Error(`Invalid --normal-webp-quality: ${argv[i]}`);
      }
    } else if (arg === '--orm-max-size') {
      if (i + 1 >= argv.length) throw new Error('--orm-max-size requires a positive integer');
      ormMaxSize = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(ormMaxSize) || ormMaxSize < 64 || ormMaxSize > 4096) {
        throw new Error(`Invalid --orm-max-size: ${argv[i]}`);
      }
    } else if (arg === '--occlusion-strength') {
      if (i + 1 >= argv.length) throw new Error('--occlusion-strength requires a float in [0, 1]');
      occlusionStrength = Number.parseFloat(argv[++i]);
      if (!Number.isFinite(occlusionStrength) || occlusionStrength < 0 || occlusionStrength > 1) {
        throw new Error(`Invalid --occlusion-strength: ${argv[i]}`);
      }
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 3) {
    throw new Error(
      'Usage: node pack_pbr_glb.mjs <geom.glb> <pbr_maps_dir> <out.glb> [--uncompressed-out <pre.glb>] [--pbr-report <json>] [--webp-quality 86] [--normal-webp-quality 88] [--orm-max-size 512] [--occlusion-strength 0.85]',
    );
  }

  return {
    geomGlb: path.resolve(positional[0]),
    pbrMapsDir: path.resolve(positional[1]),
    outGlb: path.resolve(positional[2]),
    uncompressedOut: uncompressedOut ? path.resolve(uncompressedOut) : null,
    pbrReportPath: pbrReportPath ? path.resolve(pbrReportPath) : null,
    webpQuality,
    normalWebpQuality,
    ormMaxSize,
    occlusionStrength,
  };
}

async function encodePngToWebp(sharp, pngPath, quality, maxSize = null, webpOptions = {}) {
  if (!fs.existsSync(pngPath)) {
    throw new Error(`Missing required PBR map: ${pngPath}`);
  }
  let pipeline = sharp(pngPath);
  if (maxSize) {
    pipeline = pipeline.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true });
  }
  const buf = await pipeline.webp({ quality, effort: 5, ...webpOptions }).toBuffer();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function assertPublicationIneligible(glbPath) {
  const glb = fs.readFileSync(glbPath);
  const jsonOffset = 20;
  if (
    glb.length < jsonOffset ||
    glb.readUInt32LE(0) !== 0x46546c67 ||
    glb.readUInt32LE(4) !== 2 ||
    glb.readUInt32LE(16) !== 0x4e4f534a
  ) {
    throw new Error(`Invalid GLB header or missing JSON chunk: ${glbPath}`);
  }
  const jsonEnd = jsonOffset + glb.readUInt32LE(12);
  if (jsonEnd > glb.length) {
    throw new Error(`Truncated GLB JSON chunk: ${glbPath}`);
  }
  const gltf = JSON.parse(glb.toString('utf8', jsonOffset, jsonEnd));
  if (gltf?.asset?.extras?.publication_eligible !== false) {
    throw new Error(`Expected asset.extras.publication_eligible to be false: ${glbPath}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sharp = loadSharp();
  const {
    NodeIO,
    ALL_EXTENSIONS,
    EXTTextureWebP,
    KHRMaterialsClearcoat,
    KHRMaterialsSheen,
    dedup,
    prune,
  } = await loadGltfTransform();
  const gltfTransformBin = resolveGltfTransformCli();

  const candidateReport = args.pbrReportPath || path.join(args.pbrMapsDir, 'pbr_report.json');
  let pbrReport = null;
  if (fs.existsSync(candidateReport)) {
    pbrReport = JSON.parse(fs.readFileSync(candidateReport, 'utf8'));
  }

  fs.mkdirSync(path.dirname(args.outGlb), { recursive: true });

  // Use 512px lossless WebP for scalar data masks (ORM, clearcoat) so YUV 4:2:0
  // chroma subsampling cannot bleed AO/roughness channels into metallic (B=0),
  // while staying well under the 5 MB delivery GLB budget.
  const [baseColorBytes, ormBytes, coatBytes, normalBytes] = await Promise.all([
    encodePngToWebp(sharp, path.join(args.pbrMapsDir, 'basecolor_delit.png'), args.webpQuality),
    encodePngToWebp(sharp, path.join(args.pbrMapsDir, 'orm.png'), 100, args.ormMaxSize, {
      lossless: true,
    }),
    encodePngToWebp(sharp, path.join(args.pbrMapsDir, 'clearcoat.png'), 100, 512, {
      lossless: true,
    }),
    encodePngToWebp(sharp, path.join(args.pbrMapsDir, 'normal_final.png'), args.normalWebpQuality),
  ]);

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(args.geomGlb);

  // Declare WebP extension so glTF validation passes cleanly.
  document.createExtension(EXTTextureWebP).setRequired(true);

  const baseColorTex = document
    .createTexture('basecolor_delit')
    .setImage(baseColorBytes)
    .setMimeType('image/webp');
  const ormTex = document.createTexture('orm').setImage(ormBytes).setMimeType('image/webp');
  const coatTex = document.createTexture('clearcoat').setImage(coatBytes).setMimeType('image/webp');
  const normalTex = document
    .createTexture('normal_final')
    .setImage(normalBytes)
    .setMimeType('image/webp');

  const clearcoatExt = document.createExtension(KHRMaterialsClearcoat);
  const sheenExt = document.createExtension(KHRMaterialsSheen);

  let materials = document.getRoot().listMaterials();
  if (materials.length === 0) {
    const mat = document.createMaterial('food3d_pbr');
    for (const mesh of document.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        prim.setMaterial(mat);
      }
    }
    materials = [mat];
  }

  for (const mat of materials) {
    mat
      .setMetallicFactor(0.0)
      .setRoughnessFactor(1.0)
      .setBaseColorTexture(baseColorTex)
      .setMetallicRoughnessTexture(ormTex)
      .setOcclusionTexture(ormTex)
      .setOcclusionStrength(args.occlusionStrength)
      .setNormalTexture(normalTex)
      .setNormalScale(1.0);

    const clearcoat = clearcoatExt
      .createClearcoat()
      .setClearcoatFactor(1.0)
      .setClearcoatTexture(coatTex)
      .setClearcoatRoughnessFactor(1.0)
      .setClearcoatRoughnessTexture(coatTex);
    mat.setExtension('KHR_materials_clearcoat', clearcoat);

    const sheen = sheenExt
      .createSheen()
      .setSheenColorFactor([0.0, 0.0, 0.0])
      .setSheenRoughnessFactor(1.0);
    mat.setExtension('KHR_materials_sheen', sheen);
  }

  await document.transform(dedup(), prune());
  const asset = document.getRoot().getAsset();
  const pbrExtras = {
    occlusion_strength: args.occlusionStrength,
    ...(typeof pbrReport?.micro_normal_strength === 'number'
      ? { micro_normal_strength: pbrReport.micro_normal_strength }
      : {}),
    ...(typeof pbrReport?.detail_normal_strength === 'number'
      ? { detail_normal_strength: pbrReport.detail_normal_strength }
      : {}),
    ...(typeof pbrReport?.cavity_strength === 'number'
      ? { cavity_strength: pbrReport.cavity_strength }
      : {}),
    ...(typeof pbrReport?.wet_fraction === 'number'
      ? { wet_fraction: pbrReport.wet_fraction }
      : {}),
    ...(typeof pbrReport?.wet_food === 'boolean' ? { wet_food: pbrReport.wet_food } : {}),
    ...(typeof pbrReport?.wet_oil_fraction === 'number'
      ? { wet_oil_fraction: pbrReport.wet_oil_fraction }
      : {}),
    ...(typeof pbrReport?.oil_clearcoat_max === 'number'
      ? { oil_clearcoat_max: pbrReport.oil_clearcoat_max }
      : {}),
    ...(typeof pbrReport?.oil_albedo_removal === 'number'
      ? { oil_albedo_removal: pbrReport.oil_albedo_removal }
      : {}),
  };
  asset.extras = {
    ...(asset.extras || {}),
    publication_eligible: false,
    pipeline: 'food3d-v1',
    ...pbrExtras,
  };

  let tmpDir = null;
  let prePath = args.uncompressedOut;
  if (!prePath) {
    tmpDir = fs.mkdtempSync(path.join(path.dirname(args.outGlb), '.tmp-pack-'));
    prePath = path.join(tmpDir, 'premeshopt.glb');
  } else {
    fs.mkdirSync(path.dirname(prePath), { recursive: true });
  }

  try {
    await io.write(prePath, document);

    execFileSync(gltfTransformBin, ['meshopt', prePath, args.outGlb, '--level', 'high'], {
      stdio: 'inherit',
    });
    assertPublicationIneligible(args.outGlb);

    execFileSync(gltfTransformBin, ['validate', args.outGlb], {
      stdio: 'inherit',
    });
  } finally {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  const stat = fs.statSync(args.outGlb);
  console.log(
    JSON.stringify({
      publication_eligible: false,
      out_glb: args.outGlb,
      bytes: stat.size,
      webp_quality: args.webpQuality,
      normal_webp_quality: args.normalWebpQuality,
      orm_max_size: args.ormMaxSize,
      scalar_maps_max_size: 512,
    }),
  );
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
