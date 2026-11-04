import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

const built = new Date().toISOString().slice(0, 16).replace('T', ' ');

export default defineConfig({
  define: { __BUILD__: JSON.stringify(`${built} UTC`) },
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'prompt',
      // 注册在 src/pwa.svelte.ts 里自己做（要显示"有新版本"横条），插件不注入注册脚本
      injectRegister: false,
      manifest: {
        name: '英语阅读器',
        short_name: '阅读器',
        description: '边读英文小说边看中文小注',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f7f3ea',
        theme_color: '#f7f3ea',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 只缓存应用外壳。书在 IndexedDB 里，不走 service worker；epub 不在白名单里，也绝不该出现在 dist/
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
