// runAttempt 的流程規則。這些規則原本只能靠真實 codex attempt 驗證（一次數分鐘），
// 注入 collaborator 之後可以在毫秒內測到，而且能測「反向」與「邊界」——
// 那正是真實 attempt 很難刻意製造的情況。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/trace/store.ts';
import { Orchestrator, type RuntimeDriver, type EvidenceCollector } from '../src/orchestrator.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { CONTRACT_REL_PATH } from '../src/repo/contract.ts';
import type {
  AttemptInputSnapshot, AttemptOutputRefs, AttemptPhase,
  GlobalPolicy, RuntimeResult, VerificationBaseline,
} from '../src/types.ts';
import type { GitObservation, DirtyEntry } from '../src/evidence/git.ts';
import type { VerificationOutcome } from '../src/evidence/verification.ts';

// ---------------------------------------------------------------- fixtures

const CHECKS = [{ id: 'test', kind: 'test' as const, argv: ['npm', 'test'], required: true }];

let evSeq = 0;
/** required verification 失敗的 evidence。id 必須每次不同 —— 同一個 work 會插入多次。 */
function failingVerification(ids: { workId: string; attemptId: string } = { workId: 'W', attemptId: 'A' }): VerificationOutcome {
  const e = {
    id: `EV-fake-${++evSeq}`, ...ids, type: 'test_result' as const,
    label: 'test', status: 'FAIL' as const, data: { required: true }, observedAt: 'now',
  };
  return { evidence: [e], requiredFailed: [e], allRequiredPassed: false };
}

function repoWith(base: string, checks: unknown = CHECKS): string {
  const repo = join(base, 'repo');
  mkdirSync(join(repo, '.harness'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  writeFileSync(join(repo, CONTRACT_REL_PATH), JSON.stringify({
    schemaVersion: '1', repositoryId: 'fixture',
    context: { entryPoints: ['README.md'] },
    filesystem: { protectedPaths: ['secret/**'] },
    verification: { checks },
  }));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });
  return repo;
}

const completed = (workId: string, attemptId: string, paths: string[] = ['src/a.ts']): RuntimeResult => ({
  schemaVersion: '1', workId, attemptId, status: 'completed',
  summary: 'done', claims: [], questions: [], declaredChangedPaths: paths,
});

/** driver 回傳什麼由測試決定：一段文字（模擬 runtime 輸出）或一個產生器。 */
function fakeDriver(reply: (ids: { workId: string; attemptId: string }) => string,
                    opts?: { timedOut?: boolean }): RuntimeDriver & { calls: number } {
  const d = {
    calls: 0,
    prepare(input: { attemptId: string }) {
      return { attemptDir: '', promptPath: '', lastMessagePath: '', logPath: '',
        argv: [], env: {}, cwd: '', attemptId: input.attemptId } as never;
    },
    async run(run: unknown, onState?: Parameters<RuntimeDriver['run']>[1]) {
      d.calls++;
      const attemptId = (run as { attemptId: string }).attemptId;
      const child = { pid: process.pid, processStart: 'fixture' };
      onState?.({ phase: 'running', child, quiesced: false });
      onState?.({ phase: 'stopped', child, quiesced: true });
      return {
        exitCode: 0, signal: null, timedOut: opts?.timedOut ?? false,
        stdout: '', stderr: '', durationMs: 1,
        lastMessage: reply({ workId: '', attemptId }),
      };
    },
  };
  return d;
}

interface EvidenceOverrides {
  changedPaths?: string[];
  preExisting?: DirtyEntry[];
  verification?: VerificationOutcome;
  baseline?: VerificationBaseline[];
}

function fakeEvidence(over: EvidenceOverrides = {}): EvidenceCollector & { verificationCalls: number; baselineCalls: number } {
  const changed = over.changedPaths ?? [];
  const e = {
    verificationCalls: 0,
    baselineCalls: 0,
    async baseRevision() { return 'rev-base'; },
    async snapshotDirty() { return over.preExisting ?? []; },
    async observeGit(): Promise<GitObservation> {
      return { changedPaths: changed, preExistingUnchanged: [], diff: '',
        baseRevision: 'rev-base', head: 'rev-head', clean: changed.length === 0 };
    },
    async collectBaseline() { e.baselineCalls++; return over.baseline ?? []; },
    async runVerification(
      _snapshot: Parameters<EvidenceCollector['runVerification']>[0],
      _workspace: string,
      ids: Parameters<EvidenceCollector['runVerification']>[2],
    ): Promise<VerificationOutcome> {
      e.verificationCalls++;
      if (!over.verification) return { evidence: [], requiredFailed: [], allRequiredPassed: true };
      const evidence = over.verification.evidence.map((record) => ({ ...record, ...ids }));
      const failed = new Set(over.verification.requiredFailed.map((record) => record.id));
      return { ...over.verification, evidence, requiredFailed: evidence.filter((record) => failed.has(record.id)) };
    },
  };
  return e;
}

function setup(opts: { request?: string; retryBudget?: number; checks?: unknown;
                      driver?: RuntimeDriver; evidence?: EvidenceCollector } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'harness-flow-'));
  const policy: GlobalPolicy = { ...DEFAULT_POLICY, stateDir: join(base, 'state') };
  const store = new Store(policy.stateDir);
  const repo = repoWith(base, opts.checks ?? CHECKS);
  // workId 在 createWork 之後才存在，driver 卻要在建構時就傳入 —— 用 holder late-bind
  const ids = { workId: '' };
  const driver = opts.driver ?? fakeDriver(({ attemptId }) => JSON.stringify(completed(ids.workId, attemptId)));
  const evidence = opts.evidence ?? fakeEvidence();
  const orch = new Orchestrator(policy, store, () => {}, { driver, evidence });
  const work = orch.createWork({ request: opts.request ?? '修一個 bug', workspace: repo });
  ids.workId = work.id;
  if (opts.retryBudget !== undefined) {
    store.db.prepare('update works set retry_budget = ? where id = ?').run(opts.retryBudget, work.id);
  }
  return {
    base, store, orch, repo, work, driver, evidence,
    cleanup: () => { store.close(); rmSync(base, { recursive: true, force: true }); },
  };
}

