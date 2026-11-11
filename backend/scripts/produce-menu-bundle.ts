import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import {
  BundleProducerError,
  produceMenuBundle,
  type VerifiedT0Asset,
} from '../src/bundle-producer/produce';
import { admitMenuBundleHandoff, loadApprovedDishSources } from '../src/bundle-producer/repository';
import {
  MenuBundleRequestSchema,
  T0AssetManifestSchema,
  webpVariant,
} from '../src/bundle-producer/request';

const USAGE = `Usage: pnpm produce:bundle --request <file> --t0-root <dir> [options]

Builds an immutable Bundle v1 from approved database content, a restaurant-confirmed request
file and PR #25 T0 asset directories. Writes <menu_revision_id>.json (exact published bytes)
and <menu_revision_id>.handoff.json to --out. Never uploads; hosting is an operator step.

Options:
  --request <file>       Menu bundle request JSON (schema_version 1). Required.
  --t0-root <dir>        Directory containing <asset_id>/manifest.json T0 bundles. Required.
  --database-url <url>   PostgreSQL URL. Default: PEEKAPLATE_PRODUCER_DATABASE_URL.
                         --admit requires the privileged (migration-owner) connection.
  --out <dir>            Output directory. Default: work/menu-bundles.
  --admit                Register the RES-02 review subject and public bundle URL.
                         Without it the command performs no database writes.
  --help                 Show this help.`;

class CliError extends Error {}

async function writeImmutable(path: string, bytes: Uint8Array) {
  try {
    await writeFile(path, bytes, { flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const existing = await readFile(path);
    if (!existing.equals(Buffer.from(bytes))) {
      throw new CliError(`${path} already exists with different content; refusing to overwrite`);
    }
  }
}

async function loadVerifiedAsset(t0Root: string, assetId: string): Promise<VerifiedT0Asset> {
  const directory = join(t0Root, assetId);
  const parsed = T0AssetManifestSchema.safeParse(
    JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')),
  );
  if (!parsed.success) throw new CliError(`T0 manifest ${assetId} is invalid`);
  const manifest = parsed.data;
  if (manifest.asset_id !== assetId) {
    throw new CliError(`T0 manifest in ${assetId}/ declares asset ${manifest.asset_id}`);
  }
  for (const name of ['card-480', 'detail-1280'] as const) {
    const variant = webpVariant(manifest, name);
    const bytes = await readFile(join(directory, variant.path));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== variant.sha256 || bytes.byteLength !== variant.size_bytes) {
      throw new CliError(`T0 variant ${assetId}/${variant.path} does not match its manifest`);
    }
  }
  return { manifest };
}

async function main() {
  const { values } = parseArgs({
    options: {
      request: { type: 'string' },
      't0-root': { type: 'string' },
      'database-url': { type: 'string' },
      out: { type: 'string', default: 'work/menu-bundles' },
      admit: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const databaseUrl = values['database-url'] ?? process.env.PEEKAPLATE_PRODUCER_DATABASE_URL;
  if (!values.request || !values['t0-root'] || !databaseUrl) {
    throw new CliError(`--request, --t0-root and a database URL are required\n\n${USAGE}`);
  }

  const parsedRequest = MenuBundleRequestSchema.safeParse(
    JSON.parse(await readFile(values.request, 'utf8')),
  );
  if (!parsedRequest.success) {
    const issues = parsedRequest.error.issues
      .slice(0, 10)
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new CliError(`Request file is invalid:\n${issues.join('\n')}`);
  }
  const request = parsedRequest.data;
  const requestedDishes = request.categories.flatMap((category) => category.dishes);

  const assets = new Map<string, VerifiedT0Asset>();
  for (const dish of requestedDishes) {
    if (dish.t0_asset_id && !assets.has(dish.t0_asset_id)) {
      assets.set(dish.t0_asset_id, await loadVerifiedAsset(values['t0-root'], dish.t0_asset_id));
    }
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const sources = await loadApprovedDishSources(
      client,
      request.venue_id,
      requestedDishes.map((dish) => dish.dish_id),
    );
    const produced = await produceMenuBundle(request, sources, assets);
    const handoff = {
      bundleUrl: produced.bundleUrl,
      contentHash: produced.contentHash,
      assetManifestHash: produced.assetManifestHash,
      menuRevisionId: produced.menuRevisionId,
      contentApprovalId: produced.contentApprovalId,
      assetApprovalId: produced.assetApprovalId,
      diagnostics: produced.diagnostics,
    };
    await mkdir(values.out, { recursive: true });
    await writeImmutable(join(values.out, `${produced.menuRevisionId}.json`), produced.bytes);
    await writeImmutable(
      join(values.out, `${produced.menuRevisionId}.handoff.json`),
      new TextEncoder().encode(`${JSON.stringify(handoff, null, 2)}\n`),
    );
    const admission = values.admit
      ? await admitMenuBundleHandoff(client, {
          tenantId: request.venue_id,
          menuId: request.menu_id,
          menuRevisionId: produced.menuRevisionId,
          contentApprovalId: produced.contentApprovalId,
          contentHash: produced.contentHash,
          assetApprovalId: produced.assetApprovalId,
          assetManifestHash: produced.assetManifestHash,
          bundleUrl: produced.bundleUrl,
        })
      : 'not_requested';
    console.log(JSON.stringify({ ...handoff, admission }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof BundleProducerError) {
    console.error(`Bundle producer error (${error.code}): ${error.message}`);
  } else if (error instanceof CliError) {
    console.error(error.message);
  } else if (error instanceof Error && 'code' in error && error.code === '42501') {
    console.error('Database permission denied: --admit requires the privileged connection.');
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
