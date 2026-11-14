import process from 'node:process';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The synthetic demos (foundations and the owner dashboard) are built only for PR previews
// (deploy-preview.yml sets PEEKAPLATE_PREVIEW_DEMOS), so reviewers can open them from the preview link. Staging and
// production builds never set it and contain only the console. Not a VITE_ variable, so it never
// reaches client code.
const includeDemos = process.env.PEEKAPLATE_PREVIEW_DEMOS === 'true';
const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  plugins: [react()],
  ...(includeDemos && {
    build: {
      rollupOptions: {
        input: {
          main: page('index.html'),
          foundations: page('foundations.html'),
          firstDashboard: page('first-dashboard.html'),
          ownerDashboard: page('owner-dashboard.html'),
        },
      },
    },
  }),
});
