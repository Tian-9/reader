/**
 * service worker 注册 + "有新版本"提示。
 * 用 prompt 模式而不是自动更新：自动接管会清掉旧缓存，正开着的页面再懒加载旧的 SDK 分包就 404 了。
 * 新版本装好后 needRefresh 变 true，App 顶上出一条横条，她点了才切到新版并刷新。
 */
import { registerSW } from 'virtual:pwa-register';

export const pwa = $state({ needRefresh: false });

let updateSW: ((reload?: boolean) => Promise<void>) | null = null;

export function initPwa(): void {
  if (!('serviceWorker' in navigator)) return;
  updateSW = registerSW({
    onNeedRefresh() {
      pwa.needRefresh = true;
    },
    onRegisterError(e) {
      console.error('service worker 注册失败', e);
    },
  });
}

export function applyUpdate(): void {
  void updateSW?.(true);
}
