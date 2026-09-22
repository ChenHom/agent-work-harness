import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { Worker } from '@temporalio/worker';
import { createDurableActivities } from '../src/durable/activities.ts';
import type { DurableWorkflowResult, DurableWorkflowSnapshot } from '../src/durable/contracts.ts';
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

test('reconciliation retry and callback deadline timers survive worker handoff', {
  timeout: 60_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-durable-timers-'));
  const stateDir = join(root, 'state');
  const providerLedgerPath = join(root, 'provider.json');
  const env = await TestWorkflowEnvironment.createLocal();
  const taskQueue = `durable-timers-${Date.now()}`;
  let runtime: RuntimeExecutionState | null = null;
  const activities = createDurableActivities({ stateDir, providerLedgerPath, readRuntime: () => runtime });
  const newWorker = (): Promise<Worker> => createDurableWorker({
    connection: env.nativeConnection, namespace: env.namespace, taskQueue, activities,
  });
  let worker: Worker | undefined;
  let workerRun: Promise<void> | undefined;

  const stopWorker = async (): Promise<void> => {
    worker?.shutdown();
    if (workerRun) await workerRun;
    worker = undefined;
    workerRun = undefined;
  };
  const startWorker = async (): Promise<void> => {
    worker = await newWorker();
    workerRun = worker.run();
  };

  try {
    await startWorker();
    const retryWorkflowId = `durable-retry-${Date.now()}`;
    const retryHandle = await env.client.workflow.start('durableFakeWorkflow', {
      taskQueue, workflowId: retryWorkflowId,
      args: [{
        workId: 'W-retry', epoch: 1, businessId: 'customer-retry', value: 'enabled',
        generatedText: 'retry output', callbackTimeoutMs: 5_000,
        lookupDelayCount: 1, reconcileDelayMs: 300, maxReconcileAttempts: 2,
      }],
    });
    runtime = {
      workflowId: retryWorkflowId, runId: retryHandle.firstExecutionRunId,
      epoch: 1, status: 'ACTIVE',
    };
    const retryWaiting = await waitForStatus(retryHandle, 'WAITING_EXTERNAL');
    assert.ok(retryWaiting.operationId);
    await retryHandle.signal('durable.callback', {
      eventId: 'retry-callback', sourceVersion: 1, sequence: 1,
      operationId: retryWaiting.operationId, receiptRef: 'provider:retry-callback',
    });
    await waitForStatus(retryHandle, 'RETRY_WAIT');
    await stopWorker();
    await delay(450);
    await startWorker();
    const retryResult = await retryHandle.result() as DurableWorkflowResult;
    assert.equal(retryResult.status, 'SUCCEEDED');
    assert.equal(new FakeProvider(providerLedgerPath).effectCount(), 1);
    assert.equal(new FakeProvider(providerLedgerPath).lookupCount(), 2);

    const deadlineWorkflowId = `durable-deadline-${Date.now()}`;
    const deadlineHandle = await env.client.workflow.start('durableFakeWorkflow', {
      taskQueue, workflowId: deadlineWorkflowId,
      args: [{
        workId: 'W-deadline', epoch: 1, businessId: 'customer-deadline', value: 'enabled',
        generatedText: 'deadline output', callbackTimeoutMs: 300,
      }],
    });
    runtime = {
      workflowId: deadlineWorkflowId, runId: deadlineHandle.firstExecutionRunId,
      epoch: 1, status: 'ACTIVE',
    };
    const deadlineWaiting = await waitForStatus(deadlineHandle, 'WAITING_EXTERNAL');
    assert.ok(deadlineWaiting.operationId);
    await stopWorker();
    await delay(450);
    await startWorker();
    const deadlineResult = await deadlineHandle.result() as DurableWorkflowResult;
    assert.equal(deadlineResult.status, 'WAITING_USER');
    await assert.rejects(deadlineHandle.signal('durable.callback', {
      eventId: 'late-callback', sourceVersion: 1, sequence: 1,
      operationId: deadlineWaiting.operationId, receiptRef: 'provider:late-callback',
    }));
    assert.equal((await deadlineHandle.result() as DurableWorkflowResult).status, 'WAITING_USER');
  } finally {
    await stopWorker();
    await env.teardown();
    rmSync(root, { recursive: true, force: true });
  }
});
