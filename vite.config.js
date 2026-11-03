import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: resolve(process.cwd(), 'index.html'),
        players: resolve(process.cwd(), 'players.html'),
        business: resolve(process.cwd(), 'business.html'),
        features: resolve(process.cwd(), 'features.html'),
        pricing: resolve(process.cwd(), 'pricing.html'),
        clubs: resolve(process.cwd(), 'clubs.html'),
        courts: resolve(process.cwd(), 'courts.html'),
        ownerPortal: resolve(process.cwd(), 'owner-portal.html'),
        venue: resolve(process.cwd(), 'venue.html')
      }
    }
  }
});
