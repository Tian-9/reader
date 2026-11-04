/** 导入失败的原因。message 直接给界面显示（中文、不带术语堆砌）。 */
export type EpubErrorCode = 'drm' | 'maybe-encrypted' | 'not-epub' | 'no-content';

/** PLAN 2.3 定的提示语，一字不改。 */
export const DRM_MESSAGE =
  '这本书带版权锁，阅读器打不开。用你自己买的无 DRM 版本就行（官方 Wizarding World/Pottermore 卖的通常只有水印，没有锁）。';

const MESSAGES: Record<EpubErrorCode, string> = {
  drm: DRM_MESSAGE,
  'maybe-encrypted': `这本可能加密了：解析出来的正文是乱码。${DRM_MESSAGE}`,
  'not-epub': '这个文件不是能打开的 EPUB（电子书文件）。确认一下选的是 .epub，而且下载完整了。',
  'no-content': '这本书里没找到正文段落，阅读器打不开。',
};

export class EpubError extends Error {
  constructor(
    public readonly code: EpubErrorCode,
    /** 给开发看的细节（控制台），不给用户看 */
    public readonly detail = '',
  ) {
    super(MESSAGES[code]);
    this.name = 'EpubError';
  }
}
