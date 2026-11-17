export type ExtractedSegment = {
  segment_id: string;
  text: string;
  page_number?: number | undefined;
  method: 'html' | 'text' | 'pdf_native' | 'ocr' | 'ocr_space_engine3';
  is_menu_scope?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
  provenance?:
    | {
        source_sha256?: string | undefined;
        original_url?: string | undefined;
        final_url?: string | undefined;
        retrieved_at?: string | undefined;
      }
    | undefined;
};

export type ParseSourceResult = {
  segments: ExtractedSegment[];
  discoveredLinks: string[];
  hasStructuredMenu: boolean;
  warnings: string[];
};

/**
 * Parses raw HTML into clean text segments while preserving segment offsets,
 * extracting potential menu links, and identifying schema.org structured menu items.
 */
export function parseHtmlSource(
  htmlContent: string,
  sourceId: string,
  baseUrl?: string,
): ParseSourceResult {
  const warnings: string[] = [];
  const discoveredLinks: string[] = [];
  let hasStructuredMenu = false;
  const structuredMenuSegments: ExtractedSegment[] = [];
  const seenStructuredItems = new Set<string>();

  // 1. Extract JSON-LD scripts before stripping tags
  const jsonLdRegex =
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = jsonLdRegex.exec(htmlContent)) !== null) {
    const rawJson = match[1];
    if (!rawJson) continue;
    try {
      const parsed = JSON.parse(rawJson);
      if (hasMenuItemEntity(parsed)) {
        hasStructuredMenu = true;
        // Emit only source-grounded MenuItem fields. Detecting JSON-LD alone
        // formerly dropped the dish facts when script tags were stripped.
        for (const item of extractStructuredMenuItems(parsed)) {
          const key = JSON.stringify(item);
          if (seenStructuredItems.has(key)) continue;
          seenStructuredItems.add(key);
          const fields = [item.name, item.description, item.price_text].filter(Boolean);
          structuredMenuSegments.push({
            segment_id: `${sourceId}#jsonld-${structuredMenuSegments.length + 1}`,
            text: fields.join(' — '),
            method: 'html',
            is_menu_scope: true,
            metadata: {
              schema_type: 'MenuItem',
              name: item.name,
              ...(item.description ? { description: item.description } : {}),
              ...(item.price_text ? { price_text: item.price_text } : {}),
              ...(item.price_currency ? { price_currency: item.price_currency } : {}),
            },
          });
        }
      }
    } catch {
      // Ignore invalid JSON-LD scripts
    }
  }

  // 2. Discover potential menu links
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = anchorRegex.exec(htmlContent)) !== null) {
    const rawHref = match[1];
    const rawLinkText = match[2];
    if (!rawHref || !rawLinkText) continue;
    const href = rawHref.trim();
    const linkText = rawLinkText.toLowerCase();
    if (
      (href.toLowerCase().includes('menu') ||
        linkText.includes('menu') ||
        /\.(pdf|png|jpg|jpeg|webp)$/i.test(href)) &&
      !href.startsWith('#') &&
      !href.startsWith('javascript:')
    ) {
      try {
        const resolved = baseUrl ? new URL(href, baseUrl).toString() : href;
        if (!discoveredLinks.includes(resolved) && discoveredLinks.length < 5) {
          discoveredLinks.push(resolved);
        }
      } catch {
        // Skip invalid URL strings
      }
    }
  }

  // 3. Remove non-content elements (<script>, <style>, <nav>, <footer>, <header>, etc.)
  let cleaned = htmlContent
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]*aria-hidden=["']true["'][^>]*>[\s\S]*?<\/[^>]+>/gi, '')
    .replace(
      /<[^>]*style=["'][^"']*(?:display:\s*none|visibility:\s*hidden)[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi,
      '',
    );

  // Convert block element endings to newlines
  cleaned = cleaned
    .replace(/<\/(p|div|section|article|li|tr|h1|h2|h3|h4|h5|h6)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');

  // Strip remaining HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');

  // Decode standard HTML entities
  cleaned = decodeHtmlEntities(cleaned);

  // 4. Split into segments by paragraph breaks
  const rawSections = cleaned
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const segments: ExtractedSegment[] = [];
  let segIndex = 1;

  for (const section of rawSections) {
    // Avoid returning tiny navigation boilerplate
    if (section.length < 5) continue;

    // Check if section appears to be in a menu scope
    const isMenuScope = /menu|appetizer|entree|main|dessert|beverage|dish|price|\$\s*\d+/i.test(
      section,
    );

    segments.push({
      segment_id: `${sourceId}#seg-${segIndex++}`,
      text: section,
      method: 'html',
      is_menu_scope: isMenuScope,
    });
  }

  if (segments.length === 0 && cleaned.trim().length > 0) {
    segments.push({
      segment_id: `${sourceId}#seg-1`,
      text: cleaned.trim(),
      method: 'html',
    });
  }

  return {
    segments: [...structuredMenuSegments, ...segments],
    discoveredLinks,
    hasStructuredMenu,
    warnings,
  };
}

/**
 * Parses plain text or pre-extracted OCR text into segments.
 */
export function parsePlainTextSource(
  text: string,
  sourceId: string,
  method: 'text' | 'pdf_native' | 'ocr' = 'text',
): ParseSourceResult {
  const sections = text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const segments: ExtractedSegment[] = [];
  let segIndex = 1;

  for (const sec of sections) {
    segments.push({
      segment_id: `${sourceId}#seg-${segIndex++}`,
      text: sec,
      method,
    });
  }

  if (segments.length === 0 && text.trim().length > 0) {
    segments.push({
      segment_id: `${sourceId}#seg-1`,
      text: text.trim(),
      method,
    });
  }

  return {
    segments,
    discoveredLinks: [],
    hasStructuredMenu: false,
    warnings: [],
  };
}

type StructuredMenuItem = {
  name: string;
  description?: string;
  price_text?: string;
  price_currency?: string;
};

/**
 * Traverse Schema.org Menu / MenuSection / MenuItem / @graph trees. Only
 * MenuItem nodes with a source-provided name can become evidence. Do not
 * infer currency or invent item names from generic Product/Restaurant nodes.
 */
export function extractStructuredMenuItems(root: unknown): StructuredMenuItem[] {
  const items: StructuredMenuItem[] = [];
  const seen = new Set<unknown>();
  function walk(value: unknown, depth: number): void {
    if (depth > 16 || items.length >= 150 || !value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) walk(child, depth + 1);
      return;
    }
    const obj = value as Record<string, unknown>;
    const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
    if (types.includes('MenuItem')) {
      const name = typeof obj.name === 'string' ? obj.name.trim().slice(0, 200) : '';
      if (name) {
        const description =
          typeof obj.description === 'string' ? obj.description.trim().slice(0, 2000) : '';
        const offer = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
        const offerObject =
          offer && typeof offer === 'object' ? (offer as Record<string, unknown>) : undefined;
        const rawPrice = offerObject?.price;
        const price =
          typeof rawPrice === 'string' || typeof rawPrice === 'number'
            ? String(rawPrice).trim()
            : '';
        const currency = offerObject?.priceCurrency;
        const validPrice = /^\d{1,7}(?:\.\d{1,2})?$/.test(price);
        const validCurrency = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency);
        items.push({
          name,
          ...(description ? { description } : {}),
          ...(validPrice ? { price_text: price } : {}),
          ...(validCurrency ? { price_currency: currency } : {}),
        });
      }
    }
    for (const child of Object.values(obj)) walk(child, depth + 1);
  }
  walk(root, 0);
  return items;
}

