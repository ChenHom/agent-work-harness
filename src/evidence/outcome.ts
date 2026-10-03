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
  runtimeStderr?: string;
}

function runnerProtocolFailure(stderr: string | undefined): string | undefined {
  if (!stderr) return undefined;
  if (/invalid_refresh_token|unauthorized\s*\(401\)|routing.*\b401\b/i.test(stderr)) {
    return 'RUNNER_AUTH_UNAUTHORIZED: Codex runner 在輸出最終 RuntimeResult 前遭授權拒絕；請檢查登入憑證與模型路由權限';
  }
  if (/hit your usage limit|usage[ _-]?limit/i.test(stderr)) {
    return 'RUNNER_QUOTA_EXHAUSTED: Codex runner 在輸出最終 RuntimeResult 前達到用量限制；請確認帳戶配額後再建立新 attempt';
  }
  return undefined;
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

  // 3. runtime 逾時／被砍：即使留下可解析的結果也不得判成功
  if (i.runtimeCrashed) {
    const r = 'runtime 逾時或被中止，無法確認 agent 是否完成工作';
    return i.retryBudgetRemaining > 0 ? push('RETRYABLE_FAILURE', r) : push('FAILED', r);
  }

  // 4. Protocol 失敗 → 可重試
  if (!i.protocolOk) {
    const diagnosis = runnerProtocolFailure(i.runtimeStderr);
    const r = diagnosis
      ? `${diagnosis}（RuntimeResult v1：${i.protocolError ?? 'unknown'}）`
      : `runtime 輸出不符 RuntimeResult v1：${i.protocolError ?? 'unknown'}`;
    return i.retryBudgetRemaining > 0 ? push('RETRYABLE_FAILURE', r) : push('FAILED', r);
  }

  const result = i.runtimeResult!;

  // 5. Agent 明確要求決策 / 表示被擋
  if (result.status === 'needs_user_decision') {
    return push('NEEDS_USER_DECISION', result.questions.map((q) => q.text).join(' / ') || result.summary);
  }
  if (result.status === 'blocked') return push('BLOCKED', result.summary);
  if (result.status === 'failed') {
    return i.retryBudgetRemaining > 0
      ? push('RETRYABLE_FAILURE', `agent 回報失敗：${result.summary}`)
      : push('FAILED', `agent 回報失敗：${result.summary}`);
  }

  // git observation 不完整時，不能把空的 changedPaths 當成乾淨 worktree。
  const gitEvidence = i.evidence.find((e) => e.type === 'git_diff');
  if (!gitEvidence || gitEvidence.status !== 'PASS') {
    const status = gitEvidence?.status ?? 'MISSING';
    const r = `git observation 不完整（${status}），無法確認實際變更`;
    return i.retryBudgetRemaining > 0 ? push('RETRYABLE_FAILURE', r) : push('FAILED', r);
  }

  // 6. 機械 acceptance（§7.1）
  // fail-closed：path policy evidence 必須存在且 PASS，缺失或 INCONCLUSIVE 都不得判成功
  const pathPass = pathEvidence.filter((e) => e.status === 'PASS');
  if (pathPass.length === 0) {
    const detail = pathEvidence.length
      ? `path policy evidence 狀態為 ${pathEvidence.map((e) => e.status).join('/')}`
      : 'path policy evidence 缺失';
    const r = `無法確認變更是否落在授權範圍內：${detail}`;
    return i.retryBudgetRemaining > 0 ? push('RETRYABLE_FAILURE', r) : push('FAILED', r);
  }

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
