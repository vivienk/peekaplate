import { describe, expect, it } from 'vitest';
import { readConfirmationCode } from './callback';

describe('confirmation callback boundary', () => {
  it('accepts the exact clean callback aliases served by Cloudflare Pages', () => {
    expect(
      readConfirmationCode(
        'https://peekaplate-console-staging.pages.dev/auth-confirm?code=synthetic-code',
      ),
    ).toBe('synthetic-code');
    expect(
      readConfirmationCode(
        'https://peekaplate-console-staging.pages.dev/auth-reset?code=synthetic-code',
        'recovery',
      ),
    ).toBe('synthetic-code');
    for (const path of [
      '/auth-confirmation',
      '/auth-confirm/',
      '/auth-confirm.html/extra',
      '/owner-auth',
    ]) {
      expect(
        readConfirmationCode(
          `https://peekaplate-console-staging.pages.dev${path}?code=synthetic-code`,
        ),
      ).toBeNull();
    }
    expect(
      readConfirmationCode(
        'https://peekaplate-console-staging.pages.dev/auth-reset?code=synthetic-code',
      ),
    ).toBeNull();
    expect(
      readConfirmationCode(
        'https://peekaplate-console-staging.pages.dev/auth-confirm?code=synthetic-code',
        'recovery',
      ),
    ).toBeNull();
    for (const suffix of [
      '?code=a&code=b',
      '?code=a&next=https://evil.test',
      '?code=a#access_token=synthetic',
    ]) {
      expect(
        readConfirmationCode(`https://peekaplate-console-staging.pages.dev/auth-confirm${suffix}`),
      ).toBeNull();
      expect(
        readConfirmationCode(
          `https://peekaplate-console-staging.pages.dev/auth-reset${suffix}`,
          'recovery',
        ),
      ).toBeNull();
    }
  });

  it('accepts only one code on the exact confirmation path', () => {
    expect(
      readConfirmationCode('http://127.0.0.1:5174/auth-confirm.html?code=synthetic-code'),
    ).toBe('synthetic-code');
    for (const suffix of [
      '',
      '?code=',
      '?code=a&code=b',
      '?code=a&next=https://evil.test',
      '?type=recovery',
      '#access_token=synthetic',
      '?error=access_denied&error_description=private',
    ]) {
      expect(readConfirmationCode(`http://127.0.0.1:5174/auth-confirm.html${suffix}`)).toBeNull();
    }
    expect(readConfirmationCode('http://127.0.0.1:5174/owner-auth.html?code=a')).toBeNull();
  });
});
