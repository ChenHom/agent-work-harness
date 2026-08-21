import { newId, nowIso } from './ids.ts';
import { Store } from './trace/store.ts';
import { parseRequest } from './work/parser.ts';
import { loadSnapshot, ContractError } from './repo/contract.ts';
import { admitSkills } from './security/skills.ts';
import { buildManifest } from './context/manifest.ts';
import { applyBudget } from './context/budget.ts';
import { compilePrompt } from './prompt/compiler.ts';
import { CodexDriver } from './runtime/codex-driver.ts';
import { parseRuntimeResult } from './runtime/result.ts';
import { baseRevision, snapshotDirty, observeGit, gitDiffEvidence, pathPolicyEvidence } from './evidence/git.ts';
import { runVerification } from './evidence/verification.ts';
import { decideOutcome } from './evidence/outcome.ts';
import { buildResponse } from './response.ts';
import type {
  GlobalPolicy, Work, WorkContract, Attempt, AttemptAuthority, DecisionRecord,
  EvidenceRecord, OutcomeDecision, RuntimeResult, SkillAdmission, RepositoryContractSnapshot,
} from './types.ts';

export interface AttemptReport {
  attempt: Attempt;
  decision: OutcomeDecision;
  result?: RuntimeResult;
  evidence: EvidenceRecord[];
  response: string;
}

export class Orchestrator {
  private readonly driver: CodexDriver;
  private readonly policy: GlobalPolicy;
  private readonly store: Store;
  private readonly log: (m: string) => void;

  constructor(policy: GlobalPolicy, store: Store, log: (m: string) => void = () => {}) {
    this.policy = policy;
    this.store = store;
    this.log = log;
    this.driver = new CodexDriver(policy);
  }

  // ---------------------------------------------------------------- work

  createWork(input: { request: string; workspace: string; title?: string; successCriteria?: string[] }): Work {
    const snapshot = loadSnapshot(input.workspace, this.policy);  // fail fast：沒有 contract 就不建 work
    const parsed = parseRequest(input.request);
    const workId = newId('W');
    const messageId = this.store.insertMessage('user', input.request, workId);

    const work: Work = {
      id: workId,
      title: input.title ?? input.request.slice(0, 60),
      repositoryId: snapshot.contract.repositoryId,
      workspace: input.workspace,
      state: 'ACTIVE',
      currentContractVersion: 1,
      retryBudget: this.policy.defaultRetryBudget,
      createdAt: nowIso(),
    };
    this.store.insertWork(work);

    const contract: WorkContract = {
      id: newId('WC'), workId, version: 1,
      request: input.request,                    // §2.1：原文永不被整理覆蓋
      mode: parsed.mode,
      constraints: parsed.constraints,
      allowedPaths: parsed.allowedPaths,
      deniedPaths: parsed.deniedPaths,
      successCriteria: input.successCriteria ?? [
        'Repository Contract 中的 required verification 全部通過',
        'denied / protected paths 未被變更',
      ],
      sourceMessageIds: [messageId],
      createdAt: nowIso(),
    };
    this.store.insertContract(contract);
    this.recordDecisions(workId, messageId, parsed);
    this.store.event('context_manifest.created', { parsed: parsed.matched }, workId);
    return work;
  }

  private recordDecisions(workId: string, messageId: string, parsed: ReturnType<typeof parseRequest>): void {
    const add = (kind: DecisionRecord['kind'], value: string): void => {
      this.store.insertDecision({ id: newId('D'), workId, sourceMessageId: messageId, kind, value, createdAt: nowIso() });
    };
    parsed.deniedPaths.forEach((p) => add('deny_path', p));
    parsed.allowPathDecisions.forEach((p) => add('allow_path', p));
    parsed.allowedPaths?.forEach((p) => add('allow_path', p));
    parsed.constraints.forEach((c) => add('constraint', c));
  }

