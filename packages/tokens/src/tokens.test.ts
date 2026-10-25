import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

function declarations(block: string) {
  return Object.fromEntries(
    [...block.matchAll(/(--pp-[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value]),
  );
}

async function tokenBlocks() {
  const css = (await read('./tokens.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  const reducedStart = css.indexOf('@media (prefers-reduced-motion: reduce)');
  expect(reducedStart).toBeGreaterThan(0);
  return {
    base: declarations(css.slice(0, reducedStart)),
    reduced: declarations(css.slice(reducedStart)),
  };
}

const group = (tokens: Record<string, string>, pattern: RegExp) =>
  Object.fromEntries(Object.entries(tokens).filter(([name]) => pattern.test(name)));

const motion = /^--pp-motion-/;
const typography = /^--pp-(font|line-height)-/;
const radius = /^--pp-radius-/;

describe('design tokens', () => {
  it('belong to an approved token group', async () => {
    const { base } = await tokenBlocks();
    expect(
      Object.keys(base).filter((name) => ![motion, typography, radius].some((g) => g.test(name))),
    ).toEqual([]);
  });

  it('match the Design System corner radius scale', async () => {
    const { base } = await tokenBlocks();
    expect(group(base, radius)).toEqual({
      '--pp-radius-4': '4px',
      '--pp-radius-6': '6px',
      '--pp-radius-8': '8px',
      '--pp-radius-10': '10px',
      '--pp-radius-12': '12px',
      '--pp-radius-16': '16px',
      '--pp-radius-20': '20px',
      '--pp-radius-24': '24px',
      '--pp-radius-full': '999px',
    });
  });

  it('match the Design System text styles', async () => {
    const { base } = await tokenBlocks();
    expect(group(base, typography)).toEqual({
      '--pp-font-family-base': '"Inter", system-ui, sans-serif',
      '--pp-font-weight-regular': '400',
      '--pp-font-weight-medium': '500',
      '--pp-font-weight-semibold': '600',
      '--pp-font-weight-bold': '700',
      '--pp-font-size-h1': '3rem',
      '--pp-line-height-h1': '3.5rem',
      '--pp-font-size-h2': '2.25rem',
      '--pp-line-height-h2': '3rem',
      '--pp-font-size-h3': '1.5rem',
      '--pp-line-height-h3': '2rem',
      '--pp-font-size-h4': '1.25rem',
      '--pp-line-height-h4': '2rem',
      '--pp-font-size-h5': '1.125rem',
      '--pp-line-height-h5': '1.75rem',
      '--pp-line-height-h5-bold': '1.5rem',
      '--pp-font-size-paragraph-1': '1rem',
      '--pp-line-height-paragraph-1': '1.5rem',
      '--pp-font-size-paragraph-2': '0.875rem',
      '--pp-line-height-paragraph-2': '1.375rem',
      '--pp-font-size-small': '0.75rem',
      '--pp-line-height-small': '1rem',
      '--pp-font-size-footer': '0.625rem',
      '--pp-line-height-footer': '0.875rem',
    });
  });

  it('match the Animation specification', async () => {
    const { base } = await tokenBlocks();
    expect(group(base, motion)).toEqual({
      '--pp-motion-ease-standard': 'ease',
      '--pp-motion-ease-out': 'ease-out',
      '--pp-motion-ease-linear': 'linear',
      '--pp-motion-duration-press': '150ms',
      '--pp-motion-duration-category-exit': '180ms',
      '--pp-motion-duration-chip': '200ms',
      '--pp-motion-duration-item': '240ms',
      '--pp-motion-duration-picker-item': '260ms',
      '--pp-motion-duration-hover': '300ms',
      '--pp-motion-duration-reveal': '420ms',
      '--pp-motion-duration-shared': '440ms',
      '--pp-motion-duration-tilt': '450ms',
      '--pp-motion-duration-screen-exit': '200ms',
      '--pp-motion-duration-screen-enter': '300ms',
      '--pp-motion-duration-scroll-smoothing': '80ms',
      '--pp-motion-delay-screen-enter': '80ms',
      '--pp-motion-delay-detail-start': '120ms',
      '--pp-motion-stagger-detail': '50ms',
      '--pp-motion-stagger-item': '50ms',
      '--pp-motion-stagger-picker': '45ms',
      '--pp-motion-distance-exit': '8px',
      '--pp-motion-distance-enter': '12px',
      '--pp-motion-scale-press': '0.96',
      '--pp-motion-scale-hover': '1.03',
      '--pp-motion-scale-scroll-min': '0.78',
      '--pp-motion-opacity-scroll-min': '0.55',
      '--pp-motion-tilt-step': '4deg',
    });
  });

  it('remove waiting and shorten every timing under reduced motion', async () => {
    const { base, reduced } = await tokenBlocks();
    const timings = Object.keys(base).filter((name) =>
      /^--pp-motion-(duration|delay|stagger)-/.test(name),
    );
    expect(Object.keys(reduced).sort()).toEqual(timings.sort());
    for (const name of timings) {
      const expected = /-(delay|stagger)-/.test(name)
        ? '0ms'
        : name === '--pp-motion-duration-screen-enter'
          ? '150ms'
          : '1ms';
      expect([name, reduced[name]]).toEqual([name, expected]);
    }
  });

  it('are the shared source for both apps', async () => {
    for (const app of ['diner', 'console']) {
      const style = await read(`../../../frontend/${app}/src/style.css`);
      expect(style.startsWith('@import "@peekaplate/tokens/tokens.css";\n')).toBe(true);
      expect(style).not.toMatch(/--pp-motion-[\w-]+\s*:/);
    }
  });
});
