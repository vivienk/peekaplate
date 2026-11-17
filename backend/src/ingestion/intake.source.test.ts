import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type SafeFetchResult, safeFetch } from '../retrieval/fetcher';
import { materializeMenuUrl, selectUnambiguousMenuFile } from './intake';
import { menuPdfFixture } from './pdf-fixture';

vi.mock('../retrieval/fetcher', () => ({ safeFetch: vi.fn() }));
const fetched = (
  finalUrl: string,
  bytes: Uint8Array,
  contentType: string,
  content = '',
): SafeFetchResult => ({
  finalUrl,
  bytes,
  contentType,
  content,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  redirectCount: 1,
  sizeBytes: bytes.length,
  retrievedAt: '2026-11-12T00:00:00.000Z',
});
describe('materialized URL source provenance', () => {
  it('retains original and resolved source plus retrieval time while extracting actual file bytes', async () => {
    const original = 'https://restaurant.example/menu';
    vi.mocked(safeFetch).mockResolvedValueOnce(
      fetched(
        'https://restaurant.example/menu-page',
        new Uint8Array(),
        'text/html',
        '<a href="/menu.pdf">Menu</a>',
      ),
    );
    const pdf = fetched('https://cdn.example/actual-menu.pdf', menuPdfFixture(), 'application/pdf');
    vi.mocked(safeFetch).mockResolvedValueOnce(pdf);
    const result = await materializeMenuUrl(original, crypto.randomUUID());
    expect(result.sourceType).toBe('pdf');
    expect(result.sourceHash).toBe(pdf.sha256);
    expect(result.provenance).toEqual({
      originalUrl: original,
      finalUrl: pdf.finalUrl,
      retrievedAt: pdf.retrievedAt,
    });
    expect(vi.mocked(safeFetch).mock.calls.map((call) => call[0])).toEqual([
      original,
      'https://restaurant.example/menu.pdf',
    ]);
  });
  it('selects one explicitly named menu when the site also links unrelated files', async () => {
    const url = 'https://restaurant.example/menu';
    vi.mocked(safeFetch).mockResolvedValueOnce(
      fetched(
        url,
        new Uint8Array(),
        'text/html; charset=utf-8',
        '<a href="/files/catering.pdf">Catering</a><a href="/files/main-menu.pdf">Menu</a>',
      ),
    );
    const pdf = fetched('https://restaurant.example/files/main-menu.pdf', menuPdfFixture(), 'application/pdf');
    vi.mocked(safeFetch).mockResolvedValueOnce(pdf);
    const result = await materializeMenuUrl(url, crypto.randomUUID());
    expect(result.sourceHash).toBe(pdf.sha256);
    expect(vi.mocked(safeFetch).mock.calls.map((call) => call[0])).toEqual([
      url,
      'https://restaurant.example/files/main-menu.pdf',
    ]);
  });

  it('never guesses when multiple different menu assets are identified', () => {
    expect(
      selectUnambiguousMenuFile([
        'https://restaurant.example/lunch-menu.pdf',
        'https://restaurant.example/dinner-menu.pdf',
      ]),
    ).toBeNull();
    expect(
      selectUnambiguousMenuFile([
        'https://restaurant.example/files/one.pdf',
        'https://restaurant.example/files/two.pdf',
      ]),
    ).toBeNull();
  });

  it('handles duplicate links and ignores menu-like folder names', () => {
    expect(
      selectUnambiguousMenuFile([
        'https://restaurant.example/menu/catering.pdf',
        'https://restaurant.example/menu/catering.pdf',
        'https://restaurant.example/menu/dinner-menu.pdf',
      ]),
    ).toBe('https://restaurant.example/menu/dinner-menu.pdf');
    expect(selectUnambiguousMenuFile(['https://restaurant.example/menu'])).toBeNull();
  });

  it('does not choose arbitrarily between menu files', async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(
      fetched(
        'https://restaurant.example/menu',
        new Uint8Array(),
        'text/html',
        '<a href="/one.pdf">Menu</a><a href="/two.pdf">Menu</a>',
      ),
    );
    await expect(
      materializeMenuUrl('https://restaurant.example/menu', crypto.randomUUID()),
    ).rejects.toMatchObject({ code: 'menu_file_link_required' });
  });
});
