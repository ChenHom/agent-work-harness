import type { Mode } from '../types.ts';

// §18：deterministic parsing。只解析高信心語句；解析不了的原樣保留成 constraint。
// 明確禁止在此處使用 LLM 或模糊猜測（§3.3 / §18.1）。

export interface ParsedRequest {
  mode: Mode;
  deniedPaths: string[];
  allowedPaths?: string[];      // §20.1：只有「只改 X」這種明確限定才產生
  allowPathDecisions: string[]; // 「可以改 X」→ 授權但不縮限 write scope
  constraints: string[];
  matched: Array<{ rule: string; text: string }>;
}

const READ_ONLY_PATTERNS = [
  /只看/, /不要改/, /不要修改/, /不要更動/, /別改/, /不用改/, /只分析/, /只調查/, /先不要改/,
  /\bread[- ]?only\b/i, /\bdon'?t\s+(modify|change|edit)\b/i, /\bjust\s+(look|investigate|analy[sz]e)\b/i,
];

// 「不要碰 payment」「不要動 src/x」「不要改 a/b」
const DENY_PATH_PATTERNS = [
  /(?:不要|不可|不能|別|禁止)\s*(?:碰|動|改|修改|更動|touch)\s*([^\s，,。;；、和跟以及]+)/g,
  /\b(?:do\s*not|don'?t)\s+(?:touch|modify|change)\s+([^\s,.;]+)/gi,
];

// 「只改 src/auth」「只能改 X」「僅修改 X」
const ONLY_PATH_PATTERNS = [
  /(?:只|僅)\s*(?:能|可以)?\s*(?:改|修改|更動|動)\s*([^\s，,。;；、和跟以及]+)/g,
  /\bonly\s+(?:modify|change|edit|touch)\s+([^\s,.;]+)/gi,
];

// 「可以改 X」「允許修改 X」
const ALLOW_PATH_PATTERNS = [
  /(?:可以|允許|能)\s*(?:改|修改|更動|動)\s*([^\s，,。;；、和跟以及]+)/g,
  /\b(?:you\s+may|allowed\s+to)\s+(?:modify|change|edit)\s+([^\s,.;]+)/gi,
];

// 高頻 constraint：機械化後仍以原文保存（§3.2）
const CONSTRAINT_PATTERNS: Array<[RegExp, string]> = [
  [/不要部署|別部署|不用部署|\bdo\s*not\s+deploy\b/i, '不要部署'],
  [/不要(?:提交|commit)|別commit|\bdo\s*not\s+commit\b/i, '不要提交'],
  [/不要(?:推送|push)|\bdo\s*not\s+push\b/i, '不要推送'],
  [/不要(?:安裝|裝)新(?:的)?(?:套件|依賴|package)|\bno\s+new\s+dependenc/i, '不要安裝新依賴'],
];

// 看起來像路徑：含 /、含 . 副檔名、或是常見目錄字（單一 token）
const PATH_LIKE = /^[A-Za-z0-9_@.*/-]+$/;

function looksLikePath(token: string): boolean {
  const t = token.trim().replace(/[的了。，,]+$/u, '');
  if (!t || t.length > 120) return false;
  if (!PATH_LIKE.test(t)) return false;
  return t.includes('/') || t.includes('.') || t.includes('*') || /^[a-z][a-z0-9_-]*$/i.test(t);
}

/** 把使用者寫的片段正規化為 glob。目錄形式補 `/**`。 */
export function normalizePath(raw: string): string {
  let t = raw.trim().replace(/[的了。，,;；]+$/u, '');
  t = t.replace(/^\.\//, '');
  if (t.includes('*')) return t;
  if (/\.[A-Za-z0-9]{1,8}$/.test(t)) return t;      // 檔案
  return `${t.replace(/\/+$/, '')}/**`;             // 目錄
}

function collect(text: string, patterns: RegExp[]): Array<{ value: string; text: string }> {
  const out: Array<{ value: string; text: string }> = [];
  for (const p of patterns) {
    const re = new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const captured = m[1];
      if (captured && looksLikePath(captured)) out.push({ value: normalizePath(captured), text: m[0] });
    }
  }
  return out;
}

export function parseRequest(text: string): ParsedRequest {
  const matched: Array<{ rule: string; text: string }> = [];

  // read/write 語句同時出現時取 read（fail-safe：較小權限），由使用者再明確擴權。
  const isRead = READ_ONLY_PATTERNS.some((p) => {
    const hit = p.test(text);
    if (hit) matched.push({ rule: 'mode:read', text: text.match(p)?.[0] ?? '' });
    return hit;
  });

  const denied = collect(text, DENY_PATH_PATTERNS);
  denied.forEach((d) => matched.push({ rule: 'deny_path', text: d.text }));

  const only = collect(text, ONLY_PATH_PATTERNS);
  only.forEach((d) => matched.push({ rule: 'only_path', text: d.text }));

  const allow = collect(text, ALLOW_PATH_PATTERNS)
    .filter((a) => !only.some((o) => o.text.includes(a.value.replace('/**', ''))));
  allow.forEach((d) => matched.push({ rule: 'allow_path', text: d.text }));

  const constraints: string[] = [];
  for (const [re, label] of CONSTRAINT_PATTERNS) {
    if (re.test(text)) { constraints.push(label); matched.push({ rule: 'constraint', text: label }); }
  }

  const deniedPaths = [...new Set(denied.map((d) => d.value))];
  const onlyPaths = [...new Set(only.map((d) => d.value))];

  return {
    mode: isRead ? 'read' : 'write',
    deniedPaths,
    allowedPaths: onlyPaths.length ? onlyPaths : undefined,
    allowPathDecisions: [...new Set(allow.map((a) => a.value))],
    constraints,
    matched,
  };
}
