import { describe, expect, it } from 'vitest';
import { readConfirmationCode } from './callback';

describe('confirmation callback boundary', () => {
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
