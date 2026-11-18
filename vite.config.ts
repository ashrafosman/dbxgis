import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the build works under GitHub Pages (/dbxgis/) or any sub-path.
  base: './',
  server: { port: 5180 },
  // MapLibre v6 loads its worker relative to its own module URL; pre-bundling breaks that.
  optimizeDeps: { exclude: ['maplibre-gl'] },
});
