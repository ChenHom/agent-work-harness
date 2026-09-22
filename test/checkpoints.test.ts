import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointService } from '../src/trace/checkpoints.ts';
import { Store } from '../src/trace/store.ts';
import { PlanService, acceptanceCriterionId } from '../src/work/plans.ts';
import type { Attempt, Work, WorkContract } from '../src/types.ts';

function fixture(): {
  base: string; workspace: string; store: Store; work: Work; plans: PlanService; checkpoints: CheckpointService;
  activePlanId: string;
} {
  const base = mkdtempSync(join(tmpdir(), 'harness-checkpoints-'));
  const workspace = join(base, 'workspace');
  mkdirSync(workspace);
  const store = new Store(join(base, 'state'));
  const work: Work = {
    id: 'W-1', title: 'checkpoint fixture', repositoryId: 'repo', workspace,
    state: 'ACTIVE', currentContractVersion: 1, retryBudget: 2,
    createdAt: '2026-09-22T00:00:00.000Z',
  };
  const contract: WorkContract = {
    id: 'C-1', workId: work.id, version: 1, request: 'two milestones', mode: 'write',
    constraints: ['never deploy'], deniedPaths: ['secret/**'],
    successCriteria: ['first accepted', 'second accepted'], sourceMessageIds: ['MSG-1'],
    createdAt: '2026-09-22T00:00:00.000Z',
  };
  store.insertWork(work);
  store.insertContract(contract);
  const plans = new PlanService(store);
  const proposed = plans.propose({
    workId: work.id, contractVersion: 1, branchId: 'B-main', reason: 'initial',
    milestones: [
      { id: 'M-1', objective: 'first', acceptanceCriterionIds: [acceptanceCriterionId('first accepted')] },
      {
        id: 'M-2', objective: 'second', acceptanceCriterionIds: [acceptanceCriterionId('second accepted')],
        dependsOn: ['M-1'],
      },
    ],
  });
  plans.activate(proposed.plan.id);
  return {
    base, workspace, store, work, plans, checkpoints: new CheckpointService(store),
    activePlanId: proposed.plan.id,
  };
}

test('checkpoint creation verifies artifacts and forms an append-only parent chain', () => {
  const h = fixture();
  try {
    const artifact = h.store.putArtifact('checkpoint_output', 'v1', 'txt');
    const first = h.checkpoints.create({
      workId: h.work.id, planId: h.activePlanId, milestoneId: 'M-1',
      artifacts: [{ artifactId: artifact.id, logicalName: 'build', producerMilestoneId: 'M-1' }],
      validationStatus: 'pending_validation', validationEvidenceIds: [],
    });
    const second = h.checkpoints.create({
      workId: h.work.id, planId: h.activePlanId, parentCheckpointId: first.id,
      artifacts: [], validationStatus: 'validated', validationEvidenceIds: [],
    });

    assert.equal(first.artifactManifest[0]!.hash, artifact.hash);
    assert.equal(first.validationStatus, 'pending_validation');
    assert.equal(second.parentCheckpointId, first.id);
    assert.deepEqual(h.store.listCheckpoints(h.work.id).map((checkpoint) => checkpoint.id), [first.id, second.id]);
    const checkpointEvent = h.store.events(h.work.id).find((event) => event.type === 'checkpoint.created');
    assert.ok(checkpointEvent && checkpointEvent.seq > first.createdEventSeq);
  } finally {
    h.store.close();
    rmSync(h.base, { recursive: true, force: true });
  }
});

test('checkpoint creation and resume fail closed for missing or corrupt artifacts', () => {
  const h = fixture();
  try {
    assert.throws(() => h.checkpoints.create({
      workId: h.work.id, planId: h.activePlanId,
      artifacts: [{ artifactId: 'AR-missing', logicalName: 'build' }],
      validationStatus: 'pending_validation', validationEvidenceIds: [],
    }), /CHECKPOINT_ARTIFACT_UNAVAILABLE.*AR-missing/);

    const artifact = h.store.putArtifact('checkpoint_output', 'v1', 'txt');
    const checkpoint = h.checkpoints.create({
      workId: h.work.id, planId: h.activePlanId,
      artifacts: [{ artifactId: artifact.id, logicalName: 'build' }],
      validationStatus: 'validated', validationEvidenceIds: [],
    });
    writeFileSync(artifact.path, 'xx');
    assert.throws(() => h.checkpoints.resume(checkpoint.id), /CHECKPOINT_ARTIFACT_CORRUPT/);
  } finally {
    h.store.close();
    rmSync(h.base, { recursive: true, force: true });
  }
});

