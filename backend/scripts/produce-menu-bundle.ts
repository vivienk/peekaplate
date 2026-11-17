import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import {
  BundleProducerError,
  produceMenuBundle,
  type VerifiedT0Asset,
} from '../src/bundle-producer/produce';
import { admitMenuBundleHandoff, loadApprovedDishSources } from '../src/bundle-producer/repository';
import {
  prepareApprovedPortion,
  verifyHostedPortionFiles,
  type PreparedPortionFile,
} from '../src/bundle-producer/approved-portions';
import {
  MenuBundleRequestSchema,
  T0AssetManifestSchema,
  webpVariant,
} from '../src/bundle-producer/request';
import { loadOwnerRestaurant } from '../src/bundle-producer/restaurant';

const USAGE = `Usage: pnpm produce:bundle --request <file> --t0-root <dir> [options]

Builds an immutable Bundle v1 from approved database content, a restaurant-confirmed request
file and PR #25 T0 asset directories. Writes <menu_revision_id>.json (exact published bytes)
and <menu_revision_id>.handoff.json to --out. Never uploads; hosting is an operator step.

Options:
  --request <file>       Menu bundle request JSON (schema_version 1). Required.
  --t0-root <dir>        Directory containing <asset_id>/manifest.json T0 bundles. Required.
  --database-url <url>   PostgreSQL URL. Default: PEEKAPLATE_PRODUCER_DATABASE_URL.
                         --admit requires the privileged (migration-owner) connection.
  --owner-profile-api <origin>  Read saved Screen 5 name/logo with PEEKAPLATE_OWNER_TOKEN.
                         Writes the verified logo under --out/assets for hosting.
  --owner-portion-api <origin>  Authenticated owner API for approved Screen 9 2.5D export.
  --portion-map <file>       JSON { venue_id, items: [{ dish_id, draft_id, photo_id }] }.
                         Writes verified public layer bytes under --out/assets/portions.
                         Requires PEEKAPLATE_OWNER_TOKEN. Public hosting remains operator-owned.
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
      'owner-profile-api': { type: 'string' },
      'owner-portion-api': { type: 'string' },
      'portion-map': { type: 'string' },
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
  const ownerRestaurant = values['owner-profile-api']
    ? await loadOwnerRestaurant(
        values['owner-profile-api'],
        process.env.PEEKAPLATE_OWNER_TOKEN ?? '',
        request.venue_id,
        request.asset_base_url,
      )
    : null;
  if (ownerRestaurant) request.restaurant = ownerRestaurant.restaurant;
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

    const approvedPortionFiles: PreparedPortionFile[] = [];
    if (values['portion-map']) {
      if (!values['owner-portion-api'] || !process.env.PEEKAPLATE_OWNER_TOKEN) {
        throw new CliError('--portion-map requires --owner-portion-api and PEEKAPLATE_OWNER_TOKEN');
      }
      const api = new URL(values['owner-portion-api']);
      if (
        api.protocol !== 'https:' ||
        api.username ||
        api.password ||
        api.search ||
        api.hash ||
        api.pathname !== '/'
      ) {
        throw new CliError('Approved portion API must be a bare HTTPS origin');
      }
      const mapping: unknown = JSON.parse(await readFile(values['portion-map'], 'utf8'));
      if (!mapping || typeof mapping !== 'object') {
        throw new CliError('Invalid portion mapping');
      }
      const manifest = mapping as {
        venue_id?: unknown;
        items?: Array<{ dish_id: string; draft_id: string; photo_id: string }>;
      };
      const ids = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (
        manifest.venue_id !== request.venue_id ||
        !Array.isArray(manifest.items) ||
        manifest.items.length === 0 ||
        manifest.items.length > 500
      ) {
        throw new CliError('Portion map venue/items do not match the bundle request');
      }
      const seen = new Set<string>();
      for (const item of manifest.items) {
        if (
          !item || !ids.test(item.dish_id) || !ids.test(item.draft_id) ||
          !ids.test(item.photo_id) || seen.has(item.dish_id)
        ) {
          throw new CliError('Invalid or duplicate portion map entry');
        }
        seen.add(item.dish_id);
        const dish = request.categories.flatMap((category) => category.dishes)
          .find((candidate) => candidate.dish_id === item.dish_id);
        const source = sources.get(item.dish_id);
        if (!dish || !source || dish.portion) {
          throw new CliError('Portion map must target one existing, unmapped approved dish');
        }
        const endpoint = new URL(
          `/venues/${request.venue_id}/drafts/${item.draft_id}/photos/${item.photo_id}/portion/export`,
          api,
        );
        const response = await fetch(endpoint, {
          headers: { Authorization: `Bearer ${process.env.PEEKAPLATE_OWNER_TOKEN}` },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          throw new CliError(`Approved 2.5D export unavailable for dish ${item.dish_id}`);
        }
        const raw: unknown = await response.json();
        const prepared = prepareApprovedPortion(raw, {
          venueId: request.venue_id,
          dishId: item.dish_id,
          dishRevisionId: source.dishRevisionId,
          draftId: item.draft_id,
          photoId: item.photo_id,
          assetBaseUrl: request.asset_base_url,
        });
        dish.portion = prepared.portion;
        for (const file of prepared.files) {
          const localPath = join(values.out, 'assets', file.relativePath);
          await mkdir(dirname(localPath), { recursive: true });
          await writeImmutable(localPath, file.bytes);
          approvedPortionFiles.push(file);
        }
      }
    }
    // A producer admission must not point at unhosted or tampered public assets.
    if (values.admit && approvedPortionFiles.length) {
      await verifyHostedPortionFiles(approvedPortionFiles);
    }
    const produced = await produceMenuBundle(request, sources, assets);
    if (ownerRestaurant?.logoFile) {
      const path = join(values.out, 'assets', ownerRestaurant.logoFile.path);
      await mkdir(dirname(path), { recursive: true });
      await writeImmutable(path, ownerRestaurant.logoFile.bytes);
    }
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
