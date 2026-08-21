import type { EvidenceRecord, RuntimeResult, OutcomeDecision, Attempt } from './types.ts';

// §25：模板，不使用 Presenter LLM。
// 「Agent 判斷」來自 claim；「實際修改／驗證」只能來自 evidence。

const OUTCOME_TITLE: Record<OutcomeDecision['outcome'], string> = {
  SUCCESS: '已完成',
  NEEDS_USER_DECISION: '需要你的決定',
  RETRYABLE_FAILURE: '本次未通過驗證（可重試）',
  POLICY_VIOLATION: '偵測到越界變更，已擋下',
  BLOCKED: '已阻擋',
  FAILED: '失敗',
};

export function formatPromptChars(prompt: string | null): string {
  return `    promptChars: ${prompt?.length ?? 0}`;
}

export function buildResponse(input: {
  attempt: Attempt;
  decision: OutcomeDecision;
  result?: RuntimeResult;
  evidence: readonly EvidenceRecord[];
  notExecuted: readonly string[];
}): string {
  const { attempt, decision, result, evidence } = input;
  const out: string[] = [`${OUTCOME_TITLE[decision.outcome]}（attempt #${attempt.number}，${attempt.mode}）`];

  if (result?.summary) out.push('', 'Agent 摘要', `- ${result.summary}`);

  const claims = (result?.claims ?? []).filter((c) => c.type !== 'verification');
  if (claims.length) {
    out.push('', 'Agent 判斷（未經 Harness 獨立驗證）');
    for (const c of claims) out.push(`- [${c.type}] ${c.text}${c.relatedPaths?.length ? `（${c.relatedPaths.join(', ')}）` : ''}`);
  }

  const git = evidence.find((e) => e.type === 'git_diff');
  const changed = (git?.data as { changedPaths?: string[] } | undefined)?.changedPaths ?? [];
  out.push('', '實際修改（Harness 觀察）');
  if (changed.length) for (const p of changed) out.push(`- ${p}`);
  else out.push('- 無');

  if (decision.outcome === 'POLICY_VIOLATION') {
    const violations = evidence
      .filter((e) => e.type === 'path_policy' && e.status === 'FAIL')
      .flatMap((e) => (e.data as { violations?: Array<{ path: string; rule: string }> }).violations ?? []);
    out.push('', '禁止範圍內的變更（已擋下）');
    if (violations.length) {
      for (const v of violations) out.push(`- ${v.path}（規則：${v.rule}）`);
    } else {
      out.push('- path policy 驗證失敗，但證據未提供違規路徑');
    }
  }

  const verifications = evidence.filter((e) => e.type !== 'git_diff');
  out.push('', '驗證（Harness 執行）');
  if (verifications.length) for (const e of verifications) out.push(`- ${e.label}：${e.status}`);
  else out.push('- 未執行');

  const failed = verifications.filter((e) => e.status !== 'PASS');
  for (const e of failed) {
    const t = (e.data as { tail?: string; violations?: unknown }).tail;
    if (t) out.push('', `${e.label} 輸出（末段）`, '```', t, '```');
  }

  if (result?.questions.length) {
    out.push('', '待你回覆');
    for (const q of result.questions) out.push(`- ${q.text}${q.requestedAuthority ? `（要求權限：${q.requestedAuthority}）` : ''}`);
  }

  if (decision.reasons.length) out.push('', '判定理由', ...decision.reasons.map((r) => `- ${r}`));

  // 只列根因推論：agent 的 verification claim 不重複顯示，Harness 自己的驗證區才是權威
  const unproven = (result?.claims ?? []).filter((c) => c.type === 'diagnosis');
  if (decision.outcome === 'SUCCESS' && unproven.length) {
    out.push('', '目前未能獨立證明');
    for (const c of unproven) out.push(`- ${c.text}`);
  }

  if (input.notExecuted.length) {
    out.push('', '未執行');
    for (const n of input.notExecuted) out.push(`- ${n}`);
  }
  return out.join('\n');
}
