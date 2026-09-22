import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { createDurableActivities } from '../src/durable/activities.ts';
import type {
  DurableWorkflowInput, DurableWorkflowResult, DurableWorkflowSnapshot,
} from '../src/durable/contracts.ts';
import type { RuntimeExecutionState } from '../src/durable/runtime-state.ts';
import { createDurableWorker } from '../src/durable/worker.ts';
import { FakeProvider } from '../src/tools/fake-provider.ts';

async function waitForStatus(
  handle: { query<R>(name: string): Promise<R> },
  expected: DurableWorkflowSnapshot['status'],
): Promise<DurableWorkflowSnapshot> {
  let last: unknown;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const snapshot = await handle.query<DurableWorkflowSnapshot>('durable.state');
      if (snapshot.status === expected) return snapshot;
      last = snapshot;
    } catch (error) {
      last = error;
    }
    await delay(20);
  }
  throw new Error(`workflow did not reach ${expected}: ${String(last)}`);
}

test('cancellation quiesces dispatch, unknown delivery, reconciliation, and compensation', {
  timeout: 60_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-durable-cancel-'));
  const stateDir = join(root, 'state');
  const providerLedgerPath = join(root, 'provider.json');
  const provider = new FakeProvider(providerLedgerPath);
  const env = await TestWorkflowEnvironment.createLocal();
  const taskQueue = `durable-cancel-${Date.now()}`;
  let runtime: RuntimeExecutionState | null = null;
  const activities = createDurableActivities({ stateDir, providerLedgerPath, readRuntime: () => runtime });
  const worker = await createDurableWorker({
    connection: env.nativeConnection, namespace: env.namespace, taskQueue, activities,
  });
  const workerRun = worker.run();
  let sequence = 0;

  const start = async (suffix: string, overrides: Partial<DurableWorkflowInput> = {}) => {
    sequence += 1;
    const workflowId = `durable-cancel-${suffix}-${Date.now()}-${sequence}`;
    const handle = await env.client.workflow.start('durableFakeWorkflow', {
      taskQueue, workflowId,
      args: [{
        workId: `W-cancel-${suffix}`, epoch: 1, businessId: `customer-${suffix}`,
        value: 'enabled', generatedText: `${suffix} output`, callbackTimeoutMs: 5_000,
        reconcileDelayMs: 50, maxReconcileAttempts: 2, ...overrides,
      }],
    });
    runtime = { workflowId, runId: handle.firstExecutionRunId, epoch: 1, status: 'ACTIVE' };
    return handle;
  };
  const cancel = async (handle: { signal(name: string): Promise<void> }): Promise<void> => {
    assert.ok(runtime);
    runtime = { ...runtime, status: 'QUIESCING' };
    await handle.signal('durable.cancel');
  };

  try {
    const dispatchHandle = await start('dispatch', { dispatchDelayMs: 350 });
    await waitForStatus(dispatchHandle, 'DISPATCHING');
    await cancel(dispatchHandle);
    const dispatchResult = await dispatchHandle.result() as DurableWorkflowResult;
    assert.equal(dispatchResult.status, 'CANCELLED');
    assert.equal(dispatchResult.compensationStatus, 'SUCCEEDED');

    const unknownHandle = await start('unknown', { lookupDelayCount: 5, maxReconcileAttempts: 1 });
    await waitForStatus(unknownHandle, 'WAITING_EXTERNAL');
    await cancel(unknownHandle);
    const unknownResult = await unknownHandle.result() as DurableWorkflowResult;
    assert.equal(unknownResult.status, 'WAITING_USER');
    assert.equal(unknownResult.operationStatus, 'UNKNOWN');
    assert.equal(unknownResult.compensationStatus, undefined);

    const reconcileHandle = await start('reconcile', { lookupDelayMs: 350 });
    const reconcileWaiting = await waitForStatus(reconcileHandle, 'WAITING_EXTERNAL');
    assert.ok(reconcileWaiting.operationId);
    await reconcileHandle.signal('durable.callback', {
      eventId: 'reconcile-callback', sourceVersion: 1, sequence: 1,
      operationId: reconcileWaiting.operationId, receiptRef: 'provider:reconcile',
    });
    await waitForStatus(reconcileHandle, 'RECONCILING');
    await cancel(reconcileHandle);
    const reconcileResult = await reconcileHandle.result() as DurableWorkflowResult;
    assert.equal(reconcileResult.status, 'CANCELLED');
    assert.equal(reconcileResult.compensationStatus, 'SUCCEEDED');

    const compensationHandle = await start('compensation', {
      compensationBehavior: 'lose-response-after-effect',
    });
    await waitForStatus(compensationHandle, 'WAITING_EXTERNAL');
    await cancel(compensationHandle);
    const compensationResult = await compensationHandle.result() as DurableWorkflowResult;
    assert.equal(compensationResult.status, 'CANCELLED');
    assert.equal(compensationResult.compensationStatus, 'SUCCEEDED');

    assert.equal(provider.effectCount(), 4);
    assert.equal(provider.compensationEffectCount(), 3);
  } finally {
    worker.shutdown();
    await workerRun;
    await env.teardown();
    rmSync(root, { recursive: true, force: true });
  }
});
