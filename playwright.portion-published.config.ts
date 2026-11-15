import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'portion-published.spec.ts',
  outputDir: './outputs/duplication-wiring-evidence/portion-published-results',
  workers: 2,
  timeout: 45_000,
  use: { trace: 'retain-on-failure', baseURL: 'http://127.0.0.1:5191' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command:
      'pnpm --filter @peekaplate/diner exec vite build --outDir ../../outputs/duplication-wiring-evidence/dist/portion-published && pnpm --filter @peekaplate/diner exec vite preview --outDir ../../outputs/duplication-wiring-evidence/dist/portion-published --host 127.0.0.1 --port 5191 --strictPort',
    env: {
      PEEKAPLATE_PREVIEW_DEMOS: 'false',
      VITE_MENU_SOURCE: 'live',
      VITE_PUBLIC_API_URL: 'https://api.example.test',
    },
    url: 'http://127.0.0.1:5191',
    reuseExistingServer: false,
  },
});
