import { BoundedRetrievalResultSchema, type RetrievalRequestInput } from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import { parseHtmlSource, parsePlainTextSource } from './parser';
import { extractPassageFromSegment, rankAndBoundPassages, tokenizeQuery } from './ranker';
import { retrieveMenuEvidence } from './retriever';

function createTestPdf(text: string): Uint8Array {
  const escapedText = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 12 Tf 50 750 Td (${escapedText}) Tj ET`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];

  for (let i = 0; i < objects.length; i++) {
    offsets.push(new TextEncoder().encode(pdf).length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = new TextEncoder().encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';

  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return new TextEncoder().encode(pdf);
}

describe('S3-VIS-04 Bounded Menu Evidence Retrieval Engine', () => {
  const sampleMenuHtml = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>Trattoria Rustica Menu</title>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "MenuItem",
            "name": "Tuscan White Bean Soup",
            "offers": { "@type": "Offer", "price": "11.50", "priceCurrency": "USD" }
          }
        </script>
        <style>.nav { color: red; }</style>
      </head>
      <body>
        <nav><a href="/home">Home</a><a href="/about">About Us</a></nav>
        <header><h1>Welcome to Trattoria Rustica</h1></header>
        <main id="menu">
          <section class="starters">
            <h2>Primi & Soups</h2>
            <div class="dish">
              <h3>Tuscan White Bean Soup</h3>
              <p>Creamy cannellini beans simmered with rosemary, garlic, and extra virgin olive oil. Served with warm focaccia: $11.50</p>
            </div>
            <div class="dish">
              <h3>Minestrone Classico</h3>
              <p>Seasonal garden vegetables, san marzano tomatoes, ditalini pasta, and parmigiano-reggiano broth: $9.50</p>
            </div>
          </section>
          <section class="mains">
            <h2>Secondi</h2>
            <div class="dish">
              <h3>Wild Mushroom Risotto</h3>
              <p>Arborio rice slowly cooked with porcini mushrooms, white wine, shallots, and fresh thyme: $22.00</p>
            </div>
          </section>
        </main>
        <footer><p>&copy; 2026 Trattoria Rustica. All rights reserved. <a href="/menu-winter-2026.pdf">Download PDF Menu</a></p></footer>
      </body>
    </html>
  `;

  describe('HTML and text parsing', () => {
    it('parses HTML and preserves structured menu items and candidate links', () => {
      const parsed = parseHtmlSource(sampleMenuHtml, 'src_html_1', 'https://trattoria.example.com');
      expect(parsed.hasStructuredMenu).toBe(true);
      expect(parsed.discoveredLinks).toContain(
        'https://trattoria.example.com/menu-winter-2026.pdf',
      );
      expect(parsed.segments.length).toBeGreaterThan(0);

      // Verifies non-content elements like <nav> and <footer> tags were stripped
      const fullExtractedText = parsed.segments.map((s) => s.text).join('\n');
      expect(fullExtractedText).not.toContain('<nav>');
      expect(fullExtractedText).not.toContain('style');
      expect(fullExtractedText).toContain('Tuscan White Bean Soup');
    });

    it('parses plain text sections correctly', () => {
      const plainText = `
Breakfast Menu

Classic Buttermilk Pancakes
Three fluffy pancakes served with pure Quebec maple syrup and butter: $13.00

Avocado Toast Tartine
Sourdough bread topped with mashed hass avocado, radish, and chili flakes: $11.50
      `;
      const parsed = parsePlainTextSource(plainText, 'src_txt_1', 'text');
      expect(parsed.segments.length).toBe(3);
      expect(parsed.segments[1]?.text).toContain('Classic Buttermilk Pancakes');
      expect(parsed.segments[2]?.text).toContain('Avocado Toast Tartine');
    });
  });

  describe('Deterministic passage extraction and offset preservation', () => {
    it('guarantees exact character substring identity for offsets', () => {
      const parsed = parseHtmlSource(sampleMenuHtml, 'src_trattoria');
      const tokens = tokenizeQuery('Tuscan White Bean Soup');

      const soupSegment = parsed.segments.find((s) => s.text.includes('Tuscan White Bean Soup'));
      expect(soupSegment).toBeDefined();

      if (soupSegment) {
        const candidate = extractPassageFromSegment(
          'src_trattoria',
          soupSegment,
          'Tuscan White Bean Soup',
          tokens,
        );
        expect(candidate).not.toBeNull();
        if (candidate) {
          // Offsets must match raw substring exactly
          const slicedSubstring = soupSegment.text.slice(
            candidate.start_offset,
            candidate.end_offset,
          );
          expect(slicedSubstring).toBe(candidate.text);
          expect(candidate.end_offset - candidate.start_offset).toBe(candidate.text.length);
        }
      }
    });

    it('preserves offsets with Unicode characters (accented text, emoji, currency symbols)', () => {
      const unicodeText = `Café Crème Brûlée: $8.50. Crème pâtissière caramélisée au sucre de canne. 🍮`;
      const parsed = parsePlainTextSource(unicodeText, 'src_unicode');
      const tokens = tokenizeQuery('Crème Brûlée');

      const segment = parsed.segments[0];
      expect(segment).toBeDefined();
      if (segment) {
        const candidate = extractPassageFromSegment('src_unicode', segment, 'Crème Brûlée', tokens);
        expect(candidate).not.toBeNull();
        if (candidate) {
          expect(segment.text.slice(candidate.start_offset, candidate.end_offset)).toBe(
            candidate.text,
          );
          expect(candidate.text).toContain('Café Crème Brûlée');
        }
      }
    });
  });

  describe('retrieveMenuEvidence end-to-end', () => {
    it('follows a discovered PDF menu link within the configured source limit', async () => {
      const pdfBytes = createTestPdf('Tuscan White Bean Soup: $11.50');

      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);

        if (url === 'https://trattoria.example.com/menu') {
          return new Response(sampleMenuHtml, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }

        if (url === 'https://trattoria.example.com/menu-winter-2026.pdf') {
          return new Response(pdfBytes.slice().buffer as ArrayBuffer, {
            status: 200,
            headers: { 'Content-Type': 'application/pdf' },
          });
        }

        throw new Error(`Unexpected URL fetched: ${url}`);
      };

      const result = await retrieveMenuEvidence(
        {
          query: 'Tuscan White Bean Soup',
          candidate_urls: ['https://trattoria.example.com/menu'],
        },
        {
          customFetch: mockFetch,
          allowLocalTestDestinations: true,
          maxFetchedSources: 2,
        },
      );

      expect(result.status).toBe('success');
      expect(result.passages.some((p) => p.text.includes('Tuscan White Bean Soup'))).toBe(true);
    });

    it('does not fetch discovered links when the source budget is exhausted', async () => {
      const fetchedUrls: string[] = [];

      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        fetchedUrls.push(url);

        return new Response(sampleMenuHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      };

      await retrieveMenuEvidence(
        {
          query: 'Tuscan White Bean Soup',
          candidate_urls: ['https://trattoria.example.com/menu'],
        },
        {
          customFetch: mockFetch,
          allowLocalTestDestinations: true,
          maxFetchedSources: 1,
        },
      );

      expect(fetchedUrls).toEqual(['https://trattoria.example.com/menu']);
    });

    it('retrieves relevant evidence from HTML menu with high confidence', async () => {
      const request: RetrievalRequestInput = {
        query: 'Tuscan White Bean Soup',
        sources: [
          {
            source_id: 'src_trattoria_web',
            kind: 'html',
            content: sampleMenuHtml,
            location: 'https://trattoria.example.com/menu',
          },
        ],
        max_passages: 5,
        max_context_chars: 5000,
      };

      const result = await retrieveMenuEvidence(request);

      expect(result.schema_version).toBe(1);
      expect(result.status).toBe('success');
      expect(result.passages.length).toBeGreaterThan(0);
      expect(result.passages.length).toBeLessThanOrEqual(5);

      const topPassage = result.passages[0];
      expect(topPassage).toBeDefined();
      if (topPassage) {
        expect(topPassage.rank).toBe(1);
        expect(topPassage.score).toBeGreaterThan(0.7);
        expect(topPassage.text).toContain('Tuscan White Bean Soup');
        expect(topPassage.source.source_id).toBe('src_trattoria_web');
        expect(topPassage.end_offset - topPassage.start_offset).toBe(topPassage.text.length);
      }

      // Validates schema strictly
      expect(BoundedRetrievalResultSchema.parse(result)).toEqual(result);
    });

    it('retrieves evidence from multiple candidate sources and ranks deterministically', async () => {
      const secondSourceText = `
Special of the Day
Tuscan White Bean Soup Bowl: $10.00. Fresh herbs and olive oil.
Garlic Bread: $4.00
      `;

      const request: RetrievalRequestInput = {
        query: 'Tuscan White Bean Soup',
        sources: [
          {
            source_id: 'src_web',
            kind: 'html',
            content: sampleMenuHtml,
          },
          {
            source_id: 'src_specials',
            kind: 'text',
            content: secondSourceText,
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);
      expect(['success', 'ambiguous']).toContain(result.status);
      expect(result.passages.length).toBeGreaterThanOrEqual(1);

      // Verify ranks are sequentially 1, 2, ...
      for (let i = 0; i < result.passages.length; i++) {
        expect(result.passages[i]?.rank).toBe(i + 1);
      }
    });

    it('returns no_result when query has no matching evidence in available sources', async () => {
      const request: RetrievalRequestInput = {
        query: 'Dragonfruit Curry and Mango Sticky Rice',
        sources: [
          {
            source_id: 'src_trattoria',
            kind: 'html',
            content: sampleMenuHtml,
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);
      expect(result.status).toBe('no_result');
      expect(result.passages).toHaveLength(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('returns ambiguous when multiple conflicting candidates have near-equal high scores', async () => {
      const conflictingText1 = 'Lobster Bisque: $16.00 with tarragon cream';
      const conflictingText2 = 'Lobster Bisque: $28.00 with black truffle butter';

      const request: RetrievalRequestInput = {
        query: 'Lobster Bisque',
        sources: [
          {
            source_id: 'src_lunch',
            kind: 'text',
            content: conflictingText1,
          },
          {
            source_id: 'src_dinner',
            kind: 'text',
            content: conflictingText2,
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);
      expect(result.status).toBe('ambiguous');
      expect(result.passages.length).toBe(2);
      expect(result.warnings.some((w) => w.toLowerCase().includes('ambiguous'))).toBe(true);
    });

    it('deduplicates substantially identical or overlapping passages', () => {
      const candidate1 = {
        passage_id: 'p1',
        source_id: 'src1',
        segment_id: 'seg1',
        text: 'Tomato Soup with Basil: $12.00. Fresh tomatoes.',
        start_offset: 0,
        end_offset: 46,
        score: 0.9,
      };
      // Overlapping passage in same segment
      const candidate2 = {
        passage_id: 'p2',
        source_id: 'src1',
        segment_id: 'seg1',
        text: 'Tomato Soup with Basil: $12.00',
        start_offset: 0,
        end_offset: 30,
        score: 0.85,
      };
      // High word overlap from different segment
      const candidate3 = {
        passage_id: 'p3',
        source_id: 'src2',
        segment_id: 'seg2',
        text: 'Tomato Soup with Basil: $12.00. Fresh tomatoes.',
        start_offset: 0,
        end_offset: 46,
        score: 0.88,
      };

      const { passages } = rankAndBoundPassages([candidate1, candidate2, candidate3]);
      expect(passages).toHaveLength(1);
      expect(passages[0]?.passage_id).toBe('p1');
    });

    it('handles inaccessible candidate URLs and records diagnostic warnings', async () => {
      const mockFetch: typeof fetch = async () => {
        throw new Error('Connection refused to target host');
      };

      const request: RetrievalRequestInput = {
        query: 'Soup',
        candidate_urls: ['https://unavailable-domain.example.com/menu'],
      };

      const result = await retrieveMenuEvidence(request, {
        customFetch: mockFetch,
        allowLocalTestDestinations: true,
      });

      expect(result.status).toBe('failed');
      expect(result.passages).toHaveLength(0);
      expect(result.warnings.some((w) => w.includes('Failed to fetch candidate source'))).toBe(
        true,
      );
    });

    it('respects max_passages and aggregate context character limits', async () => {
      const candidates = Array.from({ length: 8 }, (_, i) => ({
        passage_id: `p_${i + 1}`,
        source_id: `src_${i + 1}`,
        segment_id: `seg_${i + 1}`,
        text: `Dish number ${i + 1} with description: ${'x'.repeat(400)}`,
        start_offset: 0,
        end_offset: 435,
        score: 0.8 - i * 0.05,
      }));

      // Aggregate limit set to 1000 characters: only 2 passages can fit (435 * 2 = 870 < 1000)
      const { passages } = rankAndBoundPassages(candidates, {
        maxPassages: 5,
        maxContextChars: 1000,
      });

      expect(passages.length).toBe(2);
      const totalLen = passages.reduce((sum, p) => sum + p.text.length, 0);
      expect(totalLen).toBeLessThanOrEqual(1000);
    });
  });
});
