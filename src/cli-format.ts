import type {
  Attempt, BudgetLimit, BudgetReservation, Compensation, LogicalCheckpoint, Operation,
  Outcome, PlanMilestone, RecoverySession, Work, WorkPlan,
} from './types.ts';
import type { DurableWorkflowSnapshot } from './durable/contracts.ts';
import type { ReviewEnvelope, ReviewedFile } from './review/report.ts';
import type { LatestReview } from './review/review.ts';

export function formatWorkListRow(work: Work, outcome: Outcome | null): string {
  return `${work.id}  ${work.state.padEnd(12)} ${work.repositoryId.padEnd(16)} ${work.title}  outcome=${outcome ?? '-'}`;
}

// list --json：給外部輪詢（例如 UI pane）用。outcome 只在屬於最新 attempt 時輸出，
// retry 進行中時上一輪的 outcome 不能被讀成現況。
export function workListEntry(
  work: Work, attempt: Attempt | null, last: { outcome: Outcome; reasons: string[]; attemptId: string } | null,
) {
  return {
    id: work.id, title: work.title, repositoryId: work.repositoryId, state: work.state, createdAt: work.createdAt,
    attempt: attempt && {
      id: attempt.id, number: attempt.number, status: attempt.status, phase: attempt.phase ?? null,
      startedAt: attempt.startedAt, endedAt: attempt.endedAt ?? null,
      runtimeState: attempt.runtimeDispatch?.state ?? null, childPid: attempt.runtimeDispatch?.child?.pid ?? null,
    },
    outcome: last && attempt && last.attemptId === attempt.id ? { outcome: last.outcome, reasons: last.reasons } : null,
  };
}

export function formatPreExistingDirty(attempt: Attempt): string {
  const dirty = attempt.preExistingDirty ?? [];
  if (!dirty.length) return '    preExistingDirty: -';
  return `    preExistingDirty: ${dirty.map(({ path, hash, error }) => error !== undefined ? `(snapshot failed: ${error})`
    : `${path} (hash=${hash ?? 'null'})`).join(', ')}`;
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

const reviewedFile = (file: ReviewedFile): string => `- ${file.path}${file.reasons.length ? `: ${file.reasons.join(', ')}` : ''}`;

/**
 * 來自報表、repository 或外部程序的字串：C0、DEL、C1 控制字元（含 ESC 與換行）改成 `\xNN`，
 * 終端機不會執行它們，一筆資料也不會偽裝成好幾行輸出。
 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
export function escapeControl(text: string): string {
  return text.replace(CONTROL, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** `harness review` 與 `show` 共用。未選入的檔案一律帶 DEV-01 標示，不寫成已驗證安全（C7）。 */
export function formatReview(envelope: ReviewEnvelope, hashes: { envelopeSha256: string; reportSha256: string }): string[] {
  const checks = envelope.verification.checks.map((check) => `${check.checkId}=${check.status}`).join(', ') || '(no checks)';
  const lines = [
    `status: ${envelope.status}`,
    `candidate: ${envelope.candidate}  attempt: ${envelope.attemptId}`,
    `base: ${envelope.baseRevision}  resultTree: ${envelope.resultTree}`,
    `envelope sha256: ${hashes.envelopeSha256}`,
    `report sha256: ${hashes.reportSha256}`,
    `reviewer: ${envelope.reviewer.imageId} revision=${envelope.reviewer.revision}`,
    `verification (clean copy of ${envelope.verification.revision}): ${checks}; changed paths ${envelope.verification.changedPaths}`,
    '人工待辦（Reviewer 選入）:',
    ...(envelope.humanReview.length ? envelope.humanReview.map(reviewedFile) : ['(none)']),
    '機械審查未選入，fact layer 尚未接入（DEV-01）；不代表已驗證安全:',
    ...(envelope.notSelected.length ? envelope.notSelected.map(reviewedFile) : ['(none)']),
  ];
  return lines.map(escapeControl);
}

/** `show` 的 [review] 段落：最新一筆 review 事件。 */
export function formatLatestReview(review: LatestReview): string[] {
  switch (review.status) {
    case 'none': return ['(none)'];
    case 'invalid': return [escapeControl(`REVIEW_ARTIFACT_INVALID: ${review.reason}`)];
    case 'failed': return [escapeControl(`FAILED ${review.code} (exit ${review.exitCode ?? '?'}): ${review.detail}`)];
    case 'valid': return [
      ...(review.stale ? [`STALE: work contract is now v${review.stale.current ?? '?'}; this review is for v${review.stale.reviewed}`] : []),
      ...formatReview(review.envelope, review),
    ];
  }
}
