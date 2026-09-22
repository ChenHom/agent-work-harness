import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/trace/store.ts';
import { Orchestrator, type EvidenceCollector, type RuntimeDriver } from '../src/orchestrator.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { main } from '../src/cli.ts';
import type { GlobalPolicy } from '../src/types.ts';
import {
  acquireExecutionOwnership,
  inspectExecutionOwnership,
  type DriverExecutionState,
} from '../src/runtime/ownership.ts';

function policyIn(base: string): GlobalPolicy {
  const stateDir = join(base, 'state');
  return {
    ...DEFAULT_POLICY,
    stateDir,
    agentHome: join(stateDir, 'agent-home'),
    codexHome: join(stateDir, 'codex-home'),
    verificationHome: join(stateDir, 'verification-home'),
    skillsDir: join(stateDir, 'skills'),
  };
}

function repoIn(base: string): string {
  const repo = join(base, 'repo');
  mkdirSync(join(repo, '.harness'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  writeFileSync(join(repo, '.harness/config.json'), JSON.stringify({
    schemaVersion: '1', repositoryId: 'fixture', context: { entryPoints: ['README.md'] },
    filesystem: { protectedPaths: [] }, verification: { checks: [] },
  }));
  return repo;
}

function fakeEvidence(): EvidenceCollector {
  return {
    async baseRevision() { return 'base'; },
    async snapshotDirty() { return []; },
    async observeGit() {
      return { changedPaths: [], preExistingUnchanged: [], diff: '', baseRevision: 'base', head: 'head', clean: true };
    },
    async collectBaseline() { return []; },
    async runVerification() { return { evidence: [], requiredFailed: [], allRequiredPassed: true }; },
  };
}

async function captureCli(policy: GlobalPolicy, args: string[]): Promise<{ code: number; output: string }> {
  const output: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...values: unknown[]) => { output.push(values.join(' ')); };
  console.error = (...values: unknown[]) => { output.push(values.join(' ')); };
  try {
    return { code: await main(args, policy), output: output.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('process death after dispatch intent preserves one attempt and occupied ownership', () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-owner-crash-'));
  const policy = policyIn(base);
  const repo = repoIn(base);
  const idsPath = join(base, 'ids.json');
  const orchestratorModule = new URL('../src/orchestrator.ts', import.meta.url).href;
  const storeModule = new URL('../src/trace/store.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { writeFileSync } from 'node:fs';
    import { Store } from ${JSON.stringify(storeModule)};
    import { Orchestrator } from ${JSON.stringify(orchestratorModule)};
    const policy = JSON.parse(process.env.CRASH_POLICY);
    const store = new Store(policy.stateDir);
    const evidence = {
      async baseRevision() { return 'base'; }, async snapshotDirty() { return []; },
      async observeGit() { throw new Error('unreachable'); }, async collectBaseline() { return []; },
      async runVerification() { throw new Error('unreachable'); },
    };
    let workId = '';
    const driver = {
      prepare(input) {
        writeFileSync(process.env.CRASH_IDS, JSON.stringify({ workId, attemptId: input.attemptId }));
        process.kill(process.pid, 'SIGKILL');
        return {};
      },
      async run() { throw new Error('unreachable'); },
    };
    const orch = new Orchestrator(policy, store, () => {}, { driver, evidence });
    const work = orch.createWork({ request: 'crash boundary', workspace: process.env.CRASH_REPO });
    workId = work.id;
    await orch.runAttempt(work.id, { noBaseline: true });
  `], {
    env: {
      ...process.env, CRASH_POLICY: JSON.stringify(policy), CRASH_REPO: repo, CRASH_IDS: idsPath,
    },
    timeout: 5_000,
  });
  assert.equal(child.signal, 'SIGKILL');
  const ids = JSON.parse(readFileSync(idsPath, 'utf8')) as { workId: string; attemptId: string };
  const reopened = new Store(policy.stateDir);
  try {
    const attempts = reopened.listAttempts(ids.workId);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.id, ids.attemptId);
    assert.equal(attempts[0]!.status, 'RUNNING');
    assert.equal(attempts[0]!.phase, 'dispatch_intent');
    assert.equal(reopened.lastOutcome(ids.workId), null);
    assert.equal(reopened.events(ids.workId).some((event) => event.type === 'attempt.completed'), false);
    assert.equal(inspectExecutionOwnership(policy.stateDir).occupied, true);
    assert.throws(() => acquireExecutionOwnership(policy.stateDir), (error) => {
      assert.match(String((error as Error).message), /OWNER_(ACTIVE|UNKNOWN)/);
      return true;
    });
  } finally {
    reopened.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('exclusive ownership blocks a second executor and exposes metadata', () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-owner-'));
  const stateDir = join(base, 'state');
  const owner = acquireExecutionOwnership(stateDir);
  try {
    const inspection = inspectExecutionOwnership(stateDir);
    assert.equal(inspection.occupied, true);
    assert.equal(inspection.metadata?.token, owner.token);
    assert.equal(inspection.metadata?.pid, process.pid);
    assert.ok(inspection.metadata?.host);
    assert.ok(inspection.metadata?.processStart);
    assert.throws(() => acquireExecutionOwnership(stateDir), (error) => {
      assert.equal((error as { code?: string }).code, 'OWNER_ACTIVE');
      return true;
    });
  } finally {
    owner.release();
    rmSync(base, { recursive: true, force: true });
  }
});

test('an empty ownership directory is occupied and cannot be cleared as stale', () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-owner-'));
  const stateDir = join(base, 'state');
  mkdirSync(join(stateDir, 'execution.lock'), { recursive: true });
  const inspection = inspectExecutionOwnership(stateDir);
  assert.equal(inspection.occupied, true);
  assert.equal(inspection.metadata, null);
  assert.match(inspection.blockedReason ?? '', /OWNER_UNKNOWN/);
  assert.throws(() => acquireExecutionOwnership(stateDir), (error) => {
    assert.equal((error as { code?: string }).code, 'OWNER_UNKNOWN');
    return true;
  });
  assert.equal(existsSync(join(stateDir, 'execution.lock')), true);
  rmSync(base, { recursive: true, force: true });
});

test('partially written child metadata remains occupied as OWNER_UNKNOWN', () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-owner-'));
  const stateDir = join(base, 'state');
  const lockDir = join(stateDir, 'execution.lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
    token: 'partial', host: 'host', pid: 1, processStart: '1', phase: 'running',
    child: {}, acquiredAt: 'now', updatedAt: 'now',
  }));
  const inspection = inspectExecutionOwnership(stateDir);
  assert.equal(inspection.occupied, true);
  assert.equal(inspection.metadata, null);
  assert.match(inspection.blockedReason ?? '', /OWNER_UNKNOWN/);
  rmSync(base, { recursive: true, force: true });
});

test('release requires matching token and a stopped managed child receipt', () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-owner-'));
  const stateDir = join(base, 'state');
  const owner = acquireExecutionOwnership(stateDir);
  const lockDir = join(stateDir, 'execution.lock');
  const running: DriverExecutionState = {
    phase: 'running', child: { pid: 4321, processStart: '123' }, quiesced: false,
  };
  owner.update(running);
  assert.equal(owner.release(), false);
  assert.equal(existsSync(lockDir), true);

  const metadata = inspectExecutionOwnership(stateDir).metadata!;
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ ...metadata, token: 'someone-else' }));
  assert.equal(owner.release(), false);
  assert.equal(existsSync(lockDir), true);
  rmSync(base, { recursive: true, force: true });
});

test('an orchestrator rejects a borrowed token that no longer owns the lock', () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-owner-'));
  const policy = policyIn(base);
  const store = new Store(policy.stateDir);
  const owner = acquireExecutionOwnership(policy.stateDir);
  const lockDir = join(policy.stateDir, 'execution.lock');
  const metadata = inspectExecutionOwnership(policy.stateDir).metadata!;
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ ...metadata, token: 'replacement' }));
  const orch = new Orchestrator(policy, store);

  assert.throws(() => orch.createWork({ request: '修正問題', workspace: repoIn(base) }, owner), (error) => {
    assert.equal((error as { code?: string }).code, 'OWNER_UNKNOWN');
    return true;
  });
  assert.deepEqual(store.listWorks(), []);
  store.close();
  rmSync(base, { recursive: true, force: true });
});

test('a paused orchestrator blocks a second executor before prepare and leaves queries unchanged', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-owner-'));
  const policy = policyIn(base);
  const store = new Store(policy.stateDir);
  const repo = repoIn(base);
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  let workId = '';
  const first: RuntimeDriver = {
    prepare(input) {
      return { attemptDir: '', promptPath: '', lastMessagePath: '', logPath: '', argv: [], env: {}, cwd: '', attemptId: input.attemptId } as never;
    },
    async run(run, onState) {
      onState?.({ phase: 'running', child: { pid: process.pid, processStart: 'fixture' }, quiesced: false });
      enter();
      await gate;
      onState?.({ phase: 'stopped', child: { pid: process.pid, processStart: 'fixture' }, quiesced: true });
      const attemptId = (run as unknown as { attemptId: string }).attemptId;
      return {
        exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1,
        lastMessage: JSON.stringify({
          schemaVersion: '1', workId, attemptId, status: 'completed', summary: 'done',
          claims: [], questions: [], declaredChangedPaths: [],
        }),
      };
    },
  };
  let secondPrepare = 0;
  let secondRun = 0;
  const contaminant = join(policy.codexHome, 'second-executor');
  const second: RuntimeDriver = {
    prepare() {
      secondPrepare++;
      mkdirSync(policy.codexHome, { recursive: true });
      writeFileSync(contaminant, 'bad');
      return {} as never;
    },
    async run() { secondRun++; throw new Error('must not run'); },
  };
  const firstOrchestrator = new Orchestrator(policy, store, () => {}, { driver: first, evidence: fakeEvidence() });
  const secondOrchestrator = new Orchestrator(policy, store, () => {}, { driver: second, evidence: fakeEvidence() });
  const work = firstOrchestrator.createWork({ request: '修正問題', workspace: repo });
  workId = work.id;
  const active = firstOrchestrator.runAttempt(work.id, { noBaseline: true });
  await entered;
  assert.equal(existsSync(policy.verificationHome), true, 'runtime directories must be prepared inside ownership');

  const attempt = store.listAttempts(work.id)[0]!;
  const before = {
    work: store.getWork(work.id), attempt: store.getAttempt(attempt.id),
    events: store.events(work.id).map((event) => event.seq),
  };
  for (const args of [
    ['list'], ['show', work.id], ['trace', work.id], ['prompt', attempt.id],
    ['stats'], ['notes'], ['skills', 'list'], ['ownership'],
  ]) {
    assert.equal((await captureCli(policy, args)).code, 0, args.join(' '));
  }
  assert.deepEqual({
    work: store.getWork(work.id), attempt: store.getAttempt(attempt.id),
    events: store.events(work.id).map((event) => event.seq),
  }, before);

  await assert.rejects(secondOrchestrator.runAttempt(work.id, { noBaseline: true }), (error) => {
    assert.equal((error as { code?: string }).code, 'OWNER_ACTIVE');
    return true;
  });
  assert.equal(secondPrepare, 0);
  assert.equal(secondRun, 0);
  assert.equal(existsSync(contaminant), false);

  resume();
  await active;
  assert.equal(inspectExecutionOwnership(policy.stateDir).occupied, false);
  store.close();
  rmSync(base, { recursive: true, force: true });
});

test('one borrowed ownership handle serializes operations and can be reused afterward', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-owner-'));
  const policy = policyIn(base);
  const store = new Store(policy.stateDir);
  const owner = acquireExecutionOwnership(policy.stateDir);
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  let workId = '';
  let prepares = 0;
  let runs = 0;
  const driver: RuntimeDriver = {
    prepare(input) {
      prepares++;
      return { attemptDir: '', promptPath: '', lastMessagePath: '', logPath: '', argv: [], env: {}, cwd: '', attemptId: input.attemptId } as never;
    },
    async run(run, onState) {
      runs++;
      const child = { pid: process.pid, processStart: 'fixture' };
      onState?.({ phase: 'running', child, quiesced: false });
      if (runs === 1) {
        enter();
        await gate;
      }
      onState?.({ phase: 'stopped', child, quiesced: true });
      const attemptId = (run as unknown as { attemptId: string }).attemptId;
      return {
        exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1,
        lastMessage: JSON.stringify({
          schemaVersion: '1', workId, attemptId, status: 'completed', summary: 'done',
          claims: [], questions: [], declaredChangedPaths: [],
        }),
      };
    },
  };
  const orch = new Orchestrator(policy, store, () => {}, { driver, evidence: fakeEvidence() });
  const work = orch.createWork({ request: '修正問題', workspace: repoIn(base) }, owner);
  workId = work.id;
  const first = orch.runAttempt(work.id, { noBaseline: true, ownership: owner });
  await entered;

  await assert.rejects(orch.runAttempt(work.id, { noBaseline: true, ownership: owner }), (error) => {
    assert.equal((error as { code?: string }).code, 'OWNER_ACTIVE');
    return true;
  });
  assert.equal(prepares, 1);
  assert.equal(runs, 1);

  resume();
  await first;
  await orch.runAttempt(work.id, { noBaseline: true, ownership: owner });
  assert.equal(prepares, 2);
  assert.equal(runs, 2);
  assert.equal(owner.release(), true);
  store.close();
  rmSync(base, { recursive: true, force: true });
});

test('an unknown child after launch failure preserves ownership', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-owner-'));
  const policy = policyIn(base);
  const store = new Store(policy.stateDir);
  const orch = new Orchestrator(policy, store, () => {}, {
    evidence: fakeEvidence(),
    driver: {
      prepare(input) {
        return { attemptDir: '', promptPath: '', lastMessagePath: '', logPath: '', argv: [], env: {}, cwd: '', attemptId: input.attemptId } as never;
      },
      async run(_run, onState) {
        onState?.({ phase: 'unknown', child: null, quiesced: false });
        throw new Error('launch state unknown');
      },
    },
  });
  const work = orch.createWork({ request: '修正問題', workspace: repoIn(base) });
  await assert.rejects(orch.runAttempt(work.id, { noBaseline: true }), /launch state unknown/);
  const inspection = inspectExecutionOwnership(policy.stateDir);
  assert.equal(inspection.occupied, true);
  assert.match(inspection.blockedReason ?? '', /OWNER_UNKNOWN/);
  assert.throws(() => acquireExecutionOwnership(policy.stateDir), (error) => {
    assert.equal((error as { code?: string }).code, 'OWNER_UNKNOWN');
    return true;
  });
  store.close();
  rmSync(base, { recursive: true, force: true });
});

test('a returned runtime result cannot override an unknown child receipt', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-owner-'));
  const policy = policyIn(base);
  const store = new Store(policy.stateDir);
  let workId = '';
  const orch = new Orchestrator(policy, store, () => {}, {
    evidence: fakeEvidence(),
    driver: {
      prepare(input) {
        return { attemptDir: '', promptPath: '', lastMessagePath: '', logPath: '', argv: [], env: {}, cwd: '', attemptId: input.attemptId } as never;
      },
      async run(run, onState) {
        onState?.({ phase: 'unknown', child: null, quiesced: false });
        const attemptId = (run as unknown as { attemptId: string }).attemptId;
        return {
          exitCode: null, signal: null, timedOut: true, stdout: '', stderr: '', durationMs: 1,
          lastMessage: JSON.stringify({
            schemaVersion: '1', workId, attemptId, status: 'failed', summary: 'unknown',
            claims: [], questions: [], declaredChangedPaths: [],
          }),
        };
      },
    },
  });
  const work = orch.createWork({ request: '修正問題', workspace: repoIn(base) });
  workId = work.id;
  await assert.rejects(orch.runAttempt(work.id, { noBaseline: true }), (error) => {
    assert.equal((error as { code?: string }).code, 'OWNER_UNKNOWN');
    return true;
  });
  assert.equal(inspectExecutionOwnership(policy.stateDir).occupied, true);
  store.close();

  const reopened = new Store(policy.stateDir);
  const attempt = reopened.listAttempts(work.id)[0]!;
  assert.equal(attempt.status, 'RECOVERY_REQUIRED');
  assert.equal(attempt.phase, 'executing');
  assert.match(attempt.failureReason ?? '', /OWNER_UNKNOWN|not quiesced/i);
  assert.equal(reopened.getWork(work.id)?.state, 'BLOCKED');
  assert.equal(reopened.lastOutcome(work.id), null);
  const eventTypes = reopened.events(work.id).map((event) => event.type);
  assert.equal(eventTypes.filter((type) => type === 'recovery.required').length, 1);
  assert.ok(!eventTypes.includes('attempt.completed'));
  reopened.close();
  rmSync(base, { recursive: true, force: true });
});

test('a throw after a stopped child receipt releases ownership', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-owner-'));
  const policy = policyIn(base);
  const store = new Store(policy.stateDir);
  const orch = new Orchestrator(policy, store, () => {}, {
    evidence: fakeEvidence(),
    driver: {
      prepare(input) {
        return { attemptDir: '', promptPath: '', lastMessagePath: '', logPath: '', argv: [], env: {}, cwd: '', attemptId: input.attemptId } as never;
      },
      async run(_run, onState) {
        const child = { pid: process.pid, processStart: 'fixture' };
        onState?.({ phase: 'running', child, quiesced: false });
        onState?.({ phase: 'stopped', child, quiesced: true });
        throw new Error('post-close failure');
      },
    },
  });
  const work = orch.createWork({ request: '修正問題', workspace: repoIn(base) });
  await assert.rejects(orch.runAttempt(work.id, { noBaseline: true }), /post-close failure/);
  assert.equal(inspectExecutionOwnership(policy.stateDir).occupied, false);
  store.close();
  rmSync(base, { recursive: true, force: true });
});

test('runtime directory setup failure releases ownership before launch', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-owner-'));
  const policy = policyIn(base);
  const store = new Store(policy.stateDir);
  const work = new Orchestrator(policy, store).createWork({ request: '修正問題', workspace: repoIn(base) });
  writeFileSync(policy.agentHome, 'not a directory');

  await assert.rejects(new Orchestrator(policy, store).runAttempt(work.id, { noBaseline: true }), /EEXIST/);
  assert.equal(inspectExecutionOwnership(policy.stateDir).occupied, false);
  store.close();
  rmSync(base, { recursive: true, force: true });
});

test('lost ownership reported by a swallowed driver callback stops before evidence', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-owner-'));
  const policy = policyIn(base);
  const store = new Store(policy.stateDir);
  let evidenceCalls = 0;
  const evidence = fakeEvidence();
  evidence.runVerification = async () => {
    evidenceCalls++;
    return { evidence: [], requiredFailed: [], allRequiredPassed: true };
  };
  let workId = '';
  const orch = new Orchestrator(policy, store, () => {}, {
    evidence,
    driver: {
      prepare(input) {
        return { attemptDir: '', promptPath: '', lastMessagePath: '', logPath: '', argv: [], env: {}, cwd: '', attemptId: input.attemptId } as never;
      },
      async run(run, onState) {
        const child = { pid: process.pid, processStart: 'fixture' };
        onState?.({ phase: 'running', child, quiesced: false });
        const lockDir = join(policy.stateDir, 'execution.lock');
        const metadata = inspectExecutionOwnership(policy.stateDir).metadata!;
        writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ ...metadata, token: 'replacement' }));
        try {
          onState?.({ phase: 'stopped', child, quiesced: true });
        } catch {
          // A runtime driver may swallow callback errors while it finishes collecting the child result.
        }
        const attemptId = (run as unknown as { attemptId: string }).attemptId;
        return {
          exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1,
          lastMessage: JSON.stringify({
            schemaVersion: '1', workId, attemptId, status: 'completed', summary: 'done',
            claims: [], questions: [], declaredChangedPaths: [],
          }),
        };
      },
    },
  });
  const work = orch.createWork({ request: '修正問題', workspace: repoIn(base) });
  workId = work.id;

  await assert.rejects(orch.runAttempt(work.id, { noBaseline: true }), (error) => {
    assert.equal((error as { code?: string }).code, 'OWNER_UNKNOWN');
    return true;
  });
  assert.equal(evidenceCalls, 0);
  assert.equal(store.lastOutcome(work.id), null);
  assert.equal(inspectExecutionOwnership(policy.stateDir).metadata?.token, 'replacement');
  store.close();
  rmSync(base, { recursive: true, force: true });
});

test('ownership replaced after stopped receipt stops before runtime artifacts and evidence', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-owner-'));
  const policy = policyIn(base);
  const store = new Store(policy.stateDir);
  let evidenceCalls = 0;
  const evidence = fakeEvidence();
  evidence.observeGit = async () => {
    evidenceCalls++;
    return { changedPaths: [], preExistingUnchanged: [], diff: '', baseRevision: 'base', head: 'head', clean: true };
  };
  let workId = '';
  const orch = new Orchestrator(policy, store, () => {}, {
    evidence,
    driver: {
      prepare(input) {
        return { attemptDir: '', promptPath: '', lastMessagePath: '', logPath: '', argv: [], env: {}, cwd: '', attemptId: input.attemptId } as never;
      },
      async run(run, onState) {
        const child = { pid: process.pid, processStart: 'fixture' };
        onState?.({ phase: 'running', child, quiesced: false });
        onState?.({ phase: 'stopped', child, quiesced: true });
        const lockDir = join(policy.stateDir, 'execution.lock');
        const metadata = inspectExecutionOwnership(policy.stateDir).metadata!;
        writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ ...metadata, token: 'replacement' }));
        const attemptId = (run as unknown as { attemptId: string }).attemptId;
        return {
          exitCode: 0, signal: null, timedOut: false, stdout: 'runtime output', stderr: '', durationMs: 1,
          lastMessage: JSON.stringify({
            schemaVersion: '1', workId, attemptId, status: 'completed', summary: 'done',
            claims: [], questions: [], declaredChangedPaths: [],
          }),
        };
      },
    },
  });
  const work = orch.createWork({ request: '修正問題', workspace: repoIn(base) });
  workId = work.id;

  await assert.rejects(orch.runAttempt(work.id, { noBaseline: true }), (error) => {
    assert.equal((error as { code?: string }).code, 'OWNER_UNKNOWN');
    return true;
  });
  const attempt = store.listAttempts(work.id)[0]!;
  assert.equal(evidenceCalls, 0);
  assert.equal((store.db.prepare(`select count(*) as n from artifacts where kind like 'runtime_%'`).get() as { n: number }).n, 0);
  assert.equal((store.db.prepare('select count(*) as n from evidence where attempt_id = ?').get(attempt.id) as { n: number }).n, 0);
  assert.equal(store.lastOutcome(work.id), null);
  assert.equal(attempt.status, 'RUNNING');
  assert.equal(inspectExecutionOwnership(policy.stateDir).metadata?.token, 'replacement');
  store.close();
  rmSync(base, { recursive: true, force: true });
});