// ---------------------------------------------------------------- 規則 1：retry budget

test('retry budget 正向：還有額度時，驗證失敗判 RETRYABLE_FAILURE', async () => {
  const s = setup({ retryBudget: 2, evidence: fakeEvidence({ changedPaths: ['src/a.ts'], verification: failingVerification() }) });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'RETRYABLE_FAILURE');
  s.cleanup();
});

test('retry budget 反向：額度用盡後轉 FAILED，不會無限重試', async () => {
  // 每次呼叫都要新的 evidence id，否則第二個 attempt 插入時會撞主鍵
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'] });
  ev.runVerification = async (_s, _w, ids) => failingVerification(ids);
  const s = setup({ retryBudget: 1, evidence: ev });
  const first = await s.orch.runAttempt(s.work.id);
  assert.equal(first.decision.outcome, 'RETRYABLE_FAILURE');
  const second = await s.orch.retry(s.work.id);           // 這一次就用掉唯一的額度
  assert.equal(second.decision.outcome, 'FAILED');
  s.cleanup();
});

test('retry budget 邊界：budget=0 時第一次失敗就是 FAILED', async () => {
  const s = setup({ retryBudget: 0, evidence: fakeEvidence({ changedPaths: ['src/a.ts'], verification: failingVerification() }) });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'FAILED');
  s.cleanup();
});

test('retry budget 正向：retry 一次後仍有額度 → 繼續 RETRYABLE', async () => {
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'] });
  ev.runVerification = async (_s, _w, ids) => failingVerification(ids);
  const s = setup({ retryBudget: 3, evidence: ev });
  await s.orch.runAttempt(s.work.id);
  const second = await s.orch.retry(s.work.id);
  assert.equal(second.decision.outcome, 'RETRYABLE_FAILURE');
  s.cleanup();
});

test('retry budget 正向：驗證通過時完全不消耗額度', async () => {
  const s = setup({ retryBudget: 1, evidence: fakeEvidence({ changedPaths: ['src/a.ts'] }) });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'SUCCESS');
  assert.equal(s.store.listAttempts(s.work.id).filter((a) => a.retryOf).length, 0);
  s.cleanup();
});

test('retry budget 反向：額度用盡後再 retry，不得再啟動 runtime', async () => {
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'] });
  ev.runVerification = async (_s, _w, ids) => failingVerification(ids);
  const driver = fakeDriver(() => 'not json');   // 一律 protocol 失敗，逼它耗盡額度
  const s = setup({ retryBudget: 1, driver, evidence: ev });
  await s.orch.runAttempt(s.work.id);
  await s.orch.retry(s.work.id);
  const callsBefore = driver.calls;
  const third = await s.orch.retry(s.work.id);
  assert.equal(third.decision.outcome, 'FAILED');
  assert.equal(driver.calls, callsBefore, '額度用盡後不該再花錢啟動 runtime');
  s.cleanup();
});

test('retry budget 反向：protocol 失敗同樣消耗額度', async () => {
  const s = setup({ retryBudget: 1, driver: fakeDriver(() => 'not json'),
    evidence: fakeEvidence({ changedPaths: ['src/a.ts'] }) });
  assert.equal((await s.orch.runAttempt(s.work.id)).decision.outcome, 'RETRYABLE_FAILURE');
  assert.equal((await s.orch.retry(s.work.id)).decision.outcome, 'FAILED');
  s.cleanup();
});

test('retry budget：retry 的 dispatch intent 已持久化即計費，重開後不會再派發', async () => {
  let failPrepare = false;
  const ids = { workId: '' };
  const base = fakeDriver(({ attemptId }) => JSON.stringify(completed(ids.workId, attemptId)));
  const driver: RuntimeDriver & { calls: number } = {
    get calls() { return base.calls; },
    prepare(input) {
      if (failPrepare) throw new Error('prepare crash');
      return base.prepare(input);
    },
    run: (...args) => base.run(...args),
  };
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'] });
  ev.runVerification = async (_s, _w, ids) => failingVerification(ids);
  const s = setup({ retryBudget: 1, driver, evidence: ev });
  ids.workId = s.work.id;
  assert.equal((await s.orch.runAttempt(s.work.id)).decision.outcome, 'RETRYABLE_FAILURE');

  failPrepare = true;
  await assert.rejects(() => s.orch.retry(s.work.id), /prepare crash/);
  const dispatchedRetry = s.store.listAttempts(s.work.id).at(-1)!;
  assert.equal(dispatchedRetry.phase, 'dispatch_intent');
  s.store.close();

  const reopened = new Store(join(s.base, 'state'));
  const orch = new Orchestrator(
    { ...DEFAULT_POLICY, stateDir: join(s.base, 'state') }, reopened, () => {}, { driver, evidence: ev });
  const before = driver.calls;
  const exhausted = await orch.retry(s.work.id);
  assert.equal(exhausted.decision.outcome, 'FAILED');
  assert.equal(driver.calls, before);
  assert.equal(reopened.listAttempts(s.work.id).length, 2);
  reopened.close();
  rmSync(s.base, { recursive: true, force: true });
});

test('retry budget 邊界：budget=0 時 retry 不建立新 attempt', async () => {
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'] });
  ev.runVerification = async (_s, _w, ids) => failingVerification(ids);
  const s = setup({ retryBudget: 0, evidence: ev });
  await s.orch.runAttempt(s.work.id);
  const before = s.store.listAttempts(s.work.id).length;
  const r = await s.orch.retry(s.work.id);
  assert.equal(r.decision.outcome, 'FAILED');
  assert.equal(s.store.listAttempts(s.work.id).length, before, '不該多出一個 attempt');
  s.cleanup();
});

test('retry budget 邊界：成功之後仍可 retry（成功不鎖死 work）', async () => {
  const s = setup({ retryBudget: 1, evidence: fakeEvidence({ changedPaths: ['src/a.ts'] }) });
  await s.orch.runAttempt(s.work.id);
  const again = await s.orch.retry(s.work.id);
  assert.equal(again.decision.outcome, 'SUCCESS');
  assert.equal(s.store.listAttempts(s.work.id).length, 2);
  s.cleanup();
});

