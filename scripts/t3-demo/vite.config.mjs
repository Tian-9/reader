// T3 本地 demo（不进 dist）：npx vite --config scripts/t3-demo/vite.config.mjs
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [svelte()],
  server: { port: 5287, strictPort: true, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
  define: { __BUILD__: '"demo"' },
});
