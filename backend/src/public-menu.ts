import { randomUUID } from 'node:crypto';
import {
  MENU_TOKEN_AUDIENCE,
  MENU_TOKEN_TTL_SECONDS,
  type MenuTokenClaims,
  type PublicMenuResponse,
  PublicMenuResponseSchema,
} from '@peekaplate/contracts';
import { importJWK, type JWK, SignJWT } from 'jose';
import type { Client } from 'pg';

export type PublicMenuRecord = Omit<PublicMenuResponse, 'menuToken' | 'tokenExpiresAt'>;

export type MenuTokenSigningConfig = {
  issuer: string;
  signingJwk: string;
  allowLocalIssuer?: boolean;
};

type ParsedSigningKey = { key: CryptoKey; kid: string; publicJwk: JWK };

function trustedIssuer(config: MenuTokenSigningConfig): string {
  let issuer: URL;
  try {
    issuer = new URL(config.issuer);
  } catch {
    throw new Error('MENU_TOKEN_ISSUER must be an absolute URL');
  }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(issuer.hostname);
  if (
    (issuer.protocol !== 'https:' &&
      !(config.allowLocalIssuer && local && issuer.protocol === 'http:')) ||
    issuer.search ||
    issuer.pathname !== '/' ||
    issuer.hash ||
    issuer.username ||
    issuer.password
  ) {
    throw new Error('MENU_TOKEN_ISSUER is not trusted');
  }
  return issuer.href;
}

async function signingKey(raw: string): Promise<ParsedSigningKey> {
  let candidate: Record<string, unknown>;
  try {
    candidate = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('MENU_TOKEN_SIGNING_JWK must be valid JSON');
  }
  const allowed = new Set(['kty', 'crv', 'x', 'y', 'd', 'kid', 'alg', 'use']);
  const kid = typeof candidate.kid === 'string' ? candidate.kid : '';
  if (
    Object.keys(candidate).some((key) => !allowed.has(key)) ||
    candidate.kty !== 'EC' ||
    candidate.crv !== 'P-256' ||
    candidate.alg !== 'ES256' ||
    candidate.use !== 'sig' ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(kid) ||
    !['x', 'y', 'd'].every((key) => typeof candidate[key] === 'string' && candidate[key])
  ) {
    throw new Error('MENU_TOKEN_SIGNING_JWK must be one named ES256 signing key');
  }
  const publicJwk: JWK = {
    kty: 'EC',
    crv: 'P-256',
    x: candidate.x as string,
    y: candidate.y as string,
    kid,
    alg: 'ES256',
    use: 'sig',
  };
  return {
    key: (await importJWK(candidate as JWK, 'ES256')) as CryptoKey,
    kid,
    publicJwk,
  };
}

export async function menuJwks(config: MenuTokenSigningConfig) {
  trustedIssuer(config);
  return { keys: [(await signingKey(config.signingJwk)).publicJwk] };
}

export async function readPublicMenu(
  client: Client,
  venueId: string,
  menuId: string,
): Promise<PublicMenuRecord | undefined> {
  let started = false;
  try {
    await client.query('BEGIN READ ONLY');
    started = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);
    const result = await client.query<PublicMenuRecord>(
      `SELECT
         1 AS "schemaVersion",
         publication.tenant_id AS "venueId",
         publication.menu_id AS "menuId",
         approval.menu_revision_id AS "menuRevisionId",
         publication.publication_id AS "publicationId",
         publication.publication_hash AS "publicationHash",
         publication.availability_version AS "availabilityVersion",
         'T0' AS tier,
         jsonb_build_object(
           'url', bundle.bundle_url,
           'contentHash', approval.content_hash,
           'assetManifestHash', approval.asset_manifest_hash
         ) AS bundle
       FROM app_private.menu_publication_current publication
       JOIN app_private.menu_approval approval
         ON approval.tenant_id = publication.tenant_id
        AND approval.menu_id = publication.menu_id
        AND approval.approval_id = publication.approval_id
       JOIN app_private.public_menu_bundle bundle
         ON bundle.tenant_id = approval.tenant_id
        AND bundle.menu_id = approval.menu_id
        AND bundle.menu_revision_id = approval.menu_revision_id
       WHERE publication.tenant_id = $1
         AND publication.menu_id = $2
         AND publication.status = 'published'`,
      [venueId, menuId],
    );
    await client.query('COMMIT');
    started = false;
    return result.rows[0];
  } catch (error) {
    if (started) await client.query('ROLLBACK');
    throw error;
  }
}

export async function issueMenuToken(
  menu: PublicMenuRecord,
  config: MenuTokenSigningConfig,
  now = Math.floor(Date.now() / 1000),
): Promise<Pick<PublicMenuResponse, 'menuToken' | 'tokenExpiresAt'>> {
  const issuer = trustedIssuer(config);
  const signing = await signingKey(config.signingJwk);
  const claims: MenuTokenClaims = {
    venue: menu.venueId,
    publication: menu.publicationId,
    scope: 'observations',
    iat: now,
    exp: now + MENU_TOKEN_TTL_SECONDS,
    jti: randomUUID(),
  };
  const menuToken = await new SignJWT({
    venue: claims.venue,
    publication: claims.publication,
    scope: claims.scope,
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: signing.kid })
    .setIssuer(issuer)
    .setAudience(MENU_TOKEN_AUDIENCE)
    .setIssuedAt(claims.iat)
    .setExpirationTime(claims.exp)
    .setJti(claims.jti)
    .sign(signing.key);
  return {
    menuToken,
    tokenExpiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}

export async function createPublicMenuResponse(
  menu: PublicMenuRecord,
  config: MenuTokenSigningConfig,
): Promise<PublicMenuResponse> {
  return PublicMenuResponseSchema.parse({
    ...menu,
    ...(await issueMenuToken(menu, config)),
  });
}
