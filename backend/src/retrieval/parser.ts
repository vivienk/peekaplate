export type ExtractedSegment = {
  segment_id: string;
  text: string;
  page_number?: number | undefined;
  method: 'html' | 'text' | 'pdf_native' | 'ocr';
  is_menu_scope?: boolean | undefined;
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
    segments,
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

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number.parseInt(dec, 10)));
}
