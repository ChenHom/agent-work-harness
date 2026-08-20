import type { RuntimeResult, RuntimeClaim, RuntimeQuestion } from '../types.ts';

// §22：stdout/最後訊息 → 取出唯一 JSON → schema validate → workId/attemptId 一致 → ACCEPT / PROTOCOL_FAILED。
// 不允許用第二個 LLM 猜它原本想說什麼。

export type ParseOutcome =
  | { ok: true; result: RuntimeResult }
  | { ok: false; error: string };

/** 從文字中取出最後一個完整的 top-level JSON 物件。 */
export function extractJsonObject(text: string): string | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!.trim());
  const candidates = [...fenced];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) { candidates.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i]!;
    try {
      const v = JSON.parse(c) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v) && 'schemaVersion' in v) return c;
    } catch { /* 下一個候選 */ }
  }
  return null;
}

const CLAIM_TYPES = new Set(['finding', 'diagnosis', 'change', 'verification', 'limitation']);
const STATUSES = new Set(['completed', 'needs_user_decision', 'blocked', 'failed']);

export function parseRuntimeResult(text: string, expect: { workId: string; attemptId: string }): ParseOutcome {
  const json = extractJsonObject(text);
  if (!json) return { ok: false, error: '輸出中找不到 RuntimeResult JSON 物件' };

  let raw: Record<string, unknown>;
  try { raw = JSON.parse(json) as Record<string, unknown>; }
  catch (e) { return { ok: false, error: `JSON 解析失敗: ${(e as Error).message}` }; }

  const errs: string[] = [];
  if (raw.schemaVersion !== '1') errs.push('schemaVersion 必須是 "1"');
  if (typeof raw.status !== 'string' || !STATUSES.has(raw.status)) errs.push(`status 不合法: ${String(raw.status)}`);
  if (typeof raw.summary !== 'string') errs.push('summary 必須是字串');
  if (raw.workId !== expect.workId) errs.push(`workId 不符（期望 ${expect.workId}，得到 ${String(raw.workId)}）`);
  if (raw.attemptId !== expect.attemptId) errs.push(`attemptId 不符（期望 ${expect.attemptId}，得到 ${String(raw.attemptId)}）`);

  const claims: RuntimeClaim[] = [];
  if (!Array.isArray(raw.claims)) errs.push('claims 必須是陣列');
  else for (const [i, c] of raw.claims.entries()) {
    const o = c as Partial<RuntimeClaim>;
    if (!o || typeof o.text !== 'string' || !CLAIM_TYPES.has(String(o.type))) { errs.push(`claims[${i}] 格式錯誤`); continue; }
    claims.push({
      type: o.type as RuntimeClaim['type'], text: o.text,
      relatedPaths: Array.isArray(o.relatedPaths) ? o.relatedPaths.filter((p): p is string => typeof p === 'string') : undefined,
    });
  }

  const questions: RuntimeQuestion[] = [];
  if (!Array.isArray(raw.questions)) errs.push('questions 必須是陣列');
  else for (const [i, q] of raw.questions.entries()) {
    const o = q as Partial<RuntimeQuestion>;
    if (!o || typeof o.text !== 'string') { errs.push(`questions[${i}] 格式錯誤`); continue; }
    questions.push({
      id: typeof o.id === 'string' ? o.id : `Q${i + 1}`, text: o.text,
      requestedAuthority: typeof o.requestedAuthority === 'string' ? o.requestedAuthority : undefined,
    });
  }

  const declared = Array.isArray(raw.declaredChangedPaths)
    ? raw.declaredChangedPaths.filter((p): p is string => typeof p === 'string')
    : (errs.push('declaredChangedPaths 必須是陣列'), []);

  if (errs.length) return { ok: false, error: errs.join('；') };

  return {
    ok: true,
    result: {
      schemaVersion: '1',
      workId: expect.workId,
      attemptId: expect.attemptId,
      status: raw.status as RuntimeResult['status'],
      summary: raw.summary as string,
      claims, questions, declaredChangedPaths: declared,
    },
  };
}
