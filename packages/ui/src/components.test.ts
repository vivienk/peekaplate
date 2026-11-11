import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('shared component styles', () => {
  it('disables button press transform under reduced motion', () => {
    const css = readFileSync(join(here, 'components.css'), 'utf8');
    expect(css).toMatch(
      /prefers-reduced-motion:\s*reduce[\s\S]*?\.pp-button:active:not\(:disabled\)\s*\{[^}]*transform:\s*none;/,
    );
  });
});
