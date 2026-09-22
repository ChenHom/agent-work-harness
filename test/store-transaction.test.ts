import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/trace/store.ts';
import type { Attempt, EvidenceRecord, Work } from '../src/types.ts';

function seededStore(state: string): { store: Store; work: Work; attempt: Attempt; evidence: EvidenceRecord } {
  const store = new Store(state);
  const work: Work = {
    id: 'W', title: 'transaction fixture', repositoryId: 'repo', workspace: '/tmp/repo',
    state: 'RUNNING', currentContractVersion: 1, retryBudget: 1, createdAt: '2026-09-20T00:00:00.000Z',
  };
  const attempt: Attempt = {
    id: 'A', workId: work.id, number: 1, mode: 'write', contractVersion: 1,
    contractSnapshotHash: 'contract', baseRevision: 'base', promptArtifactId: '', runtime: 'codex',
    status: 'RUNNING', startedAt: '2026-09-20T00:00:00.000Z',
  };
  const evidence: EvidenceRecord = {
    id: 'EV', workId: work.id, attemptId: attempt.id, type: 'test_result', label: 'test',
    status: 'PASS', data: { exitCode: 0 }, observedAt: '2026-09-20T00:01:00.000Z',
  };
  store.insertWork(work);
  store.insertAttempt(attempt);
  store.insertEvidence(evidence);
  return { store, work, attempt, evidence };
}

function completed(attempt: Attempt): Attempt {
  return { ...attempt, status: 'COMPLETED', endedAt: '2026-09-20T00:02:00.000Z' };
}

const STORE_MODULE = new URL('../src/trace/store.ts', import.meta.url).href;