  /** 使用者回覆 → 只累積 Decision，不累積 conversation（§13）。 */
  answer(workId: string, text: string): DecisionRecord[] {
    const work = this.requireWork(workId);
    const messageId = this.store.insertMessage('user', text, workId);
    const parsed = parseRequest(text);
    const before = this.store.listDecisions(workId).length;
    this.recordDecisions(workId, messageId, parsed);
    const all = this.store.listDecisions(workId);

    // 使用者的新限制要進入下一版 contract（§13 既有 deny 不因擴權消失）
    const contract = this.currentContract(work);
    const next: WorkContract = {
      ...contract, id: newId('WC'), version: contract.version + 1,
      deniedPaths: [...new Set([...contract.deniedPaths, ...parsed.deniedPaths])],
      constraints: [...new Set([...contract.constraints, ...parsed.constraints])],
      allowedPaths: mergeAllowed(contract.allowedPaths, parsed.allowedPaths, parsed.allowPathDecisions),
      sourceMessageIds: [...contract.sourceMessageIds, messageId],
      createdAt: nowIso(),
    };
    this.store.insertContract(next);
    this.store.setContractVersion(workId, next.version);
    this.store.setWorkState(workId, 'ACTIVE');
    return all.slice(before);
  }

  // ---------------------------------------------------------------- attempt

