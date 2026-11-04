/**
 * 设置：一个全局 $state，启动时从 Dexie 读，改完调 save() 写回。
 * 写库前用 $state.snapshot —— $state 是 Proxy，直接 put 会 DataCloneError。
 */
import { db } from './db/db';
import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  level: 'B1',
  noSpoilers: false,
  models: {},
};

export const settings: Settings = $state(structuredClone(DEFAULT_SETTINGS));

/** 把存的设置补全成完整形状（老版本少字段时用默认值）。 */
export function normalizeSettings(raw: Partial<Settings> | undefined): Settings {
  // appToken 是代理模式的遗留字段，直连后不用了，读出来就扔
  const { appToken: _legacy, ...rest } = raw ?? {};
  return { ...DEFAULT_SETTINGS, ...rest, models: { ...(raw?.models ?? {}) } };
}

export async function loadSettings(): Promise<void> {
  const row = await db().settings.get('app');
  if (!row) return;
  const { key: _key, ...saved } = row;
  Object.assign(settings, normalizeSettings(saved));
}

export async function saveSettings(): Promise<void> {
  await db().settings.put({ key: 'app', ...$state.snapshot(settings) });
}
