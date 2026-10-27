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
      '--pp-radius-0': '0px',
      '--pp-radius-2': '2px',
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
      '--pp-space-48': '48px',
      '--pp-space-80': '80px',
    });
  });

  it('match the Design System shadows', async () => {
    const { base } = await tokenBlocks();
    expect(group(base, shadow)).toEqual({
      '--pp-shadow-small': '0 8px 12px rgba(34, 34, 34, 0.08)',
      '--pp-shadow-medium': '0 8px 12px rgba(34, 34, 34, 0.1)',
      '--pp-shadow-large': '0 8px 12px rgba(34, 34, 34, 0.14)',
      '--pp-shadow-chip': '0 1px 2px rgba(0, 0, 0, 0.12)',
      '--pp-shadow-elevation-1': '0 1px 2px rgba(0, 0, 0, 0.12)',
      '--pp-shadow-elevation-2': '0 8px 24px rgba(0, 0, 0, 0.32)',
      '--pp-shadow-elevation-3': '0 16px 48px rgba(0, 0, 0, 0.4)',
      '--pp-shadow-dish': '0 14px 36px rgba(0, 0, 0, 0.45)',
      '--pp-shadow-dish-contact': '0 14px 36px rgba(0, 0, 0, 0.45)',
      '--pp-shadow-qr-bg': '0 0 36px rgba(0, 0, 0, 0.35)',
      '--pp-shadow-bottom-sheet': '0 0 36px rgba(0, 0, 0, 0.45)',
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
      '--pp-color-neutral-700': '#2d3038',
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
      '--pp-role-button-action-bg': 'var(--pp-color-orange-500)',
      '--pp-role-button-action-text': 'var(--pp-color-orange-950)',
      '--pp-role-button-action-pressed-bg': 'var(--pp-color-orange-600)',
      '--pp-role-button-outline-bg': 'var(--pp-color-neutral-800)',
      '--pp-role-button-outline-text': 'var(--pp-color-neutral-50)',
      '--pp-role-button-outline-border': 'var(--pp-color-neutral-700)',
      '--pp-role-button-disabled-bg': 'var(--pp-color-neutral-600)',
      '--pp-role-button-disabled-text': 'var(--pp-color-neutral-400)',
      '--pp-role-focus-ring': 'var(--pp-color-info-400)',
      '--pp-role-text-on-dark': 'var(--pp-color-neutral-50)',
      '--pp-role-nav-bg': 'var(--pp-color-neutral-800)',
      '--pp-role-nav-icon': 'var(--pp-color-neutral-50)',
      '--pp-role-nav-hover-bg': 'var(--pp-color-orange-500)',
      '--pp-role-nav-hover-icon': 'var(--pp-color-orange-950)',
      '--pp-role-nav-pressed-bg': 'var(--pp-color-neutral-950)',
      '--pp-role-nav-disabled-bg': 'var(--pp-color-neutral-600)',

      '--pp-role-primary': 'var(--pp-color-orange-500)',
      '--pp-role-on-primary': 'var(--pp-color-orange-950)',
      '--pp-role-primary-container': 'var(--pp-color-orange-800)',
      '--pp-role-on-primary-container': 'var(--pp-color-orange-100)',
      '--pp-role-surface': 'var(--pp-color-neutral-800)',
      '--pp-role-surface-container': 'var(--pp-color-neutral-700)',
      '--pp-role-on-surface': 'var(--pp-color-neutral-50)',
      '--pp-role-on-surface-variant': 'var(--pp-color-gray-400)',
      '--pp-role-outline': 'color-mix(in srgb, var(--pp-color-neutral-500) 30%, transparent)',
      '--pp-role-outline-solid': 'var(--pp-color-neutral-500)',
      '--pp-role-outline-variant': 'var(--pp-color-neutral-700)',
      '--pp-role-text-secondary': 'var(--pp-color-neutral-200)',
      '--pp-role-error': 'var(--pp-color-error-400)',
      '--pp-role-on-error': 'var(--pp-color-neutral-950)',
      '--pp-role-error-container': 'var(--pp-color-error-800)',
      '--pp-role-on-error-container': 'var(--pp-color-error-100)',
      '--pp-role-success': 'var(--pp-color-success-400)',
      '--pp-role-on-success': 'var(--pp-color-success-900)',
      '--pp-role-success-container': 'var(--pp-color-success-800)',
      '--pp-role-on-success-container': 'var(--pp-color-success-100)',
      '--pp-role-warning': 'var(--pp-color-warning-400)',
      '--pp-role-on-warning': 'var(--pp-color-warning-900)',
      '--pp-role-warning-container': 'var(--pp-color-warning-800)',
      '--pp-role-on-warning-container': 'var(--pp-color-warning-100)',
      '--pp-role-information': 'var(--pp-color-info-400)',
      '--pp-role-on-information': 'var(--pp-color-neutral-950)',
      '--pp-role-information-container': 'var(--pp-color-info-800)',
      '--pp-role-on-information-container': 'var(--pp-color-info-100)',
      '--pp-role-button-text-hover-bg':
        'color-mix(in srgb, var(--pp-color-orange-800) 50%, transparent)',
      '--pp-role-button-disabled-border': 'var(--pp-color-neutral-600)',
      '--pp-role-button-outline-pressed-bg': 'var(--pp-color-neutral-600)',
      '--pp-role-nav-icon-disabled': 'var(--pp-color-neutral-400)',

      '--pp-role-chip-active-bg': 'var(--pp-color-neutral-50)',
      '--pp-role-chip-active-text': 'var(--pp-color-neutral-800)',
      '--pp-role-chip-inactive-text': 'var(--pp-color-neutral-50)',
      '--pp-role-chip-inactive-border': 'var(--pp-role-outline)',

      '--pp-role-input-bg': 'var(--pp-color-neutral-800)',
      '--pp-role-input-text': 'var(--pp-color-neutral-50)',
      '--pp-role-input-placeholder': 'var(--pp-color-neutral-400)',
      '--pp-role-input-border': 'var(--pp-color-neutral-400)',
      '--pp-role-input-border-focus': 'var(--pp-color-info-400)',
      '--pp-role-input-border-error': 'var(--pp-color-error-400)',
      '--pp-role-input-text-error': 'var(--pp-color-error-400)',
      '--pp-role-input-bg-disabled': 'var(--pp-color-neutral-600)',
      '--pp-role-input-text-disabled': 'var(--pp-color-neutral-400)',
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

  it('has no duplicate token names', async () => {
    const css = (await read('./tokens.css')).replace(/\/\*[\s\S]*?\*\//g, '');
    const reducedStart = css.indexOf('@media (prefers-reduced-motion: reduce)');
    const baseCss = css.slice(0, reducedStart);
    const names = [...baseCss.matchAll(/(--pp-[\w-]+)\s*:/g)].map(([, name]) => name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('maps color roles only to palette colors', async () => {
    const { base } = await tokenBlocks();
    const roles = group(base, role);
    for (const [name, value] of Object.entries(roles)) {
      const refs = [...value.matchAll(/var\((--pp-[\w-]+)\)/g)].map(([, ref]) => ref);
      expect(refs.length).toBeGreaterThan(0);
      const resolvedRefs = refs.flatMap((ref) => {
        if (ref.startsWith('--pp-role-')) {
          const nested = base[ref];
          return nested
            ? [...nested.matchAll(/var\((--pp-[\w-]+)\)/g)].map(([, nestedRef]) => nestedRef)
            : [];
        }
        return [ref];
      });
      expect(resolvedRefs.length).toBeGreaterThan(0);
      for (const ref of resolvedRefs) {
        expect(ref).toMatch(/^--pp-color-/);
      }
    }
  });

  it('keeps active foreground/background pairs at WCAG AA contrast', async () => {
    const { base } = await tokenBlocks();
    const hexOf = (name: string): string => {
      let value = base[name];
      for (let i = 0; i < 5 && value; i++) {
        const next = /^var\((--pp-[\w-]+)\)$/.exec(value.trim())?.[1];
        if (!next) break;
        value = base[next];
      }
      if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} is not a solid color`);
      return value;
    };
    const luminance = (hex: string) => {
      const channel = (i: number) => {
        const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    };
    const ratio = ([fg, bg]: string[]) => {
      const a = luminance(hexOf(fg as string));
      const b = luminance(hexOf(bg as string));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const r = (name: string) => `--pp-role-${name}`;

    // Disabled pairs are left out because WCAG exempts inactive components.
    const textPairs = [
      ...['primary', 'error', 'success', 'warning', 'information'].flatMap((n) => [
        [r(`on-${n}`), r(n)],
        [r(`on-${n}-container`), r(`${n}-container`)],
      ]),
      [r('button-action-text'), r('button-action-bg')],
      [r('button-action-text'), r('button-action-pressed-bg')],
      [r('button-outline-text'), r('button-outline-bg')],
      [r('nav-icon'), r('nav-bg')],
      [r('nav-hover-icon'), r('nav-hover-bg')],
[r('chip-active-text'), r('chip-active-bg')],
      [r('on-surface'), r('surface')],
      [r('on-surface'), r('surface-container')],
      [r('on-surface-variant'), r('surface')],
      [r('on-surface-variant'), r('surface-container')],
      [r('input-text'), r('input-bg')],
    ];
    for (const pair of textPairs) {
      expect(ratio(pair), pair.join(' on ')).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio([r('focus-ring'), r('surface')]), 'focus-ring on surface').toBeGreaterThanOrEqual(
      3,
    );
  });

  it('are the shared source for both apps', async () => {
    for (const app of ['diner', 'console']) {
      const style = await read(`../../../frontend/${app}/src/style.css`);
      expect(style.startsWith('@import "@peekaplate/tokens/tokens.css";\n')).toBe(true);
      expect(style).not.toMatch(/--pp-[\w-]+\s*:/);
    }
  });
});
