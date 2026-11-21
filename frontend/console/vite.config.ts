import process from 'node:process';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { PRODUCTION_OWNER_API_ORIGIN } from './src/owner/api-origin.ts';
import { OWNER_AUTH_PATH, OWNER_PAGE_PATHS, ownerPageForPath } from './src/owner/routes.ts';

// The synthetic demos (foundations, owner sign-in and the owner dashboard) are built only for PR
// previews (deploy-preview.yml sets PEEKAPLATE_PREVIEW_DEMOS), so reviewers can inspect synthetic
// states from the preview link. Normal builds include the separate provider-backed auth
// entry/callbacks instead; the provider stays off without public config. Not a VITE_ variable, so
// it never reaches client code.
const includeDemos = process.env.PEEKAPLATE_PREVIEW_DEMOS === 'true';
const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

function ownerRoutes(production: boolean): Plugin {
  return {
    name: 'owner-routes',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url) {
          const url = new URL(request.url, 'http://localhost');
          if (ownerPageForPath(url.pathname)) request.url = `${OWNER_AUTH_PATH}.html${url.search}`;
        }
        next();
      });
    },
    generateBundle() {
      if (!production) return;
      const redirects = [
        `/ ${OWNER_AUTH_PATH} 302`,
        ...Object.values(OWNER_PAGE_PATHS).map((path) => `${path} ${OWNER_AUTH_PATH} 200`),
      ];
      this.emitFile({ type: 'asset', fileName: '_redirects', source: `${redirects.join('\n')}\n` });
    },
  };
}

export default defineConfig(({ command, mode }) => ({
  define: {
    __OWNER_AI_LOCAL_PREVIEW__: JSON.stringify(
      command === 'serve' && process.env.OWNER_AI_LOCAL_PREVIEW === 'true',
    ),
    ...(includeDemos && { 'import.meta.env.VITE_OWNER_AUTH_ENABLED': JSON.stringify('false') }),
  },
  ...(command === 'serve' && process.env.OWNER_AI_LOCAL_PREVIEW === 'true'
    ? {
        server: {
          proxy: {
            '/__owner-ai': {
              target: 'http://127.0.0.1:8792',
              changeOrigin: true,
              rewrite: (path: string) => path.replace(/^\/__owner-ai/, ''),
            },
          },
        },
      }
    : {}),
  plugins: [
    react(),
    !includeDemos &&
      ownerRoutes(loadEnv(mode, page('.')).VITE_PUBLIC_API_URL === PRODUCTION_OWNER_API_ORIGIN),
  ],
  build: {
    rollupOptions: {
      input: {
        main: page('index.html'),
        ...(includeDemos
          ? {
              foundations: page('foundations.html'),
              ownerSignIn: page('owner-sign-in.html'),
              ownerOnboarding: page('owner-onboarding.html'),
              ownerMenuPreview: page('owner-menu-preview.html'),
              firstDashboard: page('first-dashboard.html'),
              ownerDashboard: page('owner-dashboard.html'),
              reviewDishes: page('review-dishes.html'),
            }
          : {
              ownerAuth: page('owner-auth.html'),
              authConfirm: page('auth-confirm.html'),
              authReset: page('auth-reset.html'),
            }),
      },
    },
  },
}));
