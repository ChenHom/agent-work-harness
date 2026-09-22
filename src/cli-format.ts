import type {
  Attempt, LogicalCheckpoint, Outcome, PlanMilestone, RecoverySession, Work, WorkPlan,
} from './types.ts';

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
