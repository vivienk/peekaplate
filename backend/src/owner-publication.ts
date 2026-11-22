import {
  type PreparedMenu,
  PreparedMenuSchema,
  verifyPublicMenuContentBytes,
} from '@peekaplate/contracts';
import type { Client } from 'pg';
import { AuthUnavailableError } from './auth';
import { PREPARED_ASSET_PATH, PREPARED_BUNDLE_PATH } from './owner-prepare';
import { beginAuthorizedOwner } from './publication-command';

/** The Worker's own origin and bucket, for owner-prepared menus it stores itself (Part A). */
export type OwnHost = { origin: string; read(key: string): Promise<Uint8Array | null> };

// Admission stays operator-owned. These reads never grant publication authority or create a bundle.
export async function listPreparedMenus(
  client: Client,
  actorId: string,
  venueId: string,
): Promise<PreparedMenu[]> {
  await beginAuthorizedOwner(client, actorId, venueId);
  try {
    const result = await client.query(
      `SELECT subject.tenant_id AS "venueId", subject.menu_id AS "menuId",
         subject.menu_revision_id AS "menuRevisionId", subject.content_approval_id AS "contentApprovalId",
         subject.asset_approval_id AS "assetApprovalId", subject.content_hash AS "contentHash",
         subject.asset_manifest_hash AS "assetManifestHash", bundle.bundle_url AS "bundleUrl",
         COALESCE(review.version,0) AS "reviewVersion", COALESCE(publication.version,0) AS "publicationVersion",
         CASE WHEN publication.status='published' THEN approved.menu_revision_id ELSE NULL END AS "publishedRevisionId"
       FROM app_private.menu_review_subject subject
       JOIN app_private.public_menu_bundle bundle USING(tenant_id,menu_id,menu_revision_id)
       LEFT JOIN app_private.menu_review_current review ON review.tenant_id=subject.tenant_id AND review.menu_id=subject.menu_id
       LEFT JOIN app_private.menu_publication_current publication ON publication.tenant_id=subject.tenant_id AND publication.menu_id=subject.menu_id
       LEFT JOIN app_private.menu_approval approved ON approved.tenant_id=publication.tenant_id AND approved.menu_id=publication.menu_id AND approved.approval_id=publication.approval_id
       WHERE subject.tenant_id=$1 ORDER BY subject.created_at DESC,subject.menu_id,subject.menu_revision_id LIMIT 101`,
      [venueId],
    );
    if (result.rows.length > 100) throw new AuthUnavailableError();
    const menus = result.rows.map((row) => PreparedMenuSchema.parse(row));
    await client.query('COMMIT');
    return menus;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function ownPath(value: string, own: OwnHost | undefined, prefix: string): string | null {
  if (!own) return null;
  const url = new URL(value);
  if (
    url.origin !== own.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(`${prefix}/`)
  )
    return null;
  return url.pathname.slice(prefix.length + 1);
}

function stagingAsset(value: string, own?: OwnHost): string {
  // Owner-prepared photos live at the Worker's own immutable, hash-named address.
  if (ownPath(value, own, PREPARED_ASSET_PATH)) return new URL(value).href;
  const url = new URL(value);
  // shortcut: staging-only prepared snapshots; extend with reviewed production asset hosting at release.
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^(?:[a-f0-9]{8}|routing-staging)\.peekaplate-diner-staging\.pages\.dev$/.test(url.hostname)
  )
    throw new AuthUnavailableError();
  return url.href;
}

export async function fetchPreparedMenu(
  menu: PreparedMenu,
  send: typeof fetch = fetch,
  own?: OwnHost,
) {
  // Owner-prepared bundles are read from the Worker's bucket directly (no Worker self-fetch).
  const ownBundle = ownPath(menu.bundleUrl, own, PREPARED_BUNDLE_PATH);
  if (own && ownBundle) {
    const expected = `${menu.venueId}/${menu.menuId}/${menu.menuRevisionId}.json`;
    if (ownBundle !== expected) throw new AuthUnavailableError();
    const bytes = await own.read(`prepared-menus/${expected}`);
    if (!bytes || bytes.byteLength > 2_000_000) throw new AuthUnavailableError();
    return checkContent(menu, await verifyPublicMenuContentBytes(bytes, menu.contentHash), own);
  }
  const url = stagingAsset(menu.bundleUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await send(url, {
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new AuthUnavailableError();
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2_000_000) throw new AuthUnavailableError();
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const content = await verifyPublicMenuContentBytes(bytes, menu.contentHash);
    return checkContent(menu, content);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader?.cancel().catch(() => {});
  }
}

function checkContent(
  menu: PreparedMenu,
  content: Awaited<ReturnType<typeof verifyPublicMenuContentBytes>>,
  own?: OwnHost,
) {
  if (
    content.venue_id !== menu.venueId ||
    content.menu_id !== menu.menuId ||
    content.menu_revision_id !== menu.menuRevisionId
  )
    throw new AuthUnavailableError();
  if (content.restaurant.logo) stagingAsset(content.restaurant.logo.url, own);
  for (const category of content.categories)
    for (const dish of category.dishes) {
      if (dish.complete && dish.images) {
        stagingAsset(dish.images.card.url, own);
        stagingAsset(dish.images.detail.url, own);
      }
    }
  return content;
}
