import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { WorkflowClient } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { FakeProvider } from '../src/tools/fake-provider.ts';
import type { SpikeResult, SpikeSnapshot, SpikeWorkflowInput } from '../src/durable/spike-workflow.ts';
import { createSpikeActivities } from '../src/durable/spike-activities.ts';

const workflowsPath = new URL('../src/durable/spike-workflow.ts', import.meta.url).pathname;

async function waitForStatus(
  handle: { query<R>(name: string): Promise<R> },
  expected: SpikeSnapshot['status'],
): Promise<SpikeSnapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const state = await handle.query<SpikeSnapshot>('spike.state');
      if (state.status === expected) return state;
    } catch {
      // The first Workflow task may not have registered the query handler yet.
    }
    await delay(20);
  }
  throw new Error(`workflow did not reach ${expected}`);
}

test('Temporal Gate 0 proves retries, worker takeover, durable timers, signals, cancellation, and replay', {
  timeout: 60_000,
}, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'harness-temporal-selection-'));
  const ledgerPath = join(stateDir, 'provider-ledger.json');
  const provider = new FakeProvider(ledgerPath);
  const env = await TestWorkflowEnvironment.createLocal();
  const workflowClient: WorkflowClient = env.client.workflow;
  const taskQueue = `p4-selection-${Date.now()}`;
  const input = (suffix: string, overrides: Partial<SpikeWorkflowInput> = {}): SpikeWorkflowInput => ({
    businessId: `business-${suffix}`,
    idempotencyKey: `operation-${suffix}`,
    value: 'selected',
    deadlineMs: 5_000,
    quiesceMs: 100,
    minimumCallbackVersion: 2,
    ...overrides,
  });

  try {
    const worker1 = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue,
      workflowsPath,
      activities: createSpikeActivities(ledgerPath),
    });
    const worker1Run = worker1.run();

    const signalHandle = await workflowClient.start('spikeWorkflow', {
      taskQueue, workflowId: `p4-signal-${Date.now()}`, args: [input('signal')],
    });
    const waiting = await waitForStatus(signalHandle, 'WAITING_EXTERNAL');
    assert.equal(waiting.activityAttempt, 2, 'the post-effect failure must cause an Activity retry');
    assert.equal(provider.effectCount(), 1, 'the provider idempotency key must prevent a duplicate effect');

    await signalHandle.signal('spike.callback', {
      eventId: 'callback-stale', sourceVersion: 1, outcome: 'resolved',
    });
    await signalHandle.signal('spike.callback', {
      eventId: 'callback-stale', sourceVersion: 1, outcome: 'resolved',
    });
    await signalHandle.signal('spike.callback', {
      eventId: 'callback-current', sourceVersion: 2, outcome: 'resolved',
    });
    const signalResult = await signalHandle.result() as SpikeResult;
    assert.deepEqual(
      { status: signalResult.status, accepted: signalResult.acceptedCallbackCount, ignored: signalResult.ignoredCallbackCount },
      { status: 'SUCCEEDED', accepted: 1, ignored: 2 },
    );

    const history = await signalHandle.fetchHistory();
    const effectsBeforeReplay = provider.effectCount();
    await Worker.runReplayHistory({ workflowsPath }, history, signalHandle.workflowId);
    assert.equal(provider.effectCount(), effectsBeforeReplay, 'replay must not execute the Activity or provider write');

    const timerHandle = await workflowClient.start('spikeWorkflow', {
      taskQueue,
      workflowId: `p4-timer-${Date.now()}`,
      args: [input('timer', { deadlineMs: 250 })],
    });
    await waitForStatus(timerHandle, 'WAITING_EXTERNAL');
    worker1.shutdown();
    await worker1Run;
    await delay(400);

    const worker2 = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue,
      workflowsPath,
      activities: createSpikeActivities(ledgerPath),
    });
    const worker2Run = worker2.run();
    const timerResult = await timerHandle.result() as SpikeResult;
    assert.equal(timerResult.status, 'DEADLINE_EXCEEDED');

    const cancelHandle = await workflowClient.start('spikeWorkflow', {
      taskQueue,
      workflowId: `p4-cancel-${Date.now()}`,
      args: [input('cancel', { quiesceMs: 500 })],
    });
    await waitForStatus(cancelHandle, 'WAITING_EXTERNAL');
    await cancelHandle.signal('spike.cancel');
    await waitForStatus(cancelHandle, 'QUIESCING');
    const cancelResult = await cancelHandle.result() as SpikeResult;
    assert.equal(cancelResult.status, 'WAITING_USER', 'unresolved external effect must not be reported as CANCELLED');

    worker2.shutdown();
    await worker2Run;
    assert.equal(provider.effectCount(), 3, 'each logical operation must have exactly one provider effect');
  } finally {
    await env.teardown();
  }
});
