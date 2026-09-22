import {
  condition, defineQuery, defineSignal, proxyActivities, setHandler, workflowInfo,
} from '@temporalio/workflow';
import type {
  DurableActivities, DurableCallback, DurableWorkflowInput, DurableWorkflowResult,
  DurableWorkflowSnapshot,
} from './contracts.ts';

export const durableCallbackSignal = defineSignal<[DurableCallback]>('durable.callback');
export const durableStateQuery = defineQuery<DurableWorkflowSnapshot>('durable.state');

const activities = proxyActivities<DurableActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { initialInterval: '50 milliseconds', maximumAttempts: 3 },
});

export async function durableFakeWorkflow(input: DurableWorkflowInput): Promise<DurableWorkflowResult> {
  let snapshot: DurableWorkflowSnapshot = { status: 'GENERATING' };
  let callbackOperationId: string | undefined;
  setHandler(durableCallbackSignal, (callback) => { callbackOperationId = callback.operationId; });
  setHandler(durableStateQuery, () => ({ ...snapshot }));

  const output = await activities.generateOutput({ workId: input.workId, generatedText: input.generatedText });
  snapshot = { status: 'DISPATCHING', outputArtifactId: output.outputArtifactId };
  const info = workflowInfo();
  const authority = { workflowId: info.workflowId, runId: info.runId, epoch: input.epoch };
  const dispatched = await activities.dispatchOperation({
    workId: input.workId, businessId: input.businessId, value: input.value, authority,
  });
  snapshot = {
    status: 'WAITING_CALLBACK', outputArtifactId: output.outputArtifactId,
    operationId: dispatched.operationId, operationStatus: dispatched.operationStatus,
  };

  const callbackArrived = await condition(
    () => callbackOperationId === dispatched.operationId,
    input.callbackTimeoutMs,
  );
  if (!callbackArrived) {
    return {
      ...snapshot, status: 'WAITING_USER', validationVerdict: 'unknown',
      outputArtifactId: output.outputArtifactId, operationId: dispatched.operationId,
    };
  }

  snapshot = { ...snapshot, status: 'RECONCILING' };
  const reconciled = await activities.reconcileOperation({ operationId: dispatched.operationId, authority });
  snapshot = { ...snapshot, status: 'VALIDATING', operationStatus: reconciled.operationStatus };
  const validation = await activities.validateTerminal({
    operationId: dispatched.operationId, outputArtifactId: output.outputArtifactId,
    receiptArtifactId: reconciled.receiptArtifactId,
  });
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