function crashChild(state: string, body: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { Store } from ${JSON.stringify(STORE_MODULE)};
    const store = new Store(process.env.CRASH_STATE);
    store.db.function('crash_now', () => { process.kill(process.pid, 'SIGKILL'); return 0; });
    ${body}
  `], { env: { ...process.env, CRASH_STATE: state }, timeout: 5_000 });
}

test('process death after artifact publish leaves no database reference to an incomplete payload', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-crash-'));
  new Store(state).close();
  const child = crashChild(state, `
    store.db.exec("create trigger crash_artifact before insert on artifacts begin select crash_now(); end");
    store.putArtifact('prompt', 'fully-published-before-crash', 'txt');
  `);
  assert.equal(child.signal, 'SIGKILL');

  const reopened = new Store(state);
  try {
    assert.equal((reopened.db.prepare('select count(*) as n from artifacts').get() as { n: number }).n, 0);
    const files = readdirSync(reopened.artifactDir);
    assert.equal(files.some((name) => name.includes('.tmp-')), false);
    assert.equal(files.length, 1, 'a complete unreferenced payload is safe for later garbage collection');
  } finally {
    reopened.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('process death between outcome insert and work update rolls back the whole terminal transition', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-crash-'));
  const seeded = seededStore(state);
  seeded.store.close();
  const child = crashChild(state, `
    store.db.exec("create trigger crash_terminal before update on works when new.state = 'DONE' begin select crash_now(); end");
    const attempt = store.getAttempt('A');
    attempt.status = 'COMPLETED';
    attempt.endedAt = '2026-09-20T00:02:00.000Z';
    store.finalizeAttempt({ attempt, outcome: 'SUCCESS', reasons: ['verified'], workState: 'DONE',
      evidenceIds: ['EV'], expectedAttemptStatus: 'RUNNING', expectedWorkState: 'RUNNING' });
  `);
  assert.equal(child.signal, 'SIGKILL');

  const reopened = new Store(state);
  try {
    assert.equal(reopened.getAttempt('A')!.status, 'RUNNING');
    assert.equal(reopened.getWork('W')!.state, 'RUNNING');
    assert.equal(reopened.lastOutcome('W'), null);
    assert.equal(reopened.events('W').some((event) => event.type === 'attempt.completed'), false);
  } finally {
    reopened.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('withTransaction rolls back an event when the callback throws', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-tx-'));
  const store = new Store(state);
  try {
    assert.throws(() => store.withTransaction(() => {
      store.event('usage.note', { kind: 'test', text: 'must roll back' }, 'W');
      throw new Error('injected');
    }), /injected/);
  } finally {
    store.close();
  }

  const reopened = new Store(state);
  try {
    assert.deepEqual(reopened.events('W'), []);
  } finally {
    reopened.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('withTransaction explicitly rejects nested transactions', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-tx-'));
  const store = new Store(state);
  try {
    assert.throws(
      () => store.withTransaction(() => store.withTransaction(() => undefined)),
      /nested transaction/i,
    );
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('withTransaction rejects Promise callbacks and rolls back their writes', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-tx-'));
  const store = new Store(state);
  try {
    assert.throws(() => store.withTransaction(() => {
      store.event('usage.note', { kind: 'test', text: 'must roll back' }, 'W');
      return Promise.resolve('async work');
    }), /Promise|synchronous/i);
    assert.deepEqual(store.events('W'), []);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('withTransaction rejects an async callback before it can continue outside the transaction', async () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-tx-'));
  const store = new Store(state);
  let invoked = false;
  try {
    assert.throws(() => store.withTransaction(async () => {
      invoked = true;
      await Promise.resolve();
      store.event('usage.note', { kind: 'test', text: 'late write' }, 'W');
    }), /Promise|synchronous/i);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(invoked, false);
    assert.deepEqual(store.events('W'), []);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('withTransaction preserves the original error when SQLite already rolled back', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-tx-'));
  const store = new Store(state);
  try {
    store.db.exec(`create trigger rollback_event before insert on events
      begin select raise(rollback, 'trigger forced rollback'); end`);
    assert.throws(() => store.withTransaction(() => {
      store.event('usage.note', { kind: 'test', text: 'rollback trigger' }, 'W');
    }), /trigger forced rollback/);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('finalizeAttempt rolls back attempt, outcome, work, and events when work update fails', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-finalize-'));
  const { store, work, attempt, evidence } = seededStore(state);
  try {
    const beforeAttempt = store.getAttempt(attempt.id);
    const beforeWork = store.getWork(work.id);
    const beforeEvents = store.events(work.id);
    store.db.exec(`create trigger inject_work_update_failure before update on works
      begin select raise(abort, 'injected work update failure'); end`);

    assert.throws(() => store.finalizeAttempt({
      attempt: completed(attempt), outcome: 'SUCCESS', reasons: ['verified'],
      workState: 'DONE', evidenceIds: [evidence.id],
      expectedAttemptStatus: 'RUNNING', expectedWorkState: 'RUNNING',
    }), /injected work update failure/);

    assert.deepEqual(store.getAttempt(attempt.id), beforeAttempt);
    assert.deepEqual(store.getWork(work.id), beforeWork);
    assert.equal(store.lastOutcome(work.id), null);
    assert.deepEqual(store.events(work.id), beforeEvents);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('finalizeAttempt binds evidence and safely replays the same finalization once', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-finalize-'));
  const { store, work, attempt, evidence } = seededStore(state);
  try {
    const input = {
      attempt: completed(attempt), outcome: 'SUCCESS' as const, reasons: ['verified'],
      workState: 'DONE' as const, evidenceIds: [evidence.id],
      expectedAttemptStatus: 'RUNNING' as const, expectedWorkState: 'RUNNING' as const,
    };
    store.finalizeAttempt(input);
    const afterFirst = store.events(work.id);
    store.finalizeAttempt(input);

    assert.deepEqual(store.lastOutcome(work.id), {
      outcome: 'SUCCESS', reasons: ['verified'], attemptId: attempt.id, evidenceIds: [evidence.id],
    });
    assert.deepEqual(store.events(work.id), afterFirst);
    assert.equal(afterFirst.filter((event) => event.type === 'attempt.completed').length, 1);
    assert.equal(afterFirst.filter((event) => event.type === 'work.completed').length, 1);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('finalizeAttempt rejects a conflicting replay', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-finalize-'));
  const { store, attempt, evidence } = seededStore(state);
  try {
    store.finalizeAttempt({
      attempt: completed(attempt), outcome: 'SUCCESS', reasons: ['verified'],
      workState: 'DONE', evidenceIds: [evidence.id],
      expectedAttemptStatus: 'RUNNING', expectedWorkState: 'RUNNING',
    });
    assert.throws(() => store.finalizeAttempt({
      attempt: completed(attempt), outcome: 'FAILED', reasons: ['changed'],
      workState: 'FAILED', evidenceIds: [evidence.id],
      expectedAttemptStatus: 'RUNNING', expectedWorkState: 'RUNNING',
    }), /STATE_CONFLICT/);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('finalizeAttempt rejects an attempt attached to a different work without partial writes', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-finalize-'));
  const { store, work, attempt, evidence } = seededStore(state);
  try {
    const beforeAttempt = store.getAttempt(attempt.id);
    const beforeEvents = store.events(work.id);
    assert.throws(() => store.finalizeAttempt({
      attempt: { ...completed(attempt), workId: 'W-wrong' }, outcome: 'SUCCESS', reasons: ['verified'],
      workState: 'DONE', evidenceIds: [evidence.id],
      expectedAttemptStatus: 'RUNNING', expectedWorkState: 'RUNNING',
    }), /STATE_CONFLICT/);
    assert.deepEqual(store.getAttempt(attempt.id), beforeAttempt);
    assert.equal(store.lastOutcome(work.id), null);
    assert.deepEqual(store.events(work.id), beforeEvents);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('finalizeAttempt rejects a nonexistent attempt without changing its work', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-finalize-'));
  const { store, work, attempt } = seededStore(state);
  try {
    const beforeWork = store.getWork(work.id);
    const beforeEvents = store.events(work.id);
    assert.throws(() => store.finalizeAttempt({
      attempt: { ...completed(attempt), id: 'A-missing' }, outcome: 'SUCCESS', reasons: ['verified'],
      workState: 'DONE', evidenceIds: [],
      expectedAttemptStatus: 'RUNNING', expectedWorkState: 'RUNNING',
    }), /STATE_CONFLICT/);
    assert.deepEqual(store.getWork(work.id), beforeWork);
    assert.equal(store.lastOutcome(work.id), null);
    assert.deepEqual(store.events(work.id), beforeEvents);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('finalizeAttempt rejects a nonexistent work without changing its attempt', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-finalize-'));
  const { store, work, attempt } = seededStore(state);
  try {
    store.db.prepare('delete from works where id = ?').run(work.id);
    const beforeAttempt = store.getAttempt(attempt.id);
    const beforeEvents = store.events(work.id);
    assert.throws(() => store.finalizeAttempt({
      attempt: completed(attempt), outcome: 'FAILED', reasons: ['failed'],
      workState: 'FAILED', evidenceIds: [],
      expectedAttemptStatus: 'RUNNING', expectedWorkState: 'RUNNING',
    }), /STATE_CONFLICT/);
    assert.deepEqual(store.getAttempt(attempt.id), beforeAttempt);
    assert.equal(store.lastOutcome(work.id), null);
    assert.deepEqual(store.events(work.id), beforeEvents);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('finalizeAttempt does not accept evidence with the right attempt id from another work', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-finalize-'));
  const { store, work, attempt } = seededStore(state);
  try {
    store.insertEvidence({
      id: 'EV-foreign', workId: 'W-foreign', attemptId: attempt.id, type: 'test_result',
      label: 'foreign', status: 'PASS', data: {}, observedAt: '2026-09-20T00:01:00.000Z',
    });
    const beforeEvents = store.events(work.id);
    assert.throws(() => store.finalizeAttempt({
      attempt: completed(attempt), outcome: 'SUCCESS', reasons: ['verified'],
      workState: 'DONE', evidenceIds: ['EV-foreign'],
      expectedAttemptStatus: 'RUNNING', expectedWorkState: 'RUNNING',
    }), /STATE_CONFLICT/);
    assert.equal(store.lastOutcome(work.id), null);
    assert.deepEqual(store.events(work.id), beforeEvents);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('finalizeAttempt replay uses durable canonical identity and never rewinds later work state', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-finalize-'));
  const seeded = seededStore(state);
  const firstAttempt = completed(seeded.attempt);
  seeded.store.finalizeAttempt({
    attempt: firstAttempt, outcome: 'SUCCESS', reasons: ['verified'],
    workState: 'DONE', evidenceIds: [seeded.evidence.id],
    expectedAttemptStatus: 'RUNNING', expectedWorkState: 'RUNNING',
  });
  seeded.store.close();

  const reopened = new Store(state);
  try {
    reopened.setWorkState(seeded.work.id, 'ACTIVE');
    const beforeReplayEvents = reopened.events(seeded.work.id);
    const reorderedAttempt: Attempt = {
      endedAt: firstAttempt.endedAt,
      startedAt: firstAttempt.startedAt,
      status: firstAttempt.status,
      runtime: firstAttempt.runtime,
      promptArtifactId: firstAttempt.promptArtifactId,
      baseRevision: firstAttempt.baseRevision,
      contractSnapshotHash: firstAttempt.contractSnapshotHash,
      contractVersion: firstAttempt.contractVersion,
      mode: firstAttempt.mode,
      number: firstAttempt.number,
      workId: firstAttempt.workId,
      id: firstAttempt.id,
    };
    reopened.finalizeAttempt({
      attempt: reorderedAttempt, outcome: 'SUCCESS', reasons: ['verified'],
      workState: 'DONE', evidenceIds: [seeded.evidence.id],
      expectedAttemptStatus: 'RUNNING', expectedWorkState: 'RUNNING',
    });
    assert.equal(reopened.getWork(seeded.work.id)?.state, 'ACTIVE');
    assert.deepEqual(reopened.events(seeded.work.id), beforeReplayEvents);
  } finally {
    reopened.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('finalizeAttempt canonical identity conflicts on every logical finalization field', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-finalize-'));
  const { store, attempt, evidence } = seededStore(state);
  const finalAttempt = completed(attempt);
  const original = {
    attempt: finalAttempt, outcome: 'SUCCESS' as const, reasons: ['verified'],
    workState: 'DONE' as const, evidenceIds: [evidence.id],
    expectedAttemptStatus: 'RUNNING' as const, expectedWorkState: 'RUNNING' as const,
  };
  try {
    store.finalizeAttempt(original);
    const variants = [
      { ...original, workState: 'FAILED' as const },
      { ...original, attempt: { ...finalAttempt, endedAt: '2026-09-20T00:03:00.000Z' } },
      { ...original, outcome: 'FAILED' as const },
      { ...original, reasons: ['different'] },
      { ...original, evidenceIds: [] },
    ];
    for (const variant of variants) {
      assert.throws(() => store.finalizeAttempt(variant), /STATE_CONFLICT/);
    }
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('finalizeAttempt rejects a stale attempt status without partial writes', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-finalize-'));
  const { store, work, attempt, evidence } = seededStore(state);
  try {
    const recovered: Attempt = { ...attempt, status: 'RECOVERY_REQUIRED' };
    store.updateAttempt(recovered);
    const beforeEvents = store.events(work.id);
    assert.throws(() => store.finalizeAttempt({
      attempt: completed(attempt), outcome: 'SUCCESS', reasons: ['stale result'],
      workState: 'DONE', evidenceIds: [evidence.id],
      expectedAttemptStatus: 'RUNNING', expectedWorkState: 'RUNNING',
    }), /STATE_CONFLICT/);
    assert.deepEqual(store.getAttempt(attempt.id), recovered);
    assert.equal(store.lastOutcome(work.id), null);
    assert.deepEqual(store.events(work.id), beforeEvents);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('finalizeAttempt rejects a stale work state without partial writes', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-finalize-'));
  const { store, work, attempt, evidence } = seededStore(state);
  try {
    store.setWorkState(work.id, 'WAITING_USER');
    const beforeEvents = store.events(work.id);
    assert.throws(() => store.finalizeAttempt({
      attempt: completed(attempt), outcome: 'SUCCESS', reasons: ['stale result'],
      workState: 'DONE', evidenceIds: [evidence.id],
      expectedAttemptStatus: 'RUNNING', expectedWorkState: 'RUNNING',
    }), /STATE_CONFLICT/);
    assert.equal(store.getAttempt(attempt.id)?.status, 'RUNNING');
    assert.equal(store.getWork(work.id)?.state, 'WAITING_USER');
    assert.equal(store.lastOutcome(work.id), null);
    assert.deepEqual(store.events(work.id), beforeEvents);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});
