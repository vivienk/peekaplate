import { MENU_TOKEN_AUDIENCE } from '@peekaplate/contracts';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  createMenuTokenVerifier,
  MenuTokenAuthenticationError,
  MenuTokenAuthorizationError,
  MenuTokenUnavailableError,
  validateMenuTokenClaims,
} from './menu-token';

const now = 1_800_000_000;
const base = {
  venue: '10000000-0000-4000-8000-000000000001',
  publication: '20000000-0000-4000-8000-000000000001',
  jti: '30000000-0000-4000-8000-000000000001',
  scope: 'observations',
  iat: now,
  exp: now + 1_800,
};

describe('menu-token claims', () => {
  it('accepts the exact 30-minute lifetime and allowed clock skew', () => {
    expect(validateMenuTokenClaims(base, now)).toMatchObject({
      venueId: base.venue,
      publicationId: base.publication,
      jti: base.jti,
      trafficClass: 'live',
    });
    expect(
      validateMenuTokenClaims({ ...base, iat: now + 60, exp: now + 1_860 }, now),
    ).toBeDefined();
  });

  it('rejects a future issuance beyond skew and a lifetime over 30 minutes', () => {
    expect(() =>
      validateMenuTokenClaims({ ...base, iat: now + 61, exp: now + 1_861 }, now),
    ).toThrow(MenuTokenAuthenticationError);
    expect(() => validateMenuTokenClaims({ ...base, exp: now + 1_801 }, now)).toThrow(
      MenuTokenAuthenticationError,
    );
  });

  it('rejects expired claims and the wrong scope', () => {
    expect(() => validateMenuTokenClaims({ ...base, iat: now - 200, exp: now - 61 }, now)).toThrow(
      MenuTokenAuthenticationError,
    );
    expect(() => validateMenuTokenClaims({ ...base, scope: 'reports' }, now)).toThrow(
      MenuTokenAuthorizationError,
    );
  });

  it('validates audience against PR #43 MENU_TOKEN_AUDIENCE', () => {
    expect(validateMenuTokenClaims({ ...base, aud: MENU_TOKEN_AUDIENCE }, now)).toMatchObject({
      venueId: base.venue,
      publicationId: base.publication,
    });
    expect(() => validateMenuTokenClaims({ ...base, aud: 'wrong-audience' }, now)).toThrow(
      MenuTokenAuthenticationError,
    );
  });

  it('validates and extracts trusted traffic_class with live fallback', () => {
    expect(validateMenuTokenClaims(base, now).trafficClass).toBe('live');
    expect(validateMenuTokenClaims({ ...base, traffic_class: 'test' }, now).trafficClass).toBe(
      'test',
    );
    expect(validateMenuTokenClaims({ ...base, traffic_class: 'demo' }, now).trafficClass).toBe(
      'demo',
    );
    expect(() => validateMenuTokenClaims({ ...base, traffic_class: 'invalid_class' }, now)).toThrow(
      MenuTokenAuthenticationError,
    );
  });

  it('rejects untrusted issuer with non-root pathname matching PR #43', () => {
    expect(() => createMenuTokenVerifier({ issuer: 'https://example.com/subpath' })).toThrow(
      MenuTokenUnavailableError,
    );
  });

  it('accepts valid HTTPS root issuer matching staging Worker configuration', () => {
    expect(() =>
      createMenuTokenVerifier({
        issuer: 'https://peekaplate-api-staging.vxkong.workers.dev',
      }),
    ).not.toThrow();
  });

  it('verifies signed ES256 token and audience via createMenuTokenVerifier', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'key-1';
    publicJwk.alg = 'ES256';

    const issuer = 'http://localhost';
    const verifier = createMenuTokenVerifier({
      issuer,
      allowLocalIssuer: true,
    });

    const token = await new SignJWT({
      venue: base.venue,
      publication: base.publication,
      scope: 'observations',
      traffic_class: 'test',
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'key-1' })
      .setIssuer(`${issuer}/`)
      .setAudience(MENU_TOKEN_AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 1800)
      .setJti(base.jti)
      .sign(privateKey);

    // Mock global fetch for JWKS endpoint
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'http://localhost/.well-known/jwks.json') {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { 'Content-Type': 'application/jwk-set+json' },
        });
      }
      return originalFetch(url);
    });

    try {
      const verified = await verifier(`Bearer ${token}`);
      expect(verified).toMatchObject({
        venueId: base.venue,
        publicationId: base.publication,
        jti: base.jti,
        trafficClass: 'test',
      });

      // Wrong audience should be rejected
      const wrongAudToken = await new SignJWT({
        venue: base.venue,
        publication: base.publication,
        scope: 'observations',
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'key-1' })
        .setIssuer(`${issuer}/`)
        .setAudience('wrong-aud')
        .setIssuedAt(Math.floor(Date.now() / 1000))
        .setExpirationTime(Math.floor(Date.now() / 1000) + 1800)
        .setJti(base.jti)
        .sign(privateKey);

      await expect(verifier(`Bearer ${wrongAudToken}`)).rejects.toThrow(
        MenuTokenAuthenticationError,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
