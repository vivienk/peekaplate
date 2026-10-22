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
const space = /^--pp-space-/;
const shadow = /^--pp-shadow-/;
const color = /^--pp-color-/;
const role = /^--pp-role-/;

describe('design tokens', () => {
  it('belong to an approved token group', async () => {
    const { base } = await tokenBlocks();
    expect(
      Object.keys(base).filter(
        (name) =>
          ![motion, typography, radius, space, shadow, color, role].some((g) => g.test(name)),
      ),
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

  it('match the Design System spacing scale', async () => {
    const { base } = await tokenBlocks();
    expect(group(base, space)).toEqual({
      '--pp-space-0': '0px',
      '--pp-space-2': '2px',
      '--pp-space-4': '4px',
      '--pp-space-6': '6px',
      '--pp-space-8': '8px',
      '--pp-space-12': '12px',
      '--pp-space-16': '16px',
      '--pp-space-20': '20px',
      '--pp-space-24': '24px',
      '--pp-space-28': '28px',
      '--pp-space-32': '32px',
      '--pp-space-40': '40px',
      '--pp-space-80': '80px',
    });
  });

  it('match the Design System shadows', async () => {
    const { base } = await tokenBlocks();
    expect(group(base, shadow)).toEqual({
      '--pp-shadow-small': '0 8px 12px rgba(34, 34, 34, 0.08)',
      '--pp-shadow-medium': '0 8px 12px rgba(34, 34, 34, 0.1)',
      '--pp-shadow-large': '0 8px 12px rgba(34, 34, 34, 0.14)',
    });
  });

  it('match the Design System color palette', async () => {
    const { base } = await tokenBlocks();
    expect(group(base, color)).toEqual({
      '--pp-color-white': '#ffffff',
      '--pp-color-black': '#000000',
      '--pp-color-orange-50': '#fffdf9',
      '--pp-color-orange-100': '#fff8ed',
      '--pp-color-orange-200': '#feeed6',
      '--pp-color-orange-300': '#fddaab',
      '--pp-color-orange-400': '#fbbf76',
      '--pp-color-orange-500': '#f89537',
      '--pp-color-orange-600': '#f67c19',
      '--pp-color-orange-700': '#e7610f',
      '--pp-color-orange-800': '#983a14',
      '--pp-color-orange-900': '#7a3214',
      '--pp-color-orange-950': '#421708',
      '--pp-color-neutral-50': '#fafafa',
      '--pp-color-neutral-100': '#f4f4f5',
      '--pp-color-neutral-200': '#e7e7e9',
      '--pp-color-neutral-300': '#d4d5d8',
      '--pp-color-neutral-400': '#a1a3aa',
      '--pp-color-neutral-500': '#71737a',
      '--pp-color-neutral-600': '#52555c',
      '--pp-color-neutral-700': '#3e414a',
      '--pp-color-neutral-800': '#2a2d36',
      '--pp-color-neutral-900': '#171921',
      '--pp-color-neutral-950': '#07080e',
      '--pp-color-info-50': '#f1f8fe',
      '--pp-color-info-100': '#e1f0fd',
      '--pp-color-info-200': '#bde2fa',
      '--pp-color-info-300': '#83cbf6',
      '--pp-color-info-400': '#41b0ef',
      '--pp-color-info-500': '#168acd',
      '--pp-color-info-600': '#0b77be',
      '--pp-color-info-700': '#0a5f9a',
      '--pp-color-info-800': '#0d517f',
      '--pp-color-info-900': '#10446a',
      '--pp-color-success-50': '#ecfdf5',
      '--pp-color-success-100': '#d1fae5',
      '--pp-color-success-200': '#a7f3d0',
      '--pp-color-success-300': '#6ee7b7',
      '--pp-color-success-400': '#34d399',
      '--pp-color-success-500': '#10b981',
      '--pp-color-success-600': '#059669',
      '--pp-color-success-700': '#047857',
      '--pp-color-success-800': '#065f46',
      '--pp-color-success-900': '#064e3b',
      '--pp-color-error-50': '#fef2f2',
      '--pp-color-error-100': '#fee2e2',
      '--pp-color-error-200': '#fecaca',
      '--pp-color-error-300': '#fca5a5',
      '--pp-color-error-400': '#f87171',
      '--pp-color-error-500': '#ef4444',
      '--pp-color-error-600': '#dc2626',
      '--pp-color-error-700': '#b91c1c',
      '--pp-color-error-800': '#991b1b',
      '--pp-color-error-900': '#7f1d1d',
      '--pp-color-gray-50': '#fafaf9',
      '--pp-color-gray-100': '#f5f5f4',
      '--pp-color-gray-200': '#e7e6e4',
      '--pp-color-gray-300': '#cdcbc7',
      '--pp-color-gray-400': '#a8a59e',
      '--pp-color-gray-500': '#78746c',
      '--pp-color-gray-600': '#57554e',
      '--pp-color-gray-700': '#44423c',
      '--pp-color-gray-800': '#292624',
      '--pp-color-gray-900': '#1c1a17',
      '--pp-color-gray-950': '#0c0b09',

      '--pp-color-warning-50': '#fff9e8',
      '--pp-color-warning-100': '#fdf0c5',
      '--pp-color-warning-200': '#f8e19a',
      '--pp-color-warning-300': '#f2ce69',
      '--pp-color-warning-400': '#e8b747',
      '--pp-color-warning-500': '#d99a32',
      '--pp-color-warning-600': '#b97c22',
      '--pp-color-warning-700': '#965f1a',
      '--pp-color-warning-800': '#744815',
      '--pp-color-warning-900': '#5b3813',
    });
  });

  it('map color roles to existing palette colors', async () => {
    const { base } = await tokenBlocks();
    const roles = group(base, role);
    expect(roles).toEqual({
      '--pp-role-action-bg': 'var(--pp-color-orange-500)',
      '--pp-role-action-text': 'var(--pp-color-orange-950)',
      '--pp-role-action-pressed-bg': 'var(--pp-color-orange-600)',
      '--pp-role-outline-bg': 'var(--pp-color-neutral-800)',
      '--pp-role-outline-text': 'var(--pp-color-neutral-50)',
      '--pp-role-outline-border': 'var(--pp-color-neutral-700)',
      '--pp-role-disabled-bg': 'var(--pp-color-neutral-600)',
      '--pp-role-disabled-text': 'var(--pp-color-neutral-400)',
      '--pp-role-focus-ring': 'var(--pp-color-info-400)',
      '--pp-role-text-on-dark': 'var(--pp-color-neutral-50)',
      '--pp-role-nav-bg': 'var(--pp-color-neutral-800)',
      '--pp-role-nav-icon': 'var(--pp-color-neutral-50)',
      '--pp-role-nav-hover-bg': 'var(--pp-color-orange-500)',
      '--pp-role-nav-pressed-bg': 'var(--pp-color-neutral-950)',
      '--pp-role-nav-disabled-bg': 'var(--pp-color-neutral-600)',
    });

    for (const value of Object.values(roles)) {
      const target = /var\((--pp-[\w-]+)\)/.exec(value)?.[1];
      expect(target && base[target]).toBeTruthy();
    }
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
      '--pp-font-size-paragraph-1': '1rem',
      '--pp-line-height-paragraph-1': '1.5rem',
      '--pp-font-size-paragraph-2': '0.875rem',
      '--pp-line-height-paragraph-2': '1.5rem',
      '--pp-font-size-small': '0.75rem',
      '--pp-line-height-small': '1rem',
      '--pp-font-size-footer': '0.625rem',
      '--pp-line-height-footer': '0.75rem',
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