  async runAttempt(workId: string, opts?: { retryOf?: string }): Promise<AttemptReport> {
    const work = this.requireWork(workId);
    const contract = this.currentContract(work);

    // §34.1.1：每次 Attempt 前重新 load → validate → hash → freeze
    let snapshot: RepositoryContractSnapshot;
    try {
      snapshot = loadSnapshot(work.workspace, this.policy);
    } catch (e) {
      const err = e as ContractError;
      return this.blockedReport(work, contract, `${err.code}: ${err.message}`);
    }

    const authority = buildAuthority(contract, snapshot);
    const requestedSkills = snapshot.contract.skills ?? [];
    const admissions = requestedSkills.length ? admitSkills(this.policy, requestedSkills) : [];
    for (const a of admissions) {
      this.store.event(a.allowed ? 'skill.admission_allowed' : 'skill.admission_denied',
        { skillId: a.skillId, reason: a.reason, actualHash: a.actualHash }, workId);
    }
    if (admissions.some((a) => !a.allowed)) {
      const decision = decideOutcome({
        mode: contract.mode, skillAdmissions: admissions, protocolOk: true,
        evidence: [], retryBudgetRemaining: 0,
      });
      return this.finishWithoutRuntime(work, contract, decision);
    }

    const base = await baseRevision(this.policy, work.workspace);
    // attempt 開始前就存在的未提交變更不能算到 agent 頭上
    const preExistingDirty = await snapshotDirty(this.policy, work.workspace);
    if (preExistingDirty.length) {
      this.store.event('evidence.collected', { preExistingDirty: preExistingDirty.map((d) => d.path) }, workId);
    }
    const attempts = this.store.listAttempts(workId);
    const attemptId = newId('A');
    const attempt: Attempt = {
      id: attemptId, workId, number: attempts.length + 1, mode: contract.mode,
      contractVersion: contract.version, contractSnapshotHash: snapshot.hash,
      baseRevision: base, preExistingDirty, promptArtifactId: '', runtime: 'codex', status: 'CREATED',
      retryOf: opts?.retryOf, startedAt: nowIso(),
    };

    // Context（§15/§16）→ Prompt（§17）
    const previous = opts?.retryOf ? this.store.getAttempt(opts.retryOf) ?? undefined : undefined;
    const manifest = buildManifest({
      contract, attempt, authority,
      decisions: this.store.listDecisions(workId),
      snapshot,
      userContext: [],
      previousAttempt: previous,
      previousEvidence: previous ? this.store.listEvidence(previous.id) : [],
      previousClaims: previous ? this.previousClaims(previous.id) : [],
    });
    const budgeted = applyBudget(manifest, this.policy.promptBudgetChars);
    attempt.contextDropped = budgeted.dropped;
    if (budgeted.dropped.length) this.store.event('context_manifest.created', { dropped: budgeted.dropped }, workId, attemptId);

    const prompt = compilePrompt({
      manifest: budgeted.manifest, contract, authority, snapshot,
      workspace: work.workspace, attemptId, workId,
      approvedSkills: admissions.filter((a) => a.allowed).map((a) => a.skillId),
    });
    const promptArtifact = this.store.putArtifact('prompt', prompt.text, 'txt');
    attempt.promptArtifactId = promptArtifact.id;
    this.store.event('prompt.compiled', {
      hash: prompt.hash, compilerVersion: prompt.compilerVersion,
      chars: prompt.text.length, artifactId: promptArtifact.id,
    }, workId, attemptId);

    this.store.insertAttempt(attempt);
    attempt.status = 'RUNNING';
    this.store.updateAttempt(attempt);
    this.store.setWorkState(workId, 'RUNNING');

    // Codex 執行（§21）
    this.log(`attempt #${attempt.number} 執行中（${contract.mode}）…`);
    const skillPaths = admissions.filter((a) => a.allowed)
      .map((a) => a.path)
      .filter((p): p is string => Boolean(p));
    const prepared = this.driver.prepare({
      attemptId, workspace: work.workspace, mode: contract.mode,
      promptText: prompt.text, approvedSkillPaths: skillPaths,
    });
    const run = await this.driver.run(prepared);
    this.store.putArtifact('runtime_stdout', run.stdout, 'log');
    if (run.stderr) this.store.putArtifact('runtime_stderr', run.stderr, 'log');

    // §22 protocol
    const parsedResult = parseRuntimeResult(run.lastMessage || run.stdout, { workId, attemptId });
    if (!parsedResult.ok) {
      this.store.event('runtime.protocol_failed', {
        error: parsedResult.error, exitCode: run.exitCode, timedOut: run.timedOut,
      }, workId, attemptId);
    }

    // §23 evidence：無論 agent 說什麼都要自己觀察
    this.store.setWorkState(workId, 'VERIFYING');
    const evidence = await this.collectEvidence({
      work, contract, snapshot, attempt, base,
      runWrite: contract.mode === 'write',
    });

    // 本次若是 retry，必須把自己算進已用次數，否則 budget 永遠用不完
    const usedRetries = countRetries(attempts) + (opts?.retryOf ? 1 : 0);
    const retryBudgetRemaining = Math.max(0, work.retryBudget - usedRetries);
    const decision = decideOutcome({
      mode: contract.mode, skillAdmissions: admissions,
      protocolOk: parsedResult.ok,
      protocolError: parsedResult.ok ? undefined : parsedResult.error,
      runtimeResult: parsedResult.ok ? parsedResult.result : undefined,
      evidence, retryBudgetRemaining,
      runtimeCrashed: run.timedOut,
    });

    if (parsedResult.ok) {
      attempt.resultArtifactId = this.store.putArtifact('runtime_result', JSON.stringify(parsedResult.result, null, 2), 'json').id;
    }
    attempt.status = parsedResult.ok ? 'COMPLETED' : 'PROTOCOL_FAILED';
    attempt.endedAt = nowIso();
    this.store.updateAttempt(attempt);
    this.store.event('attempt.completed', {
      status: attempt.status, exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs,
    }, workId, attemptId);

    this.store.insertOutcome(workId, attemptId, decision.outcome, decision.reasons);
    this.applyWorkState(workId, decision);

    const response = buildResponse({
      attempt, decision,
      result: parsedResult.ok ? parsedResult.result : undefined,
      evidence,
      notExecuted: notExecutedList(contract, decision),
    });
    return { attempt, decision, result: parsedResult.ok ? parsedResult.result : undefined, evidence, response };
  }

  private async collectEvidence(input: {
    work: Work; contract: WorkContract; snapshot: RepositoryContractSnapshot;
    attempt: Attempt; base: string; runWrite: boolean;
  }): Promise<EvidenceRecord[]> {
    const { work, contract, snapshot, attempt, base } = input;
    const evidence: EvidenceRecord[] = [];

    const obs = await observeGit(this.policy, work.workspace, base, attempt.preExistingDirty ?? []);
    const diffArtifact = this.store.putArtifact('git_diff', obs.diff, 'diff');
    const gitEv = gitDiffEvidence(work.id, attempt.id, obs, diffArtifact.id);
    evidence.push(gitEv);
    this.store.insertEvidence(gitEv);

    // read attempt：任何變更都代表 enforcement 失效
    const pathPolicy = contract.mode === 'read'
      ? { deniedPaths: ['**'] }
      : {
          deniedPaths: [...new Set([...contract.deniedPaths, ...snapshot.contract.filesystem.protectedPaths])],
          allowedPaths: contract.allowedPaths,
        };
    const pathEv = pathPolicyEvidence(work.id, attempt.id, obs.changedPaths, pathPolicy);
    evidence.push(pathEv);
    this.store.insertEvidence(pathEv);

    // §23.3：read attempt 不跑 verification；越界時也不跑（先讓使用者處理）
    if (input.runWrite && pathEv.status === 'PASS' && obs.changedPaths.length > 0) {
      const v = await runVerification(this.policy, snapshot, work.workspace,
        { workId: work.id, attemptId: attempt.id }, this.log);
      for (const e of v.evidence) { evidence.push(e); this.store.insertEvidence(e); }
    }
    return evidence;
  }

