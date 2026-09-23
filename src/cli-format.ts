import type {
  Attempt, BudgetLimit, BudgetReservation, Compensation, LogicalCheckpoint, Operation,
  Outcome, PlanMilestone, RecoverySession, Work, WorkPlan,
} from './types.ts';
import type { DurableWorkflowSnapshot } from './durable/contracts.ts';

export function formatWorkListRow(work: Work, outcome: Outcome | null): string {
  return `${work.id}  ${work.state.padEnd(12)} ${work.repositoryId.padEnd(16)} ${work.title}  outcome=${outcome ?? '-'}`;
}

export function formatPreExistingDirty(attempt: Attempt): string {
  const dirty = attempt.preExistingDirty ?? [];
  if (!dirty.length) return '    preExistingDirty: -';
  return `    preExistingDirty: ${dirty.map(({ path, hash }) => `${path} (hash=${hash ?? 'null'})`).join(', ')}`;
}

export function formatContextDropped(attempt: Attempt): string {
  const dropped = attempt.contextDropped ?? [];
  if (!dropped.length) return '    contextDropped: -';
  return `    contextDropped: ${dropped.map(({ priority, count }) => `priority=${priority} count=${count}`).join(', ')}`;
}

export function formatRecoverySession(session: RecoverySession): string {
  const evidence = session.evidenceIds.length ? session.evidenceIds.join(',') : '-';
  return `- ${session.id} ${session.status} attempt=${session.attemptId} evidence=${evidence}: ${session.reason}`;
}

export function formatPlan(plan: WorkPlan): string {
  return `plan ${plan.id} v${plan.version} ${plan.status} branch=${plan.branchId} contract=v${plan.contractVersion}`;
}

export function formatMilestone(milestone: PlanMilestone): string {
  const dependencies = milestone.dependsOn.length ? milestone.dependsOn.join(',') : '-';
  return `- ${milestone.id} ${milestone.status} required=${milestone.required} dependsOn=${dependencies}: ${milestone.objective}`;
}

export function formatCheckpoint(checkpoint: LogicalCheckpoint): string {
  return `- ${checkpoint.id} ${checkpoint.validationStatus} branch=${checkpoint.branchId} plan=${checkpoint.planId}`
    + ` milestone=${checkpoint.milestoneId ?? '-'} artifacts=${checkpoint.artifactManifest.length}`;
}

export function formatOperation(operation: Operation): string {
  return `- ${operation.id} ${operation.status} intent=${operation.intentKey}`
    + ` target=${operation.targetScope} key=${operation.idempotencyKey}`;
}

export function formatCompensation(compensation: Compensation): string {
  return `- ${compensation.id} ${compensation.status} operation=${compensation.operationId}`
    + ` target=${compensation.resourceIdentity} key=${compensation.idempotencyKey}`;
}

export function formatBudget(
  limit: BudgetLimit,
  reservations: BudgetReservation[],
  spentUnits: number,
  reservedUnits: number,
): string {
  return `- ${limit.resourceKind}/${limit.currency ?? '-'} limit=${limit.limitUnits}`
    + ` spent=${spentUnits} reserved=${reservedUnits}`
    + ` available=${limit.limitUnits - spentUnits - reservedUnits}`
    + ` reservations=${reservations.length} pricing=${limit.pricingVersion}`;
}

export function formatDurableSnapshot(snapshot: DurableWorkflowSnapshot): string {
  return `${snapshot.status} run=${snapshot.runId ?? '-'} epoch=${snapshot.epoch ?? '-'}`
    + ` operation=${snapshot.operationId ?? '-'}`
    + ` callbacks=${snapshot.acceptedCallbackCount ?? 0}/${snapshot.ignoredCallbackCount ?? 0}`
    + (snapshot.compatibilityReason ? ` reason=${snapshot.compatibilityReason}` : '');
}
