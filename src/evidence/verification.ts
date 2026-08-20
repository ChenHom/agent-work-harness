import { newId, nowIso } from '../ids.ts';
import { runIsolated, tail } from './exec.ts';
import type { EvidenceRecord, GlobalPolicy, RepositoryContractSnapshot, VerificationCheck } from '../types.ts';

// §23.3 / §34.5：verification 定義只來自 frozen Repository Contract snapshot，
// 且以 argv + shell=false 在隔離環境執行。Agent 不能提供要執行的字串。

const KIND_TO_EVIDENCE: Record<VerificationCheck['kind'], EvidenceRecord['type']> = {
  test: 'test_result',
  typecheck: 'typecheck_result',
  lint: 'test_result',
  build: 'build_result',
  custom: 'test_result',
};

export interface VerificationOutcome {
  evidence: EvidenceRecord[];
  requiredFailed: EvidenceRecord[];
  allRequiredPassed: boolean;
}

export async function runVerification(
  policy: GlobalPolicy,
  snapshot: RepositoryContractSnapshot,
  workspace: string,
  ids: { workId: string; attemptId: string },
  onProgress?: (msg: string) => void,
): Promise<VerificationOutcome> {
  const evidence: EvidenceRecord[] = [];

  for (const check of snapshot.contract.verification.checks) {
    onProgress?.(`verification: ${check.id} …`);
    const run = await runIsolated(policy, check.argv, {
      workspace,
      writable: true,               // 測試通常需要寫暫存/快取到 worktree
      timeoutMs: check.timeoutMs ?? policy.verificationTimeoutMs,
    });
    const status: EvidenceRecord['status'] = run.timedOut ? 'INCONCLUSIVE' : (run.exitCode === 0 ? 'PASS' : 'FAIL');
    evidence.push({
      id: newId('EV'), workId: ids.workId, attemptId: ids.attemptId,
      type: KIND_TO_EVIDENCE[check.kind],
      label: `${check.id} (${check.argv.join(' ')})`,
      status,
      data: {
        checkId: check.id, kind: check.kind, argv: check.argv, required: check.required,
        exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs,
        tail: tail(`${run.stdout}\n${run.stderr}`, 40),
      },
      observedAt: nowIso(),
    });
    onProgress?.(`verification: ${check.id} → ${status}`);
  }

  const requiredFailed = evidence.filter((e) => {
    const d = e.data as { required?: boolean };
    return d.required === true && e.status !== 'PASS';
  });

  return { evidence, requiredFailed, allRequiredPassed: requiredFailed.length === 0 };
}
