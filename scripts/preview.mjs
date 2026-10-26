import { lstat, readdir, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const projects = ['peekaplate-diner-preview', 'peekaplate-console-preview'];
const extensions = new Set([
  '.html',
  '.js',
  '.css',
  '.json',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.avif',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.glb',
  '.gltf',
  '.bin',
  '.txt',
]);
const reserved = new Set([
  'functions',
  '_worker.js',
  '_routes.json',
  '_redirects',
  '_headers',
  'node_modules',
  'package.json',
]);
export const headers = `/*
  X-Robots-Tag: noindex, nofollow
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
`;

export async function sanitize(root) {
  let count = 0;
  async function walk(path) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Preview symlinks are forbidden');
    if (stat.isDirectory()) {
      for (const name of await readdir(path)) {
        if (name.startsWith('.') || reserved.has(name.toLowerCase()))
          throw new Error('Non-static preview entry rejected');
        await walk(resolve(path, name));
      }
    } else if (
      !stat.isFile() ||
      !extensions.has(extname(path).toLowerCase()) ||
      stat.size > 25 * 1024 * 1024 ||
      ++count > 10000
    ) {
      throw new Error('Unsupported preview asset');
    }
  }
  for (const app of ['diner', 'console']) {
    const dir = resolve(root, app);
    await walk(dir);
    const index = await lstat(resolve(dir, 'index.html'));
    if (!index.isFile()) throw new Error('Preview index missing');
    await writeFile(resolve(dir, '_headers'), headers);
  }
}

export function validateProject(project, expected) {
  if (
    !projects.includes(expected) ||
    project.name !== expected ||
    project.production_branch !== 'unused-production' ||
    project.source ||
    (project.domains ?? []).some((d) => d !== `${expected}.pages.dev`)
  ) {
    throw new Error('Preview project isolation check failed');
  }
  for (const config of Object.values(project.deployment_configs ?? {})) {
    for (const [key, value] of Object.entries(config)) {
      if (
        [
          'build_image_major_version',
          'compatibility_date',
          'compatibility_flags',
          'placement',
          'limits',
          'fail_open',
          'usage_model',
          'always_use_latest_compatibility_date',
        ].includes(key)
      )
        continue;
      if (value != null && (typeof value !== 'object' || Object.keys(value).length > 0)) {
        throw new Error(`Preview project has unexpected configuration: ${key}`);
      }
    }
  }
}

export function deploymentIds(rows, pr) {
  if (!/^[1-9][0-9]*$/.test(String(pr))) throw new Error('Invalid PR number');
  return rows
    .filter(
      (d) => d.environment === 'preview' && d.deployment_trigger?.metadata?.branch === `pr-${pr}`,
    )
    .map((d) => {
      if (!/^[a-f0-9-]{36}$/.test(d.id)) throw new Error('Invalid deployment ID');
      return d.id;
    });
}

export async function manage(mode, env = process.env, fetcher = fetch) {
  if (!['preflight', 'cleanup'].includes(mode)) throw new Error('Invalid preview operation');
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, PR: pr } = env;
  if (!/^[a-f0-9]{32}$/.test(account ?? '') || !token)
    throw new Error('Set preview CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_PREVIEW_API_TOKEN');
  deploymentIds([], pr);
  async function api(path, method = 'GET') {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error(`Cloudflare ${method} failed (${response.status})`);
    const body = await response.json();
    if (body.success !== true) throw new Error('Cloudflare operation was not successful');
    return body.result;
  }
  // Check both targets before any mutation. Never create or reconfigure projects here.
  for (const project of projects) validateProject(await api(project), project);
  if (mode === 'preflight') return;
  for (const project of projects) {
    const ids = [];
    for (let page = 1; ; page++) {
      if (page > 1000) throw new Error('Preview pagination safety limit exceeded');
      const rows = await api(`${project}/deployments?env=preview&per_page=25&page=${page}`);
      if (!Array.isArray(rows)) throw new Error('Invalid deployment list');
      ids.push(...deploymentIds(rows, pr));
      if (rows.length < 25) break;
    }
    // Collect before deleting, so pagination cannot skip entries as the list shrinks.
    for (const id of ids) await api(`${project}/deployments/${id}?force=true`, 'DELETE');
    console.log(`${project}: removed ${ids.length} deployment(s) for pr-${pr}`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv[2] === 'sanitize') await sanitize(process.argv[3]);
    else await manage(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