test('resume is read-only, keeps branch identity, and does not promote pending validation', () => {
  const h = fixture();
  try {
    const checkpoint = h.checkpoints.create({
      workId: h.work.id, planId: h.activePlanId, milestoneId: 'M-1', artifacts: [],
      validationStatus: 'pending_validation', validationEvidenceIds: [],
    });
    const beforeEvents = h.store.events(h.work.id);
    const resumed = h.checkpoints.resume(checkpoint.id);

    assert.equal(resumed.checkpoint.branchId, 'B-main');
    assert.equal(resumed.activePlan.id, h.activePlanId);
    assert.equal(resumed.checkpoint.validationStatus, 'pending_validation');
    assert.deepEqual(h.store.events(h.work.id), beforeEvents);
  } finally {
    h.store.close();
    rmSync(h.base, { recursive: true, force: true });
  }
});

test('fork creates a new branch without resetting attempts, retry budget, or dirty workspace files', () => {
  const h = fixture();
  try {
    const dirtyPath = join(h.workspace, 'dirty.txt');
    writeFileSync(dirtyPath, 'keep me exactly');
    const attempt: Attempt = {
      id: 'A-1', workId: h.work.id, number: 1, mode: 'write', contractVersion: 1,
      contractSnapshotHash: 'hash', baseRevision: 'base', promptArtifactId: 'AR-prompt',
      runtime: 'codex', status: 'RECOVERY_REQUIRED', phase: 'dispatch_intent',
      startedAt: '2026-09-22T00:03:00.000Z',
    };
    h.store.insertAttempt(attempt);
    const checkpoint = h.checkpoints.create({
      workId: h.work.id, planId: h.activePlanId, milestoneId: 'M-1', artifacts: [],
      validationStatus: 'validated', validationEvidenceIds: [],
    });
    const attemptsBefore = h.store.listAttempts(h.work.id);
    const retryBudgetBefore = h.store.getWork(h.work.id)!.retryBudget;
    const dirtyBefore = readFileSync(dirtyPath, 'utf8');

    const forked = h.checkpoints.fork({
      checkpointId: checkpoint.id, reason: 'try another route',
      milestones: [
        { id: 'M-1', objective: 'first fork', acceptanceCriterionIds: [acceptanceCriterionId('first accepted')] },
        {
          id: 'M-2', objective: 'second fork', acceptanceCriterionIds: [acceptanceCriterionId('second accepted')],
          dependsOn: ['M-1'],
        },
      ],
    });

    assert.notEqual(forked.plan.branchId, checkpoint.branchId);
    assert.equal(forked.plan.parentPlanId, checkpoint.planId);
    assert.equal(forked.plan.sourceCheckpointId, checkpoint.id);
    assert.deepEqual(h.store.listAttempts(h.work.id), attemptsBefore);
    assert.equal(h.store.getWork(h.work.id)!.retryBudget, retryBudgetBefore);
    assert.equal(readFileSync(dirtyPath, 'utf8'), dirtyBefore);
  } finally {
    h.store.close();
    rmSync(h.base, { recursive: true, force: true });
  }
});

test('fork rejects a checkpoint whose source plan is no longer active', () => {
  const h = fixture();
  try {
    const checkpoint = h.checkpoints.create({
      workId: h.work.id, planId: h.activePlanId, artifacts: [],
      validationStatus: 'validated', validationEvidenceIds: [],
    });
    const replacement = h.plans.propose({
      workId: h.work.id, contractVersion: 1, parentPlanId: h.activePlanId,
      branchId: 'B-main', reason: 'replace source', milestones: [
        { id: 'M-1', objective: 'first new', acceptanceCriterionIds: [acceptanceCriterionId('first accepted')] },
        {
          id: 'M-2', objective: 'second new', acceptanceCriterionIds: [acceptanceCriterionId('second accepted')],
          dependsOn: ['M-1'],
        },
      ],
    }).plan;
    h.plans.activate(replacement.id);

    assert.throws(() => h.checkpoints.fork({
      checkpointId: checkpoint.id, reason: 'stale fork',
      milestones: h.store.listMilestones(replacement.id).map((milestone) => ({
        id: milestone.id, objective: milestone.objective,
        acceptanceCriterionIds: milestone.acceptanceCriterionIds, dependsOn: milestone.dependsOn,
      })),
    }), /CHECKPOINT_STALE.*source plan/i);
  } finally {
    h.store.close();
    rmSync(h.base, { recursive: true, force: true });
  }
});
