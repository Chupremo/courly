import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: resolve(projectRoot, 'public'),
  build: {
    outDir: resolve(projectRoot, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: resolve(projectRoot, 'public/index.html'),
        features: resolve(projectRoot, 'public/features.html'),
        pricing: resolve(projectRoot, 'public/pricing.html'),
        clubs: resolve(projectRoot, 'public/clubs.html'),
        courts: resolve(projectRoot, 'public/courts.html'),
        ownerPortal: resolve(projectRoot, 'public/owner-portal.html')
      }
    }
  }
});
