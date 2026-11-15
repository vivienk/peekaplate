import { createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { unstable_dev } from 'wrangler';
import { fetchPreparedMenu, listPreparedMenus } from './owner-publication';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const content = {
  schema_version: 1,
  venue_id: id(1),
  menu_id: id(2),
  menu_revision_id: id(3),
  restaurant: { name: 'Synthetic cafe', logo: null },
  categories: [
    {
      category_id: id(4),
      name: 'Lunch',
      dishes: [{ dish_id: id(5), dish_revision_id: id(6), complete: false }],
    },
  ],
};
const bytes = JSON.stringify(content);
const menu = {
  venueId: id(1),
  menuId: id(2),
  menuRevisionId: id(3),
  contentApprovalId: id(7),
  assetApprovalId: id(8),
  contentHash: createHash('sha256').update(bytes).digest('hex'),
  assetManifestHash: 'a'.repeat(64),
  bundleUrl: 'https://68d424e7.peekaplate-diner-staging.pages.dev/fixtures/menu.json',
  reviewVersion: 0,
  publicationVersion: 0,
  publishedRevisionId: null,
};

describe('prepared owner publication', () => {
  it('uses Worker-compatible manual redirects without following a hostile Location', async () => {
    const worker = await unstable_dev(
      fileURLToPath(new URL('./owner-publication.workerd-harness.ts', import.meta.url)),
      {
        config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
        local: true,
        ip: '127.0.0.1',
        port: 0,
        inspectorPort: 0,
        logLevel: 'error',
        experimental: {
          disableExperimentalWarning: true,
          forceLocal: true,
          watch: false,
          disableDevRegistry: true,
        },
      },
    );
    try {
      for (const redirect of [false, true]) {
        const response = await worker.fetch('http://fixture.test', {
          method: 'POST',
          body: JSON.stringify({ menu, bytes, redirect }),
        });
        expect(response.status).toBe(redirect ? 502 : 200);
        expect(response.headers.get('X-Fixture-Requests')).toBe('1');
        if (!redirect) expect(await response.json()).toEqual(content);
      }
    } finally {
      await worker.stop();
    }
  }, 30_000);

  it.each(['editor', 'viewer', null])(
    'denies %s before reading admitted menus',
    async (permission) => {
      const query = vi.fn(async (sql: string) => ({
        rows:
          sql.includes('FROM app_private.staff_membership') && permission ? [{ permission }] : [],
      }));
      await expect(listPreparedMenus({ query } as never, id(9), id(1))).rejects.toMatchObject({
        status: 403,
      });
      expect(
        query.mock.calls.some(([sql]) => sql.includes('FROM app_private.menu_review_subject')),
      ).toBe(false);
      expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    },
  );

  it('returns exact admitted metadata after a committed owner read', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('FROM app_private.staff_membership')
        ? [{ permission: 'owner' }]
        : sql.includes('FROM app_private.menu_review_subject')
          ? [menu]
          : [],
    }));
    expect(await listPreparedMenus({ query } as never, id(9), id(1))).toEqual([menu]);
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('verifies exact bytes and identity without credentials or redirects', async () => {
    const send = vi.fn(async () => new Response(bytes));
    expect(await fetchPreparedMenu(menu, send as typeof fetch)).toEqual(content);
    expect(send.mock.calls[0]).toEqual([
      menu.bundleUrl,
      expect.objectContaining({ redirect: 'manual' }),
    ]);
  });

  it.each([
    'https://example.test/menu.json',
    'https://68d424e7.peekaplate-diner-staging.pages.dev.evil.test/menu.json',
    'https://user:pass@68d424e7.peekaplate-diner-staging.pages.dev/menu.json',
    `${menu.bundleUrl}?secret=x`,
  ])('rejects untrusted stored URL %s without fetching', async (bundleUrl) => {
    const send = vi.fn();
    await expect(fetchPreparedMenu({ ...menu, bundleUrl }, send)).rejects.toBeDefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects tampered bytes, wrong identity, redirects and oversized bodies', async () => {
    await expect(
      fetchPreparedMenu(menu, async () => new Response(`${bytes} `)),
    ).rejects.toBeDefined();
    await expect(
      fetchPreparedMenu({ ...menu, venueId: id(20) }, async () => new Response(bytes)),
    ).rejects.toBeDefined();
    await expect(
      fetchPreparedMenu(menu, async () => new Response(null, { status: 302 })),
    ).rejects.toBeDefined();
    await expect(
      fetchPreparedMenu(menu, async () => new Response('x'.repeat(2_000_001))),
    ).rejects.toBeDefined();
  });
});
