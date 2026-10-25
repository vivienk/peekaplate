import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev } from 'wrangler';
import { FetchError, MAX_HTML_BYTES, MAX_REDIRECTS, safeFetch } from './fetcher';
import { SecurityValidationError, validateDestination } from './security';

describe('S3-VIS-04 workerd-level External-Fetch Security Boundary Acceptance', () => {
  describe('Transport security guarantees (Worker-compatible runtime)', () => {
    it('validates and allows permitted public HTTPS URLs', async () => {
      const mockDns = async () => [{ address: '93.184.216.34', family: 4 }];
      const result = await validateDestination('https://example.com/menu', { dnsLookup: mockDns });
      expect(result.url.protocol).toBe('https:');
      expect(result.resolvedIPs).toContain('93.184.216.34');
    });

    it('rejects URLs resolving to prohibited private/internal IPv4 addresses', async () => {
      const privateIps = ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254'];
      for (const ip of privateIps) {
        const mockDns = async () => [{ address: ip, family: 4 }];
        await expect(
          validateDestination(`https://host-resolving-to-${ip.replace(/\./g, '-')}.com/menu`, {
            dnsLookup: mockDns,
          }),
        ).rejects.toThrow(SecurityValidationError);
      }
    });

    it('rejects URLs resolving to prohibited IPv6 addresses (loopback, ULA, link-local)', async () => {
      const prohibitedIpv6 = ['::1', 'fc00::1', 'fe80::1', 'ff02::1'];
      for (const ip of prohibitedIpv6) {
        const mockDns = async () => [{ address: ip, family: 6 }];
        await expect(
          validateDestination('https://ipv6-internal.example.com/menu', { dnsLookup: mockDns }),
        ).rejects.toThrow(SecurityValidationError);
      }
    });

    it('blocks redirects to prohibited destinations', async () => {
      let hops = 0;
      const mockFetch: typeof fetch = async () => {
        hops++;
        if (hops === 1) {
          return new Response(null, {
            status: 302,
            headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
          });
        }
        return new Response('ok');
      };

      await expect(
        safeFetch('https://example.com/redirect-to-metadata', {
          customFetch: mockFetch,
          dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
        }),
      ).rejects.toThrow(SecurityValidationError);
    });

    it('enforces redirect hop bounds (MAX_REDIRECTS = 3)', async () => {
      let hops = 0;
      const mockFetch: typeof fetch = async () => {
        hops++;
        return new Response(null, {
          status: 302,
          headers: { Location: `https://example.com/hop-${hops}` },
        });
      };

      await expect(
        safeFetch('https://example.com/loop', {
          customFetch: mockFetch,
          maxRedirects: MAX_REDIRECTS,
          allowLocalTestDestinations: true,
        }),
      ).rejects.toThrow(FetchError);

      expect(hops).toBe(MAX_REDIRECTS + 1);
    });

    it('rejects HTTPS-to-HTTP redirect downgrade', async () => {
      let hops = 0;
      const mockFetch: typeof fetch = async () => {
        hops++;
        if (hops === 1) {
          return new Response(null, {
            status: 301,
            headers: { Location: 'http://example.com/insecure-target' },
          });
        }
        return new Response('ok');
      };

      await expect(
        safeFetch('https://example.com/secure-start', {
          customFetch: mockFetch,
          allowLocalTestDestinations: true,
        }),
      ).rejects.toThrow(SecurityValidationError);
    });

    it('rejects oversized HTML response bodies (> 2MB)', async () => {
      const oversizedHtml = '<html><body>' + 'x'.repeat(MAX_HTML_BYTES + 512) + '</body></html>';
      const mockFetch: typeof fetch = async () => {
        return new Response(oversizedHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      };

      await expect(
        safeFetch('https://example.com/huge.html', {
          customFetch: mockFetch,
          allowLocalTestDestinations: true,
        }),
      ).rejects.toThrow(FetchError);
    });

    it('rejects DNS resolution failures and missing records', async () => {
      const failingDns = async () => {
        throw new Error('ENOTFOUND');
      };
      await expect(
        validateDestination('https://nonexistent-domain-xyz.com/menu', { dnsLookup: failingDns }),
      ).rejects.toThrow(SecurityValidationError);

      const emptyDns = async () => [];
      await expect(
        validateDestination('https://no-records-domain.com/menu', { dnsLookup: emptyDns }),
      ).rejects.toThrow(SecurityValidationError);
    });
  });

  describe('workerd runtime external-fetch security boundary', () => {
    let worker: Awaited<ReturnType<typeof unstable_dev>> | null = null;
    let fixtureServer: import('node:http').Server | null = null;
    let fixturePort = 0;
    const fixtureHits = {
      menu: 0,
      redirectMeta: 0,
      redirectPrivate: 0,
      metadataTrap: 0,
    };

    beforeAll(async () => {
      if (!process.env.TEST_WORKERD) return;

      const { createServer } = await import('node:http');
      fixtureServer = createServer((req, res) => {
        if (req.url === '/allowed-menu') {
          fixtureHits.menu++;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            '<!DOCTYPE html><html><body><h1>Bistro Menu</h1><p>Wild Mushroom Risotto: $18.00</p></body></html>',
          );
          return;
        }
        if (req.url === '/redirect-to-metadata') {
          fixtureHits.redirectMeta++;
          res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
          res.end();
          return;
        }
        if (req.url === '/redirect-to-private') {
          fixtureHits.redirectPrivate++;
          res.writeHead(302, { Location: 'http://10.0.0.1/admin' });
          res.end();
          return;
        }
        if (req.url?.includes('meta-data')) {
          fixtureHits.metadataTrap++;
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ami-id-secret');
          return;
        }
        res.writeHead(404).end();
      });

      await new Promise<void>((resolve) => fixtureServer!.listen(0, '127.0.0.1', resolve));
      const addr = fixtureServer.address();
      if (!addr || typeof addr === 'string') throw new Error('Failed to bind fixture server');
      fixturePort = addr.port;

      worker = await unstable_dev(
        fileURLToPath(new URL('./fetcher.workerd-harness.ts', import.meta.url)),
        {
          config: fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)),
          local: true,
          ip: '127.0.0.1',
          port: 0,
          inspectorPort: 0,
          logLevel: 'error',
          vars: {
            APP_ENV: 'local',
          },
          experimental: {
            disableExperimentalWarning: true,
            forceLocal: true,
            watch: false,
            disableDevRegistry: true,
          },
        },
      );
    }, 45_000);

    afterAll(async () => {
      if (worker) {
        try {
          await worker.stop();
        } catch {
          // cleanup
        }
      }
      if (fixtureServer) {
        await new Promise<void>((resolve, reject) =>
          fixtureServer!.close((err) => (err ? reject(err) : resolve())),
        );
      }
    });

    it.skipIf(!process.env.TEST_WORKERD)(
      'exercises allowed destination fetch through actual workerd runtime',
      async () => {
        expect(worker).not.toBeNull();
        expect(worker!.port).toBeGreaterThan(0);

        const response = await fetch(`http://127.0.0.1:${worker!.port}/test/safe-fetch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: `http://127.0.0.1:${fixturePort}/allowed-menu`,
            options: { allowLocalTestDestinations: true },
          }),
        });

        expect(response.status).toBe(200);
        const data = (await response.json()) as {
          ok: boolean;
          result: { content: string; sha256: string };
        };
        expect(data.ok).toBe(true);
        expect(data.result.content).toContain('Wild Mushroom Risotto: $18.00');
        expect(data.result.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(fixtureHits.menu).toBeGreaterThanOrEqual(1);
      },
      20_000,
    );

    it.skipIf(!process.env.TEST_WORKERD)(
      'rejects prohibited redirect destination inside workerd runtime before accessing target',
      async () => {
        expect(worker).not.toBeNull();
        const initialHits = fixtureHits.metadataTrap;

        const response = await fetch(`http://127.0.0.1:${worker!.port}/test/safe-fetch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: `http://127.0.0.1:${fixturePort}/redirect-to-metadata`,
            options: { allowLocalTestDestinations: true },
          }),
        });

        expect(response.status).toBe(400);
        const data = (await response.json()) as { ok: boolean; name: string; code: string };
        expect(data.ok).toBe(false);
        expect(data.name).toBe('SecurityValidationError');
        expect(data.code).toBe('PROHIBITED_IP');
        expect(fixtureHits.metadataTrap).toBe(initialHits); // Prohibited destination was NEVER accessed
      },
      20_000,
    );

    it.skipIf(!process.env.TEST_WORKERD)(
      'rejects prohibited DNS and IP destinations directly through workerd runtime',
      async () => {
        expect(worker).not.toBeNull();

        // 1. Prohibited cloud metadata IP literal
        const resMeta = await fetch(`http://127.0.0.1:${worker!.port}/test/safe-fetch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
        });
        expect(resMeta.status).toBe(400);
        const dataMeta = (await resMeta.json()) as { ok: boolean; code: string };
        expect(dataMeta.ok).toBe(false);
        expect(dataMeta.code).toBe('PROHIBITED_IP');

        // 2. Prohibited private RFC1918 IP literal
        const resPrivate = await fetch(`http://127.0.0.1:${worker!.port}/test/safe-fetch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'http://10.0.0.1/admin' }),
        });
        expect(resPrivate.status).toBe(400);
        const dataPrivate = (await resPrivate.json()) as { ok: boolean; code: string };
        expect(dataPrivate.ok).toBe(false);
        expect(dataPrivate.code).toBe('PROHIBITED_IP');

        // 3. Prohibited internal hostname
        const resInternal = await fetch(`http://127.0.0.1:${worker!.port}/test/safe-fetch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'http://metadata.google.internal/computeMetadata/v1' }),
        });
        expect(resInternal.status).toBe(400);
        const dataInternal = (await resInternal.json()) as { ok: boolean; code: string };
        expect(dataInternal.ok).toBe(false);
        expect(dataInternal.code).toBe('PROHIBITED_HOSTNAME');
      },
      20_000,
    );

    it.skipIf(!process.env.TEST_WORKERD)(
      'rejects prohibited destinations through mounted API Worker route in workerd',
      async () => {
        expect(worker).not.toBeNull();
        const venueId = '00000000-0000-4000-8000-000000000001';

        const response = await fetch(
          `http://127.0.0.1:${worker!.port}/api/venues/${venueId}/menu-evidence`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer valid.jwt.token',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              query: 'Soup',
              candidate_urls: ['http://169.254.169.254/latest/meta-data'],
            }),
          },
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as {
          status: string;
          passages: unknown[];
          warnings: string[];
        };
        expect(data.status).toBe('failed');
        expect(data.passages).toHaveLength(0);
        expect(
          data.warnings.some(
            (w) => w.includes('Security rejection') && w.includes('PROHIBITED_IP'),
          ),
        ).toBe(true);
      },
      20_000,
    );
  });
});
