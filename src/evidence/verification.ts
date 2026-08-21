import { newId, nowIso } from '../ids.ts';
import { runIsolated, tail, type IsolatedRun } from './exec.ts';
import type {
  EvidenceRecord, GlobalPolicy, RepositoryContractSnapshot, VerificationCheck,
  VerificationBaseline, VerificationEvidenceData,
} from '../types.ts';

// §23.3 / §34.5：verification 定義只來自 frozen Repository Contract snapshot，
// 且以 argv + shell=false 在隔離環境執行。Agent 不能提供要執行的字串。
//
// §23.4：exit code 只能回答「這條命令沒失敗」，不能回答「該跑的有沒有跑」。
// dogfood 真的踩到：測試檔被 skip → npm test exit 0 → PASS → SUCCESS。
// 兩條原則：未知不等於失敗；不完整不等於通過。

const KIND_TO_EVIDENCE: Record<VerificationCheck['kind'], EvidenceRecord['type']> = {
  test: 'test_result',
  typecheck: 'typecheck_result',
  lint: 'test_result',
  build: 'build_result',
  custom: 'test_result',
};

export interface Completeness { executed?: number; skipped?: number }

/**
 * 從 runner 輸出解析執行規模。只支援解析得出來的格式，其他一律 undefined ——
 * 不為了填滿欄位而猜（§3.2）。
 */
export function parseCompleteness(output: string): Completeness | undefined {
  // node:test：`ℹ tests 80` / `ℹ skipped 3`
  const nodeTests = /^\s*(?:ℹ|i)\s+tests\s+(\d+)\s*$/m.exec(output);
  if (nodeTests) {
    const total = Number(nodeTests[1]);
    const sk = /^\s*(?:ℹ|i)\s+skipped\s+(\d+)\s*$/m.exec(output);
    const skipped = sk ? Number(sk[1]) : 0;
    return { executed: total - skipped, skipped };
  }

  // pytest：`5 passed, 2 skipped in 0.30s`（含 failed / error 變體）
  const num = (word: string): number => {
    const m = new RegExp(`(\\d+)\\s+${word}`).exec(output);
    return m ? Number(m[1]) : 0;
  };
  if (/\d+\s+(?:passed|failed|skipped|error)/.test(output)) {
    const executed = num('passed') + num('failed') + num('error');
    return { executed, skipped: num('skipped') };
  }

  return undefined;
}

/** §23.4 判定規則。baseline 缺席時退回現行行為，不判失敗。 */
export function decideCheckStatus(
  run: IsolatedRun,
  completeness: Completeness | undefined,
  baseline: VerificationBaseline | undefined,
): { status: EvidenceRecord['status']; reason?: string } {
  if (run.timedOut) return { status: 'INCONCLUSIVE', reason: '執行逾時，無法確認是否跑完' };
  if (run.outputTruncated) {
    return { status: 'INCONCLUSIVE', reason: '輸出超過上限導致行程被終止，執行沒有跑完' };
  }
  if (run.exitCode !== 0) return { status: 'FAIL' };

  // exit 0：再看有沒有比 agent 動手前少跑
  if (baseline && completeness) {
    if (baseline.executed !== undefined && completeness.executed !== undefined
        && completeness.executed < baseline.executed) {
      return {
        status: 'INCONCLUSIVE',
        reason: `執行數量比 baseline 少（${completeness.executed} < ${baseline.executed}）`,
      };
    }
    if (baseline.skipped !== undefined && completeness.skipped !== undefined
        && completeness.skipped > baseline.skipped) {
      return {
        status: 'INCONCLUSIVE',
        reason: `skip 數量比 baseline 多（${completeness.skipped} > ${baseline.skipped}）`,
      };
    }
  }
  return { status: 'PASS' };
}

async function runCheck(policy: GlobalPolicy, check: VerificationCheck, workspace: string): Promise<IsolatedRun> {
  return runIsolated(policy, check.argv, {
    workspace,
    writable: true,               // 測試通常需要寫暫存/快取到 worktree
    timeoutMs: check.timeoutMs ?? policy.verificationTimeoutMs,
  });
}

