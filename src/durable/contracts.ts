import type { RuntimeExecutionIdentity } from './runtime-state.ts';

type DurableWorkflowStatus =
  | 'GENERATING'
  | 'DISPATCHING'
  | 'WAITING_EXTERNAL'
  | 'RETRY_WAIT'
  | 'RECONCILING'
  | 'VALIDATING'
  | 'SUCCEEDED'
  | 'WAITING_USER'
  | 'FAILED';

export interface DurableWorkflowInput {
  workId: string;
  epoch: number;
  businessId: string;
  value: string;
  generatedText: string;
  callbackTimeoutMs: number;
  callbackSourceVersion?: number;
  callbackDedupeLimit?: number;
  lookupDelayCount?: number;
  reconcileDelayMs?: number;
  maxReconcileAttempts?: number;
  historyEventLimit?: number;
}

export interface DurableCallback {
  eventId: string;
  sourceVersion: number;
  sequence: number;
  operationId: string;
  receiptRef: string;
}

export interface DurableCallbackInbox {
  recentEvents: DurableCallback[];
  lastSequence: number;
  acceptedEventId?: string;
  acceptedReceiptRef?: string;
  acceptedTransitionCount: number;
  ignoredCount: number;
  conflictReason?: string;
}

interface DurableContinueAsNewState {
  budgetWorkId: string;
  deadlineAtMs: number;
  outputArtifactId?: string;
  operationId?: string;
  operationStatus?: string;
  receiptArtifactId?: string;
  callbackInbox: DurableCallbackInbox;
}

export interface DurableContinueAsNewInput extends DurableWorkflowInput {
  carry: DurableContinueAsNewState;
}

export interface DurableWorkflowSnapshot {
  status: DurableWorkflowStatus;
  outputArtifactId?: string;
  operationId?: string;
  operationStatus?: string;
  receiptArtifactId?: string;
  acceptedCallbackCount?: number;
  ignoredCallbackCount?: number;
  callbackConflict?: string;
}

export interface DurableWorkflowResult extends DurableWorkflowSnapshot {
  validationVerdict: 'pass' | 'fail' | 'unknown';
  outputArtifactId: string;
  operationId: string;
  receiptArtifactId?: string;
  validationArtifactId?: string;
}

interface GenerateOutputInput {
  workId: string;
  generatedText: string;
}

interface DispatchOperationInput {
  workId: string;
  businessId: string;
  value: string;
  lookupDelayCount?: number;
  authority: RuntimeExecutionIdentity;
}

export interface DispatchOperationResult {
  operationId: string;
  operationStatus: string;
  inputArtifactId: string;
  idempotencyKey: string;
}

interface ReconcileOperationInput {
  operationId: string;
  authority: RuntimeExecutionIdentity;
}

export interface ReconcileOperationResult {
  operationStatus: string;
  receiptArtifactId?: string;
}

interface ValidateTerminalInput {
  operationId: string;
  outputArtifactId: string;
  receiptArtifactId?: string;
}

export interface ValidateTerminalResult {
  verdict: 'pass' | 'fail';
  validationArtifactId: string;
}

export interface DurableActivities {
  generateOutput(input: GenerateOutputInput): Promise<{ outputArtifactId: string }>;
  dispatchOperation(input: DispatchOperationInput): Promise<DispatchOperationResult>;
  reconcileOperation(input: ReconcileOperationInput): Promise<ReconcileOperationResult>;
  validateTerminal(input: ValidateTerminalInput): Promise<ValidateTerminalResult>;
}
