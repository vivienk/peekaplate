import { describe, expect, it } from 'vitest';
import { dinerPreviewUrl } from './diner-url';

describe('S13 diner preview address', () => {
  it('pairs a PR console preview with the same PR diner preview', () => {
    expect(
      dinerPreviewUrl({
        protocol: 'https:',
        hostname: 'pr-205.peekaplate-console-preview.pages.dev',
      }),
    ).toBe('https://pr-205.peekaplate-diner-preview.pages.dev/');
  });

  it('uses the staging diner on the staging console and the local diner locally', () => {
    expect(
      dinerPreviewUrl({ protocol: 'https:', hostname: 'peekaplate-console-staging.pages.dev' }),
    ).toBe('https://peekaplate-diner-staging.pages.dev/');
    expect(dinerPreviewUrl({ protocol: 'http:', hostname: '127.0.0.1' })).toBe(
      'http://127.0.0.1:5173/',
    );
  });

  it('shows no diner anywhere else rather than guessing', () => {
    for (const location of [
      { protocol: 'https:', hostname: 'example.com' },
      { protocol: 'http:', hostname: 'pr-1.peekaplate-console-preview.pages.dev' },
      { protocol: 'https:', hostname: 'pr-1.peekaplate-console-preview.pages.dev.evil.test' },
      { protocol: 'https:', hostname: 'peekaplate.app' },
    ]) {
      expect(dinerPreviewUrl(location)).toBeNull();
    }
  });
});
