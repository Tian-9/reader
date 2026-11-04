/**
 * 持久存储（PLAN 2.5 兜底）：启动时向浏览器申请 navigator.storage.persist()，
 * 意思是"空间紧张时别自动清掉这个网站的数据"。批不批由浏览器定（安卓 Chrome 一般要加到主屏幕、常用才批）。
 * 结果显示在设置页。
 */
export const storage: { persisted: boolean | null; supported: boolean } = $state({ persisted: null, supported: true });

export async function requestPersist(): Promise<void> {
  const s = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!s?.persist) {
    storage.supported = false;
    return;
  }
  try {
    // 已经批过的不再申请（persist() 在某些浏览器会弹提示）
    storage.persisted = (await s.persisted?.()) || (await s.persist());
  } catch (e) {
    console.warn('申请持久存储失败', e);
    storage.persisted = false;
  }
}

/** 把一个对象存成 JSON 文件下载（Blob + <a download>，不走网络，CSP 不拦）。 */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 文件名里的日期：2026-11-04 */
export const today = () => new Date().toISOString().slice(0, 10);
