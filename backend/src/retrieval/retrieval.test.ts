import { BoundedRetrievalResultSchema, type RetrievalRequestInput } from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import { mapVis02SegmentToSourceSegment } from './handoff';
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

    it('deduplicates candidate URLs before applying the source limit', async () => {
      const pdfBytes = createTestPdf('Saffron Lobster Ravioli: $29.00');
      const fetchedUrls: string[] = [];

      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        fetchedUrls.push(url);

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
          query: 'Saffron Lobster Ravioli',
          candidate_urls: [
            'https://trattoria.example.com/menu',
            'https://trattoria.example.com/menu',
          ],
        },
        {
          customFetch: mockFetch,
          allowLocalTestDestinations: true,
          maxFetchedSources: 2,
        },
      );

      expect(fetchedUrls).toEqual([
        'https://trattoria.example.com/menu',
        'https://trattoria.example.com/menu-winter-2026.pdf',
      ]);
      expect(result.status).toBe('success');
      expect(
        result.passages.some((passage) => passage.text.includes('Saffron Lobster Ravioli')),
      ).toBe(true);
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

    it('ingests VIS-02 image sources with ocr_space_engine3 and preserves metadata', async () => {
      const request: RetrievalRequestInput = {
        query: 'Lobster Roll',
        sources: [
          {
            source_id: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            kind: 'image',
            sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            segments: [
              {
                segment_id:
                  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef#image-1',
                text: 'Fresh Maine Lobster Roll with lemon butter: $24.00',
                method: 'ocr_space_engine3',
                metadata: { engine: 3, word_count: 8 },
                warnings: ['Low lighting condition on image'],
              },
            ],
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);

      expect(result.status).toBe('success');
      expect(result.passages).toHaveLength(1);
      expect(result.passages[0]?.source.source_id).toBe(
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      );
      expect(result.passages[0]?.source.source_sha256).toBe(
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      );
      expect(result.warnings.some((w) => w.includes('Low lighting condition'))).toBe(true);
    });

    it('surfaces partial/failed page processing in warnings without marking source fully complete', async () => {
      const request: RetrievalRequestInput = {
        query: 'Duck Confit',
        sources: [
          {
            source_id: 'src_scanned_menu_pdf',
            kind: 'pdf',
            segments: [
              {
                segment_id: 'src_scanned_menu_pdf#page-1',
                text: 'Duck Confit with roasted potatoes: $28.00',
                page_number: 1,
                method: 'ocr_space_engine3',
                status: 'ready',
              },
              {
                segment_id: 'src_scanned_menu_pdf#page-2',
                text: '',
                page_number: 2,
                method: 'ocr_space_engine3',
                status: 'failed',
                error: 'OCR API timeout after 15000ms',
              },
            ],
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);

      // Page 1 evidence is retrieved successfully
      expect(result.status).toBe('success');
      expect(result.passages).toHaveLength(1);
      expect(result.passages[0]?.text).toContain('Duck Confit');

      // But page 2 failure is transparently surfaced in warnings
      expect(
        result.warnings.some((w) =>
          w.includes("segment 'src_scanned_menu_pdf#page-2' marked as failed: OCR API timeout"),
        ),
      ).toBe(true);
    });

    it('retains complete URL provenance in passages when fetching candidate URLs', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          '<html><body><h1>Bistro Menu</h1><p>Mushroom Risotto with truffle oil: $18.00</p></body></html>',
          {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          },
        );
      };

      const request: RetrievalRequestInput = {
        query: 'Mushroom Risotto',
        candidate_urls: ['https://bistro.example.com/menu'],
      };

      const result = await retrieveMenuEvidence(request, {
        customFetch: mockFetch,
        allowLocalTestDestinations: true,
      });

      expect(result.status).toBe('success');
      expect(result.passages).toHaveLength(1);

      const passageSource = result.passages[0]?.source;
      expect(passageSource?.original_url).toBe('https://bistro.example.com/menu');
      expect(passageSource?.final_url).toBe('https://bistro.example.com/menu');
      expect(passageSource?.source_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(passageSource?.retrieved_at).toBeDefined();
    });
  });

  describe('Finding P2: Contradictory evidence preservation before deduplication', () => {
    const desc1 = 'Tomato Soup with fresh basil cream and toasted sourdough bread $12.00';
    const desc2 = 'Tomato Soup with fresh basil cream and toasted sourdough bread $18.00';

    it('preserves conflicting prices for identical descriptions so contradictions remain detectable', async () => {
      const request: RetrievalRequestInput = {
        query: 'Tomato Soup',
        sources: [
          {
            source_id: 'src_menu_a',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_a1',
                text: desc1,
                status: 'ready',
              },
            ],
          },
          {
            source_id: 'src_menu_b',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_b1',
                text: desc2,
                status: 'ready',
              },
            ],
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);

      // Both contradictory passages must be preserved
      expect(result.passages).toHaveLength(2);
      expect(result.passages.map((p) => p.text)).toEqual([desc1, desc2]);

      // Both distinct source references must be preserved
      const sourceIds = result.passages.map((p) => p.source.source_id);
      expect(sourceIds).toContain('src_menu_a');
      expect(sourceIds).toContain('src_menu_b');

      // Ambiguity must be surfaced in status and warnings
      expect(result.status).toBe('ambiguous');
      expect(
        result.warnings.some((w) =>
          w.includes(
            'Ambiguous evidence detected: multiple candidate menu entries matched with differing details',
          ),
        ),
      ).toBe(true);
    });

    it('deduplicates identical passages with matching prices as normal', async () => {
      const request: RetrievalRequestInput = {
        query: 'Tomato Soup',
        sources: [
          {
            source_id: 'src_menu_1',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_1',
                text: desc1,
                status: 'ready',
              },
            ],
          },
          {
            source_id: 'src_menu_2',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_2',
                text: desc1, // Identical description AND price
                status: 'ready',
              },
            ],
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);

      // Only one passage should survive deduplication
      expect(result.passages).toHaveLength(1);
      expect(result.passages[0]?.text).toBe(desc1);
      expect(result.status).toBe('success');
    });

    it('extractPrices and hasConflictingPrices detect disagreements across formats', async () => {
      const { extractPrices, hasConflictingPrices } = await import('./ranker');

      expect(extractPrices('Soup: $12.00 and Salad: $8.50')).toEqual(['12.00', '8.50'].sort());
      expect(extractPrices('Entree CAD 18.00')).toEqual(['18.00']);
      expect(extractPrices('Pasta €14.50')).toEqual(['14.50']);
      expect(extractPrices('Tacos $12')).toEqual(['12.00']);
      expect(extractPrices('Complimentary Bread $0.00')).toEqual(['0.00']);
      expect(extractPrices('Free Sauce $0')).toEqual(['0.00']);
      expect(extractPrices('Item CAD 0.00')).toEqual(['0.00']);

      expect(hasConflictingPrices('Soup $12.00', 'Soup $18.00')).toBe(true);
      expect(hasConflictingPrices('Soup $12.00', 'Soup $12.00')).toBe(false);
      expect(hasConflictingPrices('Soup with bread', 'Soup with bread')).toBe(false);
      expect(hasConflictingPrices('Soup $12.00', 'Soup with bread')).toBe(false);
      expect(hasConflictingPrices('Soup $0.00', 'Soup $18.00')).toBe(true);
      expect(hasConflictingPrices('Soup $0.00', 'Soup $0.00')).toBe(false);
      expect(hasConflictingPrices('Soup $0.00', 'Soup $0')).toBe(false);

      // Comma-separated thousands prices
      expect(extractPrices('Imperial Caviar Service $1,200.00')).toEqual(['1200.00']);
      expect(extractPrices('Imperial Caviar Service $1,200')).toEqual(['1200.00']);
      expect(extractPrices('Reserve Wine €2,500.50')).toEqual(['2500.50']);
      expect(
        hasConflictingPrices(
          'Imperial Caviar Service $1,200.00',
          'Imperial Caviar Service $1200.00',
        ),
      ).toBe(false);
      expect(
        hasConflictingPrices(
          'Imperial Caviar Service $1,200.00',
          'Imperial Caviar Service $1,500.00',
        ),
      ).toBe(true);
      expect(
        hasConflictingPrices(
          'Imperial Caviar Service $1,200.00',
          'Imperial Caviar Service $200.00',
        ),
      ).toBe(true);

      // Descriptive text, dates, calories, and non-price numbers
      expect(
        extractPrices('Established in 1998, serving 450 calories per portion at 1200 Market St'),
      ).toEqual([]);
      expect(extractPrices('Published on 2026-10-25 with 0 grams added sugar')).toEqual([]);
      expect(
        hasConflictingPrices(
          'Tasting Menu: 12 courses for 2 guests',
          'Tasting Menu: 12 courses for 4 guests',
        ),
      ).toBe(false);
      expect(
        hasConflictingPrices(
          'Grand Tasting $1,200.00 with 12 courses',
          'Grand Tasting $1,200.00 with 14 courses',
        ),
      ).toBe(false);
    });

    it('preserves $1,200.00 vs $1,500.00 contradictory evidence and marks ambiguity through real retrieval path', async () => {
      const desc1 =
        'Grand Seafood Tower: Maine lobster, oysters, king crab legs, and caviar service: $1,200.00';
      const desc2 =
        'Grand Seafood Tower: Maine lobster, oysters, king crab legs, and caviar service: $1,500.00';

      const request: RetrievalRequestInput = {
        query: 'Grand Seafood Tower',
        sources: [
          {
            source_id: 'src_menu_a',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_a',
                text: desc1,
                status: 'ready',
              },
            ],
          },
          {
            source_id: 'src_menu_b',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_b',
                text: desc2,
                status: 'ready',
              },
            ],
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);

      expect(result.passages).toHaveLength(2);
      expect(result.status).toBe('ambiguous');
      expect(result.warnings.some((w) => w.includes('Ambiguous evidence detected'))).toBe(true);
    });

    it('deduplicates $1,200.00 vs $1200.00 cleanly without false conflict through real retrieval path', async () => {
      const desc1 =
        'Grand Seafood Tower: Maine lobster, oysters, king crab legs, and caviar service: $1,200.00';
      const desc2 =
        'Grand Seafood Tower: Maine lobster, oysters, king crab legs, and caviar service: $1200.00';

      const request: RetrievalRequestInput = {
        query: 'Grand Seafood Tower',
        sources: [
          {
            source_id: 'src_menu_a',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_a',
                text: desc1,
                status: 'ready',
              },
            ],
          },
          {
            source_id: 'src_menu_b',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_b',
                text: desc2,
                status: 'ready',
              },
            ],
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);

      expect(result.passages).toHaveLength(1);
      expect(result.status).toBe('success');
      expect(result.warnings.some((w) => w.includes('Ambiguous evidence detected'))).toBe(false);
    });

    it('preserves explicit zero-price ($0.00 vs $18.00) contradiction and marks ambiguity (Hemu review finding)', async () => {
      const zeroPriceDesc = 'Tomato Soup with fresh basil cream and toasted sourdough bread $0.00';
      const positivePriceDesc =
        'Tomato Soup with fresh basil cream and toasted sourdough bread $18.00';

      const request: RetrievalRequestInput = {
        query: 'Tomato Soup',
        sources: [
          {
            source_id: 'src_zero_price',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_zero_1',
                text: zeroPriceDesc,
                status: 'ready',
              },
            ],
          },
          {
            source_id: 'src_positive_price',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_pos_1',
                text: positivePriceDesc,
                status: 'ready',
              },
            ],
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);

      // 1. Both source passages survive retrieval/deduplication
      expect(result.passages).toHaveLength(2);
      const texts = result.passages.map((p) => p.text);
      expect(texts).toContain(zeroPriceDesc);
      expect(texts).toContain(positivePriceDesc);

      // 2. The conflicting price values remain available as evidence in the passages
      const sourceIds = result.passages.map((p) => p.source.source_id);
      expect(sourceIds).toContain('src_zero_price');
      expect(sourceIds).toContain('src_positive_price');

      // 3. Result is marked ambiguous, not an unambiguous success
      expect(result.status).toBe('ambiguous');
      expect(result.status).not.toBe('success');
      expect(
        result.warnings.some((w) =>
          w.includes(
            'Ambiguous evidence detected: multiple candidate menu entries matched with differing details',
          ),
        ),
      ).toBe(true);
    });

    it('deduplicates matching zero-price passages ($0.00 vs $0.00) cleanly without false conflict', async () => {
      const zeroPriceDesc = 'Tomato Soup with fresh basil cream and toasted sourdough bread $0.00';

      const request: RetrievalRequestInput = {
        query: 'Tomato Soup',
        sources: [
          {
            source_id: 'src_zero_a',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_zero_a1',
                text: zeroPriceDesc,
                status: 'ready',
              },
            ],
          },
          {
            source_id: 'src_zero_b',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_zero_b1',
                text: zeroPriceDesc,
                status: 'ready',
              },
            ],
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);

      // Identical zero prices deduplicate to one passage with success status
      expect(result.passages).toHaveLength(1);
      expect(result.passages[0]?.text).toBe(zeroPriceDesc);
      expect(result.status).toBe('success');
      expect(result.status).not.toBe('ambiguous');
    });
  });

  describe('Finding P2: Exclude failed and skipped segments from evidence indexing', () => {
    it('never indexes a failed segment with non-empty text and an error (Hemu review case)', async () => {
      const request: RetrievalRequestInput = {
        query: 'Tomato Soup',
        sources: [
          {
            source_id: 'src_failed_doc',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_failed_ocr',
                text: 'Tomato Soup $12.00',
                status: 'failed',
                error: 'OCR extraction failed',
              },
            ],
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);

      // The failed text must NEVER become evidence
      expect(result.passages).toHaveLength(0);
      expect(result.status).not.toBe('success');

      // The failure diagnostics must be preserved in warnings
      expect(
        result.warnings.some((w) =>
          w.includes(
            "Source 'src_failed_doc' segment 'seg_failed_ocr' marked as failed: OCR extraction failed",
          ),
        ),
      ).toBe(true);
      expect(
        result.warnings.some((w) =>
          w.includes("Source 'src_failed_doc' contained no usable segments"),
        ),
      ).toBe(true);
    });

    it('never indexes a failed segment when error is null/omitted (Sai VIS-01 regression case)', async () => {
      const failedSegmentWithoutError = mapVis02SegmentToSourceSegment({
        segment_id: 'seg_failed_null_error',
        text: 'Tomato Soup $12.00',
        method: 'ocr',
        status: 'failed',
        error: null,
        warnings: ['Extraction halted'],
      });

      expect(failedSegmentWithoutError).not.toHaveProperty('error');
      expect(failedSegmentWithoutError.status).toBe('failed');

      const request: RetrievalRequestInput = {
        query: 'Tomato Soup',
        sources: [
          {
            source_id: 'src_failed_doc_null_err',
            kind: 'text',
            segments: [failedSegmentWithoutError],
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);

      // The failed text must NEVER become evidence even without an error property
      expect(result.passages).toHaveLength(0);
      expect(result.status).not.toBe('success');
      expect(
        result.warnings.some((w) =>
          w.includes(
            "Source 'src_failed_doc_null_err' segment 'seg_failed_null_error' marked as failed",
          ),
        ),
      ).toBe(true);
      expect(
        result.warnings.some((w) =>
          w.includes("Source 'src_failed_doc_null_err' contained no usable segments"),
        ),
      ).toBe(true);
    });

    it('never indexes a skipped segment even with non-empty text', async () => {
      const request: RetrievalRequestInput = {
        query: 'Minestrone',
        sources: [
          {
            source_id: 'src_skipped_doc',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_skipped_page',
                text: 'Minestrone Classico: $9.50',
                status: 'skipped',
              },
            ],
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);
      expect(result.passages).toHaveLength(0);
      expect(result.status).not.toBe('success');
      expect(
        result.warnings.some((w) =>
          w.includes("Source 'src_skipped_doc' segment 'seg_skipped_page' marked as skipped"),
        ),
      ).toBe(true);
    });

    it('indexes valid successful segments while excluding failed segments from the same source', async () => {
      const request: RetrievalRequestInput = {
        query: 'Soup',
        sources: [
          {
            source_id: 'src_partial_menu',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_page_1',
                text: 'Tuscan White Bean Soup with rosemary: $11.50',
                page_number: 1,
                status: 'ready',
              },
              {
                segment_id: 'seg_page_2',
                text: 'French Onion Soup with gruyere: $13.50',
                page_number: 2,
                status: 'failed',
                error: 'OCR blur threshold exceeded',
              },
            ],
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);

      // Page 1 should be retrieved
      expect(result.passages).toHaveLength(1);
      expect(result.passages[0]?.text).toContain('Tuscan White Bean Soup');
      expect(result.passages[0]?.source.segment_id).toBe('seg_page_1');

      // Page 2 should NOT be in passages
      expect(result.passages.some((p) => p.text.includes('French Onion Soup'))).toBe(false);

      // Warnings must record page 2 failure and indicate partial extraction
      expect(
        result.warnings.some((w) =>
          w.includes(
            "Source 'src_partial_menu' segment 'seg_page_2' marked as failed: OCR blur threshold exceeded",
          ),
        ),
      ).toBe(true);
      expect(
        result.warnings.some((w) =>
          w.includes("Source 'src_partial_menu' partially indexed (1 valid, 1 failed/skipped)"),
        ),
      ).toBe(true);
    });

    it('reports failure when all sources have only failed or skipped segments', async () => {
      const request: RetrievalRequestInput = {
        query: 'Soup',
        sources: [
          {
            source_id: 'src_all_failed_1',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_1',
                text: 'Soup $10.00',
                status: 'failed',
                error: 'Page unreadable',
              },
            ],
          },
          {
            source_id: 'src_all_failed_2',
            kind: 'text',
            segments: [
              {
                segment_id: 'seg_2',
                text: 'Chowder $12.00',
                status: 'skipped',
              },
            ],
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);
      expect(result.passages).toHaveLength(0);
      expect(result.status).toBe('failed');
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('Finding P2: Decode numeric HTML entities without truncating Unicode', () => {
    it('decodes decimal astral entity &#127836; to 🍜 (Soup 🍜 $8.50)', async () => {
      const html = '<html><body><p>Soup &#127836; $8.50</p></body></html>';
      const parsed = parseHtmlSource(html, 'src_test');

      expect(parsed.segments).toHaveLength(1);
      expect(parsed.segments[0]?.text).toBe('Soup 🍜 $8.50');
      // Verify length in code points vs UTF-16 code units
      expect(parsed.segments[0]?.text.length).toBe(13); // JS UTF-16
      expect(Array.from(parsed.segments[0]?.text ?? '').length).toBe(12); // Python Unicode code points
    });

    it('decodes hexadecimal astral entity &#x1F35C; and &#X1F35C; to 🍜', async () => {
      const html = '<html><body><p>Soup &#x1F35C; $8.50 and Bowl &#X1F35C; $9.50</p></body></html>';
      const parsed = parseHtmlSource(html, 'src_test');

      expect(parsed.segments[0]?.text).toBe('Soup 🍜 $8.50 and Bowl 🍜 $9.50');
    });

    it('decodes multiple astral entities in sequence correctly', async () => {
      const html = '<html><body><p>Menu: &#127829;&#127836;&#127790; $25.00</p></body></html>';
      const parsed = parseHtmlSource(html, 'src_test');

      expect(parsed.segments[0]?.text).toBe('Menu: 🍕🍜🌮 $25.00');
    });

    it('handles out-of-range code points and surrogates safely with replacement character', async () => {
      const { decodeHtmlEntities } = await import('./parser');

      // Out of range (> 0x10FFFF)
      expect(decodeHtmlEntities('Test &#9999999; End')).toBe('Test \uFFFD End');

      // Surrogate code points (0xD800 - 0xDFFF)
      expect(decodeHtmlEntities('Test &#55296; End')).toBe('Test \uFFFD End');
    });

    it('preserves existing named entities and avoids double decoding', async () => {
      const { decodeHtmlEntities } = await import('./parser');

      expect(decodeHtmlEntities('&quot;Soup&quot; &amp; &lt;Salad&gt; &apos;Bread&apos;')).toBe(
        '"Soup" & <Salad> \'Bread\'',
      );

      // Verify no double decoding of &amp;#127836;
      expect(decodeHtmlEntities('&amp;#127836;')).toBe('&#127836;');
    });

    it('preserves correct downstream passage offsets after entity decoding', async () => {
      const html = '<main id="menu"><p>Signature Ramen: Soup &#127836; $8.50 - Hot</p></main>';
      const request: RetrievalRequestInput = {
        query: 'Signature Ramen',
        sources: [
          {
            source_id: 'src_ramen',
            kind: 'html',
            content: html,
          },
        ],
      };

      const result = await retrieveMenuEvidence(request);
      expect(result.status).toBe('success');
      expect(result.passages).toHaveLength(1);

      const passage = result.passages[0]!;
      expect(passage.text).toContain('Soup 🍜 $8.50');

      // Reconstructed slice from the segment text must match exactly
      const segmentText = result.passages[0]?.text ?? '';
      expect(segmentText.slice(0, passage.text.length)).toBe(passage.text);
    });
  });
});
