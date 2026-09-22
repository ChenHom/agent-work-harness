import { newId } from '../ids.ts';
import type {
  ContextItem, ContextManifest, WorkContract, DecisionRecord,
  RepositoryContractSnapshot, EvidenceRecord, Attempt, AttemptAuthority,
} from '../types.ts';
import { normalizePath } from '../work/parser.ts';
import { matchesGlob } from '../repo/paths.ts';

// §14/§15：每個 ContextItem 都帶 source 與 trust；Prompt Compiler 只依 kind/trust/priority 決定位置。

function item(
  kind: ContextItem['kind'], trust: ContextItem['trust'], priority: ContextItem['priority'],
  source: string, body: { content?: string; pointer?: string },
): ContextItem {
  return { id: newId('CI'), kind, trust, priority, source, ...body };
}

/** §34.4 / D6：初始 pointers = entryPoints + 使用者明確提到的 path。不做 ranking / RAG。 */
export function derivePointers(
  snapshot: RepositoryContractSnapshot,
  contract: WorkContract,
  decisions: readonly DecisionRecord[],
): string[] {
  const explicit = new Set<string>();
  const fromText = (t: string): void => {
    for (const m of t.matchAll(/[A-Za-z0-9_@.-]+\/[A-Za-z0-9_@./*-]+|[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}/g)) {
      explicit.add(normalizePath(m[0]));
    }
  };
  fromText(contract.request);
  contract.constraints.forEach(fromText);
  for (const d of decisions) if (d.kind === 'allow_path') explicit.add(d.value);
  contract.allowedPaths?.forEach((p) => explicit.add(p));

  const guarded = [...contract.deniedPaths, ...snapshot.contract.filesystem.protectedPaths];
  const isGuarded = (path: string): boolean => guarded.some((pattern) => matchesGlob(path, pattern));
  // Automatic entry points must not point into guarded areas; an explicit user path
  // remains visible so the agent can inspect it, while authority still forbids edits.
  const entryPoints = snapshot.contract.context.entryPoints.filter((p) => !isGuarded(p));
  return [...new Set([...entryPoints, ...explicit])].sort();
}

export function buildManifest(input: {
  contract: WorkContract;
  attempt: Attempt;
  authority: AttemptAuthority;
  decisions: readonly DecisionRecord[];
  snapshot: RepositoryContractSnapshot;
  userContext: readonly string[];
  previousAttempt?: Attempt;
  previousEvidence?: readonly EvidenceRecord[];
  previousClaims?: readonly string[];
}): ContextManifest {
  const { contract, attempt, authority, decisions, snapshot } = input;

  // P0 control：authority，永不裁切（§16）
  const control: ContextItem[] = [
    item('control', 'authority', 0, `contract:${contract.id}`, { content: contract.request }),
    item('control', 'authority', 0, 'harness:policy', {
      content: [
        `mode: ${authority.filesystem}`,
        `network: ${authority.network}`,
        authority.writablePaths?.length ? `writable: ${authority.writablePaths.join(', ')}` : 'writable: 整個 worktree（除 denied/protected 之外）',
        `denied: ${authority.deniedPaths.join(', ')}`,
      ].join('\n'),
    }),
  ];
  if (attempt.planId && attempt.branchId && attempt.milestoneId) {
    control.push(item('control', 'authority', 0, `plan:${attempt.planId}`, {
      content: `plan: ${attempt.planId}\nbranch: ${attempt.branchId}\nmilestone: ${attempt.milestoneId}`,
    }));
  }
  for (const c of contract.constraints) {
    control.push(item('control', 'authority', 0, `contract:${contract.id}`, { content: c }));
  }
  for (const s of contract.successCriteria) {
    control.push(item('control', 'authority', 0, `contract:${contract.id}:success`, { content: s }));
  }

  const decisionItems = decisions.map((d) =>
    item('decision', 'authority', 0, `user:${d.sourceMessageId}`, { content: `${d.kind}: ${d.value}` }));

  const userContext = input.userContext.map((t, i) =>
    item('user_context', 'trusted', 2, `user:context:${i}`, { content: t }));

  const pointers = derivePointers(snapshot, contract, decisions).map((p) =>
    item('pointer', 'untrusted', 3, 'repo', { pointer: p }));

  // §12：只帶 observed evidence 與必要 claim，不帶完整 transcript
  const previousEvidence: ContextItem[] = [];
  if (input.previousAttempt) {
    previousEvidence.push(item('evidence', 'trusted', 1, `attempt:${input.previousAttempt.id}`, {
      content: `Attempt: ${input.previousAttempt.id} (#${input.previousAttempt.number}, ${input.previousAttempt.status})`,
    }));
  }
  for (const e of input.previousEvidence ?? []) {
    previousEvidence.push(item('evidence', 'trusted', 1, `evidence:${e.id}`, {
      content: `${e.label}: ${e.status}${summarizeEvidence(e)}`,
    }));
  }
  for (const c of input.previousClaims ?? []) {
    previousEvidence.push(item('evidence', 'untrusted', 1, 'agent:claim', { content: `Previous claim: ${c}` }));
  }

  return {
    workId: contract.workId,
    attemptId: attempt.id,
    control,
    userContext,
    decisions: decisionItems,
    pointers,
    previousEvidence,
  };
}

function summarizeEvidence(e: EvidenceRecord): string {
  const d = e.data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return '';
  if (e.type === 'git_diff' && Array.isArray(d.changedPaths)) {
    return `\n  changed: ${(d.changedPaths as string[]).slice(0, 20).join(', ') || '(none)'}`;
  }
  if (typeof d.tail === 'string' && d.tail.length) {
    const tail = d.tail.split('\n').slice(-12).join('\n  ');
    return `\n  ${tail}`;
  }
  if (Array.isArray(d.violations) && d.violations.length) {
    return `\n  violations: ${JSON.stringify(d.violations)}`;
  }
  return '';
}
