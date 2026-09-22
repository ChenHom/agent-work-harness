import {
  condition, defineQuery, defineSignal, proxyActivities, setHandler,
} from '@temporalio/workflow';
import type { SpikeActivities, SpikeDispatchResult } from './spike-activities.ts';

export interface SpikeWorkflowInput {
  businessId: string;
  idempotencyKey: string;
  value: string;
  deadlineMs: number;
  quiesceMs: number;
  minimumCallbackVersion: number;
}

export interface SpikeCallback {
  eventId: string;
  sourceVersion: number;
  outcome: 'resolved';
}

export type SpikeStatus =
  | 'DISPATCHING'
  | 'WAITING_EXTERNAL'
  | 'QUIESCING'
  | 'SUCCEEDED'
  | 'DEADLINE_EXCEEDED'
  | 'WAITING_USER';

export interface SpikeSnapshot {
  status: SpikeStatus;
  acceptedCallbackCount: number;
  ignoredCallbackCount: number;
  activityAttempt?: number;
}

export interface SpikeResult extends SpikeSnapshot {
  providerReceiptId: string;
}

export const callbackSignal = defineSignal<[SpikeCallback]>('spike.callback');
export const cancelSignal = defineSignal('spike.cancel');
export const stateQuery = defineQuery<SpikeSnapshot>('spike.state');

const { dispatchEffect } = proxyActivities<SpikeActivities>({
  startToCloseTimeout: '5 seconds',
  retry: { initialInterval: '20 milliseconds', maximumAttempts: 3 },
});

export async function spikeWorkflow(input: SpikeWorkflowInput): Promise<SpikeResult> {
  let status: SpikeStatus = 'DISPATCHING';
  let acceptedCallbackCount = 0;
  let ignoredCallbackCount = 0;
  let resolved = false;
  let cancelRequested = false;
  let activityResult: SpikeDispatchResult | undefined = undefined;
  const seenEventIds = new Set<string>();

  setHandler(callbackSignal, (callback) => {
    if (seenEventIds.has(callback.eventId)) {
      ignoredCallbackCount += 1;
      return;
    }
    seenEventIds.add(callback.eventId);
    if (callback.sourceVersion < input.minimumCallbackVersion || resolved) {
      ignoredCallbackCount += 1;
      return;
    }
    acceptedCallbackCount += 1;
    resolved = true;
  });
  setHandler(cancelSignal, () => { cancelRequested = true; });
  setHandler(stateQuery, () => ({
    status, acceptedCallbackCount, ignoredCallbackCount,
    ...(activityResult ? { activityAttempt: activityResult.activityAttempt } : {}),
  }));

  activityResult = await dispatchEffect({
    businessId: input.businessId,
    idempotencyKey: input.idempotencyKey,
    value: input.value,
  });
  status = 'WAITING_EXTERNAL';

  const woke = await condition(() => resolved || cancelRequested, input.deadlineMs);
  if (resolved) status = 'SUCCEEDED';
  else if (!woke) status = 'DEADLINE_EXCEEDED';
  else {
    status = 'QUIESCING';
    const effectResolved = await condition(() => resolved, input.quiesceMs);
    status = effectResolved ? 'SUCCEEDED' : 'WAITING_USER';
  }

  return {
    status,
    acceptedCallbackCount,
    ignoredCallbackCount,
    activityAttempt: activityResult.activityAttempt,
    providerReceiptId: activityResult.providerReceiptId,
  };
}
