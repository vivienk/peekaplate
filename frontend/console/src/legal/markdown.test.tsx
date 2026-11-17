import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LEGAL_DOCUMENTS } from './LegalDialog';
import { LegalBody, parseLegalMarkdown } from './markdown';

describe('parseLegalMarkdown', () => {
  it('takes the title from "#" and moves the other headings down a level', () => {
    const doc = parseLegalMarkdown('# Terms\n\n## Your account\n\n### If you are in California\n');
    expect(doc.title).toBe('Terms');
    expect(doc.blocks).toEqual([
      { kind: 'heading', level: 3, text: 'Your account' },
      { kind: 'heading', level: 4, text: 'If you are in California' },
    ]);
  });

  it('keeps line breaks in a paragraph and starts a list straight after it', () => {
    const doc = parseLegalMarkdown(
      '**Email:** a\n**Mail:** b\n\n**Things we need:**\n- one\n- two',
    );
    expect(doc.blocks).toEqual([
      { kind: 'paragraph', lines: ['**Email:** a', '**Mail:** b'] },
      { kind: 'paragraph', lines: ['**Things we need:**'] },
      {
        kind: 'list',
        items: [
          { text: 'one', children: [] },
          { text: 'two', children: [] },
        ],
      },
    ]);
  });

  it('nests indented list items under the item above', () => {
    const doc = parseLegalMarkdown('- **Honest limits:**\n  - backups\n  - diners\n- Closing');
    expect(doc.blocks).toEqual([
      {
        kind: 'list',
        items: [
          { text: '**Honest limits:**', children: ['backups', 'diners'] },
          { text: 'Closing', children: [] },
        ],
      },
    ]);
  });

  it('reads tables and rules', () => {
    const doc = parseLegalMarkdown(
      '---\n\n| What | How long |\n| --- | --- |\n| Backups | **1 year** |',
    );
    expect(doc.blocks).toEqual([
      { kind: 'rule' },
      { kind: 'table', head: ['What', 'How long'], rows: [['Backups', '**1 year**']] },
    ]);
  });
});

describe('LegalBody', () => {
  it('renders bold and italic as elements and never as raw HTML', () => {
    const doc = parseLegalMarkdown('*For owners* and **bold** <b>not markup</b>');
    const html = renderToStaticMarkup(<LegalBody blocks={doc.blocks} />);
    expect(html).toBe(
      '<p><em>For owners</em> and <strong>bold</strong> &lt;b&gt;not markup&lt;/b&gt;</p>',
    );
  });
});

describe('owner legal documents', () => {
  it('has no unfilled placeholders and gives the contact email', () => {
    for (const doc of Object.values(LEGAL_DOCUMENTS)) {
      const text = JSON.stringify(doc);
      expect(text).not.toMatch(/\[(contact email|mailing address)\]/);
      expect(text).toContain('hello@peekaplate.io');
    }
  });

  it('loads both documents with their titles and sections', () => {
    expect(LEGAL_DOCUMENTS.terms.title).toBe('Terms of Service');
    expect(LEGAL_DOCUMENTS.privacy.title).toBe('Privacy Policy');
    const headings = (id: 'terms' | 'privacy') =>
      LEGAL_DOCUMENTS[id].blocks.flatMap((block) => (block.kind === 'heading' ? [block.text] : []));
    expect(headings('terms')).toContain('The legal bits');
    expect(headings('privacy')).toContain('If you are a California resident');
    expect(LEGAL_DOCUMENTS.privacy.blocks.filter((block) => block.kind === 'table')).toHaveLength(
      2,
    );
  });
});
