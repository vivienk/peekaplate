import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'portion-upload.spec.ts',
  workers: 1,
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
});
