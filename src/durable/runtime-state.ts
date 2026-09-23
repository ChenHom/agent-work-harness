import type { DispatchAction, DispatchAuthority } from '../runtime/dispatch-authority.ts';

type RuntimeExecutionStatus =
  | 'ACTIVE'
  | 'CANCEL_REQUESTED'
  | 'QUIESCING'
  | 'RECONCILING'
  | 'WAITING_USER'
  | 'COMPLETED'
  | 'CANCELLED';

export interface RuntimeExecutionState {
  workflowId: string;
  runId: string;
  epoch: number;
  status: RuntimeExecutionStatus;
}

export interface RuntimeExecutionIdentity {
  workflowId: string;
  runId: string;
  epoch: number;
}

export type RuntimeExecutionReader = (
  workflowId: string,
  expected?: RuntimeExecutionIdentity,
) => RuntimeExecutionState | null | Promise<RuntimeExecutionState | null>;

export function nextRuntimeEpoch(
  current: RuntimeExecutionState,
  runId: string,
): RuntimeExecutionState {
  if (!runId.trim()) throw new Error('RUNTIME_RUN_ID_REQUIRED');
  if (!Number.isSafeInteger(current.epoch) || current.epoch < 1) throw new Error('RUNTIME_EPOCH_INVALID');
  return { workflowId: current.workflowId, runId, epoch: current.epoch + 1, status: 'ACTIVE' };
}

export class TemporalDispatchAuthority implements DispatchAuthority {
  readonly identity: RuntimeExecutionIdentity;
  private readonly read: RuntimeExecutionReader;
  private operationInUse = false;

  constructor(identity: RuntimeExecutionIdentity, read: RuntimeExecutionReader) {
    if (!identity.workflowId.trim() || !identity.runId.trim()) throw new Error('RUNTIME_EXECUTION_ID_REQUIRED');
    if (!Number.isSafeInteger(identity.epoch) || identity.epoch < 1) throw new Error('RUNTIME_EPOCH_INVALID');
    this.identity = structuredClone(identity);
    this.read = read;
  }

  beginOperation(): boolean {
    if (this.operationInUse) return false;
    this.operationInUse = true;
    return true;
  }

  endOperation(): void { this.operationInUse = false; }

  async validate(action: DispatchAction): Promise<boolean> {
    const active = await this.read(this.identity.workflowId, this.identity);
    if (!active || active.workflowId !== this.identity.workflowId
      || active.runId !== this.identity.runId || active.epoch !== this.identity.epoch) return false;
    if (action === 'dispatch' || action === 'publish') return active.status === 'ACTIVE';
    return active.status === 'ACTIVE' || active.status === 'QUIESCING' || active.status === 'RECONCILING';
  }
}
