import { newId, nowIso } from './ids.ts';
import { Store } from './trace/store.ts';
import { parseRequest } from './work/parser.ts';
import { loadSnapshot, ContractError } from './repo/contract.ts';
import { admitSkills } from './security/skills.ts';
import { buildManifest } from './context/manifest.ts';
import { applyBudget } from './context/budget.ts';
import { compilePrompt } from './prompt/compiler.ts';
import { CodexDriver, type PreparedCodexRun, type CodexRunResult } from './runtime/codex-driver.ts';
import { ensureRuntimeDirs } from './runtime/isolation.ts';
import {
  acquireExecutionOwnership,
  inspectExecutionOwnership,
  type DriverExecutionState,
  type ExecutionOwnership,
  OwnershipError,
} from './runtime/ownership.ts';
import { parseRuntimeResult, type ParseOutcome } from './runtime/result.ts';
import { baseRevision, snapshotDirty, observeGit, gitDiffEvidence, pathPolicyEvidence,
  type DirtyEntry, type GitObservation } from './evidence/git.ts';
import { runVerification, collectBaseline, type VerificationOutcome } from './evidence/verification.ts';
import { decideOutcome } from './evidence/outcome.ts';
import { buildResponse } from './response.ts';
import type {
  GlobalPolicy, Work, WorkContract, Attempt, AttemptAuthority, DecisionRecord,
  EvidenceRecord, OutcomeDecision, RuntimeResult, SkillAdmission, RepositoryContractSnapshot,
  Mode, VerificationBaseline,
} from './types.ts';

/**
 * runAttempt 的外部互動點。抽出來不是為了支援第二種 runtime（設計上明確不做），
 * 而是為了讓流程規則能在沒有 codex 的情況下被測試 —— 那 180 行裡的規則
 * 目前只能靠真實 attempt 驗證，一次幾分鐘。
 */
export interface RuntimeDriver {
  prepare(input: {
    attemptId: string; workspace: string; mode: Mode;
    promptText: string; approvedSkillPaths: readonly string[];
  }): PreparedCodexRun;
  run(run: PreparedCodexRun, onState?: (state: DriverExecutionState) => void): Promise<CodexRunResult>;
}

interface OwnershipContext {
  state: DriverExecutionState;
  update(state: DriverExecutionState): void;
  assertValid(): void;
}

/** prepareAttempt 的三段之間傳遞的東西。attempt 是同一個物件參考被逐段補齊，不複製。 */
interface ReadyAttempt {
  kind: 'ready';
  work: Work;
  contract: WorkContract;
  snapshot: RepositoryContractSnapshot;
  admissions: SkillAdmission[];
  attempt: Attempt;
  prompt: ReturnType<typeof compilePrompt>;
  /** insertAttempt 之前的 attempts —— retry budget 用這份算 */
  priorAttempts: Attempt[];
}

type PreparedAttempt = ReadyAttempt | { kind: 'short_circuit'; report: AttemptReport };

interface RuntimeExecution {
  run: CodexRunResult;
  parsed: ParseOutcome;
}

export interface EvidenceCollector {
  baseRevision(workspace: string): Promise<string>;
  snapshotDirty(workspace: string): Promise<DirtyEntry[]>;
  observeGit(workspace: string, base: string, preExisting: readonly DirtyEntry[]): Promise<GitObservation>;
  collectBaseline(snapshot: RepositoryContractSnapshot, workspace: string): Promise<VerificationBaseline[]>;
  runVerification(
    snapshot: RepositoryContractSnapshot, workspace: string,
    ids: { workId: string; attemptId: string; baseRevision: string; headRevision: string },
    baseline: readonly VerificationBaseline[] | undefined,
  ): Promise<VerificationOutcome>;
}

/** 預設實作：把既有函式綁上 policy，行為完全不變。 */
function defaultEvidenceCollector(policy: GlobalPolicy, log?: (m: string) => void): EvidenceCollector {
  return {
    baseRevision: (ws) => baseRevision(policy, ws),
    snapshotDirty: (ws) => snapshotDirty(policy, ws),
    observeGit: (ws, base, pre) => observeGit(policy, ws, base, pre),
    collectBaseline: (snap, ws) => collectBaseline(policy, snap, ws, log),
    runVerification: (snap, ws, ids, baseline) => runVerification(policy, snap, ws, ids, baseline, log),
  };
}