function hasMenuItemEntity(value: unknown, depth = 0): boolean {
  if (depth > 15 || !value) return false;
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.some((item) => hasMenuItemEntity(item, depth + 1));
    }
    const obj = value as Record<string, unknown>;
    const type = obj['@type'];
    if (
      type === 'MenuItem' ||
      (Array.isArray(type) && type.includes('MenuItem')) ||
      type === 'Menu'
    ) {
      return true;
    }
    return Object.values(obj).some((v) => hasMenuItemEntity(v, depth + 1));
  }
  return false;
}

export function decodeCodePoint(cp: number): string {
  if (!Number.isSafeInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return '\uFFFD';
  }
  return String.fromCodePoint(cp);
}

export function decodeHtmlEntities(str: string): string {
  return str.replace(
    /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z]+));/g,
    (match, hex, dec, named) => {
      if (hex !== undefined) {
        const cp = Number.parseInt(hex, 16);
        return decodeCodePoint(cp);
      }
      if (dec !== undefined) {
        const cp = Number.parseInt(dec, 10);
        return decodeCodePoint(cp);
      }
      if (named !== undefined) {
        switch (named.toLowerCase()) {
          case 'amp':
            return '&';
          case 'lt':
            return '<';
          case 'gt':
            return '>';
          case 'quot':
            return '"';
          case 'apos':
            return "'";
          case 'nbsp':
            return ' ';
          default:
            return match;
        }
      }
      return match;
    },
  );
}
