import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['backend/src/**/*.integration.ts', 'backend/src/owner-report.test.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 45_000,
  },
});