  // ---------------------------------------------------------------- retry / recovery

  async retry(workId: string): Promise<AttemptReport> {
    const work = this.requireWork(workId);
    const attempts = this.store.listAttempts(workId);
    const last = attempts.at(-1);
    if (!last) throw new Error('沒有可重試的 attempt');
    const used = countRetries(attempts);
    if (used >= work.retryBudget) {
      const decision: OutcomeDecision = { outcome: 'FAILED', reasons: [`retry budget 已用盡（${work.retryBudget}）`] };
      this.store.insertOutcome(workId, last.id, decision.outcome, decision.reasons);
      this.applyWorkState(workId, decision);
      return { attempt: last, decision, evidence: this.store.listEvidence(last.id), response: buildResponse({ attempt: last, decision, evidence: this.store.listEvidence(last.id), notExecuted: [] }) };
    }
    return this.runAttempt(workId, { retryOf: last.id });
  }

  /** §D5：不得直接 auto-rerun 同一 Attempt。啟動時把殘留 RUNNING 標成 RECOVERY_REQUIRED。 */
  markCrashedAttempts(): Attempt[] {
    const stuck = this.store.attemptsByStatus('RUNNING');
    for (const a of stuck) {
      a.status = 'RECOVERY_REQUIRED';
      a.endedAt = nowIso();
      this.store.updateAttempt(a);
      this.store.event('recovery.required', { attemptId: a.id, reason: 'RUNNING 狀態下 harness 重啟' }, a.workId, a.id);
      this.store.setWorkState(a.workId, 'BLOCKED');
    }
    return stuck;
  }

  /** 對 RECOVERY_REQUIRED 的 attempt 重新收集 evidence，由使用者決定接受或重試。 */
  async recover(workId: string): Promise<AttemptReport> {
    const work = this.requireWork(workId);
    const contract = this.currentContract(work);
    const attempt = this.store.listAttempts(workId).at(-1);
    if (!attempt) throw new Error('沒有 attempt 可恢復');
    const snapshot = loadSnapshot(work.workspace, this.policy);
    const evidence = await this.collectEvidence({
      work, contract, snapshot, attempt, base: attempt.baseRevision, runWrite: contract.mode === 'write',
    });
    const decision: OutcomeDecision = {
      outcome: 'NEEDS_USER_DECISION',
      reasons: ['上一個 attempt 在執行中中斷，已重新收集 evidence；請確認要接受現況、捨棄或建立新的 retry attempt'],
    };
    this.store.insertOutcome(workId, attempt.id, decision.outcome, decision.reasons);
    this.store.setWorkState(workId, 'WAITING_USER');
    return { attempt, decision, evidence, response: buildResponse({ attempt, decision, evidence, notExecuted: [] }) };
  }

  // ---------------------------------------------------------------- helpers

  /** §12：只帶必要 claim，且明確標記為 agent 自述，不與 observed evidence 混用。 */
  private previousClaims(attemptId: string): string[] {
    const attempt = this.store.getAttempt(attemptId);
    if (!attempt?.resultArtifactId) return [];
    const raw = this.store.readArtifact(attempt.resultArtifactId);
    if (!raw) return [];
    try {
      const r = JSON.parse(raw) as RuntimeResult;
      return r.claims
        .filter((c) => c.type === 'diagnosis' || c.type === 'change' || c.type === 'limitation')
        .slice(0, 5)
        .map((c) => `[${c.type}] ${c.text}`);
    } catch { return []; }
  }

