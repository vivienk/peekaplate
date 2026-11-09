import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/review-preview',
  use: { browserName: 'chromium', viewport: { width: 390, height: 844 } },
});
