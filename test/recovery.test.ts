import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/trace/store.ts';
import { Orchestrator, type EvidenceCollector, type RuntimeDriver } from '../src/orchestrator.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { acquireExecutionOwnership } from '../src/runtime/ownership.ts';
import type { GlobalPolicy, WorkContract } from '../src/types.ts';

function repoFixture(base: string): string {
  const repo = join(base, 'repo');
  mkdirSync(join(repo, '.harness'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  writeFileSync(join(repo, '.harness/config.json'), JSON.stringify({
    schemaVersion: '1', repositoryId: 'fixture',
    context: { entryPoints: ['README.md'] },
    filesystem: { protectedPaths: ['secret/**'] },
    verification: { checks: [] },
  }));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });
  return repo;
}

function harness(): { base: string; store: Store; orch: Orchestrator; policy: GlobalPolicy; repo: string } {
  const base = mkdtempSync(join(tmpdir(), 'harness-orch-'));
  const policy: GlobalPolicy = { ...DEFAULT_POLICY, stateDir: join(base, 'state') };
  const store = new Store(policy.stateDir);
  return { base, store, orch: new Orchestrator(policy, store), policy, repo: repoFixture(base) };
}

function recoveryHarness(): {
  base: string;
  store: Store;
  orch: Orchestrator;
  policy: GlobalPolicy;
  repo: string;
  driver: RuntimeDriver & { calls: number };
  evidence: EvidenceCollector & { verificationCalls: number };
} {
  const base = mkdtempSync(join(tmpdir(), 'harness-recover-v2-'));
  const repo = join(base, 'repo');
  mkdirSync(join(repo, '.harness'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# recovery fixture\n');
  writeFileSync(join(repo, '.harness/config.json'), JSON.stringify({
    schemaVersion: '1', repositoryId: 'recovery-fixture',
    context: { entryPoints: ['README.md'] },
    filesystem: { protectedPaths: ['secret/**'] },
    verification: { checks: [{ id: 'v1-check', kind: 'test', argv: ['node', '--test'], required: true }] },
  }));
  const policy: GlobalPolicy = {
    ...DEFAULT_POLICY,
    stateDir: join(base, 'state'),
    agentHome: join(base, 'state', 'agent-home'),
    codexHome: join(base, 'state', 'codex-home'),
    verificationHome: join(base, 'state', 'verification-home'),
    skillsDir: join(base, 'state', 'skills'),
  };
  let calls = 0;
  const driver: RuntimeDriver & { calls: number } = {
    get calls() { return calls; },
    prepare(input) {
      return { attemptId: input.attemptId } as never;
    },
    async run(_prepared, onState) {
      calls++;
      const child = { pid: process.pid, processStart: 'fixture' };
      onState?.({ phase: 'running', child, quiesced: false });
      onState?.({ phase: 'stopped', child, quiesced: true });
      throw new Error('fixture interrupted after child stopped');
    },
  };
  let verificationCalls = 0;
  const evidence: EvidenceCollector & { verificationCalls: number } = {
    get verificationCalls() { return verificationCalls; },
    async baseRevision() { return 'base-v1'; },
    async snapshotDirty() { return []; },
    async observeGit() {
      return { changedPaths: [], preExistingUnchanged: [], diff: '', baseRevision: 'base-v1', head: 'head-v2', clean: true };
    },
    async collectBaseline() { return []; },
    async runVerification() {
      verificationCalls++;
      return { evidence: [], requiredFailed: [], allRequiredPassed: true };
    },
  };
  const store = new Store(policy.stateDir);
  return { base, store, orch: new Orchestrator(policy, store, () => {}, { driver, evidence }), policy, repo, driver, evidence };
}

async function interruptedAttempt(h: ReturnType<typeof recoveryHarness>): Promise<{ workId: string; attemptId: string }> {
  const work = h.orch.createWork({ request: '修正問題，不要碰 secret', workspace: h.repo });
  await assert.rejects(h.orch.runAttempt(work.id, { noBaseline: true }), /fixture interrupted/);
  return { workId: work.id, attemptId: h.store.listAttempts(work.id)[0]!.id };
}

test('createWork：原文保留、決策入帳、denied 進 contract', () => {
  const h = harness();
  const work = h.orch.createWork({ request: '修 token 過期問題，不要碰 payment，不要部署', workspace: h.repo });
  const c = h.store.getContract(work.id, 1)!;
  assert.equal(c.request, '修 token 過期問題，不要碰 payment，不要部署');
  assert.deepEqual(c.deniedPaths, ['payment/**']);
  assert.deepEqual(c.constraints, ['不要部署']);
  assert.equal(h.store.listDecisions(work.id).length, 2);
  h.store.close(); rmSync(h.base, { recursive: true, force: true });
});

test('answer：新增決策後產生新 contract 版本，既有 deny 不消失', () => {
  const h = harness();
  const work = h.orch.createWork({ request: '修登入問題，不要碰 payment', workspace: h.repo });
  h.orch.answer(work.id, '可以改 src/token');
  const w = h.store.getWork(work.id)!;
  assert.equal(w.currentContractVersion, 2);
  const c = h.store.getContract(work.id, 2)!;
  assert.deepEqual(c.deniedPaths, ['payment/**']);          // 擴權不移除既有 deny
  assert.equal(c.allowedPaths, undefined);                   // §20.1 / D-12
  assert.ok(h.store.listDecisions(work.id).some((d) => d.kind === 'allow_path' && d.value === 'src/token/**'));
  h.store.close(); rmSync(h.base, { recursive: true, force: true });
});

test('crash recovery：殘留 RUNNING → RECOVERY_REQUIRED，不 auto-rerun', () => {
  const h = harness();
  const work = h.orch.createWork({ request: '修東西', workspace: h.repo });
  h.store.insertAttempt({
    id: 'A-stuck', workId: work.id, number: 1, mode: 'write', contractVersion: 1,
    contractSnapshotHash: 'x', baseRevision: 'y', promptArtifactId: '', runtime: 'codex',
    status: 'RUNNING', startedAt: new Date().toISOString(),
  });
  const stuck = h.orch.markCrashedAttempts();
  assert.equal(stuck.length, 1);
  assert.equal(h.store.getAttempt('A-stuck')!.status, 'RECOVERY_REQUIRED');
  assert.equal(h.store.getWork(work.id)!.state, 'BLOCKED');
  assert.ok(h.store.events(work.id).some((e) => e.type === 'recovery.required'));
  h.store.close(); rmSync(h.base, { recursive: true, force: true });
});

test('沒有 .harness/config.json → 不建立 work（REPOSITORY_NOT_INITIALIZED）', () => {
  const h = harness();
  assert.throws(() => h.orch.createWork({ request: 'x', workspace: h.base }), /REPOSITORY_NOT_INITIALIZED|找不到/);
  h.store.close(); rmSync(h.base, { recursive: true, force: true });
});

test('trace 記錄關鍵事件', () => {
  const h = harness();
  const work = h.orch.createWork({ request: '修東西，不要碰 secret', workspace: h.repo });
  const types = h.store.events(work.id).map((e) => e.type);
  assert.ok(types.includes('work.created'));
  assert.ok(types.includes('work_contract.versioned'));
  assert.ok(types.includes('decision.recorded'));
  h.store.close(); rmSync(h.base, { recursive: true, force: true });
});

test('Gate 5：process restart 後 work 狀態仍在（persistence）', () => {
  const h = harness();
  const work = h.orch.createWork({ request: '修東西，不要碰 secret', workspace: h.repo });
  h.store.setWorkState(work.id, 'WAITING_USER');
  h.store.close();

  // 模擬 harness 重啟：重新開同一個 state dir
  const reopened = new Store(h.policy.stateDir);
  const after = reopened.getWork(work.id)!;
  assert.equal(after.state, 'WAITING_USER');
  assert.equal(reopened.getContract(work.id, 1)!.request, '修東西，不要碰 secret');

  const orch2 = new Orchestrator(h.policy, reopened);
  orch2.answer(work.id, '可以改 src/token');
  assert.equal(reopened.getWork(work.id)!.state, 'ACTIVE');
  assert.equal(reopened.getWork(work.id)!.currentContractVersion, 2);
  reopened.close();
  rmSync(h.base, { recursive: true, force: true });
});

test('Gate 2 C2：attempt 綁定 repository revision 與 contract snapshot hash', () => {
  const h = harness();
  const work = h.orch.createWork({ request: '修東西', workspace: h.repo });
  h.store.insertAttempt({
    id: 'A-1', workId: work.id, number: 1, mode: 'write', contractVersion: 1,
    contractSnapshotHash: 'deadbeef', baseRevision: 'abc123', promptArtifactId: '',
    runtime: 'codex', status: 'CREATED', startedAt: new Date().toISOString(),
  });
  const a = h.store.getAttempt('A-1')!;
  assert.equal(a.baseRevision, 'abc123');
  assert.equal(a.contractSnapshotHash, 'deadbeef');
  h.store.close(); rmSync(h.base, { recursive: true, force: true });
});

test('usage note：跨 work 查詢與彙總', () => {
  const h = harness();
  const w1 = h.orch.createWork({ request: '修東西', workspace: h.repo });
  const w2 = h.orch.createWork({ request: '修別的東西', workspace: h.repo });
  h.store.event('usage.note', { kind: 'false-accept', text: 'PASS 但其實壞了' }, w1.id);
  h.store.event('usage.note', { kind: 'friction', text: '每次都要手動裝依賴' }, w2.id);

  const all = h.store.notes();
  assert.equal(all.length, 2);
  assert.equal(all[0]!.kind, 'friction');          // 最新的在前
  assert.equal(all[0]!.workId, w2.id);
  assert.equal(h.store.notes('false-accept').length, 1);

  const st = h.store.stats();
  assert.equal(st.works, 2);
  assert.deepEqual(st.notes.map((n) => n.kind).sort(), ['false-accept', 'friction']);
  h.store.close(); rmSync(h.base, { recursive: true, force: true });
});

test('recover uses the original input snapshot and never reruns model or changed checks', async () => {
  const h = recoveryHarness();
  const ids = await interruptedAttempt(h);
  const beforeAttempt = h.store.getAttempt(ids.attemptId);
  const beforeCalls = h.driver.calls;
  writeFileSync(join(h.repo, '.harness/config.json'), JSON.stringify({
    schemaVersion: '1', repositoryId: 'recovery-fixture',
    context: { entryPoints: ['README.md'] },
    filesystem: { protectedPaths: ['secret/**'] },
    verification: { checks: [{ id: 'v2-check', kind: 'test', argv: ['node', '--test', 'v2'], required: true }] },
  }));

  const report = await h.orch.recover(ids.workId);
  assert.equal(report.decision.outcome, 'NEEDS_USER_DECISION');
  assert.equal(h.driver.calls, beforeCalls);
  assert.equal(h.evidence.verificationCalls, 0);
  assert.deepEqual(h.store.getAttempt(ids.attemptId), beforeAttempt);
  assert.equal(h.store.lastOutcome(ids.workId), null);
  const sessions = h.store.listRecoverySessions(ids.workId);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.attemptId, ids.attemptId);
  assert.equal(sessions[0]!.status, 'OBSERVED');
  const readback = report.evidence.find((record) => record.type === 'readback');
  const data = readback?.data as {
    originalRepository?: { contract?: { verification?: { checks?: Array<{ id: string }> } } };
    currentRepository?: { contract?: { verification?: { checks?: Array<{ id: string }> } } };
  };
  assert.equal(data.originalRepository?.contract?.verification?.checks?.[0]?.id, 'v1-check');
  assert.equal(data.currentRepository?.contract?.verification?.checks?.[0]?.id, 'v2-check');
  assert.match(report.response, /已知/);
  assert.match(report.response, /未知/);
  assert.match(report.response, /可採取動作/);
  assert.doesNotMatch(report.response, /已完成/);
  h.store.close(); rmSync(h.base, { recursive: true, force: true });
});

test('recover binds the attempt contract and blocks resumption under stricter current authority', async () => {
  const h = recoveryHarness();
  const ids = await interruptedAttempt(h);
  const v1 = h.store.getContract(ids.workId, 1)!;
  const v2: WorkContract = {
    ...v1, id: 'WC-v2', version: 2, mode: 'read',
    deniedPaths: [...v1.deniedPaths, 'src/**'], createdAt: new Date().toISOString(),
  };
  h.store.insertContract(v2);
  h.store.setContractVersion(ids.workId, 2);

  const report = await h.orch.recover(ids.workId);
  const session = h.store.listRecoverySessions(ids.workId)[0]!;
  assert.equal(session.status, 'POLICY_DENIED');
  assert.match(session.reason, /current authority|目前.*限制|POLICY_DENIED/i);
  const data = report.evidence[0]!.data as {
    originalContractVersion?: number; currentContractVersion?: number; policyAllowed?: boolean;
  };
  assert.equal(data.originalContractVersion, 1);
  assert.equal(data.currentContractVersion, 2);
  assert.equal(data.policyAllowed, false);
  assert.match(report.response, /new attempt|新 attempt/i);
  h.store.close(); rmSync(h.base, { recursive: true, force: true });
});

test('recover reports legacy missing and corrupt snapshots without inventing evidence', async () => {
  const h = recoveryHarness();
  const work = h.orch.createWork({ request: 'legacy recovery', workspace: h.repo });
  h.store.insertAttempt({
    id: 'A-legacy', workId: work.id, number: 1, mode: 'write', contractVersion: 1,
    contractSnapshotHash: 'legacy', baseRevision: 'base', promptArtifactId: '', runtime: 'codex',
    status: 'RECOVERY_REQUIRED', startedAt: new Date().toISOString(),
  });
  h.store.setWorkState(work.id, 'BLOCKED');

  const missing = await h.orch.recover(work.id);
  assert.match(missing.response, /SNAPSHOT_UNAVAILABLE/);
  assert.equal(h.store.listRecoverySessions(work.id)[0]!.status, 'SNAPSHOT_UNAVAILABLE');
  assert.deepEqual(missing.evidence, []);

  const bad = h.store.putArtifact('attempt_input', '{bad json', 'json');
  const attempt = h.store.getAttempt('A-legacy')!;
  attempt.inputSnapshotArtifactId = bad.id;
  h.store.updateAttempt(attempt);
  const corrupt = await h.orch.recover(work.id);
  assert.match(corrupt.response, /ARTIFACT_CORRUPT|SNAPSHOT_UNAVAILABLE/);
  assert.equal(h.store.listRecoverySessions(work.id)[1]!.status, 'ARTIFACT_CORRUPT');
  assert.deepEqual(corrupt.evidence, []);
  assert.equal(h.store.lastOutcome(work.id), null);
  h.store.close(); rmSync(h.base, { recursive: true, force: true });
});

test('recover rejects terminal attempts and an active owner before creating a session', async () => {
  const h = recoveryHarness();
  const ids = await interruptedAttempt(h);
  const attempt = h.store.getAttempt(ids.attemptId)!;
  attempt.status = 'COMPLETED';
  attempt.phase = 'terminal';
  h.store.updateAttempt(attempt);
  await assert.rejects(h.orch.recover(ids.workId), /RECOVERY_NOT_APPLICABLE/);
  assert.deepEqual(h.store.listRecoverySessions(ids.workId), []);

  attempt.status = 'RECOVERY_REQUIRED';
  attempt.phase = 'executing';
  h.store.updateAttempt(attempt);
  const owner = acquireExecutionOwnership(h.policy.stateDir);
  try {
    await assert.rejects(h.orch.recover(ids.workId), (error) => {
      assert.equal((error as { code?: string }).code, 'OWNER_ACTIVE');
      return true;
    });
    assert.deepEqual(h.store.listRecoverySessions(ids.workId), []);
  } finally {
    owner.release();
    h.store.close(); rmSync(h.base, { recursive: true, force: true });
  }
});

test('each recover call creates a new observation session without rewriting the attempt or outcome', async () => {
  const h = recoveryHarness();
  const ids = await interruptedAttempt(h);
  const before = h.store.getAttempt(ids.attemptId);
  await h.orch.recover(ids.workId);
  await h.orch.recover(ids.workId);
  const sessions = h.store.listRecoverySessions(ids.workId);
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0]!.id, sessions[1]!.id);
  assert.deepEqual(h.store.getAttempt(ids.attemptId), before);
  assert.equal(h.store.lastOutcome(ids.workId), null);
  h.store.close(); rmSync(h.base, { recursive: true, force: true });
});
