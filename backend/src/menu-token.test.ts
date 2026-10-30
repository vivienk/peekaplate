import { describe, expect, it } from 'vitest';
import {
  MenuTokenAuthenticationError,
  MenuTokenAuthorizationError,
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
});
