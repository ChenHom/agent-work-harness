import {
  condition, continueAsNew, patched, proxyActivities, setHandler, sleep,
  workflowInfo,
} from '@temporalio/workflow';
import type {
  DurableActivities, DurableCallback, DurableWorkflowInput, DurableWorkflowResult,
  DurableWorkflowSnapshot,
} from './contracts.ts';
import {
  applyDurableCallback, buildContinueAsNewInput, createCallbackInbox,
  DEFAULT_CALLBACK_DEDUPE_LIMIT, DEFAULT_DURABLE_HISTORY_EVENT_LIMIT,
  durableCallbackSignal, durableCancelSignal, durableRolloverSignal, durableStateQuery,
} from './signals.ts';
import { DURABLE_ROLLOVER_PATCH_ID, evaluateDurableCompatibility } from './versioning.ts';

const activities = proxyActivities<DurableActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { initialInterval: '50 milliseconds', maximumAttempts: 3 },
});

export async function durableFakeWorkflow(input: DurableWorkflowInput): Promise<DurableWorkflowResult> {
  const info = workflowInfo();
  const carry = input.carry;
  const rolloverEnabled = patched(DURABLE_ROLLOVER_PATCH_ID);
  const compatibility = evaluateDurableCompatibility(input.requiredWorkflowVersion);
  let snapshot: DurableWorkflowSnapshot = carry ? {
    status: carry.stage,
    outputArtifactId: carry.outputArtifactId,
    operationId: carry.operationId,
    operationStatus: carry.operationStatus,
    receiptArtifactId: carry.receiptArtifactId,
    epoch: input.epoch,
    runId: info.runId,
    deadlineAtMs: carry.deadlineAtMs,
  } : { status: 'GENERATING', epoch: input.epoch, runId: info.runId };
  let callbackInbox = carry?.callbackInbox ?? createCallbackInbox();
  let cancelRequested = false;
  let rolloverRequested = false;
  const pendingCallbacks: DurableCallback[] = [];
  const sourceVersion = input.callbackSourceVersion ?? 1;
  const dedupeLimit = input.callbackDedupeLimit ?? DEFAULT_CALLBACK_DEDUPE_LIMIT;
  const updateCallbackSnapshot = (): void => {
    snapshot = {
      ...snapshot,
      acceptedCallbackCount: callbackInbox.acceptedTransitionCount,
      ignoredCallbackCount: callbackInbox.ignoredCount,
      ...(callbackInbox.conflictReason ? { callbackConflict: callbackInbox.conflictReason } : {}),
    };
  };
  const applyCallback = (callback: DurableCallback): void => {
    if (!snapshot.operationId) {
      pendingCallbacks.push(callback);
      return;
    }
    if (snapshot.status === 'SUCCEEDED' || snapshot.status === 'FAILED'
      || snapshot.status === 'WAITING_USER' || snapshot.status === 'CANCELLED') {
      callbackInbox = { ...callbackInbox, ignoredCount: callbackInbox.ignoredCount + 1 };
    } else {
      callbackInbox = applyDurableCallback(
        callbackInbox, callback, snapshot.operationId, sourceVersion, dedupeLimit,
      );
    }
    updateCallbackSnapshot();
  };
  setHandler(durableCallbackSignal, applyCallback);
  setHandler(durableCancelSignal, () => {
    if (snapshot.status === 'SUCCEEDED' || snapshot.status === 'FAILED'
      || snapshot.status === 'WAITING_USER' || snapshot.status === 'CANCELLED') return;
    cancelRequested = true;
    snapshot = { ...snapshot, status: 'CANCEL_REQUESTED' };
  });
  setHandler(durableRolloverSignal, () => { if (rolloverEnabled) rolloverRequested = true; });
  setHandler(durableStateQuery, () => ({ ...snapshot }));
  updateCallbackSnapshot();

  if (!compatibility.compatible) {
    return {
      ...snapshot, status: 'WAITING_USER', validationVerdict: 'unknown',
      compatibilityReason: compatibility.reason,
    };
  }
  if (carry && (carry.budgetWorkId !== input.workId || !carry.outputArtifactId
    || !carry.operationId || !carry.operationStatus)) {
    return {
      ...snapshot, status: 'WAITING_USER', validationVerdict: 'unknown',
      compatibilityReason: 'Continue-As-New state is incomplete or belongs to another Work',
    };
  }

  const authority = { workflowId: info.workflowId, runId: info.runId, epoch: input.epoch };
  let outputArtifactId = carry?.outputArtifactId;
  let operationId = carry?.operationId;
  let operationStatus = carry?.operationStatus;
  if (!carry) {
    const output = await activities.generateOutput({ workId: input.workId, generatedText: input.generatedText });
    outputArtifactId = output.outputArtifactId;
    if (cancelRequested) return cancellationResult(snapshot, outputArtifactId, undefined, 'CANCELLED');
    snapshot = { status: 'DISPATCHING', outputArtifactId, epoch: input.epoch, runId: info.runId };
    const dispatched = await activities.dispatchOperation({
      workId: input.workId, businessId: input.businessId, value: input.value,
      lookupDelayCount: input.lookupDelayCount, dispatchDelayMs: input.dispatchDelayMs,
      providerResponseDelayMs: input.providerResponseDelayMs,
      lookupDelayMs: input.lookupDelayMs, compensationDelayMs: input.compensationDelayMs,
      compensationBehavior: input.compensationBehavior, authority,
    });
    operationId = dispatched.operationId;
    operationStatus = dispatched.operationStatus;
    snapshot = {
      status: 'WAITING_EXTERNAL', outputArtifactId, operationId, operationStatus,
      epoch: input.epoch, runId: info.runId,
    };
  }
  if (!outputArtifactId || !operationId || !operationStatus) {
    return {
      ...snapshot, status: 'WAITING_USER', validationVerdict: 'unknown',
      compatibilityReason: 'durable operation state is incomplete',
    };
  }
  for (const callback of pendingCallbacks.splice(0)) applyCallback(callback);
  updateCallbackSnapshot();

  const deadlineAtMs = carry?.deadlineAtMs ?? Date.now() + input.callbackTimeoutMs;
  snapshot = { ...snapshot, deadlineAtMs };
  const rollover = async (reconcileAttempt = 0): Promise<never> => {
    const continued = buildContinueAsNewInput(input, snapshot, callbackInbox, deadlineAtMs, reconcileAttempt);
    return continueAsNew<typeof durableFakeWorkflow>(continued);
  };
  const shouldRollover = (): boolean => rolloverEnabled && (
    rolloverRequested
    || workflowInfo().continueAsNewSuggested
    || workflowInfo().historyLength >= (input.historyEventLimit ?? DEFAULT_DURABLE_HISTORY_EVENT_LIMIT)
  );

  const quiesce = async (initialOperationStatus: string): Promise<DurableWorkflowResult> => {
    snapshot = { ...snapshot, status: 'QUIESCING', operationStatus: initialOperationStatus };
    let currentOperationStatus = initialOperationStatus;
    let receiptArtifactId = snapshot.receiptArtifactId;
    const maximumReconcileAttempts = Math.max(1, input.maxReconcileAttempts ?? 3);
    for (let attempt = 1;
      (currentOperationStatus === 'UNKNOWN' || currentOperationStatus === 'RECONCILING')
        && attempt <= maximumReconcileAttempts;
      attempt += 1) {
      const reconciled = await activities.reconcileOperation({ operationId, authority });
      currentOperationStatus = reconciled.operationStatus;
      receiptArtifactId = reconciled.receiptArtifactId ?? receiptArtifactId;
      snapshot = {
        ...snapshot, status: 'QUIESCING', operationStatus: currentOperationStatus,
        ...(receiptArtifactId ? { receiptArtifactId } : {}),
      };
      if ((currentOperationStatus === 'UNKNOWN' || currentOperationStatus === 'RECONCILING')
        && attempt < maximumReconcileAttempts) await sleep(Math.max(1, input.reconcileDelayMs ?? 250));
    }
    if (currentOperationStatus === 'FAILED') {
      return cancellationResult(snapshot, outputArtifactId, operationId, 'CANCELLED');
    }
    if (currentOperationStatus !== 'SUCCEEDED') {
      return cancellationResult(snapshot, outputArtifactId, operationId, 'WAITING_USER');
    }

    const maximumCompensationAttempts = Math.max(1, input.maxCompensationAttempts ?? 3);
    for (let attempt = 1; attempt <= maximumCompensationAttempts; attempt += 1) {
      const compensation = await activities.compensateOperation({
        operationId, businessId: input.businessId, authority,
      });
      snapshot = {
        ...snapshot, status: 'QUIESCING', compensationId: compensation.compensationId,
        compensationStatus: compensation.compensationStatus,
      };
      if (compensation.compensationStatus === 'SUCCEEDED') {
        return cancellationResult(snapshot, outputArtifactId, operationId, 'CANCELLED');
      }
      if (compensation.compensationStatus === 'WAITING_USER'
        || compensation.compensationStatus === 'FAILED') break;
      if (attempt < maximumCompensationAttempts) await sleep(Math.max(1, input.reconcileDelayMs ?? 250));
    }
    return cancellationResult(snapshot, outputArtifactId, operationId, 'WAITING_USER');
  };

  if (cancelRequested) return quiesce(operationStatus);
  if (shouldRollover()) return rollover();

  const woke = await condition(
    () => cancelRequested || shouldRollover() || callbackInbox.acceptedTransitionCount > 0
      || callbackInbox.conflictReason !== undefined,
    Math.max(1, deadlineAtMs - Date.now()),
  );
  if (cancelRequested) return quiesce(operationStatus);
  if (shouldRollover()) return rollover();
  if (callbackInbox.conflictReason) {
    return waitingUserResult(snapshot, outputArtifactId, operationId, callbackInbox.conflictReason);
  }
  if (!woke) return waitingUserResult(snapshot, outputArtifactId, operationId);

  const maximumAttempts = Math.max(1, input.maxReconcileAttempts ?? 3);
  const firstAttempt = (carry?.reconcileAttempt ?? 0) + 1;
  let reconciled;
  for (let attempt = firstAttempt; attempt <= maximumAttempts; attempt += 1) {
    snapshot = { ...snapshot, status: 'RECONCILING' };
    reconciled = await activities.reconcileOperation({ operationId, authority });
    operationStatus = reconciled.operationStatus;
    snapshot = {
      ...snapshot, operationStatus,
      ...(reconciled.receiptArtifactId ? { receiptArtifactId: reconciled.receiptArtifactId } : {}),
    };
    if (cancelRequested) return quiesce(operationStatus);
    if (callbackInbox.conflictReason) {
      return waitingUserResult(snapshot, outputArtifactId, operationId, callbackInbox.conflictReason);
    }
    if (operationStatus === 'SUCCEEDED') break;
    if (operationStatus === 'FAILED' || operationStatus === 'WAITING_USER') {
      return {
        ...snapshot, status: operationStatus === 'FAILED' ? 'FAILED' : 'WAITING_USER',
        validationVerdict: 'unknown', outputArtifactId, operationId,
        receiptArtifactId: reconciled.receiptArtifactId,
      };
    }
    if (attempt === maximumAttempts) return waitingUserResult(snapshot, outputArtifactId, operationId);
    snapshot = { ...snapshot, status: 'RETRY_WAIT' };
    const wokeDuringRetry = await condition(
      () => cancelRequested || shouldRollover(),
      Math.max(1, input.reconcileDelayMs ?? 250),
    );
    if (cancelRequested) return quiesce(operationStatus);
    if (wokeDuringRetry && shouldRollover()) return rollover(attempt);
    if (callbackInbox.conflictReason) {
      return waitingUserResult(snapshot, outputArtifactId, operationId, callbackInbox.conflictReason);
    }
  }
  if (!reconciled || operationStatus !== 'SUCCEEDED') {
    return waitingUserResult(snapshot, outputArtifactId, operationId);
  }

  snapshot = { ...snapshot, status: 'VALIDATING', operationStatus };
  const validation = await activities.validateTerminal({
    operationId, outputArtifactId, receiptArtifactId: reconciled.receiptArtifactId,
  });
  if (cancelRequested) return quiesce(operationStatus);
  return {
    ...snapshot,
    status: validation.verdict === 'pass' ? 'SUCCEEDED' : 'FAILED',
    validationVerdict: validation.verdict,
    outputArtifactId,
    operationId,
    receiptArtifactId: reconciled.receiptArtifactId,
    validationArtifactId: validation.validationArtifactId,
  };
}

function cancellationResult(
  snapshot: DurableWorkflowSnapshot,
  outputArtifactId: string | undefined,
  operationId: string | undefined,
  status: 'CANCELLED' | 'WAITING_USER',
): DurableWorkflowResult {
  return {
    ...snapshot, status, validationVerdict: 'unknown',
    ...(outputArtifactId ? { outputArtifactId } : {}),
    ...(operationId ? { operationId } : {}),
  };
}

function waitingUserResult(
  snapshot: DurableWorkflowSnapshot,
  outputArtifactId: string,
  operationId: string,
  callbackConflict?: string,
): DurableWorkflowResult {
  return {
    ...snapshot, status: 'WAITING_USER', validationVerdict: 'unknown', outputArtifactId, operationId,
    ...(callbackConflict ? { callbackConflict } : {}),
  };
}
