import type { ContextManifest, ContextItem } from '../types.ts';

// §16：固定 priority 裁切，不使用 LLM 壓縮。P0 永不裁切。

export interface BudgetResult {
  manifest: ContextManifest;
  dropped: Array<{ priority: number; count: number }>;
}

function size(items: readonly ContextItem[]): number {
  return items.reduce((n, i) => n + (i.content?.length ?? 0) + (i.pointer?.length ?? 0) + 4, 0);
}

export function applyBudget(m: ContextManifest, budgetChars: number): BudgetResult {
  const dropped: Array<{ priority: number; count: number }> = [];
  const out: ContextManifest = { ...m, pointers: [...m.pointers], userContext: [...m.userContext], previousEvidence: [...m.previousEvidence] };

  const total = (): number =>
    size(out.control) + size(out.decisions) + size(out.previousEvidence) + size(out.userContext) + size(out.pointers);

  // 順序：P4/P3（pointers 由後往前）→ P2 保留來源 → P1 只留必要 evidence
  while (total() > budgetChars && out.pointers.length > 1) {
    out.pointers.pop();
    dropped.push({ priority: 3, count: 1 });
  }
  // P2 必須保留來源（§16）：只截內容，不刪項目
  if (total() > budgetChars) {
    out.userContext = out.userContext.map((i) =>
      (i.content && i.content.length > 200)
        ? { ...i, content: `${i.content.slice(0, 200)}…[內容因 budget 截斷，來源 ${i.source}]` }
        : i);
  }
  while (total() > budgetChars && out.previousEvidence.length > 1) {
    out.previousEvidence.pop();
    dropped.push({ priority: 1, count: 1 });
  }
  // P0 永遠不裁切；超出就讓它超出並讓 caller 記錄。
  const merged = new Map<number, number>();
  for (const d of dropped) merged.set(d.priority, (merged.get(d.priority) ?? 0) + d.count);
  return { manifest: out, dropped: [...merged].map(([priority, count]) => ({ priority, count })) };
}