/**
 * pre-flight baseline：agent 動任何東西之前先跑一次 required checks。
 * MVP 只用它回答「這次有沒有比動手前變差或少跑」。
 */
export async function collectBaseline(
  policy: GlobalPolicy,
  snapshot: RepositoryContractSnapshot,
  workspace: string,
  onProgress?: (msg: string) => void,
): Promise<VerificationBaseline[]> {
  const out: VerificationBaseline[] = [];
  for (const check of snapshot.contract.verification.checks) {
    if (!check.required) continue;                       // 只對 required 付這個時間成本
    onProgress?.(`baseline: ${check.id} …`);
    const run = await runCheck(policy, check, workspace);
    // baseline 自己跑不起來就不記 —— 之後走「baseline 不可用」那條規則
    if (run.timedOut || run.outputTruncated) {
      onProgress?.(`baseline: ${check.id} → 不可用（逾時或輸出超限）`);
      continue;
    }
    const c = parseCompleteness(`${run.stdout}\n${run.stderr}`);
    out.push({ checkId: check.id, exitCode: run.exitCode, executed: c?.executed, skipped: c?.skipped });
    onProgress?.(`baseline: ${check.id} → exit ${run.exitCode}${c ? ` (executed ${c.executed}, skipped ${c.skipped})` : ''}`);
  }
  return out;
}

export interface VerificationOutcome {
  evidence: EvidenceRecord[];
  requiredFailed: EvidenceRecord[];
  allRequiredPassed: boolean;
}

export async function runVerification(
  policy: GlobalPolicy,
  snapshot: RepositoryContractSnapshot,
  workspace: string,
  ids: { workId: string; attemptId: string; baseRevision: string; headRevision: string },
  baseline: readonly VerificationBaseline[] | undefined,
  onProgress?: (msg: string) => void,
): Promise<VerificationOutcome> {
  const evidence: EvidenceRecord[] = [];

  for (const check of snapshot.contract.verification.checks) {
    onProgress?.(`verification: ${check.id} …`);
    const run = await runCheck(policy, check, workspace);
    const completeness = parseCompleteness(`${run.stdout}\n${run.stderr}`);
    const base = baseline?.find((b) => b.checkId === check.id);
    const { status, reason } = decideCheckStatus(run, completeness, base);

    const data: VerificationEvidenceData = {
      checkId: check.id, kind: check.kind, argv: check.argv, required: check.required,
      baseRevision: ids.baseRevision, headRevision: ids.headRevision, contractHash: snapshot.hash,
      exitCode: run.exitCode, timedOut: run.timedOut, outputTruncated: run.outputTruncated,
      durationMs: run.durationMs,
      // 輸出被終止時保留的是「開頭」，這裡的 tail 其實是開頭那段的末端，必須講清楚
      tail: run.outputTruncated
        ? `[輸出超過上限，行程被終止；以下是保留下來的開頭那段的末端，不是真正的結尾]\n${tail(`${run.stdout}\n${run.stderr}`, 40)}`
        : tail(`${run.stdout}\n${run.stderr}`, 40),
      executed: completeness?.executed, skipped: completeness?.skipped,
      baseline: base, reason,
    };

    evidence.push({
      id: newId('EV'), workId: ids.workId, attemptId: ids.attemptId,
      type: KIND_TO_EVIDENCE[check.kind],
      label: `${check.id} (${check.argv.join(' ')})`,
      status, data, observedAt: nowIso(),
    });
    onProgress?.(`verification: ${check.id} → ${status}${reason ? `（${reason}）` : ''}`);
  }

  const requiredFailed = evidence.filter((e) => {
    const d = e.data as VerificationEvidenceData;
    return d.required === true && e.status !== 'PASS';
  });

  return { evidence, requiredFailed, allRequiredPassed: requiredFailed.length === 0 };
}
