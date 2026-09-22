import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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

test('artifact replacement marks completed downstream milestones stale with dependency paths', () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-checkpoint-stale-'));
  const store = new Store(join(base, 'state'));
  try {
    const work: Work = {
      id: 'W-stale', title: 'dependency invalidation', repositoryId: 'repo', workspace: join(base, 'workspace'),
      state: 'ACTIVE', currentContractVersion: 1, retryBudget: 2,
      createdAt: '2026-09-22T00:00:00.000Z',
    };
    store.insertWork(work);
    store.insertContract({
      id: 'C-stale', workId: work.id, version: 1, request: 'three milestones', mode: 'write',
      constraints: [], deniedPaths: [], successCriteria: ['build', 'package', 'release'],
      sourceMessageIds: ['MSG-1'], createdAt: '2026-09-22T00:00:00.000Z',
    });
    const plans = new PlanService(store);
    const proposed = plans.propose({
      workId: work.id, contractVersion: 1, branchId: 'B-stale', reason: 'initial',
      milestones: [
        { id: 'M-1', objective: 'build', acceptanceCriterionIds: [acceptanceCriterionId('build')] },
        {
          id: 'M-2', objective: 'package', acceptanceCriterionIds: [acceptanceCriterionId('package')],
          dependsOn: ['M-1'],
        },
        {
          id: 'M-3', objective: 'release', acceptanceCriterionIds: [acceptanceCriterionId('release')],
          dependsOn: ['M-2'],
        },
      ],
    });
    plans.activate(proposed.plan.id);
    store.setMilestoneStatus(proposed.plan.id, 'M-2', 'COMPLETED', 'A-2');
    store.setMilestoneStatus(proposed.plan.id, 'M-3', 'COMPLETED', 'A-3');
    const checkpoints = new CheckpointService(store);
    const firstArtifact = store.putArtifact('checkpoint_output', 'hash-a', 'txt');
    const first = checkpoints.create({
      workId: work.id, planId: proposed.plan.id, milestoneId: 'M-1',
      artifacts: [{ artifactId: firstArtifact.id, logicalName: 'build', producerMilestoneId: 'M-1' }],
      validationStatus: 'validated', validationEvidenceIds: [],
    });
    const firstSnapshot = store.getCheckpoint(first.id);

    const secondArtifact = store.putArtifact('checkpoint_output', 'hash-b', 'txt');
    checkpoints.create({
      workId: work.id, planId: proposed.plan.id, parentCheckpointId: first.id, milestoneId: 'M-1',
      artifacts: [{ artifactId: secondArtifact.id, logicalName: 'build', producerMilestoneId: 'M-1' }],
      validationStatus: 'validated', validationEvidenceIds: [],
    });

    assert.equal(store.getMilestone(proposed.plan.id, 'M-1')!.status, 'PENDING');
    assert.equal(store.getMilestone(proposed.plan.id, 'M-2')!.status, 'STALE');
    assert.equal(store.getMilestone(proposed.plan.id, 'M-3')!.status, 'STALE');
    assert.deepEqual(store.getCheckpoint(first.id), firstSnapshot);
    const events = store.events(work.id).map((event) => ({
      type: event.type, data: JSON.parse(event.data) as Record<string, unknown>,
    }));
    const replaced = events.find((event) => event.type === 'dependency.artifact_replaced');
    assert.deepEqual(replaced?.data, {
      planId: proposed.plan.id, producerMilestoneId: 'M-1', logicalName: 'build',
      previousArtifactId: firstArtifact.id, replacementArtifactId: secondArtifact.id,
      previousHash: firstArtifact.hash, replacementHash: secondArtifact.hash,
    });
    assert.deepEqual(events.filter((event) => event.type === 'milestone.stale').map((event) => event.data), [
      {
        planId: proposed.plan.id, milestoneId: 'M-2', sourceMilestoneId: 'M-1',
        logicalName: 'build', dependencyPath: ['M-1', 'M-2'],
      },
      {
        planId: proposed.plan.id, milestoneId: 'M-3', sourceMilestoneId: 'M-1',
        logicalName: 'build', dependencyPath: ['M-1', 'M-2', 'M-3'],
      },
    ]);
  } finally {
    store.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('G2 acceptance: real harness workspace forks a two-milestone checkpoint without rewriting history', () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-g2-'));
  const store = new Store(join(base, 'state'));
  const workspace = process.cwd();
  const trackedPath = join(workspace, 'package.json');
  const fileHash = (): string => createHash('sha256').update(readFileSync(trackedPath)).digest('hex');
  const work: Work = {
    id: 'W-G2', title: 'G2 real workspace', repositoryId: 'agent-work-harness', workspace,
    state: 'ACTIVE', currentContractVersion: 1, retryBudget: 3,
    createdAt: '2026-09-22T00:00:00.000Z',
  };
  const complete = (attempt: Attempt): void => {
    store.insertAttempt(attempt);
    store.setWorkState(work.id, 'VERIFYING');
    attempt.status = 'COMPLETED';
    attempt.phase = 'terminal';
    attempt.endedAt = '2026-09-22T00:10:00.000Z';
    store.finalizeAttempt({
      attempt, outcome: 'SUCCESS', reasons: ['G2 fixture verified'], workState: 'DONE', evidenceIds: [],
      expectedAttemptStatus: 'RUNNING', expectedWorkState: 'VERIFYING',
    });
  };
  const attempt = (id: string, number: number, planId: string, branchId: string, milestoneId: string): Attempt => ({
    id, workId: work.id, planId, branchId, milestoneId, number, mode: 'write', contractVersion: 1,
    contractSnapshotHash: 'fixture-snapshot', baseRevision: 'fixture-base', promptArtifactId: 'AR-fixture',
    runtime: 'codex', status: 'RUNNING', phase: 'executing', startedAt: '2026-09-22T00:05:00.000Z',
  });
  try {
    store.insertWork(work);
    store.insertContract({
      id: 'C-G2', workId: work.id, version: 1, request: 'finish two milestones', mode: 'write',
      constraints: ['never deploy'], deniedPaths: ['secret/**'],
      successCriteria: ['first accepted', 'second accepted'], sourceMessageIds: ['MSG-G2'],
      createdAt: '2026-09-22T00:00:00.000Z',
    });
    const milestones = [
      { id: 'M-1', objective: 'first', acceptanceCriterionIds: [acceptanceCriterionId('first accepted')] },
      {
        id: 'M-2', objective: 'second', dependsOn: ['M-1'],
        acceptanceCriterionIds: [acceptanceCriterionId('second accepted')],
      },
    ];
    const plans = new PlanService(store);
    const original = plans.propose({
      workId: work.id, contractVersion: 1, branchId: 'B-original', reason: 'original', milestones,
    }).plan;
    plans.activate(original.id);
    complete(attempt('A-original-M1', 1, original.id, original.branchId, 'M-1'));
    const checkpoints = new CheckpointService(store);
    const checkpoint = checkpoints.create({
      workId: work.id, planId: original.id, milestoneId: 'M-1', artifacts: [],
      validationStatus: 'validated', validationEvidenceIds: [],
    });
    const attemptsBeforeFork = store.listAttempts(work.id);
    const retryBudgetBeforeFork = store.getWork(work.id)!.retryBudget;
    const workspaceHashBeforeFork = fileHash();

    const forked = checkpoints.fork({ checkpointId: checkpoint.id, reason: 'G2 fork', milestones });
    assert.notEqual(forked.plan.branchId, original.branchId);
    assert.equal(forked.plan.parentPlanId, original.id);
    assert.deepEqual(store.listAttempts(work.id), attemptsBeforeFork);
    assert.equal(store.getWork(work.id)!.retryBudget, retryBudgetBeforeFork);
    assert.equal(fileHash(), workspaceHashBeforeFork);
    plans.activate(forked.plan.id);

    complete(attempt('A-old-M2', 2, original.id, original.branchId, 'M-2'));
    assert.equal(store.getMilestone(original.id, 'M-2')!.status, 'PENDING');
    assert.equal(store.getWork(work.id)!.state, 'ACTIVE');

    complete(attempt('A-fork-M1', 3, forked.plan.id, forked.plan.branchId, 'M-1'));
    assert.equal(store.getWork(work.id)!.state, 'ACTIVE');
    complete(attempt('A-fork-M2', 4, forked.plan.id, forked.plan.branchId, 'M-2'));
    assert.equal(store.getWork(work.id)!.state, 'DONE');
    assert.equal(fileHash(), workspaceHashBeforeFork);
  } finally {
    store.close();
    rmSync(base, { recursive: true, force: true });
  }
});