// ---------------------------------------------------------------- 規則 2：protocol

test('protocol 正向：合法 RuntimeResult 且驗證通過 → SUCCESS', async () => {
  const s = setup({ evidence: fakeEvidence({ changedPaths: ['src/a.ts'] }) });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'SUCCESS');
  assert.equal(s.store.listAttempts(s.work.id)[0]!.status, 'COMPLETED');
  s.cleanup();
});

test('protocol 反向：runtime 回傳非 JSON → 不得進成功路徑，attempt 標 PROTOCOL_FAILED', async () => {
  const s = setup({
    retryBudget: 0,
    driver: fakeDriver(() => '我做完了，測試都過了'),
    evidence: fakeEvidence({ changedPaths: ['src/a.ts'] }),
  });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'FAILED');
  assert.match(r.decision.reasons.join(), /RuntimeResult|JSON/);
  assert.equal(s.store.listAttempts(s.work.id)[0]!.status, 'PROTOCOL_FAILED');
  s.cleanup();
});

test('protocol 邊界：JSON 合法但 attemptId 不符 → 仍是 protocol 失敗', async () => {
  const s = setup({
    retryBudget: 0,
    driver: fakeDriver(() => JSON.stringify(completed('W-wrong', 'A-wrong'))),
    evidence: fakeEvidence({ changedPaths: ['src/a.ts'] }),
  });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'FAILED');
  assert.match(r.decision.reasons.join(), /workId|attemptId/);
  s.cleanup();
});

test('protocol 邊界：evidence 仍然照常收集 —— 格式錯不代表沒發生副作用', async () => {
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'] });
  const s = setup({ retryBudget: 0, driver: fakeDriver(() => 'not json'), evidence: ev });
  const r = await s.orch.runAttempt(s.work.id);
  const changed = r.evidence.find((e) => e.type === 'git_diff');
  assert.ok(changed, 'protocol 失敗時仍必須觀察 git');
  assert.deepEqual((changed.data as { changedPaths: string[] }).changedPaths, ['src/a.ts']);
  s.cleanup();
});

test('protocol 正向：JSON 夾在 prose 中間仍能解析', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-flow-'));
  const policy: GlobalPolicy = { ...DEFAULT_POLICY, stateDir: join(base, 'state') };
  const store = new Store(policy.stateDir);
  const repo = repoWith(base);
  const ids = { workId: '' };
  const driver = fakeDriver(({ attemptId }) =>
    `分析完成。\n${JSON.stringify(completed(ids.workId, attemptId))}\n以上。`);
  const orch = new Orchestrator(policy, store, () => {}, { driver, evidence: fakeEvidence({ changedPaths: ['src/a.ts'] }) });
  const work = orch.createWork({ request: '修一個 bug', workspace: repo });
  ids.workId = work.id;
  assert.equal((await orch.runAttempt(work.id)).decision.outcome, 'SUCCESS');
  store.close(); rmSync(base, { recursive: true, force: true });
});

test('protocol 正向：被 code fence 包住仍能解析', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-flow-'));
  const policy: GlobalPolicy = { ...DEFAULT_POLICY, stateDir: join(base, 'state') };
  const store = new Store(policy.stateDir);
  const repo = repoWith(base);
  const ids = { workId: '' };
  const driver = fakeDriver(({ attemptId }) =>
    '```json\n' + JSON.stringify(completed(ids.workId, attemptId)) + '\n```');
  const orch = new Orchestrator(policy, store, () => {}, { driver, evidence: fakeEvidence({ changedPaths: ['src/a.ts'] }) });
  const work = orch.createWork({ request: '修一個 bug', workspace: repo });
  ids.workId = work.id;
  assert.equal((await orch.runAttempt(work.id)).decision.outcome, 'SUCCESS');
  store.close(); rmSync(base, { recursive: true, force: true });
});

test('protocol 反向：JSON 合法但缺 status → 不得進成功路徑', async () => {
  const s = setup({
    retryBudget: 0,
    driver: fakeDriver(() => JSON.stringify({ schemaVersion: '1', workId: 'x', attemptId: 'y', summary: 'ok' })),
    evidence: fakeEvidence({ changedPaths: ['src/a.ts'] }),
  });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'FAILED');
  s.cleanup();
});

test('protocol 反向：完全空的輸出 → protocol 失敗而不是當成沒事', async () => {
  const s = setup({ retryBudget: 0, driver: fakeDriver(() => ''),
    evidence: fakeEvidence({ changedPaths: [] }) });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'FAILED');
  assert.equal(s.store.listAttempts(s.work.id)[0]!.status, 'PROTOCOL_FAILED');
  s.cleanup();
});

test('protocol 邊界：有 retry 額度時 protocol 失敗判 RETRYABLE 而非 FAILED', async () => {
  const s = setup({ retryBudget: 1, driver: fakeDriver(() => 'not json'),
    evidence: fakeEvidence({ changedPaths: ['src/a.ts'] }) });
  assert.equal((await s.orch.runAttempt(s.work.id)).decision.outcome, 'RETRYABLE_FAILURE');
  s.cleanup();
});

test('protocol 邊界：protocol 失敗但變更越界 → POLICY_VIOLATION 優先', async () => {
  const s = setup({ retryBudget: 1, driver: fakeDriver(() => 'not json'),
    evidence: fakeEvidence({ changedPaths: ['secret/k.txt'] }) });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'POLICY_VIOLATION', '越界比格式問題更該優先讓使用者知道');
  s.cleanup();
});

// ---------------------------------------------------------------- 規則 3：越界時不跑 verification

test('越界檢查 正向：沒有違規且有變更 → verification 照跑', async () => {
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'] });
  const s = setup({ evidence: ev });
  await s.orch.runAttempt(s.work.id);
  assert.equal(ev.verificationCalls, 1);
  s.cleanup();
});

