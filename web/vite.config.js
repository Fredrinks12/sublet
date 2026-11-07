import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths, so the site works from any host or sub-folder.
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
