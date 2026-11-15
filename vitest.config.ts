import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'backend/src/**/*.test.ts',
      'backend/*.test.mjs',
      'packages/*/src/**/*.test.ts',
      'frontend/diner/src/**/*.test.ts',
      'frontend/console/src/**/*.test.ts',
      'frontend/console/src/**/*.test.tsx',
      'frontend/diner/src/**/*.test.ts',
      'tests/data06/**/*.test.ts',
    ],
  },
});
