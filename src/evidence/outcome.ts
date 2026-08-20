import type { EvidenceRecord, Outcome, OutcomeDecision, RuntimeResult, SkillAdmission, Mode } from '../types.ts';

// §24：固定規則表。不使用 LLM，也不用自然語言 successCriteria 判定成功（§7.1）。

export interface OutcomeInput {
  mode: Mode;
  skillAdmissions: readonly SkillAdmission[];
  protocolOk: boolean;
  protocolError?: string;
  runtimeResult?: RuntimeResult;
  evidence: readonly EvidenceRecord[];
  retryBudgetRemaining: number;
  runtimeCrashed?: boolean;
}

export function decideOutcome(i: OutcomeInput): OutcomeDecision {
  const reasons: string[] = [];
  const push = (o: Outcome, r: string): OutcomeDecision => ({ outcome: o, reasons: [...reasons, r] });

  // 1. Skill / sandbox admission fail → BLOCKED
  const denied = i.skillAdmissions.filter((s) => !s.allowed);
  if (denied.length) return push('BLOCKED', `skill admission 失敗：${denied.map((d) => `${d.skillId}(${d.reason})`).join('；')}`);

  // 2. Policy violation 永遠優先於 agent 自述（§23.1）
  const pathEvidence = i.evidence.filter((e) => e.type === 'path_policy');
  const violated = pathEvidence.find((e) => e.status === 'FAIL');
  if (violated) {
    const v = (violated.data as { violations?: Array<{ path: string; rule: string }> }).violations ?? [];
    return push('POLICY_VIOLATION', `變更落在禁止範圍：${v.map((x) => `${x.path}(${x.rule})`).join('、')}`);
  }

  // 3. Protocol 失敗 → 可重試
  if (!i.protocolOk) {
    const r = `runtime 輸出不符 RuntimeResult v1：${i.protocolError ?? 'unknown'}`;
    return i.retryBudgetRemaining > 0 ? push('RETRYABLE_FAILURE', r) : push('FAILED', r);
  }

  const result = i.runtimeResult!;

  // 4. Agent 明確要求決策 / 表示被擋
  if (result.status === 'needs_user_decision') {
    return push('NEEDS_USER_DECISION', result.questions.map((q) => q.text).join(' / ') || result.summary);
  }
  if (result.status === 'blocked') return push('BLOCKED', result.summary);
  if (result.status === 'failed') {
    return i.retryBudgetRemaining > 0
      ? push('RETRYABLE_FAILURE', `agent 回報失敗：${result.summary}`)
      : push('FAILED', `agent 回報失敗：${result.summary}`);
  }

  // 5. 機械 acceptance（§7.1）
  const required = i.evidence.filter((e) => (e.data as { required?: boolean }).required === true);
  const failedRequired = required.filter((e) => e.status !== 'PASS');
  if (failedRequired.length) {
    const r = `required verification 未通過：${failedRequired.map((e) => `${e.label}=${e.status}`).join('、')}`;
    return i.retryBudgetRemaining > 0 ? push('RETRYABLE_FAILURE', r) : push('FAILED', r);
  }

  if (i.mode === 'write') {
    const git = i.evidence.find((e) => e.type === 'git_diff');
    const changed = (git?.data as { changedPaths?: string[] } | undefined)?.changedPaths ?? [];
    if (changed.length === 0) {
      // write work 沒有任何實際變更：agent 說完成也不算完成（§23.1）
      const r = 'agent 回報完成，但 Harness 觀察到 worktree 沒有任何變更';
      return i.retryBudgetRemaining > 0 ? push('RETRYABLE_FAILURE', r) : push('FAILED', r);
    }
    reasons.push(`實際變更 ${changed.length} 個檔案`);
  }

  if (required.length === 0 && i.mode === 'write') {
    reasons.push('警告：Repository Contract 沒有 required verification check，acceptance 僅依 path policy');
  }
  return push('SUCCESS', 'required evidence 全部 PASS');
}
