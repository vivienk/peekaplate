import process from 'node:process';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The synthetic foundations and owner sign-in demos are built only for PR previews (deploy-preview.yml sets
// PEEKAPLATE_PREVIEW_DEMOS), so reviewers can inspect synthetic states. Normal builds include the
// separate provider-backed auth entry/callbacks; the provider stays off without public config.
const includeDemos = process.env.PEEKAPLATE_PREVIEW_DEMOS === 'true';
const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  plugins: [react()],
  ...(includeDemos && {
    define: { 'import.meta.env.VITE_OWNER_AUTH_ENABLED': JSON.stringify('false') },
  }),
  build: {
    rollupOptions: {
      input: {
        main: page('index.html'),
        ...(includeDemos
          ? {
              foundations: page('foundations.html'),
              ownerSignIn: page('owner-sign-in.html'),
            }
          : {
              ownerAuth: page('owner-auth.html'),
              authConfirm: page('auth-confirm.html'),
            }),
      },
    },
  },
});
