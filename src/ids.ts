import { randomBytes } from 'node:crypto';

// 單調遞增 + 隨機尾碼：好排序、好在 log 裡辨識
export function newId(prefix: string): string {
  const ts = Date.now().toString(36);
  return `${prefix}-${ts}-${randomBytes(3).toString('hex')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
