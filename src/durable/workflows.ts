import {
  condition, proxyActivities, setHandler, sleep, workflowInfo,
} from '@temporalio/workflow';
import type {
  DurableActivities, DurableCallback, DurableWorkflowInput, DurableWorkflowResult,
  DurableWorkflowSnapshot,
} from './contracts.ts';
import {
  applyDurableCallback, createCallbackInbox, DEFAULT_CALLBACK_DEDUPE_LIMIT,
  durableCallbackSignal, durableCancelSignal, durableStateQuery,
} from './signals.ts';

const activities = proxyActivities<DurableActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { initialInterval: '50 milliseconds', maximumAttempts: 3 },
});

export async function durableFakeWorkflow(input: DurableWorkflowInput): Promise<DurableWorkflowResult> {
  let snapshot: DurableWorkflowSnapshot = { status: 'GENERATING' };
  let callbackInbox = createCallbackInbox();
  let cancelRequested = false;
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
  setHandler(durableStateQuery, () => ({ ...snapshot }));

  const output = await activities.generateOutput({ workId: input.workId, generatedText: input.generatedText });
  if (cancelRequested) {
    return {
      ...snapshot, status: 'CANCELLED', validationVerdict: 'unknown',
      outputArtifactId: output.outputArtifactId,
    };
  }
  snapshot = { status: 'DISPATCHING', outputArtifactId: output.outputArtifactId };
  const info = workflowInfo();
  const authority = { workflowId: info.workflowId, runId: info.runId, epoch: input.epoch };
  const dispatched = await activities.dispatchOperation({
    workId: input.workId, businessId: input.businessId, value: input.value,
    lookupDelayCount: input.lookupDelayCount, dispatchDelayMs: input.dispatchDelayMs,
    lookupDelayMs: input.lookupDelayMs, compensationDelayMs: input.compensationDelayMs,
    compensationBehavior: input.compensationBehavior, authority,
  });
  snapshot = {
    status: 'WAITING_EXTERNAL', outputArtifactId: output.outputArtifactId,
    operationId: dispatched.operationId, operationStatus: dispatched.operationStatus,
  };
  for (const callback of pendingCallbacks.splice(0)) applyCallback(callback);
  updateCallbackSnapshot();

  const quiesce = async (initialOperationStatus: string): Promise<DurableWorkflowResult> => {
    snapshot = { ...snapshot, status: 'QUIESCING', operationStatus: initialOperationStatus };
    let operationStatus = initialOperationStatus;
    let receiptArtifactId = snapshot.receiptArtifactId;
    const maximumReconcileAttempts = Math.max(1, input.maxReconcileAttempts ?? 3);
    for (let attempt = 1;
      (operationStatus === 'UNKNOWN' || operationStatus === 'RECONCILING')
        && attempt <= maximumReconcileAttempts;
      attempt += 1) {
      const reconciled = await activities.reconcileOperation({ operationId: dispatched.operationId, authority });
      operationStatus = reconciled.operationStatus;
      receiptArtifactId = reconciled.receiptArtifactId ?? receiptArtifactId;
      snapshot = {
        ...snapshot, status: 'QUIESCING', operationStatus,
        ...(receiptArtifactId ? { receiptArtifactId } : {}),
      };
      if ((operationStatus === 'UNKNOWN' || operationStatus === 'RECONCILING')
        && attempt < maximumReconcileAttempts) await sleep(Math.max(1, input.reconcileDelayMs ?? 250));
    }
    if (operationStatus === 'FAILED') {
      return cancellationResult(snapshot, output.outputArtifactId, dispatched.operationId, 'CANCELLED');
    }
    if (operationStatus !== 'SUCCEEDED') {
      return cancellationResult(snapshot, output.outputArtifactId, dispatched.operationId, 'WAITING_USER');
    }

    const maximumCompensationAttempts = Math.max(1, input.maxCompensationAttempts ?? 3);
    for (let attempt = 1; attempt <= maximumCompensationAttempts; attempt += 1) {
      const compensation = await activities.compensateOperation({
        operationId: dispatched.operationId, businessId: input.businessId, authority,
      });
      snapshot = {
        ...snapshot, status: 'QUIESCING', compensationId: compensation.compensationId,
        compensationStatus: compensation.compensationStatus,
      };
      if (compensation.compensationStatus === 'SUCCEEDED') {
        return cancellationResult(snapshot, output.outputArtifactId, dispatched.operationId, 'CANCELLED');
      }
      if (compensation.compensationStatus === 'WAITING_USER'
        || compensation.compensationStatus === 'FAILED') break;
      if (attempt < maximumCompensationAttempts) await sleep(Math.max(1, input.reconcileDelayMs ?? 250));
    }
    return cancellationResult(snapshot, output.outputArtifactId, dispatched.operationId, 'WAITING_USER');
  };

  if (cancelRequested) return quiesce(dispatched.operationStatus);

  const deadlineAtMs = Date.now() + input.callbackTimeoutMs;
  const callbackArrivedOrConflicted = await condition(
    () => cancelRequested || callbackInbox.acceptedTransitionCount > 0
      || callbackInbox.conflictReason !== undefined,
    Math.max(1, deadlineAtMs - Date.now()),
  );
  if (cancelRequested) return quiesce(dispatched.operationStatus);
  if (callbackInbox.conflictReason) {
    return waitingUserResult(snapshot, output.outputArtifactId, dispatched.operationId, callbackInbox.conflictReason);
  }
  if (!callbackArrivedOrConflicted) {
    return waitingUserResult(snapshot, output.outputArtifactId, dispatched.operationId);
  }

  const maximumAttempts = Math.max(1, input.maxReconcileAttempts ?? 3);
  let reconciled;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    snapshot = { ...snapshot, status: 'RECONCILING' };
    reconciled = await activities.reconcileOperation({ operationId: dispatched.operationId, authority });
    snapshot = {
      ...snapshot, operationStatus: reconciled.operationStatus,
      ...(reconciled.receiptArtifactId ? { receiptArtifactId: reconciled.receiptArtifactId } : {}),
    };
    if (cancelRequested) return quiesce(reconciled.operationStatus);
    if (callbackInbox.conflictReason) {
      return waitingUserResult(
        snapshot, output.outputArtifactId, dispatched.operationId, callbackInbox.conflictReason,
      );
    }
    if (reconciled.operationStatus === 'SUCCEEDED') break;
    if (reconciled.operationStatus === 'FAILED' || reconciled.operationStatus === 'WAITING_USER') {
      return {
        ...snapshot, status: reconciled.operationStatus === 'FAILED' ? 'FAILED' : 'WAITING_USER',
        validationVerdict: 'unknown', outputArtifactId: output.outputArtifactId,
        operationId: dispatched.operationId, receiptArtifactId: reconciled.receiptArtifactId,
      };
    }
    if (attempt === maximumAttempts) {
      return waitingUserResult(snapshot, output.outputArtifactId, dispatched.operationId);
    }
    snapshot = { ...snapshot, status: 'RETRY_WAIT' };
    const cancelledDuringRetry = await condition(
      () => cancelRequested,
      Math.max(1, input.reconcileDelayMs ?? 250),
    );
    if (cancelledDuringRetry) return quiesce(reconciled.operationStatus);
    if (callbackInbox.conflictReason) {
      return waitingUserResult(
        snapshot, output.outputArtifactId, dispatched.operationId, callbackInbox.conflictReason,
      );
    }
  }
  if (!reconciled || reconciled.operationStatus !== 'SUCCEEDED') {
    return {
      ...snapshot, status: 'WAITING_USER', validationVerdict: 'unknown',
      outputArtifactId: output.outputArtifactId, operationId: dispatched.operationId,
    };
  }

  snapshot = { ...snapshot, status: 'VALIDATING', operationStatus: reconciled.operationStatus };
  const validation = await activities.validateTerminal({
    operationId: dispatched.operationId, outputArtifactId: output.outputArtifactId,
    receiptArtifactId: reconciled.receiptArtifactId,
  });
  if (cancelRequested) return quiesce(reconciled.operationStatus);
  return {
    ...snapshot,
    status: validation.verdict === 'pass' ? 'SUCCEEDED' : 'FAILED',
    validationVerdict: validation.verdict,
    outputArtifactId: output.outputArtifactId,
    operationId: dispatched.operationId,
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
