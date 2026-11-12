import { defineConfig } from 'vite';
import { dinerBudget } from '../../scripts/check-bundle.mjs';
import { localModelPlugin } from '../../scripts/local-model-proxy.mjs';

export default defineConfig({
  plugins: [dinerBudget(), localModelPlugin()],
  optimizeDeps: { include: ['three', 'three/addons/loaders/GLTFLoader.js'] },
  build: { manifest: true },
});