export interface AttemptReport {
  attempt: Attempt;
  decision: OutcomeDecision;
  result?: RuntimeResult;
  evidence: EvidenceRecord[];
  response: string;
}

export class Orchestrator {
  private readonly driver: RuntimeDriver;
  private readonly evidence: EvidenceCollector;
  private readonly policy: GlobalPolicy;
  private readonly store: Store;
  private readonly log: (m: string) => void;

  constructor(
    policy: GlobalPolicy, store: Store, log: (m: string) => void = () => {},
    deps?: { driver?: RuntimeDriver; evidence?: EvidenceCollector },
  ) {
    this.policy = policy;
    this.store = store;
    this.log = log;
    this.driver = deps?.driver ?? new CodexDriver(policy);
    this.evidence = deps?.evidence ?? defaultEvidenceCollector(policy, log);
  }

  // ---------------------------------------------------------------- work

  createWork(
    input: { request: string; workspace: string; title?: string; successCriteria?: string[] },
    ownership?: ExecutionOwnership,
  ): Work {
    return this.withOwnershipSync(ownership, () => this.createWorkOwned(input));
  }

  private createWorkOwned(input: { request: string; workspace: string; title?: string; successCriteria?: string[] }): Work {
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
  answer(workId: string, text: string, ownership?: ExecutionOwnership): DecisionRecord[] {
    return this.withOwnershipSync(ownership, () => this.answerOwned(workId, text));
  }

  private answerOwned(workId: string, text: string): DecisionRecord[] {
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

  /**
   * 一次 Attempt 的三段：準備（凍結 contract、編 prompt、取 baseline）→ 執行 runtime
   * → 收 evidence 並判定。切開是為了讓每段的前後順序看得見 —— 特別是
   * baseline 必須在 insertAttempt 之前、retry budget 必須用準備當下的 attempts。
   */
  async runAttempt(
    workId: string,
    opts?: { retryOf?: string; noBaseline?: boolean; ownership?: ExecutionOwnership },
  ): Promise<AttemptReport> {
    return this.withOwnership(opts?.ownership, (context) => this.runAttemptOwned(workId, opts, context));
  }

  private async runAttemptOwned(
    workId: string,
    opts: { retryOf?: string; noBaseline?: boolean } | undefined,
    ownership: OwnershipContext,
  ): Promise<AttemptReport> {
    const work = this.requireWork(workId);
    const prepared = await this.prepareAttempt(work, opts);
    if (prepared.kind === 'short_circuit') return prepared.report;
    const exec = await this.executeRuntime(prepared, ownership);
    return this.collectAndDecide(prepared, exec, ownership, opts);
  }

  /**
   * 準備階段。兩條路徑不會進 runtime（contract 無效、skill admission 被拒），
   * 用 short_circuit 回報，讓 runAttempt 自己決定要不要往下走。
   */
  private async prepareAttempt(work: Work, opts?: { retryOf?: string; noBaseline?: boolean }): Promise<PreparedAttempt> {
    const workId = work.id;
    const contract = this.currentContract(work);

    // §34.1.1：每次 Attempt 前重新 load → validate → hash → freeze
    let snapshot: RepositoryContractSnapshot;
    try {
      snapshot = loadSnapshot(work.workspace, this.policy);
    } catch (e) {
      const err = e as ContractError;
      return { kind: 'short_circuit', report: this.blockedReport(work, contract, `${err.code}: ${err.message}`) };
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
      return { kind: 'short_circuit', report: this.finishWithoutRuntime(work, contract, decision) };
    }

    const base = await this.evidence.baseRevision(work.workspace);
    // attempt 開始前就存在的未提交變更不能算到 agent 頭上
    const preExistingDirty = await this.evidence.snapshotDirty(work.workspace);
    if (preExistingDirty.length) {
      this.store.event('evidence.collected', { preExistingDirty: preExistingDirty.map((d) => d.path) }, workId);
    }
    // retry budget 要用「這次之前」的 attempts；等 insertAttempt 之後再抓會多算自己一次
    const priorAttempts = this.store.listAttempts(workId);
    const attemptId = newId('A');
    const attempt: Attempt = {
      id: attemptId, workId, number: priorAttempts.length + 1, mode: contract.mode,
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

    // §23.4：pre-flight baseline —— agent 動任何東西之前先跑一次 required checks，
    // 之後才能判斷「有沒有比動手前變差或少跑」。read attempt 不跑 verification，也就不需要。
    // 位置必須在 insertAttempt 之前：這裡失敗代表這次 attempt 根本沒開始。
    if (contract.mode === 'write' && !opts?.noBaseline) {
      this.log('收集 pre-flight baseline（agent 尚未執行）…');
      attempt.baseline = await this.evidence.collectBaseline(snapshot, work.workspace);
    }

    this.store.insertAttempt(attempt);
    attempt.status = 'RUNNING';
    this.store.updateAttempt(attempt);
    this.store.setWorkState(workId, 'RUNNING');

    return { kind: 'ready', work, contract, snapshot, admissions, attempt, prompt, priorAttempts };
  }

  /** runtime 執行 + §22 protocol 解析。這一段是唯一會呼叫外部 agent 的地方。 */
  private async executeRuntime(p: ReadyAttempt, ownership: OwnershipContext): Promise<RuntimeExecution> {
    const { work, contract, attempt, admissions, prompt } = p;

    // Codex 執行（§21）
    this.log(`attempt #${attempt.number} 執行中（${contract.mode}）…`);
    const skillPaths = admissions.filter((a) => a.allowed)
      .map((a) => a.path)
      .filter((s): s is string => Boolean(s));
    const prepared = this.driver.prepare({
      attemptId: attempt.id, workspace: work.workspace, mode: contract.mode,
      promptText: prompt.text, approvedSkillPaths: skillPaths,
    });
    ownership.update({ phase: 'prepared', child: null, quiesced: true });
    ownership.update({ phase: 'launching', child: null, quiesced: false });
    const run = await this.driver.run(prepared, (state) => ownership.update(state));
    ownership.assertValid();
    if (ownership.state.phase !== 'stopped' || !ownership.state.quiesced) {
      throw new OwnershipError('OWNER_UNKNOWN', inspectExecutionOwnership(this.policy.stateDir));
    }
    this.store.putArtifact('runtime_stdout', run.stdout, 'log');
    if (run.stderr) this.store.putArtifact('runtime_stderr', run.stderr, 'log');

    // §22 protocol
    const parsed = parseRuntimeResult(run.lastMessage || run.stdout, { workId: work.id, attemptId: attempt.id });
    if (!parsed.ok) {
      this.store.event('runtime.protocol_failed', {
        error: parsed.error, exitCode: run.exitCode, timedOut: run.timedOut,
      }, work.id, attempt.id);
    }
    return { run, parsed };
  }

  /** evidence → 判定 → 落地。agent 說了什麼在這裡只是輸入之一，不是結論。 */
  private async collectAndDecide(
    p: ReadyAttempt, exec: RuntimeExecution, ownership: OwnershipContext, opts?: { retryOf?: string },
  ): Promise<AttemptReport> {
    const { work, contract, snapshot, attempt, admissions, priorAttempts } = p;
    const { run, parsed } = exec;
    const workId = work.id;
    ownership.assertValid();

    // §23 evidence：無論 agent 說什麼都要自己觀察
    this.store.setWorkState(workId, 'VERIFYING');
    const evidence = await this.collectEvidence({
      work, contract, snapshot, attempt, base: attempt.baseRevision,
      runWrite: contract.mode === 'write',
    });
    ownership.assertValid();

    // 本次若是 retry，必須把自己算進已用次數，否則 budget 永遠用不完
    const usedRetries = countRetries(priorAttempts) + (opts?.retryOf ? 1 : 0);
    const retryBudgetRemaining = Math.max(0, work.retryBudget - usedRetries);
    const decision = decideOutcome({
      mode: contract.mode, skillAdmissions: admissions,
      protocolOk: parsed.ok,
      protocolError: parsed.ok ? undefined : parsed.error,
      runtimeResult: parsed.ok ? parsed.result : undefined,
      evidence, retryBudgetRemaining,
      runtimeCrashed: run.timedOut,
    });

    if (parsed.ok) {
      attempt.resultArtifactId = this.store.putArtifact('runtime_result', JSON.stringify(parsed.result, null, 2), 'json').id;
    }
    attempt.status = parsed.ok ? 'COMPLETED' : 'PROTOCOL_FAILED';
    attempt.endedAt = nowIso();
    this.store.updateAttempt(attempt);
    this.store.event('attempt.completed', {
      status: attempt.status, exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs,
    }, workId, attempt.id);

    this.store.insertOutcome(workId, attempt.id, decision.outcome, decision.reasons);
    this.applyWorkState(workId, decision);

    const response = buildResponse({
      attempt, decision,
      result: parsed.ok ? parsed.result : undefined,
      evidence,
      notExecuted: notExecutedList(contract, decision),
    });
    return { attempt, decision, result: parsed.ok ? parsed.result : undefined, evidence, response };
  }

  private async collectEvidence(input: {
    work: Work; contract: WorkContract; snapshot: RepositoryContractSnapshot;
    attempt: Attempt; base: string; runWrite: boolean;
  }): Promise<EvidenceRecord[]> {
    const { work, contract, snapshot, attempt, base } = input;
    const evidence: EvidenceRecord[] = [];

    const obs = await this.evidence.observeGit(work.workspace, base, attempt.preExistingDirty ?? []);
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
    if (input.runWrite && gitEv.status === 'PASS' && pathEv.status === 'PASS' && obs.changedPaths.length > 0) {
      const v = await this.evidence.runVerification(snapshot, work.workspace,
        { workId: work.id, attemptId: attempt.id, baseRevision: base, headRevision: obs.head },
        attempt.baseline);
      for (const e of v.evidence) { evidence.push(e); this.store.insertEvidence(e); }
    }
    return evidence;
  }

  // ---------------------------------------------------------------- retry / recovery

  async retry(
    workId: string,
    opts?: { noBaseline?: boolean; ownership?: ExecutionOwnership },
  ): Promise<AttemptReport> {
    return this.withOwnership(opts?.ownership, (context) => this.retryOwned(workId, opts, context));
  }

  private async retryOwned(
    workId: string,
    opts: { noBaseline?: boolean } | undefined,
    ownership: OwnershipContext,
  ): Promise<AttemptReport> {
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
    return this.runAttemptOwned(workId, { retryOf: last.id, noBaseline: opts?.noBaseline }, ownership);
  }

  /** §D5：不得直接 auto-rerun 同一 Attempt。啟動時把殘留 RUNNING 標成 RECOVERY_REQUIRED。 */
  markCrashedAttempts(ownership?: ExecutionOwnership): Attempt[] {
    return this.withOwnershipSync(ownership, () => this.markCrashedAttemptsOwned());
  }

  private markCrashedAttemptsOwned(): Attempt[] {
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
  async recover(workId: string, ownership?: ExecutionOwnership): Promise<AttemptReport> {
    return this.withOwnership(ownership, () => this.recoverOwned(workId));
  }

  private async recoverOwned(workId: string): Promise<AttemptReport> {
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

  private withOwnershipSync<T>(ownership: ExecutionOwnership | undefined, action: () => T): T {
    const acquired = ownership ?? acquireExecutionOwnership(this.policy.stateDir);
    let operationBegun = false;
    try {
      if (!acquired.validate()) {
        throw new OwnershipError('OWNER_UNKNOWN', inspectExecutionOwnership(this.policy.stateDir));
      }
      if (!acquired.beginOperation()) {
        throw new OwnershipError('OWNER_ACTIVE', inspectExecutionOwnership(this.policy.stateDir));
      }
      operationBegun = true;
      return action();
    } finally {
      if (operationBegun) acquired.endOperation();
      if (!ownership) acquired.release();
    }
  }

  private async withOwnership<T>(
    ownership: ExecutionOwnership | undefined,
    action: (context: OwnershipContext) => Promise<T>,
  ): Promise<T> {
    const acquired = ownership ?? acquireExecutionOwnership(this.policy.stateDir);
    let operationBegun = false;
    try {
      if (!acquired.validate()) {
        throw new OwnershipError('OWNER_UNKNOWN', inspectExecutionOwnership(this.policy.stateDir));
      }
      if (!acquired.beginOperation()) {
        throw new OwnershipError('OWNER_ACTIVE', inspectExecutionOwnership(this.policy.stateDir));
      }
      operationBegun = true;
      ensureRuntimeDirs(this.policy);
      const policyStateDir = this.policy.stateDir;
      const context: OwnershipContext = {
        state: { phase: 'not_started', child: null, quiesced: true },
        update(state) {
          if (!acquired.update(state)) {
            throw new OwnershipError('OWNER_UNKNOWN', inspectExecutionOwnership(policyStateDir));
          }
          context.state = state;
        },
        assertValid() {
          if (!acquired.validate()) {
            throw new OwnershipError('OWNER_UNKNOWN', inspectExecutionOwnership(policyStateDir));
          }
        },
      };
      return await action(context);
    } finally {
      if (operationBegun) acquired.endOperation();
      if (!ownership) acquired.release();
    }
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
