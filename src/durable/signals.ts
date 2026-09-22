import { defineQuery, defineSignal } from '@temporalio/workflow';
import type {
  DurableCallback, DurableCallbackInbox, DurableContinueAsNewInput, DurableWorkflowInput,
  DurableWorkflowSnapshot,
} from './contracts.ts';

export const durableCallbackSignal = defineSignal<[DurableCallback]>('durable.callback');
export const durableStateQuery = defineQuery<DurableWorkflowSnapshot>('durable.state');
export const DEFAULT_CALLBACK_DEDUPE_LIMIT = 128;
const DEFAULT_DURABLE_HISTORY_EVENT_LIMIT = 10_000;

export function createCallbackInbox(): DurableCallbackInbox {
  return { recentEvents: [], lastSequence: -1, acceptedTransitionCount: 0, ignoredCount: 0 };
}

function remember(
  inbox: DurableCallbackInbox,
  callback: DurableCallback,
  limit: number,
): DurableCallbackInbox {
  return {
    ...inbox,
    recentEvents: [...inbox.recentEvents, callback].slice(-Math.max(1, limit)),
  };
}

export function applyDurableCallback(
  current: DurableCallbackInbox,
  callback: DurableCallback,
  expectedOperationId: string,
  expectedSourceVersion: number,
  dedupeLimit: number,
): DurableCallbackInbox {
  if (current.recentEvents.some((event) => event.eventId === callback.eventId)) {
    return { ...current, ignoredCount: current.ignoredCount + 1 };
  }
  let next = remember(current, callback, dedupeLimit);
  if (callback.operationId !== expectedOperationId) {
    return { ...next, conflictReason: `operation mismatch: expected ${expectedOperationId}, received ${callback.operationId}` };
  }
  if (callback.sourceVersion < expectedSourceVersion || callback.sequence < current.lastSequence) {
    return { ...next, ignoredCount: current.ignoredCount + 1 };
  }
  if (callback.sourceVersion > expectedSourceVersion) {
    return {
      ...next,
      conflictReason: `source version ahead of workflow: expected ${expectedSourceVersion}, received ${callback.sourceVersion}`,
    };
  }
  if (callback.sequence === current.lastSequence) {
    return { ...next, conflictReason: `sequence conflict at ${callback.sequence}` };
  }
  next = { ...next, lastSequence: callback.sequence };
  if (current.acceptedReceiptRef) {
    if (callback.receiptRef === current.acceptedReceiptRef) {
      return { ...next, ignoredCount: current.ignoredCount + 1 };
    }
    return {
      ...next,
      conflictReason: `receipt conflict: accepted ${current.acceptedReceiptRef}, received ${callback.receiptRef}`,
    };
  }
  return {
    ...next,
    acceptedEventId: callback.eventId,
    acceptedReceiptRef: callback.receiptRef,
    acceptedTransitionCount: current.acceptedTransitionCount + 1,
  };
}

export function buildContinueAsNewInput(
  input: DurableWorkflowInput,
  snapshot: DurableWorkflowSnapshot,
  callbackInbox: DurableCallbackInbox,
  deadlineAtMs: number,
): DurableContinueAsNewInput {
  return {
    ...input,
    historyEventLimit: input.historyEventLimit ?? DEFAULT_DURABLE_HISTORY_EVENT_LIMIT,
    carry: {
      budgetWorkId: input.workId,
      deadlineAtMs,
      outputArtifactId: snapshot.outputArtifactId,
      operationId: snapshot.operationId,
      operationStatus: snapshot.operationStatus,
      receiptArtifactId: snapshot.receiptArtifactId,
      callbackInbox,
    },
  };
}
