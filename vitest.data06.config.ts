import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/data06/**/*.test.ts'],
  },
});