test('git observation 不完整：不得 SUCCESS，也不得繼續 verification', async () => {
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'] });
  ev.observeGit = async () => ({
    changedPaths: ['src/a.ts'], preExistingUnchanged: [], diff: '',
    baseRevision: 'rev-base', head: 'rev-head', clean: false,
    probeErrors: ['git diff failed'],
  });
  const s = setup({ evidence: ev });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'RETRYABLE_FAILURE');
  assert.equal(ev.verificationCalls, 0);
  assert.equal(r.evidence.find((e) => e.type === 'git_diff')?.status, 'INCONCLUSIVE');
  s.cleanup();
});

test('越界檢查 反向：改到 protected path → POLICY_VIOLATION 且不執行 verification', async () => {
  const ev = fakeEvidence({ changedPaths: ['secret/keys.txt'] });
  const s = setup({ evidence: ev });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'POLICY_VIOLATION');
  // 先讓使用者處理越界，不在已違規的樹上留下更多副作用
  assert.equal(ev.verificationCalls, 0);
  s.cleanup();
});

test('越界檢查 邊界：零變更時不跑 verification（沒東西可驗）', async () => {
  const ev = fakeEvidence({ changedPaths: [] });
  const s = setup({ retryBudget: 0, evidence: ev });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(ev.verificationCalls, 0);
  // write attempt 卻沒有任何變更 → agent 說完成也不算完成
  assert.equal(r.decision.outcome, 'FAILED');
  s.cleanup();
});

test('越界檢查 正向：多個合法路徑的變更一次通過', async () => {
  const ev = fakeEvidence({ changedPaths: ['src/a.ts', 'src/b.ts', 'README.md'] });
  const s = setup({ evidence: ev });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'SUCCESS');
  assert.equal(ev.verificationCalls, 1);
  s.cleanup();
});

test('越界檢查 正向：使用者限縮範圍時，範圍內的變更仍然通過', async () => {
  const s = setup({ request: '只改 src/，修一個 bug', evidence: fakeEvidence({ changedPaths: ['src/a.ts'] }) });
  const contract = s.store.getContract(s.work.id, 1)!;
  assert.deepEqual(contract.allowedPaths, ['src/**']);
  assert.equal((await s.orch.runAttempt(s.work.id)).decision.outcome, 'SUCCESS');
  s.cleanup();
});

test('越界檢查 反向：合法與越界混在一起，仍judge為 POLICY_VIOLATION', async () => {
  const s = setup({ evidence: fakeEvidence({ changedPaths: ['src/a.ts', 'secret/k.txt'] }) });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'POLICY_VIOLATION');
  assert.match(r.decision.reasons.join(), /secret/);
  s.cleanup();
});

test('越界檢查 反向：限縮範圍時，範圍外的變更算越界', async () => {
  const s = setup({ request: '只改 src/，修一個 bug', evidence: fakeEvidence({ changedPaths: ['docs/x.md'] }) });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'POLICY_VIOLATION');
  assert.match(r.decision.reasons.join(), /outside_allowed/);
  s.cleanup();
});

test('越界檢查 邊界：protected 目錄本身被變更（不是底下的檔案）也要擋', async () => {
  const s = setup({ evidence: fakeEvidence({ changedPaths: ['secret'] }) });
  assert.equal((await s.orch.runAttempt(s.work.id)).decision.outcome, 'POLICY_VIOLATION');
  s.cleanup();
});

test('越界檢查 邊界：越界後 work 轉 BLOCKED，不是留在 ACTIVE', async () => {
  const s = setup({ evidence: fakeEvidence({ changedPaths: ['secret/k.txt'] }) });
  await s.orch.runAttempt(s.work.id);
  assert.equal(s.store.getWork(s.work.id)!.state, 'BLOCKED');
  s.cleanup();
});

// ---------------------------------------------------------------- 規則 4：read attempt

test('read 正向：唯讀工作沒有變更 → SUCCESS', async () => {
  const s = setup({ request: '只看不要改：找出原因', evidence: fakeEvidence({ changedPaths: [] }) });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.attempt.mode, 'read');
  assert.equal(r.decision.outcome, 'SUCCESS');
  s.cleanup();
});

test('read 反向：唯讀工作卻出現變更 → POLICY_VIOLATION（代表 enforcement 失效）', async () => {
  const s = setup({ request: '只看不要改：找出原因', evidence: fakeEvidence({ changedPaths: ['README.md'] }) });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'POLICY_VIOLATION');
  s.cleanup();
});

test('read 邊界：唯讀工作不收集 baseline（本來就不跑 verification）', async () => {
  const ev = fakeEvidence({ changedPaths: [] });
  const s = setup({ request: '只看不要改', evidence: ev });
  await s.orch.runAttempt(s.work.id);
  assert.equal(ev.baselineCalls, 0);
  assert.equal(ev.verificationCalls, 0);
  s.cleanup();
});

test('read 正向：authority 是 read-only 而不是 workspace-write', async () => {
  const s = setup({ request: '只看不要改', evidence: fakeEvidence({ changedPaths: [] }) });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.attempt.mode, 'read');
  const prompt = s.store.readArtifact(r.attempt.promptArtifactId)!;
  assert.match(prompt, /mode: read-only/);
  s.cleanup();
});

test('read 正向：唯讀工作即使 repo 設了 checks 也判 SUCCESS', async () => {
  const ev = fakeEvidence({ changedPaths: [] });
  const s = setup({ request: '只分析不要動', evidence: ev });
  assert.equal((await s.orch.runAttempt(s.work.id)).decision.outcome, 'SUCCESS');
  assert.equal(ev.verificationCalls, 0);
  s.cleanup();
});

test('read 反向：唯讀下 agent 要求擴權 → NEEDS_USER_DECISION 而非 SUCCESS', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-flow-'));
  const policy: GlobalPolicy = { ...DEFAULT_POLICY, stateDir: join(base, 'state') };
  const store = new Store(policy.stateDir);
  const repo = repoWith(base);
  const ids = { workId: '' };
  const driver = fakeDriver(({ attemptId }) => JSON.stringify({
    ...completed(ids.workId, attemptId, []), status: 'needs_user_decision',
    questions: [{ id: 'Q1', text: '可以改 src/token 嗎？', requestedAuthority: 'src/token/**' }],
  }));
  const orch = new Orchestrator(policy, store, () => {}, { driver, evidence: fakeEvidence({ changedPaths: [] }) });
  const work = orch.createWork({ request: '只看不要改', workspace: repo });
  ids.workId = work.id;
  const r = await orch.runAttempt(work.id);
  assert.equal(r.decision.outcome, 'NEEDS_USER_DECISION');
  assert.equal(store.getWork(work.id)!.state, 'WAITING_USER');
  store.close(); rmSync(base, { recursive: true, force: true });
});

