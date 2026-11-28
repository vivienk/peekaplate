// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { OWNER_AUTH_PATH, OWNER_PAGE_PATHS } from './routes';

const consoleRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

describe('Owner Console production Cloudflare Pages _headers and _redirects', () => {
  it('emits framing, CSP frame-ancestors, and HSTS headers only for production builds', async () => {
    const prodOut = mkdtempSync(join(tmpdir(), 'console-prod-'));
    const previewOut = mkdtempSync(join(tmpdir(), 'console-preview-'));
    const prevApiUrl = process.env.VITE_PUBLIC_API_URL;
    const prevDemos = process.env.PEEKAPLATE_PREVIEW_DEMOS;

    try {
      process.env.VITE_PUBLIC_API_URL = 'https://api.peekaplate.app';
      delete process.env.PEEKAPLATE_PREVIEW_DEMOS;
      await build({
        root: consoleRoot,
        mode: 'production',
        logLevel: 'silent',
        build: { outDir: prodOut, emptyOutDir: true },
      });

      const headers = readFileSync(join(prodOut, '_headers'), 'utf8');
      expect(headers).toContain('/*');
      expect(headers).toContain('X-Frame-Options: DENY');
      expect(headers).toContain("Content-Security-Policy: frame-ancestors 'none'");
      expect(headers).toContain('Strict-Transport-Security: max-age=2592000');
      expect(headers).not.toContain('includeSubDomains');
      expect(headers).not.toContain('preload');

      const redirects = readFileSync(join(prodOut, '_redirects'), 'utf8');
      expect(redirects).toContain(`/ ${OWNER_AUTH_PATH} 302`);
      for (const path of Object.values(OWNER_PAGE_PATHS)) {
        expect(redirects).toContain(`${path} ${OWNER_AUTH_PATH} 200`);
      }

      process.env.VITE_PUBLIC_API_URL = 'https://peekaplate-api-staging.vxkong.workers.dev';
      await build({
        root: consoleRoot,
        mode: 'staging',
        logLevel: 'silent',
        build: { outDir: previewOut, emptyOutDir: true },
      });
      expect(() => readFileSync(join(previewOut, '_headers'), 'utf8')).toThrow();
    } finally {
      if (prevApiUrl === undefined) delete process.env.VITE_PUBLIC_API_URL;
      else process.env.VITE_PUBLIC_API_URL = prevApiUrl;
      if (prevDemos === undefined) delete process.env.PEEKAPLATE_PREVIEW_DEMOS;
      else process.env.PEEKAPLATE_PREVIEW_DEMOS = prevDemos;
      rmSync(prodOut, { recursive: true, force: true });
      rmSync(previewOut, { recursive: true, force: true });
    }
  });
});
