import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

const sha = (process.env.GITHUB_SHA ?? '').slice(0, 7);
const built = new Date().toISOString().slice(0, 16).replace('T', ' ');

/**
 * GitHub Pages 的子路径（仓库名 reader → https://<用户>.github.io/reader/）。
 * 换仓库名要同时改这里；manifest 的 scope / start_url 跟着 BASE 走。
 */
export const BASE = '/reader/';

/**
 * CSP（PLAN 2.7 / 第 4 节版权红线）。GitHub Pages 不支持自定义响应头（Cloudflare 的 _headers 不认），只能写成 <meta>。
 * connect-src 只放 Anthropic：书的内容物理上只能发去 api.anthropic.com，发不到任何别的第三方。
 * 只在 build 时注入：dev 下 vite 的热更新要连 ws://，被 CSP 拦了开发服务器就废了。
 * meta 版 CSP 不支持 frame-ancestors / report-uri，这两样本来也没用。
 */
export const CSP = [
  "default-src 'self'",
  "connect-src 'self' https://api.anthropic.com",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
].join('; ');

function cspMeta(): Plugin {
  return {
    name: 'reader-csp-meta',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
  };
}

export default defineConfig({
  base: BASE,
  define: { __BUILD__: JSON.stringify(`${sha ? sha + ' · ' : ''}${built} UTC`) },
  plugins: [
    cspMeta(),
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
        id: BASE,
        start_url: BASE,
        scope: BASE,
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
        // 相对 sw.js 所在目录解析 = /reader/index.html（预缓存清单里也是相对路径）
        navigateFallback: 'index.html',
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
