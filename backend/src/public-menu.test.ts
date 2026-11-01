import { MenuTokenClaimsSchema, PublicMenuResponseSchema } from '@peekaplate/contracts';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './index';
import {
  createPublicMenuResponse,
  issueMenuToken,
  menuJwks,
  type PublicMenuRecord,
} from './public-menu';

const venueId = '00000000-0000-4000-8000-000000000101';
const menuId = '00000000-0000-4000-8000-000000000102';
const publicationId = '00000000-0000-4000-8000-000000000103';
const keyPair = await generateKeyPair('ES256', { extractable: true });
const signingJwk = {
  ...(await exportJWK(keyPair.privateKey)),
  kid: 'menu-test-key',
  alg: 'ES256',
  use: 'sig',
};
const signingConfig = {
  issuer: 'https://api.example.test',
  signingJwk: JSON.stringify(signingJwk),
};
const menu: PublicMenuRecord = {
  schemaVersion: 1,
  venueId,
  menuId,
  menuRevisionId: '00000000-0000-4000-8000-000000000104',
  publicationId,
  publicationHash: 'a'.repeat(64),
  availabilityVersion: 3,
  tier: 'T0',
  bundle: {
    url: 'https://assets.example.test/menus/revision.json',
    contentHash: 'b'.repeat(64),
    assetManifestHash: 'c'.repeat(64),
  },
};

describe('RES-02 public menu token', () => {
  it('binds a 30-minute observations token to the exact venue and publication', async () => {
    const now = 1_798_000_000;
    const result = await issueMenuToken(menu, signingConfig, now);
    const verified = await jwtVerify(result.menuToken, keyPair.publicKey, {
      issuer: 'https://api.example.test/',
      audience: 'peekaplate-observations',
      algorithms: ['ES256'],
      currentDate: new Date((now + 1) * 1000),
    });
    expect(verified.payload).toMatchObject({
      venue: venueId,
      publication: publicationId,
      scope: 'observations',
      iat: now,
      exp: now + 1800,
    });
    expect(verified.payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.tokenExpiresAt).toBe(new Date((now + 1800) * 1000).toISOString());
  });

  it('fails closed for an untrusted issuer or incompatible signing key', async () => {
    await expect(
      issueMenuToken(menu, { ...signingConfig, issuer: 'http://api.example.test' }),
    ).rejects.toThrow('not trusted');
    await expect(
      issueMenuToken(menu, { ...signingConfig, issuer: 'https://api.example.test/menu' }),
    ).rejects.toThrow('not trusted');
    await expect(
      issueMenuToken(menu, {
        ...signingConfig,
        signingJwk: JSON.stringify({ kty: 'oct', k: 'forged', kid: 'bad', alg: 'HS256' }),
      }),
    ).rejects.toThrow('one named ES256 signing key');
  });

  it('validates the complete response after issuing the token', async () => {
    await expect(createPublicMenuResponse(menu, signingConfig)).resolves.toMatchObject({
      ...menu,
      menuToken: expect.any(String),
      tokenExpiresAt: expect.any(String),
    });
  });

  it('publishes only the matching public ES256 key through JWKS', async () => {
    const jwks = await menuJwks(signingConfig);
    expect(jwks.keys).toEqual([
      expect.objectContaining({ kty: 'EC', crv: 'P-256', kid: 'menu-test-key', alg: 'ES256' }),
    ]);
    expect(jwks.keys[0]).not.toHaveProperty('d');
  });
  it('rejects insecure bundle pointers, unknown authority and malformed token claims', async () => {
    const response = await createPublicMenuResponse(menu, signingConfig);
    expect(
      PublicMenuResponseSchema.safeParse({
        ...response,
        bundle: { ...response.bundle, url: 'http://assets.example.test/menu.json' },
      }).success,
    ).toBe(false);
    expect(PublicMenuResponseSchema.safeParse({ ...response, actorId: venueId }).success).toBe(
      false,
    );
    expect(
      MenuTokenClaimsSchema.safeParse({
        venue: venueId,
        publication: publicationId,
        scope: 'publish',
        iat: 100,
        exp: 200,
        jti: crypto.randomUUID(),
      }).success,
    ).toBe(false);
  });
});

describe('RES-02 anonymous public menu HTTP boundary', () => {
  const path = `/public/venues/${venueId}/menus/${menuId}`;
  const baseDependencies = { verify: vi.fn(), execute: vi.fn() };

  it('returns only the active typed bundle and issued token without staff authentication', async () => {
    const responseBody = await createPublicMenuResponse(menu, signingConfig);
    const readPublicMenu = vi.fn().mockResolvedValue(menu);
    const issuePublicMenu = vi.fn().mockResolvedValue(responseBody);
    const response = await createApp({
      ...baseDependencies,
      readPublicMenu,
      issuePublicMenu,
    }).request(path);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(responseBody);
    expect(readPublicMenu).toHaveBeenCalledWith(venueId, menuId, {});
    expect(issuePublicMenu).toHaveBeenCalledWith(menu, {});
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns one indistinguishable not-found state for absent or withdrawn publications', async () => {
    const response = await createApp({
      ...baseDependencies,
      readPublicMenu: vi.fn().mockResolvedValue(undefined),
      issuePublicMenu: vi.fn(),
    }).request(path);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it('rejects malformed public scope before querying storage', async () => {
    const readPublicMenu = vi.fn();
    const response = await createApp({
      ...baseDependencies,
      readPublicMenu,
      issuePublicMenu: vi.fn(),
    }).request('/public/venues/not-a-uuid/menus/not-a-uuid');
    expect(response.status).toBe(400);
    expect(readPublicMenu).not.toHaveBeenCalled();
  });

  it('fails closed when the read or signing dependency is unavailable', async () => {
    const response = await createApp(baseDependencies).request(path);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
  });
});