test('read 反向：唯讀下變更落在 protected 也是 POLICY_VIOLATION', async () => {
  const s = setup({ request: '只看不要改', evidence: fakeEvidence({ changedPaths: ['secret/k.txt'] }) });
  assert.equal((await s.orch.runAttempt(s.work.id)).decision.outcome, 'POLICY_VIOLATION');
  s.cleanup();
});

test('read 邊界：「不要改動輸出格式」是限制，不該被降級成唯讀', async () => {
  const s = setup({
    request: '讓 list 顯示 outcome。不要改動其他指令的輸出格式。',
    evidence: fakeEvidence({ changedPaths: ['src/a.ts'] }),
  });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.attempt.mode, 'write', 'dogfood W1 就是被這句話降級成 read 而失敗的');
  s.cleanup();
});

test('read 邊界：唯讀工作沒有變更時 preExistingDirty 仍被記錄', async () => {
  const ev = fakeEvidence({ changedPaths: [], preExisting: [{ path: 'note.txt', hash: 'h' }] });
  const s = setup({ request: '只看不要改', evidence: ev });
  const r = await s.orch.runAttempt(s.work.id);
  assert.deepEqual(r.attempt.preExistingDirty, [{ path: 'note.txt', hash: 'h' }]);
  s.cleanup();
});


// ---------------------------------------------------------------- 規則 5：contract snapshot 凍結

/** driver 在「執行期間」對 repo 動手腳 —— agent 改自己驗收條件的形狀。 */
function setupWithSideEffect(sideEffect: (repo: string) => void, ev?: ReturnType<typeof fakeEvidence>) {
  const evidence = ev ?? fakeEvidence({ changedPaths: ['src/a.ts'] });
  const base = mkdtempSync(join(tmpdir(), 'harness-flow-'));
  const policy: GlobalPolicy = { ...DEFAULT_POLICY, stateDir: join(base, 'state') };
  const store = new Store(policy.stateDir);
  const repo = repoWith(base);
  const ids = { workId: '' };
  const driver = fakeDriver(({ attemptId }) => {
    sideEffect(repo);
    return JSON.stringify(completed(ids.workId, attemptId));
  });
  const orch = new Orchestrator(policy, store, () => {}, { driver, evidence });
  const work = orch.createWork({ request: '修一個 bug', workspace: repo });
  ids.workId = work.id;
  return {
    store, orch, repo, work, evidence,
    cleanup: () => { store.close(); rmSync(base, { recursive: true, force: true }); },
  };
}

function writeContract(repo: string, over: { protectedPaths?: string[]; checks?: unknown } = {}): void {
  writeFileSync(join(repo, CONTRACT_REL_PATH), JSON.stringify({
    schemaVersion: '1', repositoryId: 'fixture',
    context: { entryPoints: ['README.md'] },
    filesystem: { protectedPaths: over.protectedPaths ?? ['secret/**'] },
    verification: { checks: over.checks ?? CHECKS },
  }));
}

test('snapshot 正向：attempt 使用載入當下的 contract hash', async () => {
  const s = setup({ evidence: fakeEvidence({ changedPaths: ['src/a.ts'] }) });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.attempt.contractSnapshotHash.length, 64);
  s.cleanup();
});

test('snapshot 正向：contract 沒動時，連續兩個 attempt 的 hash 相同', async () => {
  const s = setup({ evidence: fakeEvidence({ changedPaths: ['src/a.ts'] }) });
  const a = await s.orch.runAttempt(s.work.id);
  const b = await s.orch.runAttempt(s.work.id);
  assert.equal(a.attempt.contractSnapshotHash, b.attempt.contractSnapshotHash);
  s.cleanup();
});

test('snapshot 正向：傳給 verification 的是凍結的那一份，不是磁碟上的現值', async () => {
  let seenChecks: string[] | null = null;
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'] });
  ev.runVerification = async (snapshot) => {
    seenChecks = snapshot.contract.verification.checks.map((c) => c.id);
    return { evidence: [], requiredFailed: [], allRequiredPassed: true };
  };
  // 執行期間把 checks 清空，verification 收到的仍該是原本那一條
  const s = setupWithSideEffect((repo) => writeContract(repo, { checks: [] }), ev);
  await s.orch.runAttempt(s.work.id);
  assert.deepEqual(seenChecks, ['test']);
  s.cleanup();
});

test('snapshot 反向：agent 在執行中改掉 .harness/config.json，本次判定不受影響', async () => {
  const s = setupWithSideEffect((repo) => writeContract(repo, { protectedPaths: [], checks: [] }));
  const r = await s.orch.runAttempt(s.work.id);
  // 本次仍使用凍結的那一份：verification 照跑
  assert.equal(s.evidence.verificationCalls, 1, '被清空的 checks 不能影響本次');
  assert.equal(r.attempt.contractSnapshotHash.length, 64);
  s.cleanup();
});

test('snapshot 反向：執行中把保護範圍改成 ** 也不能追溯攔下本次變更', async () => {
  const s = setupWithSideEffect((repo) => writeContract(repo, { protectedPaths: ['**'] }));
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'SUCCESS', '凍結是雙向的：事後放寬與事後收緊都不算數');
  s.cleanup();
});

test('snapshot 反向：凍結只涵蓋本次 —— 下一個 attempt 讀到的是新的 hash', async () => {
  const s = setupWithSideEffect((repo) => writeContract(repo, { protectedPaths: ['other/**'] }));
  const a = await s.orch.runAttempt(s.work.id);
  const b = await s.orch.runAttempt(s.work.id);
  assert.notEqual(a.attempt.contractSnapshotHash, b.attempt.contractSnapshotHash,
    '凍結不等於忽略；改過的 contract 從下一次起生效');
  s.cleanup();
});

