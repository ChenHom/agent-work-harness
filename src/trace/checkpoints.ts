import { newId, nowIso } from '../ids.ts';
import type { LogicalCheckpoint, PlanMilestone, WorkPlan } from '../types.ts';
import type { PlanProposal } from '../work/plans.ts';
import { PlanService } from '../work/plans.ts';
import { Store } from './store.ts';

interface CheckpointArtifactInput {
  artifactId: string;
  logicalName: string;
  producerMilestoneId?: string;
}

interface CreateCheckpointInput {
  workId: string;
  planId: string;
  parentCheckpointId?: string;
  milestoneId?: string;
  artifacts: CheckpointArtifactInput[];
  validationStatus: LogicalCheckpoint['validationStatus'];
  validationEvidenceIds: string[];
}

interface ForkCheckpointInput {
  checkpointId: string;
  reason: string;
  milestones: PlanProposal['milestones'];
}

interface ResumedCheckpoint {
  checkpoint: LogicalCheckpoint;
  activePlan: WorkPlan;
  milestones: PlanMilestone[];
}

function unavailable(id: string, reason: string): Error {
  return new Error(`CHECKPOINT_ARTIFACT_UNAVAILABLE: ${id} (${reason})`);
}

function corrupt(id: string, reason: string): Error {
  return new Error(`CHECKPOINT_ARTIFACT_CORRUPT: ${id} (${reason})`);
}

export class CheckpointService {
  private readonly store: Store;

  constructor(store: Store) { this.store = store; }

  create(input: CreateCheckpointInput): LogicalCheckpoint {
    const work = this.store.getWork(input.workId);
    if (!work) throw new Error(`CHECKPOINT_INVALID: work ${input.workId} does not exist`);
    const plan = this.store.getPlan(input.planId);
    if (!plan || plan.workId !== input.workId) {
      throw new Error(`CHECKPOINT_INVALID: plan ${input.planId} does not belong to work ${input.workId}`);
    }
    if (plan.status !== 'ACTIVE') throw new Error(`CHECKPOINT_STALE: plan ${plan.id} is not active`);
    if (plan.contractVersion !== work.currentContractVersion) {
      throw new Error(`CHECKPOINT_STALE: contract v${plan.contractVersion} is not current`);
    }
    if (input.milestoneId && !this.store.getMilestone(plan.id, input.milestoneId)) {
      throw new Error(`CHECKPOINT_INVALID: milestone ${input.milestoneId} does not belong to plan ${plan.id}`);
    }
    if (input.parentCheckpointId) {
      const parent = this.store.getCheckpoint(input.parentCheckpointId);
      if (!parent || parent.workId !== input.workId || parent.planId !== plan.id || parent.branchId !== plan.branchId) {
        throw new Error(`CHECKPOINT_INVALID: parent ${input.parentCheckpointId} is outside the current plan branch`);
      }
    }

    const logicalKeys = new Set<string>();
    const artifactManifest = input.artifacts.map((entry) => {
      if (!entry.logicalName.trim()) throw new Error('CHECKPOINT_INVALID: artifact logicalName is empty');
      if (entry.producerMilestoneId && !this.store.getMilestone(plan.id, entry.producerMilestoneId)) {
        throw new Error(`CHECKPOINT_INVALID: producer milestone ${entry.producerMilestoneId} does not belong to plan ${plan.id}`);
      }
      const logicalKey = `${entry.producerMilestoneId ?? ''}\u0000${entry.logicalName}`;
      if (logicalKeys.has(logicalKey)) throw new Error(`CHECKPOINT_INVALID: duplicate artifact identity ${entry.logicalName}`);
      logicalKeys.add(logicalKey);
      const verified = this.store.readVerifiedArtifact(entry.artifactId);
      if (verified.status !== 'verified') {
        if (verified.status === 'missing') throw unavailable(entry.artifactId, verified.reason ?? 'missing');
        throw corrupt(entry.artifactId, verified.reason ?? 'corrupt');
      }
      return {
        artifactId: entry.artifactId,
        hash: verified.hash,
        logicalName: entry.logicalName,
        producerMilestoneId: entry.producerMilestoneId,
      };
    });

    const checkpoint: LogicalCheckpoint = {
      schemaVersion: '1', id: newId('CP'), workId: input.workId,
      parentCheckpointId: input.parentCheckpointId, planId: plan.id, branchId: plan.branchId,
      contractVersion: plan.contractVersion, milestoneId: input.milestoneId,
      artifactManifest, validationStatus: input.validationStatus,
      validationEvidenceIds: [...new Set(input.validationEvidenceIds)],
      createdEventSeq: this.store.latestEventSeq(), createdAt: nowIso(),
    };
    this.store.insertCheckpoint(checkpoint);
    return checkpoint;
  }

  resume(checkpointId: string): ResumedCheckpoint {
    const checkpoint = this.verifyCheckpoint(checkpointId);
    const activePlan = this.store.getActivePlan(checkpoint.workId);
    if (!activePlan || activePlan.branchId !== checkpoint.branchId) {
      throw new Error(`CHECKPOINT_STALE: branch ${checkpoint.branchId} is not active`);
    }
    if (activePlan.contractVersion !== checkpoint.contractVersion) {
      throw new Error(`CHECKPOINT_STALE: contract v${checkpoint.contractVersion} is not active`);
    }
    return { checkpoint, activePlan, milestones: this.store.listMilestones(activePlan.id) };
  }

  fork(input: ForkCheckpointInput): { plan: WorkPlan; milestones: PlanMilestone[] } {
    const checkpoint = this.verifyCheckpoint(input.checkpointId);
    const activePlan = this.store.getActivePlan(checkpoint.workId);
    if (!activePlan || activePlan.id !== checkpoint.planId) {
      throw new Error(`CHECKPOINT_STALE: source plan ${checkpoint.planId} is no longer active`);
    }
    return new PlanService(this.store).propose({
      workId: checkpoint.workId,
      contractVersion: checkpoint.contractVersion,
      parentPlanId: checkpoint.planId,
      branchId: newId('B'),
      sourceCheckpointId: checkpoint.id,
      reason: input.reason,
      milestones: input.milestones,
      reusableArtifactIds: checkpoint.artifactManifest.map((entry) => entry.artifactId),
    });
  }

  private verifyCheckpoint(checkpointId: string): LogicalCheckpoint {
    const checkpoint = this.store.getCheckpoint(checkpointId);
    if (!checkpoint) throw new Error(`CHECKPOINT_NOT_FOUND: ${checkpointId}`);
    if (checkpoint.schemaVersion !== '1') {
      throw new Error(`CHECKPOINT_SCHEMA_UNSUPPORTED: ${checkpoint.id} uses ${String(checkpoint.schemaVersion)}`);
    }
    const plan = this.store.getPlan(checkpoint.planId);
    if (!plan || plan.workId !== checkpoint.workId || plan.branchId !== checkpoint.branchId
      || plan.contractVersion !== checkpoint.contractVersion) {
      throw new Error(`CHECKPOINT_INVALID: checkpoint ${checkpoint.id} plan identity does not match`);
    }
    for (const entry of checkpoint.artifactManifest) {
      const verified = this.store.readVerifiedArtifact(entry.artifactId);
      if (verified.status !== 'verified') {
        if (verified.status === 'missing') throw unavailable(entry.artifactId, verified.reason ?? 'missing');
        throw corrupt(entry.artifactId, verified.reason ?? 'corrupt');
      }
      if (verified.hash !== entry.hash) throw corrupt(entry.artifactId, 'manifest_hash_mismatch');
    }
    return checkpoint;
  }
}
