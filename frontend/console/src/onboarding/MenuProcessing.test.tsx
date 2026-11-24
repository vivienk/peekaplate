import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MenuProcessing } from './MenuProcessing';

describe('MenuProcessing Step 1 wording', () => {
  it('explains automatic completeness/confidence checks without claiming owner approval or publication', () => {
    const html = renderToStaticMarkup(
      <MenuProcessing state="processing" onCancel={vi.fn()} onTryAnother={vi.fn()} />,
    );
    expect(html).toMatch(/automatically checking/i);
    expect(html).toMatch(/completeness and confidence/i);
    expect(html).toMatch(/unverified draft for your review/i);
    expect(html).toMatch(/review and approve your dishes before they can be published/i);
    expect(html).not.toMatch(/auto-verif/i);
    expect(html).not.toMatch(/automatically approved/i);
  });

  it('renders no-dishes and failed states cleanly', () => {
    const noDishes = renderToStaticMarkup(
      <MenuProcessing state="no-dishes" onCancel={vi.fn()} onTryAnother={vi.fn()} />,
    );
    expect(noDishes).toContain('No dishes found');

    const failed = renderToStaticMarkup(
      <MenuProcessing
        state="failed"
        failureReason="Unable to read file content"
        onCancel={vi.fn()}
        onTryAnother={vi.fn()}
      />,
    );
    expect(failed).toContain('Extraction error — Unable to read file content');
  });
});