test('snapshot 邊界：contract 被改成無效 JSON → 本次完成，下一個 attempt 才 BLOCKED', async () => {
  const s = setupWithSideEffect((repo) => writeFileSync(join(repo, CONTRACT_REL_PATH), '{ 這不是 JSON'));
  const first = await s.orch.runAttempt(s.work.id);
  assert.notEqual(first.decision.outcome, 'BLOCKED', '本次已經凍結，不該被事後的破壞影響');

  const second = await s.orch.runAttempt(s.work.id);
  assert.equal(second.decision.outcome, 'BLOCKED');
  assert.match(second.decision.reasons.join(), /INVALID_CONTRACT/);
  s.cleanup();
});

test('snapshot 邊界：contract 檔案整個消失 → 下一個 attempt BLOCKED，而不是當成沒有限制', async () => {
  const s = setupWithSideEffect((repo) => rmSync(join(repo, CONTRACT_REL_PATH)));
  await s.orch.runAttempt(s.work.id);
  const second = await s.orch.runAttempt(s.work.id);
  assert.equal(second.decision.outcome, 'BLOCKED', '缺 contract 必須擋，fail-closed');
  s.cleanup();
});

test('snapshot 邊界：改壞又改回原樣 → hash 回到原值（hash 認內容不認時序）', async () => {
  let round = 0;
  const s = setupWithSideEffect((repo) => {
    round++;
    if (round === 1) writeContract(repo, { protectedPaths: ['tmp/**'] });
    else writeContract(repo);          // 改回原樣
  });
  const a = await s.orch.runAttempt(s.work.id);   // 讀到原始 contract
  const b = await s.orch.runAttempt(s.work.id);   // 讀到被改過的
  const c = await s.orch.runAttempt(s.work.id);   // 讀到改回來的
  assert.notEqual(a.attempt.contractSnapshotHash, b.attempt.contractSnapshotHash);
  assert.equal(a.attempt.contractSnapshotHash, c.attempt.contractSnapshotHash);
  s.cleanup();
});

// ---------------------------------------------------------------- 規則 6：preExistingDirty

test('preExistingDirty 正向：attempt 前乾淨時記錄為空', async () => {
  const s = setup({ evidence: fakeEvidence({ changedPaths: ['src/a.ts'], preExisting: [] }) });
  const r = await s.orch.runAttempt(s.work.id);
  assert.deepEqual(r.attempt.preExistingDirty, []);
  s.cleanup();
});

test('preExistingDirty 正向：多個髒檔案連 hash 一起完整記錄', async () => {
  const pre: DirtyEntry[] = [
    { path: 'a.txt', hash: 'h1' }, { path: 'b.txt', hash: 'h2' }, { path: 'c.txt', hash: 'h3' },
  ];
  const s = setup({ evidence: fakeEvidence({ changedPaths: ['src/a.ts'], preExisting: pre }) });
  const r = await s.orch.runAttempt(s.work.id);
  assert.deepEqual(r.attempt.preExistingDirty, pre, '只記路徑不夠 —— 要靠 hash 才能判斷有沒有再被動過');
  s.cleanup();
});

test('preExistingDirty 正向：hash 為 null（已刪除的檔案）照樣記錄', async () => {
  const pre: DirtyEntry[] = [{ path: 'gone.txt', hash: null }];
  const s = setup({ evidence: fakeEvidence({ changedPaths: ['src/a.ts'], preExisting: pre }) });
  const r = await s.orch.runAttempt(s.work.id);
  assert.deepEqual(r.attempt.preExistingDirty, pre);
  s.cleanup();
});

test('preExistingDirty 反向：attempt 前就髒的檔案被記進 attempt，並傳給 observeGit', async () => {
  const pre: DirtyEntry[] = [{ path: 'note.txt', hash: 'abc' }];
  let received: readonly DirtyEntry[] | null = null;
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'], preExisting: pre });
  ev.observeGit = async (_ws, base, preExisting) => {
    received = preExisting;
    return { changedPaths: ['src/a.ts'], preExistingUnchanged: ['note.txt'], diff: '',
      baseRevision: base, head: 'rev-head', clean: false };
  };
  const s = setup({ evidence: ev });
  const r = await s.orch.runAttempt(s.work.id);
  assert.deepEqual(r.attempt.preExistingDirty, pre);
  assert.deepEqual(received, pre, 'attempt 前的髒檔案必須傳到 evidence 收集端才能扣除');
  s.cleanup();
});

test('preExistingDirty 反向：本來就髒但 agent 又動過 → 仍算 agent 的變更', async () => {
  const ev = fakeEvidence({ preExisting: [{ path: 'secret/old.txt', hash: 'before' }] });
  // 內容變了，所以 observeGit 沒把它扣掉，它留在 changedPaths 裡
  ev.observeGit = async () => ({
    changedPaths: ['secret/old.txt'], preExistingUnchanged: [], diff: '',
    baseRevision: 'rev-base', head: 'rev-head', clean: false,
  });
  const s = setup({ evidence: ev });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'POLICY_VIOLATION', '「本來就髒」不是越界的通行證');
  s.cleanup();
});

test('preExistingDirty 反向：全部都是既有髒檔案時不跑 verification（agent 什麼都沒做）', async () => {
  const ev = fakeEvidence({ preExisting: [{ path: 'note.txt', hash: 'abc' }] });
  ev.observeGit = async () => ({
    changedPaths: [], preExistingUnchanged: ['note.txt'], diff: '',
    baseRevision: 'rev-base', head: 'rev-head', clean: true,
  });
  const s = setup({ evidence: ev });
  await s.orch.runAttempt(s.work.id);
  assert.equal(ev.verificationCalls, 0, '既有的髒不能被誤認成 agent 的成果而觸發驗收');
  s.cleanup();
});

test('preExistingDirty 邊界：本來就髒的 protected 檔案不該讓這次判成越界', async () => {
  const ev = fakeEvidence({ preExisting: [{ path: 'secret/old.txt', hash: 'abc' }] });
  // observeGit 已經扣掉未再變動的項目，所以 changedPaths 不含它
  ev.observeGit = async () => ({
    changedPaths: ['src/a.ts'], preExistingUnchanged: ['secret/old.txt'], diff: '',
    baseRevision: 'rev-base', head: 'rev-head', clean: false,
  });
  const s = setup({ evidence: ev });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'SUCCESS');
  s.cleanup();
});

