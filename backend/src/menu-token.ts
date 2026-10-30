import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';

const ALGORITHMS: ('RS256' | 'ES256')[] = ['RS256', 'ES256'];
const MAX_BEARER_TOKEN_LENGTH = 8_192;
const MAX_TOKEN_LIFETIME_SECONDS = 30 * 60;
const CLOCK_TOLERANCE_SECONDS = 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MenuAuthority = {
  venueId: string;
  publicationId: string;
  jti: string;
};

export class MenuTokenAuthenticationError extends Error {
  readonly status = 401;

  constructor() {
    super('Menu-token authentication failed.');
    this.name = 'MenuTokenAuthenticationError';
  }
}

export class MenuTokenAuthorizationError extends Error {
  readonly status = 403;

  constructor() {
    super('Menu token is not authorized for observation ingestion.');
    this.name = 'MenuTokenAuthorizationError';
  }
}

export class MenuTokenUnavailableError extends Error {
  readonly status = 503;

  constructor(cause?: unknown) {
    super('Menu-token verification is temporarily unavailable.', { cause });
    this.name = 'MenuTokenUnavailableError';
  }
}

export type MenuTokenVerifier = (authorization: string | undefined) => Promise<MenuAuthority>;

export function createMenuTokenVerifier(config: {
  issuer: string;
  allowLocalIssuer?: boolean;
}): MenuTokenVerifier {
  const issuer = trustedIssuer(config);
  const jwks = createRemoteJWKSet(new URL('.well-known/jwks.json', `${issuer}/`), {
    timeoutDuration: 2_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });

  return async (authorization) => {
    const token = bearerToken(authorization);
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        algorithms: ALGORITHMS,
        requiredClaims: ['exp', 'iat', 'jti'],
      });
      return validateMenuTokenClaims(payload);
    } catch (error) {
      if (
        error instanceof MenuTokenAuthenticationError ||
        error instanceof MenuTokenAuthorizationError
      ) {
        throw error;
      }
      if (isAuthenticationFailure(error)) throw new MenuTokenAuthenticationError();
      throw new MenuTokenUnavailableError(error);
    }
  };
}

export function validateMenuTokenClaims(
  payload: JWTPayload,
  nowSeconds = Math.floor(Date.now() / 1000),
): MenuAuthority {
  const venueId = typeof payload.venue === 'string' ? payload.venue.toLowerCase() : '';
  const publicationId =
    typeof payload.publication === 'string' ? payload.publication.toLowerCase() : '';
  const jti = typeof payload.jti === 'string' ? payload.jti.toLowerCase() : '';
  if (
    !UUID_PATTERN.test(venueId) ||
    !UUID_PATTERN.test(publicationId) ||
    !UUID_PATTERN.test(jti) ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    payload.iat > nowSeconds + CLOCK_TOLERANCE_SECONDS ||
    payload.exp <= nowSeconds - CLOCK_TOLERANCE_SECONDS ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SECONDS
  ) {
    throw new MenuTokenAuthenticationError();
  }
  if (payload.scope !== 'observations') throw new MenuTokenAuthorizationError();
  return { venueId, publicationId, jti };
}

function bearerToken(authorization: string | undefined): string {
  const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? '');
  if (!match?.[1] || match[1].length > MAX_BEARER_TOKEN_LENGTH) {
    throw new MenuTokenAuthenticationError();
  }
  return match[1];
}

function trustedIssuer(config: { issuer: string; allowLocalIssuer?: boolean }): string {
  let issuer: URL;
  try {
    issuer = new URL(config.issuer);
  } catch {
    throw new MenuTokenUnavailableError();
  }
  const isLocal = ['127.0.0.1', '[::1]', 'localhost'].includes(issuer.hostname);
  const trustedProtocol =
    issuer.protocol === 'https:' ||
    (config.allowLocalIssuer === true && isLocal && issuer.protocol === 'http:');
  if (!trustedProtocol || issuer.search || issuer.hash || issuer.username || issuer.password) {
    throw new MenuTokenUnavailableError();
  }
  return issuer.href;
}

function isAuthenticationFailure(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  return [
    'ERR_JOSE_ALG_NOT_ALLOWED',
    'ERR_JWS_INVALID',
    'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
    'ERR_JWT_CLAIM_VALIDATION_FAILED',
    'ERR_JWT_EXPIRED',
    'ERR_JWT_INVALID',
    'ERR_JWKS_NO_MATCHING_KEY',
  ].includes(error.code as string);
}
