import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['portion-quest.spec.ts', 'portion-landscape.spec.ts'],
  timeout: 45000,
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
});
