import { createHash } from 'node:crypto';
import { newId, nowIso } from '../ids.ts';
import { Store } from '../trace/store.ts';
import type { PlanMilestone, WorkContract, WorkPlan } from '../types.ts';

interface MilestoneProposal {
  id: string;
  objective: string;
  acceptanceCriterionIds: string[];
  dependsOn?: string[];
  required?: boolean;
}

export interface PlanProposal {
  workId: string;
  contractVersion: number;
  parentPlanId?: string;
  branchId?: string;
  sourceCheckpointId?: string;
  reason: string;
  milestones: MilestoneProposal[];
  reusableArtifactIds?: string[];
  validationEvidenceIds?: string[];
}

export function acceptanceCriterionId(text: string): string {
  return `AC-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

function criterionMap(contract: WorkContract): Map<string, string> {
  return new Map(contract.successCriteria.map((text) => [acceptanceCriterionId(text), text]));
}

function validateMilestones(contract: WorkContract, proposals: readonly MilestoneProposal[]): void {
  if (proposals.length === 0) throw new Error('PLAN_INVALID: milestones must not be empty');
  const ids = new Set<string>();
  for (const milestone of proposals) {
    if (!milestone.id.trim()) throw new Error('PLAN_INVALID: milestone id must not be empty');
    if (ids.has(milestone.id)) throw new Error(`PLAN_INVALID: duplicate milestone ${milestone.id}`);
    ids.add(milestone.id);
    if (!milestone.objective.trim()) throw new Error(`PLAN_INVALID: milestone ${milestone.id} objective is empty`);
    if (milestone.acceptanceCriterionIds.length === 0) {
      throw new Error(`PLAN_INVALID: milestone ${milestone.id} has no acceptance criterion`);
    }
  }

  const criteria = criterionMap(contract);
  for (const milestone of proposals) {
    for (const dependency of milestone.dependsOn ?? []) {
      if (dependency === milestone.id) throw new Error(`PLAN_INVALID: self dependency ${milestone.id}`);
      if (!ids.has(dependency)) throw new Error(`PLAN_INVALID: dependency ${dependency} does not exist`);
    }
    for (const criterionId of milestone.acceptanceCriterionIds) {
      if (!criteria.has(criterionId)) throw new Error(`PLAN_INVALID: criterion ${criterionId} does not exist`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(proposals.map((milestone) => [milestone.id, milestone]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`PLAN_INVALID: dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);

  const covered = new Set(proposals
    .filter((milestone) => milestone.required !== false)
    .flatMap((milestone) => milestone.acceptanceCriterionIds));
  for (const [id, text] of criteria) {
    if (!covered.has(id)) throw new Error(`PLAN_INVALID: acceptance coverage missing ${text} (${id})`);
  }
}

function milestoneChanged(previous: PlanMilestone | undefined, next: MilestoneProposal): boolean {
  if (!previous) return true;
  return previous.objective !== next.objective
    || previous.required !== (next.required !== false)
    || JSON.stringify(previous.acceptanceCriterionIds) !== JSON.stringify(next.acceptanceCriterionIds)
    || JSON.stringify(previous.dependsOn) !== JSON.stringify(next.dependsOn ?? []);
}

function downstreamImpact(proposals: readonly MilestoneProposal[], changed: ReadonlySet<string>): string[] {
  const impacted = new Set<string>();
  let added = true;
  while (added) {
    added = false;
    for (const milestone of proposals) {
      if (changed.has(milestone.id) || impacted.has(milestone.id)) continue;
      if ((milestone.dependsOn ?? []).some((id) => changed.has(id) || impacted.has(id))) {
        impacted.add(milestone.id);
        added = true;
      }
    }
  }
  return [...impacted];
}

export class PlanService {
  private readonly store: Store;

  constructor(store: Store) { this.store = store; }

  propose(input: PlanProposal): { plan: WorkPlan; milestones: PlanMilestone[] } {
    const work = this.store.getWork(input.workId);
    if (!work) throw new Error(`PLAN_INVALID: work ${input.workId} does not exist`);
    if (work.currentContractVersion !== input.contractVersion) {
      throw new Error(`PLAN_STALE: contract v${input.contractVersion} is not current v${work.currentContractVersion}`);
    }
    const contract = this.store.getContract(input.workId, input.contractVersion);
    if (!contract) throw new Error(`PLAN_INVALID: contract v${input.contractVersion} does not exist`);
    validateMilestones(contract, input.milestones);

    const active = this.store.getActivePlan(input.workId);
    let parentMilestones: PlanMilestone[] = [];
    if (input.parentPlanId) {
      const parent = this.store.getPlan(input.parentPlanId);
      if (!parent || parent.workId !== input.workId) {
        throw new Error(`PLAN_INVALID: parent ${input.parentPlanId} does not belong to work`);
      }
      if (active?.id !== parent.id) throw new Error(`PLAN_STALE: parent ${parent.id} is not active`);
      parentMilestones = this.store.listMilestones(parent.id);
    } else if (active) {
      throw new Error(`PLAN_INVALID: active plan ${active.id} requires parentPlanId`);
    }

    const previousById = new Map(parentMilestones.map((milestone) => [milestone.id, milestone]));
    const changed = new Set(input.milestones
      .filter((milestone) => milestoneChanged(previousById.get(milestone.id), milestone))
      .map((milestone) => milestone.id));
    for (const previous of parentMilestones) {
      if (!input.milestones.some((milestone) => milestone.id === previous.id)) changed.add(previous.id);
    }
    const existing = this.store.listPlans(input.workId);
    const planId = newId('P');
    const plan: WorkPlan = {
      id: planId, workId: input.workId,
      version: Math.max(0, ...existing.map((candidate) => candidate.version)) + 1,
      branchId: input.branchId ?? active?.branchId ?? newId('B'),
      parentPlanId: input.parentPlanId, contractVersion: input.contractVersion,
      reason: input.reason, changedMilestoneIds: [...changed],
      dependencyImpact: downstreamImpact(input.milestones, changed),
      reusableArtifactIds: [...new Set(input.reusableArtifactIds ?? [])],
      sourceCheckpointId: input.sourceCheckpointId,
      validationEvidenceIds: [...new Set(input.validationEvidenceIds ?? [])],
      status: 'VALIDATED', createdAt: nowIso(),
    };
    const milestones: PlanMilestone[] = input.milestones.map((milestone, index) => ({
      id: milestone.id, planId, sequence: index + 1, objective: milestone.objective,
      acceptanceCriterionIds: [...milestone.acceptanceCriterionIds],
      dependsOn: [...(milestone.dependsOn ?? [])], required: milestone.required !== false,
      status: 'PENDING',
    }));
    this.store.withTransaction(() => {
      this.store.insertPlan(plan);
      this.store.insertMilestones(milestones);
    });
    return { plan, milestones };
  }

  activate(planId: string): WorkPlan {
    return this.store.activatePlan(planId);
  }
}
