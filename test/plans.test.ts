import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/trace/store.ts';
import { PlanService, acceptanceCriterionId } from '../src/work/plans.ts';
import type { LogicalCheckpoint, PlanMilestone, Work, WorkContract, WorkPlan } from '../src/types.ts';

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

function contract(workId = 'W-1', version = 1): WorkContract {
  return {
    id: `C-${version}`, workId, version, request: 'controlled plan', mode: 'write',
    constraints: ['never deploy'], deniedPaths: ['secret/**'],
    successCriteria: ['state is durable', 'recovery is verified'],
    sourceMessageIds: ['MSG-1'], createdAt: `2026-09-22T00:00:0${version}.000Z`,
  };
}

function proposalMilestones(): Array<{
  id: string; objective: string; acceptanceCriterionIds: string[]; dependsOn?: string[]; required?: boolean;
}> {
  return [
    {
      id: 'M-1', objective: 'persist state',
      acceptanceCriterionIds: [acceptanceCriterionId('state is durable')], required: true,
    },
    {
      id: 'M-2', objective: 'verify recovery', dependsOn: ['M-1'],
      acceptanceCriterionIds: [acceptanceCriterionId('recovery is verified')], required: true,
    },
  ];
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

test('acceptance criterion IDs are stable and content-addressed', () => {
  assert.equal(acceptanceCriterionId('state is durable'), acceptanceCriterionId('state is durable'));
  assert.notEqual(acceptanceCriterionId('state is durable'), acceptanceCriterionId('state is durable!'));
  assert.match(acceptanceCriterionId('state is durable'), /^AC-[a-f0-9]{16}$/);
});

test('valid proposal freezes the contract and activates atomically', () => {
  const h = fixture();
  try {
    h.store.insertContract(contract());
    const service = new PlanService(h.store);
    const proposed = service.propose({
      workId: h.work.id, contractVersion: 1, reason: 'initial', branchId: 'B-main',
      milestones: proposalMilestones(),
    });
    assert.equal(proposed.plan.status, 'VALIDATED');
    assert.equal(proposed.plan.contractVersion, 1);
    assert.deepEqual(proposed.milestones.map((milestone) => milestone.sequence), [1, 2]);

    const active = service.activate(proposed.plan.id);
    assert.equal(active.status, 'ACTIVE');
    assert.equal(h.store.getActivePlan(h.work.id)?.id, active.id);
    assert.equal(h.store.listPlans(h.work.id).filter((candidate) => candidate.status === 'ACTIVE').length, 1);
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('invalid milestone graphs and criterion coverage leave no proposal rows', () => {
  const cases: Array<{ name: string; milestones: ReturnType<typeof proposalMilestones>; error: RegExp }> = [
    {
      name: 'duplicate id',
      milestones: [proposalMilestones()[0]!, { ...proposalMilestones()[1]!, id: 'M-1' }],
      error: /duplicate.*M-1/i,
    },
    {
      name: 'missing dependency',
      milestones: [{ ...proposalMilestones()[0]!, dependsOn: ['M-missing'] }, proposalMilestones()[1]!],
      error: /dependency.*M-missing/i,
    },
    {
      name: 'self dependency',
      milestones: [{ ...proposalMilestones()[0]!, dependsOn: ['M-1'] }, proposalMilestones()[1]!],
      error: /self|cycle/i,
    },
    {
      name: 'cycle',
      milestones: [
        { ...proposalMilestones()[0]!, dependsOn: ['M-2'] },
        { ...proposalMilestones()[1]!, dependsOn: ['M-1'] },
      ],
      error: /cycle/i,
    },
    {
      name: 'unknown criterion',
      milestones: [{ ...proposalMilestones()[0]!, acceptanceCriterionIds: ['AC-unknown'] }, proposalMilestones()[1]!],
      error: /criterion.*AC-unknown/i,
    },
    {
      name: 'missing coverage',
      milestones: [proposalMilestones()[0]!],
      error: /coverage.*recovery is verified/i,
    },
  ];
  for (const item of cases) {
    const h = fixture();
    try {
      h.store.insertContract(contract());
      const service = new PlanService(h.store);
      assert.throws(() => service.propose({
        workId: h.work.id, contractVersion: 1, reason: item.name, milestones: item.milestones,
      }), item.error, item.name);
      assert.deepEqual(h.store.listPlans(h.work.id), [], item.name);
    } finally {
      h.store.close();
      rmSync(h.state, { recursive: true, force: true });
    }
  }
});

test('activation rejects a changed contract version and leaves the candidate validated', () => {
  const h = fixture();
  try {
    h.store.insertContract(contract());
    const service = new PlanService(h.store);
    const candidate = service.propose({
      workId: h.work.id, contractVersion: 1, reason: 'before amendment', milestones: proposalMilestones(),
    }).plan;
    h.store.insertContract(contract(h.work.id, 2));
    h.store.setContractVersion(h.work.id, 2);

    assert.throws(() => service.activate(candidate.id), /PLAN_STALE.*contract/i);
    assert.equal(h.store.getPlan(candidate.id)!.status, 'VALIDATED');
    assert.equal(h.store.getActivePlan(h.work.id), null);
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('only one competing child plan can activate from the same parent', () => {
  const h = fixture();
  try {
    h.store.insertContract(contract());
    const service = new PlanService(h.store);
    const parent = service.propose({
      workId: h.work.id, contractVersion: 1, reason: 'parent', branchId: 'B-main',
      milestones: proposalMilestones(),
    }).plan;
    service.activate(parent.id);
    const childA = service.propose({
      workId: h.work.id, contractVersion: 1, parentPlanId: parent.id, reason: 'child A',
      branchId: 'B-a', milestones: proposalMilestones(),
    }).plan;
    const childB = service.propose({
      workId: h.work.id, contractVersion: 1, parentPlanId: parent.id, reason: 'child B',
      branchId: 'B-b', milestones: proposalMilestones(),
    }).plan;

    service.activate(childA.id);
    assert.throws(() => service.activate(childB.id), /PLAN_STALE.*parent/i);
    assert.equal(h.store.getActivePlan(h.work.id)!.id, childA.id);
    assert.equal(h.store.getPlan(parent.id)!.status, 'SUPERSEDED');
    assert.equal(h.store.getPlan(childB.id)!.status, 'VALIDATED');
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});