test('preExistingDirty 邊界：retry 重新 snapshot，不沿用上一個 attempt 的清單', async () => {
  let round = 0;
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'] });
  ev.snapshotDirty = async () => (++round === 1 ? [{ path: 'first.txt', hash: 'h1' }] : []);
  ev.runVerification = async (_s, _w, ids) => failingVerification(ids);
  const s = setup({ retryBudget: 2, evidence: ev });
  await s.orch.runAttempt(s.work.id);
  await s.orch.retry(s.work.id);
  const attempts = s.store.listAttempts(s.work.id);
  assert.deepEqual(attempts[0]!.preExistingDirty, [{ path: 'first.txt', hash: 'h1' }]);
  assert.deepEqual(attempts[1]!.preExistingDirty, [], 'retry 前的狀態要重新看，不能沿用');
  s.cleanup();
});

test('preExistingDirty 邊界：清單為空時不發 evidence.collected 事件（不製造噪音）', async () => {
  const s = setup({ evidence: fakeEvidence({ changedPaths: ['src/a.ts'], preExisting: [] }) });
  await s.orch.runAttempt(s.work.id);
  const noisy = s.store.events(s.work.id).filter((e) => e.data.includes('preExistingDirty'));
  assert.equal(noisy.length, 0);
  s.cleanup();
});

// ---------------------------------------------------------------- 規則 7：pre-flight baseline

const ONE_BASELINE: VerificationBaseline[] = [{ checkId: 'test', exitCode: 0, executed: 10, skipped: 0 }];

test('baseline 正向：write attempt 預設會在 agent 動手前收集', async () => {
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'] });
  const s = setup({ evidence: ev });
  await s.orch.runAttempt(s.work.id);
  assert.equal(ev.baselineCalls, 1);
  s.cleanup();
});

test('baseline 正向：收集到的 baseline 有傳進 verification（否則沒人比得出退步）', async () => {
  let seen: readonly VerificationBaseline[] | undefined | null = null;
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'], baseline: ONE_BASELINE });
  ev.runVerification = async (_s, _w, _ids, baseline) => {
    seen = baseline;
    return { evidence: [], requiredFailed: [], allRequiredPassed: true };
  };
  const s = setup({ evidence: ev });
  await s.orch.runAttempt(s.work.id);
  assert.deepEqual(seen, ONE_BASELINE);
  s.cleanup();
});

test('baseline 正向：多個 check 的 baseline 全部存進 attempt', async () => {
  const many: VerificationBaseline[] = [
    { checkId: 'test', exitCode: 0, executed: 10, skipped: 0 },
    { checkId: 'lint', exitCode: 1, executed: 0, skipped: 0 },
  ];
  const s = setup({ evidence: fakeEvidence({ changedPaths: ['src/a.ts'], baseline: many }) });
  const r = await s.orch.runAttempt(s.work.id);
  assert.deepEqual(r.attempt.baseline, many);
  s.cleanup();
});

test('baseline 反向：--no-baseline 時不收集', async () => {
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'] });
  const s = setup({ evidence: ev });
  await s.orch.runAttempt(s.work.id, { noBaseline: true });
  assert.equal(ev.baselineCalls, 0);
  s.cleanup();
});

test('baseline 反向：runtime 講不出合法結果，baseline 照樣已經收了（收集點在 agent 之前）', async () => {
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'] });
  const s = setup({ evidence: ev, driver: fakeDriver(() => '我做完了') });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.attempt.status, 'PROTOCOL_FAILED');
  assert.equal(ev.baselineCalls, 1, 'baseline 不是成功路徑的產物');
  s.cleanup();
});

test('baseline 反向：變更越界的 attempt 也已經收過 baseline', async () => {
  const ev = fakeEvidence({ changedPaths: ['secret/x.txt'] });
  const s = setup({ evidence: ev });
  const r = await s.orch.runAttempt(s.work.id);
  assert.equal(r.decision.outcome, 'POLICY_VIOLATION');
  assert.equal(ev.baselineCalls, 1);
  assert.equal(ev.verificationCalls, 0, '越界不跑 verification，但 baseline 早就收完了');
  s.cleanup();
});

test('baseline 邊界：收集到的內容存進 attempt，retry 時重新收集而不是沿用', async () => {
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'], baseline: ONE_BASELINE });
  ev.runVerification = async (_s, _w, ids) => failingVerification(ids);
  const s = setup({ retryBudget: 2, evidence: ev });
  await s.orch.runAttempt(s.work.id);
  assert.equal(ev.baselineCalls, 1);
  await s.orch.retry(s.work.id);
  assert.equal(ev.baselineCalls, 2, 'retry 是新的 attempt，baseline 要重新取');
  const attempts = s.store.listAttempts(s.work.id);
  assert.equal(attempts[0]!.baseline?.[0]?.executed, 10);
  s.cleanup();
});

test('baseline 邊界：repo 沒有任何 required check → baseline 是空陣列而不是 undefined', async () => {
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'], baseline: [] });
  const s = setup({ checks: [], evidence: ev });
  const r = await s.orch.runAttempt(s.work.id);
  assert.deepEqual(r.attempt.baseline, [], '「跑過但沒東西可跑」與「沒跑」必須分得開');
  assert.equal(ev.baselineCalls, 1);
  s.cleanup();
});