  private requireWork(workId: string): Work {
    const w = this.store.getWork(workId);
    if (!w) throw new Error(`找不到 work ${workId}`);
    return w;
  }

  private currentContract(work: Work): WorkContract {
    const c = this.store.getContract(work.id, work.currentContractVersion);
    if (!c) throw new Error(`找不到 contract ${work.id} v${work.currentContractVersion}`);
    return c;
  }

  private applyWorkState(workId: string, decision: OutcomeDecision): void {
    const map: Record<OutcomeDecision['outcome'], Work['state']> = {
      SUCCESS: 'DONE', NEEDS_USER_DECISION: 'WAITING_USER', RETRYABLE_FAILURE: 'ACTIVE',
      POLICY_VIOLATION: 'BLOCKED', BLOCKED: 'BLOCKED', FAILED: 'FAILED',
    };
    this.store.setWorkState(workId, map[decision.outcome]);
    if (decision.outcome === 'SUCCESS') this.store.event('work.completed', {}, workId);
    if (decision.outcome === 'BLOCKED' || decision.outcome === 'POLICY_VIOLATION') this.store.event('work.blocked', { reasons: decision.reasons }, workId);
  }

  private blockedReport(work: Work, contract: WorkContract, reason: string): AttemptReport {
    const decision: OutcomeDecision = { outcome: 'BLOCKED', reasons: [reason] };
    return this.finishWithoutRuntime(work, contract, decision);
  }

  private finishWithoutRuntime(work: Work, contract: WorkContract, decision: OutcomeDecision): AttemptReport {
    const attempt: Attempt = {
      id: newId('A'), workId: work.id, number: this.store.listAttempts(work.id).length + 1,
      mode: contract.mode, contractVersion: contract.version, contractSnapshotHash: 'n/a',
      baseRevision: 'n/a', promptArtifactId: '', runtime: 'codex', status: 'FAILED', startedAt: nowIso(),
      endedAt: nowIso(),
    };
    this.store.insertAttempt(attempt);
    this.store.updateAttempt(attempt);
    this.store.insertOutcome(work.id, attempt.id, decision.outcome, decision.reasons);
    this.applyWorkState(work.id, decision);
    return { attempt, decision, evidence: [], response: buildResponse({ attempt, decision, evidence: [], notExecuted: ['codex 未啟動'] }) };
  }
}

/** §20 / §34.3：Effective Authority = Global Policy ∩ Repository Contract ∩ User Decisions ∩ Attempt Mode。 */
export function buildAuthority(contract: WorkContract, snapshot: RepositoryContractSnapshot): AttemptAuthority {
  return {
    filesystem: contract.mode === 'read' ? 'read-only' : 'workspace-write',
    writablePaths: contract.mode === 'write' ? contract.allowedPaths : undefined,
    deniedPaths: [...new Set([...snapshot.contract.filesystem.protectedPaths, ...contract.deniedPaths])].sort(),
    network: 'deny',   // Global Policy 上限，repo 不能放寬
  };
}

function mergeAllowed(current: string[] | undefined, onlyPaths: string[] | undefined, allowDecisions: string[]): string[] | undefined {
  // §20.1：allowedPaths 只有在「使用者明確限定」時存在。
  // 已存在限制時，新的 allow 決策才會擴張這個 allowlist；否則維持 undefined（整個 worktree）。
  if (onlyPaths?.length) return [...new Set([...(current ?? []), ...onlyPaths])];
  if (current?.length) return [...new Set([...current, ...allowDecisions])];
  return current;
}

function countRetries(attempts: readonly Attempt[]): number {
  return attempts.filter((a) => a.retryOf).length;
}

function notExecutedList(contract: WorkContract, decision: OutcomeDecision): string[] {
  const out: string[] = [];
  for (const c of contract.constraints) if (/不要|別|不用/.test(c)) out.push(c.replace(/^不要|^別|^不用/, '').trim() || c);
  if (decision.outcome !== 'SUCCESS' && contract.mode === 'write') out.push('未宣告本次工作完成');
  return out;
}
