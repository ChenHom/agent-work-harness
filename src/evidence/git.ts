import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { newId, nowIso } from '../ids.ts';
import { runIsolated, tail } from './exec.ts';
import { checkPaths, type PathPolicy } from '../repo/paths.ts';
import type { EvidenceRecord, GlobalPolicy } from '../types.ts';

// §23.1：Harness 自己觀察 git 狀態，不採信 agent 的 declaredChangedPaths。

export async function baseRevision(policy: GlobalPolicy, workspace: string): Promise<string> {
  const r = await runIsolated(policy, ['git', 'rev-parse', 'HEAD'], { workspace, timeoutMs: 30_000 });
  return r.exitCode === 0 ? r.stdout.trim() : 'UNKNOWN';
}

export interface DirtyEntry { path: string; hash: string | null }

/** 讀檔算 hash —— 只讀內容，不執行 repository 的任何程式碼。 */
function contentHash(workspace: string, rel: string): string | null {
  const full = join(workspace, rel);
  if (!existsSync(full)) return null;
  try { return createHash('sha256').update(readFileSync(full)).digest('hex'); }
  catch { return null; }
}

/**
 * Attempt 開始前的 dirty 快照。
 * 沒有這一步，attempt 之前就存在的未提交變更會被算成 agent 造成的變更，
 * 導致誤報 POLICY_VIOLATION（實跑 dogfood 時真的踩到）。
 */
export async function snapshotDirty(policy: GlobalPolicy, workspace: string): Promise<DirtyEntry[]> {
  const paths = await statusPaths(policy, workspace);
  return paths.map((p) => ({ path: p, hash: contentHash(workspace, p) }));
}

async function statusPaths(policy: GlobalPolicy, workspace: string): Promise<string[]> {
  const status = await runIsolated(policy, ['git', 'status', '--porcelain=v1', '--untracked-files=all'], { workspace, timeoutMs: 60_000 });
  return status.stdout.split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const p = l.slice(2).trim();
      const arrow = p.indexOf(' -> ');      // rename：兩邊都算變更
      return arrow >= 0 ? [p.slice(0, arrow), p.slice(arrow + 4)] : [p];
    })
    .flat()
    .map((p) => p.replace(/^"|"$/g, ''));
}

export interface GitObservation {
  changedPaths: string[];
  preExistingUnchanged: string[];
  diff: string;
  baseRevision: string;
  head: string;
  clean: boolean;
}

/** 觀察 worktree 相對 baseRevision 的實際變更（含 untracked）。 */
export async function observeGit(
  policy: GlobalPolicy, workspace: string, base: string,
  preExisting: readonly DirtyEntry[] = [],
): Promise<GitObservation> {
  const worktreePaths = await statusPaths(policy, workspace);

  const headRes = await runIsolated(policy, ['git', 'rev-parse', 'HEAD'], { workspace, timeoutMs: 30_000 });
  const head = headRes.exitCode === 0 ? headRes.stdout.trim() : 'UNKNOWN';

  // base 之後若有 commit，也要算進變更（agent 可能自行 commit）
  let committed: string[] = [];
  if (base !== 'UNKNOWN' && head !== 'UNKNOWN' && head !== base) {
    const r = await runIsolated(policy, ['git', 'diff', '--name-only', `${base}..${head}`], { workspace, timeoutMs: 60_000 });
    committed = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  const diffRes = await runIsolated(policy, ['git', 'diff', base === 'UNKNOWN' ? 'HEAD' : base], { workspace, timeoutMs: 120_000 });
  const all = [...new Set([...worktreePaths, ...committed])].sort();

  // attempt 開始前就髒、且內容至今未再變動的檔案，不算這次 attempt 的變更
  const carried = new Map(preExisting.map((e) => [e.path, e.hash]));
  const preExistingUnchanged: string[] = [];
  const changedPaths = all.filter((p) => {
    if (!carried.has(p)) return true;
    const unchanged = carried.get(p) === contentHash(workspace, p);
    if (unchanged) preExistingUnchanged.push(p);
    return !unchanged;
  });

  return {
    changedPaths, preExistingUnchanged, diff: diffRes.stdout,
    baseRevision: base, head, clean: changedPaths.length === 0,
  };
}

export function gitDiffEvidence(workId: string, attemptId: string, obs: GitObservation, diffArtifactId: string): EvidenceRecord {
  return {
    id: newId('EV'), workId, attemptId, type: 'git_diff', label: 'git diff',
    status: 'PASS', // 觀察本身成功；是否合規由 path_policy 判定
    data: {
      changedPaths: obs.changedPaths, preExistingUnchanged: obs.preExistingUnchanged,
      baseRevision: obs.baseRevision, head: obs.head,
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
