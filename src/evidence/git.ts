import { newId, nowIso } from '../ids.ts';
import { runIsolated, tail } from './exec.ts';
import { checkPaths, type PathPolicy } from '../repo/paths.ts';
import type { EvidenceRecord, GlobalPolicy } from '../types.ts';

// §23.1：Harness 自己觀察 git 狀態，不採信 agent 的 declaredChangedPaths。

export async function baseRevision(policy: GlobalPolicy, workspace: string): Promise<string> {
  const r = await runIsolated(policy, ['git', 'rev-parse', 'HEAD'], { workspace, timeoutMs: 30_000 });
  return r.exitCode === 0 ? r.stdout.trim() : 'UNKNOWN';
}

export interface GitObservation {
  changedPaths: string[];
  diff: string;
  baseRevision: string;
  head: string;
  clean: boolean;
}

/** 觀察 worktree 相對 baseRevision 的實際變更（含 untracked）。 */
export async function observeGit(policy: GlobalPolicy, workspace: string, base: string): Promise<GitObservation> {
  const status = await runIsolated(policy, ['git', 'status', '--porcelain=v1', '--untracked-files=all'], { workspace, timeoutMs: 60_000 });
  const worktreePaths = status.stdout.split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const p = l.slice(2).trim();
      const arrow = p.indexOf(' -> ');      // rename：兩邊都算變更
      return arrow >= 0 ? [p.slice(0, arrow), p.slice(arrow + 4)] : [p];
    })
    .flat()
    .map((p) => p.replace(/^"|"$/g, ''));

  const headRes = await runIsolated(policy, ['git', 'rev-parse', 'HEAD'], { workspace, timeoutMs: 30_000 });
  const head = headRes.exitCode === 0 ? headRes.stdout.trim() : 'UNKNOWN';

  // base 之後若有 commit，也要算進變更（agent 可能自行 commit）
  let committed: string[] = [];
  if (base !== 'UNKNOWN' && head !== 'UNKNOWN' && head !== base) {
    const r = await runIsolated(policy, ['git', 'diff', '--name-only', `${base}..${head}`], { workspace, timeoutMs: 60_000 });
    committed = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  const diffRes = await runIsolated(policy, ['git', 'diff', base === 'UNKNOWN' ? 'HEAD' : base], { workspace, timeoutMs: 120_000 });
  const changedPaths = [...new Set([...worktreePaths, ...committed])].sort();

  return { changedPaths, diff: diffRes.stdout, baseRevision: base, head, clean: changedPaths.length === 0 };
}

export function gitDiffEvidence(workId: string, attemptId: string, obs: GitObservation, diffArtifactId: string): EvidenceRecord {
  return {
    id: newId('EV'), workId, attemptId, type: 'git_diff', label: 'git diff',
    status: 'PASS', // 觀察本身成功；是否合規由 path_policy 判定
    data: {
      changedPaths: obs.changedPaths, baseRevision: obs.baseRevision, head: obs.head,
      diffArtifactId, diffPreview: tail(obs.diff, 20),
    },
    observedAt: nowIso(),
  };
}

/** §24：denied / protected path 被改動 → POLICY_VIOLATION 的來源證據。 */
export function pathPolicyEvidence(workId: string, attemptId: string, changedPaths: readonly string[], policy: PathPolicy): EvidenceRecord {
  const violations = checkPaths(changedPaths, policy);
  return {
    id: newId('EV'), workId, attemptId, type: 'path_policy', label: 'denied path check',
    status: violations.length ? 'FAIL' : 'PASS',
    data: { violations, deniedPaths: policy.deniedPaths, allowedPaths: policy.allowedPaths ?? null },
    observedAt: nowIso(),
  };
}
