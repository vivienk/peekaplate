import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type SafeFetchResult, safeFetch } from '../retrieval/fetcher';
import { materializeMenuUrl } from './intake';
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
