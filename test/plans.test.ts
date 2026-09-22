import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/trace/store.ts';
import type { LogicalCheckpoint, PlanMilestone, Work, WorkPlan } from '../src/types.ts';

function fixture(): { state: string; store: Store; work: Work } {
  const state = mkdtempSync(join(tmpdir(), 'harness-plans-'));
  const store = new Store(state);
  const work: Work = {
    id: 'W-1', title: 'controlled plan', repositoryId: 'repo', workspace: '/repo',
    state: 'ACTIVE', currentContractVersion: 1, retryBudget: 2,
    createdAt: '2026-09-22T00:00:00.000Z',
  };
  store.insertWork(work);
  return { state, store, work };
}

function plan(workId = 'W-1'): WorkPlan {
  return {
    id: 'P-1', workId, version: 1, branchId: 'B-main', contractVersion: 1,
    reason: 'initial plan', changedMilestoneIds: ['M-1', 'M-2'], dependencyImpact: [],
    reusableArtifactIds: [], validationEvidenceIds: [], status: 'PROPOSED',
    createdAt: '2026-09-22T00:01:00.000Z',
  };
}

const milestones: PlanMilestone[] = [
  {
    id: 'M-1', planId: 'P-1', sequence: 1, objective: 'prepare durable state',
    acceptanceCriterionIds: ['AC-a'], dependsOn: [], required: true, status: 'PENDING',
  },
  {
    id: 'M-2', planId: 'P-1', sequence: 2, objective: 'verify durable state',
    acceptanceCriterionIds: ['AC-b'], dependsOn: ['M-1'], required: true, status: 'PENDING',
  },
];

test('plan, milestone, and checkpoint records round-trip without losing identity', () => {
  const h = fixture();
  try {
    const p = plan();
    h.store.insertPlan(p);
    h.store.insertMilestones(milestones);
    const artifact = h.store.putArtifact('checkpoint_fixture', 'payload', 'txt');
    const checkpoint: LogicalCheckpoint = {
      schemaVersion: '1', id: 'CP-1', workId: h.work.id, planId: p.id, branchId: p.branchId,
      contractVersion: 1, milestoneId: 'M-1', validationStatus: 'pending_validation',
      validationEvidenceIds: [], artifactManifest: [{
        artifactId: artifact.id, hash: artifact.hash, logicalName: 'build', producerMilestoneId: 'M-1',
      }],
      createdEventSeq: 1, createdAt: '2026-09-22T00:02:00.000Z',
    };
    h.store.insertCheckpoint(checkpoint);

    assert.deepEqual(h.store.getPlan(p.id), p);
    assert.deepEqual(h.store.listPlans(h.work.id), [p]);
    assert.deepEqual(h.store.listMilestones(p.id), milestones);
    assert.deepEqual(h.store.getMilestone(p.id, 'M-2'), milestones[1]);
    assert.deepEqual(h.store.getCheckpoint(checkpoint.id), checkpoint);
    assert.deepEqual(h.store.listCheckpoints(h.work.id), [checkpoint]);
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('checkpoint rows are append-only', () => {
  const h = fixture();
  try {
    h.store.insertPlan(plan());
    h.store.insertMilestones(milestones);
    const checkpoint: LogicalCheckpoint = {
      schemaVersion: '1', id: 'CP-1', workId: h.work.id, planId: 'P-1', branchId: 'B-main',
      contractVersion: 1, validationStatus: 'pending_validation', validationEvidenceIds: [],
      artifactManifest: [], createdEventSeq: 1, createdAt: '2026-09-22T00:02:00.000Z',
    };
    h.store.insertCheckpoint(checkpoint);
    assert.throws(() => h.store.insertCheckpoint({ ...checkpoint, validationStatus: 'validated' }), /constraint|exists/i);
    assert.deepEqual(h.store.getCheckpoint('CP-1'), checkpoint);
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});
