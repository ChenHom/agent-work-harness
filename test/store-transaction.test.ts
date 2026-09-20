import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    });
    assert.throws(() => store.finalizeAttempt({
      attempt: completed(attempt), outcome: 'FAILED', reasons: ['changed'],
      workState: 'FAILED', evidenceIds: [evidence.id],
    }), /STATE_CONFLICT/);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});
