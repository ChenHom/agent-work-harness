import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { createDurableActivities } from '../src/durable/activities.ts';
import type { DurableWorkflowResult, DurableWorkflowSnapshot } from '../src/durable/contracts.ts';
import type { RuntimeExecutionState } from '../src/durable/runtime-state.ts';
import { createDurableWorker } from '../src/durable/worker.ts';
import {
  CURRENT_DURABLE_WORKFLOW_VERSION, durableWorkerDeploymentOptions,
} from '../src/durable/versioning.ts';
import { FakeProvider } from '../src/tools/fake-provider.ts';
import { Store } from '../src/trace/store.ts';

async function waitFor(
  handle: { query<R>(name: string): Promise<R> },
  predicate: (snapshot: DurableWorkflowSnapshot) => boolean,
): Promise<DurableWorkflowSnapshot> {
  let last: unknown;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const snapshot = await handle.query<DurableWorkflowSnapshot>('durable.state');
      if (predicate(snapshot)) return snapshot;
      last = snapshot;
    } catch (error) {
      last = error;
    }
    await delay(20);
  }
  throw new Error(`workflow state did not match: ${String(last)}`);
}

test('durable worker deployment policy uses the current deployment API and pinned workflows', () => {
  assert.deepEqual(durableWorkerDeploymentOptions('harness-p4', '2026.09.22.1'), {
    version: { deploymentName: 'harness-p4', buildId: '2026.09.22.1' },
    useWorkerVersioning: true,
    defaultVersioningBehavior: 'PINNED',
  });
});

test('future workflow schema pauses explicitly and Continue-As-New preserves durable state', {
  timeout: 60_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-durable-versioning-'));
  const stateDir = join(root, 'state');
  const providerLedgerPath = join(root, 'provider.json');
  const env = await TestWorkflowEnvironment.createLocal();
  const taskQueue = `durable-versioning-${Date.now()}`;
  let runtime: RuntimeExecutionState | null = null;
  const activities = createDurableActivities({ stateDir, providerLedgerPath, readRuntime: () => runtime });
  const worker = await createDurableWorker({
    connection: env.nativeConnection, namespace: env.namespace, taskQueue, activities,
  });
  const workerRun = worker.run();
  try {
    const incompatible = await env.client.workflow.execute('durableFakeWorkflow', {
      taskQueue, workflowId: `durable-incompatible-${Date.now()}`,
      args: [{
        workId: 'W-incompatible', epoch: 1, businessId: 'customer-incompatible', value: 'enabled',
        generatedText: 'must not run', callbackTimeoutMs: 1_000,
        requiredWorkflowVersion: CURRENT_DURABLE_WORKFLOW_VERSION + 1,
      }],
    }) as DurableWorkflowResult;
    assert.equal(incompatible.status, 'WAITING_USER');
    assert.match(incompatible.compatibilityReason ?? '', /requires workflow version/);
    assert.equal(new FakeProvider(providerLedgerPath).effectCount(), 0);

    const workflowId = `durable-rollover-${Date.now()}`;
    const started = await env.client.workflow.start('durableFakeWorkflow', {
      taskQueue, workflowId,
      args: [{
        workId: 'W-rollover', epoch: 1, businessId: 'customer-rollover', value: 'enabled',
        generatedText: 'rollover output', callbackTimeoutMs: 5_000,
      }],
    });
    runtime = {
      workflowId, runId: started.firstExecutionRunId, epoch: 1, status: 'ACTIVE',
    };
    const current = env.client.workflow.getHandle(workflowId);
    const before = await waitFor(current, (snapshot) => snapshot.status === 'WAITING_EXTERNAL');
    assert.equal(before.epoch, 1);
    assert.ok(before.operationId);
    assert.ok(before.outputArtifactId);
    assert.ok(before.deadlineAtMs);

    await current.signal('durable.callback', {
      eventId: 'stale-across-rollover', sourceVersion: 0, sequence: 0,
      operationId: before.operationId, receiptRef: 'provider:stale',
    });
    await waitFor(current, (snapshot) => snapshot.ignoredCallbackCount === 1);
    await current.signal('durable.rollover');

    const after = await waitFor(current, (snapshot) => snapshot.epoch === 2);
    assert.notEqual(after.runId, before.runId);
    assert.equal(after.operationId, before.operationId);
    assert.equal(after.outputArtifactId, before.outputArtifactId);
    assert.equal(after.deadlineAtMs, before.deadlineAtMs);
    assert.equal(after.ignoredCallbackCount, 1);
    assert.ok(after.runId);
    runtime = { workflowId, runId: after.runId, epoch: 2, status: 'ACTIVE' };

    await current.signal('durable.callback', {
      eventId: 'stale-across-rollover', sourceVersion: 0, sequence: 0,
      operationId: after.operationId, receiptRef: 'provider:stale',
    });
    await current.signal('durable.callback', {
      eventId: 'valid-after-rollover', sourceVersion: 1, sequence: 1,
      operationId: after.operationId, receiptRef: 'provider:valid',
    });
    const result = await started.result() as DurableWorkflowResult;
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.operationId, before.operationId);
    assert.equal(result.outputArtifactId, before.outputArtifactId);
    assert.equal(result.acceptedCallbackCount, 1);
    assert.equal(result.ignoredCallbackCount, 2);
    assert.equal(new FakeProvider(providerLedgerPath).effectCount(), 1);

    const store = new Store(stateDir, { readOnly: true });
    try {
      assert.equal(store.listOperations('W-rollover').length, 1);
      const limit = store.findBudgetLimit('W-rollover', 'fake_write', 'unit');
      assert.ok(limit);
      assert.equal(store.listBudgetReservations(limit.id).length, 1);
    } finally {
      store.close();
    }
  } finally {
    worker.shutdown();
    await workerRun;
    await env.teardown();
    rmSync(root, { recursive: true, force: true });
  }
});