test('baseline 失敗前已持久化可驗證的 attempt inputs，且未派發 runtime', async () => {
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'] });
  ev.collectBaseline = async () => { throw new Error('baseline 跑不起來'); };
  const driver = fakeDriver(() => 'unused');
  const s = setup({ evidence: ev, driver });
  await assert.rejects(() => s.orch.runAttempt(s.work.id), /baseline 跑不起來/);
  s.store.close();

  const reopened = new Store(join(s.base, 'state'));
  const attempt = reopened.listAttempts(s.work.id)[0]!;
  const phase: AttemptPhase | undefined = attempt.phase;
  assert.equal(attempt.status, 'CREATED');
  assert.equal(phase, 'preparing');
  assert.ok(attempt.inputSnapshotArtifactId);
  const input = reopened.readVerifiedArtifact(attempt.inputSnapshotArtifactId);
  const prompt = reopened.readVerifiedArtifact(attempt.promptArtifactId);
  assert.equal(input.status, 'verified');
  assert.equal(prompt.status, 'verified');
  const snapshot = JSON.parse((input as { content: Buffer }).content.toString()) as AttemptInputSnapshot;
  assert.equal(snapshot.attemptId, attempt.id);
  assert.equal(snapshot.promptArtifactId, attempt.promptArtifactId);
  assert.equal(driver.calls, 0);
  reopened.close();
  rmSync(s.base, { recursive: true, force: true });
});

test('model 返回後 observation 失敗仍可由 attempt 找回 verified raw/stdout output', async () => {
  const ev = fakeEvidence({ changedPaths: ['src/a.ts'] });
  ev.observeGit = async () => { throw new Error('observe 爆掉'); };
  const ids = { workId: '' };
  const driver = fakeDriver(({ attemptId }) => JSON.stringify(completed(ids.workId, attemptId)));
  const s = setup({ evidence: ev, driver });
  ids.workId = s.work.id;

  await assert.rejects(() => s.orch.runAttempt(s.work.id), /observe 爆掉/);
  const attempt = s.store.listAttempts(s.work.id)[0]!;
  const outputRefs: AttemptOutputRefs | undefined = attempt.outputRefs;
  assert.equal(attempt.phase, 'collecting');
  assert.ok(attempt.runtimeDispatch?.intentAt);
  assert.ok(attempt.runtimeDispatch?.ownershipToken);
  assert.ok(attempt.runtimeDispatch?.child);
  assert.ok(outputRefs?.rawResultArtifactId);
  assert.ok(outputRefs?.stdoutArtifactId);
  assert.equal(s.store.readVerifiedArtifact(outputRefs.rawResultArtifactId).status, 'verified');
  assert.equal(s.store.readVerifiedArtifact(outputRefs.stdoutArtifactId).status, 'verified');
  assert.notEqual(s.store.getWork(s.work.id)?.state, 'DONE');
  s.cleanup();
});

test('driver prepare throw 會持久化 dispatch_intent recovery，不假造 completion/output', async () => {
  const driver: RuntimeDriver = {
    prepare() { throw new Error('prepare 爆掉'); },
    async run() { throw new Error('unreachable'); },
  };
  const s = setup({ driver });
  await assert.rejects(() => s.orch.runAttempt(s.work.id), /prepare 爆掉/);
  s.store.close();

  const reopened = new Store(join(s.base, 'state'));
  const attempt = reopened.listAttempts(s.work.id)[0]!;
  assert.equal(attempt.status, 'RECOVERY_REQUIRED');
  assert.equal(attempt.phase, 'dispatch_intent');
  assert.match(attempt.failureReason ?? '', /prepare 爆掉/);
  assert.equal(attempt.outputRefs, undefined);
  assert.equal(reopened.getWork(s.work.id)?.state, 'BLOCKED');
  assert.equal(reopened.lastOutcome(s.work.id), null);
  const eventTypes = reopened.events(s.work.id).map((event) => event.type);
  assert.ok(eventTypes.includes('recovery.required'));
  assert.ok(eventTypes.includes('work.state_changed'));
  assert.ok(!eventTypes.includes('attempt.completed'));
  reopened.close();
  rmSync(s.base, { recursive: true, force: true });
});

test('driver run throw 在 unknown receipt 後保留 executing recovery state', async () => {
  const driver: RuntimeDriver = {
    prepare() { return {} as never; },
    async run(_run, onState) {
      onState?.({ phase: 'unknown', child: null, quiesced: false });
      throw new Error('run unknown 爆掉');
    },
  };
  const s = setup({ driver });
  await assert.rejects(() => s.orch.runAttempt(s.work.id), /run unknown 爆掉/);
  s.store.close();

  const reopened = new Store(join(s.base, 'state'));
  const attempt = reopened.listAttempts(s.work.id)[0]!;
  assert.equal(attempt.status, 'RECOVERY_REQUIRED');
  assert.equal(attempt.phase, 'executing');
  assert.equal(attempt.runtimeDispatch?.state, 'unknown');
  assert.match(attempt.failureReason ?? '', /run unknown 爆掉/);
  assert.equal(attempt.outputRefs, undefined);
  assert.equal(reopened.getWork(s.work.id)?.state, 'BLOCKED');
  assert.equal(reopened.lastOutcome(s.work.id), null);
  assert.ok(!reopened.events(s.work.id).some((event) => event.type === 'attempt.completed'));
  reopened.close();
  rmSync(s.base, { recursive: true, force: true });
});

test('driver run throw 在 stopped receipt 後仍需 recovery，不能假裝已有 runtime result', async () => {
  const driver: RuntimeDriver = {
    prepare() { return {} as never; },
    async run(_run, onState) {
      const child = { pid: process.pid, processStart: 'fixture' };
      onState?.({ phase: 'running', child, quiesced: false });
      onState?.({ phase: 'stopped', child, quiesced: true });
      throw new Error('run stopped 爆掉');
    },
  };
  const s = setup({ driver });
  await assert.rejects(() => s.orch.runAttempt(s.work.id), /run stopped 爆掉/);
  s.store.close();

  const reopened = new Store(join(s.base, 'state'));
  const attempt = reopened.listAttempts(s.work.id)[0]!;
  assert.equal(attempt.status, 'RECOVERY_REQUIRED');
  assert.equal(attempt.phase, 'executing');
  assert.equal(attempt.runtimeDispatch?.state, 'stopped');
  assert.match(attempt.failureReason ?? '', /run stopped 爆掉/);
  assert.equal(attempt.outputRefs, undefined);
  assert.equal(reopened.getWork(s.work.id)?.state, 'BLOCKED');
  assert.equal(reopened.lastOutcome(s.work.id), null);
  assert.ok(!reopened.events(s.work.id).some((event) => event.type === 'attempt.completed'));
  reopened.close();
  rmSync(s.base, { recursive: true, force: true });
});
