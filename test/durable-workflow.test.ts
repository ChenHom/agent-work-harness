import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  classifyDurableFailure, createDurableActivities, toDurableActivityFailure,
} from '../src/durable/activities.ts';
import type { DurableWorkflowResult, DurableWorkflowSnapshot } from '../src/durable/contracts.ts';
import { createDurableWorker } from '../src/durable/worker.ts';
import type { RuntimeExecutionState } from '../src/durable/runtime-state.ts';
import { FakeProvider } from '../src/tools/fake-provider.ts';
import { Store } from '../src/trace/store.ts';

async function waitForCallback(
  handle: { query<R>(name: string): Promise<R> },
): Promise<DurableWorkflowSnapshot> {
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const snapshot = await handle.query<DurableWorkflowSnapshot>('durable.state');
      if (snapshot.status === 'WAITING_CALLBACK') return snapshot;
      last = snapshot;
    } catch (error) {
      // The initial Workflow task may not have installed the query handler.
      last = error;
    }
    await delay(20);
  }
  throw new Error(`workflow did not reach WAITING_CALLBACK: ${String(last)}`);
}

test('durable workflow saves output, preserves operation identity, reconciles callback, and validates', {
  timeout: 60_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-durable-workflow-'));
  const stateDir = join(root, 'state');
  const providerLedgerPath = join(root, 'provider.json');
  const env = await TestWorkflowEnvironment.createLocal();
  const workflowId = `durable-${Date.now()}`;
  let runtime: RuntimeExecutionState | null = null;
  const activities = createDurableActivities({
    stateDir,
    providerLedgerPath,
    readRuntime: () => runtime,
  });
  const taskQueue = `durable-task-${Date.now()}`;
  const worker = await createDurableWorker({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    activities,
  });
  let workerRun: Promise<void> | undefined;
  try {
    const handle = await env.client.workflow.start('durableFakeWorkflow', {
      taskQueue,
      workflowId,
      args: [{
        workId: 'W-durable', epoch: 1, businessId: 'customer-durable', value: 'enabled',
        generatedText: 'saved model output', callbackTimeoutMs: 5_000,
      }],
    });
    runtime = {
      workflowId, runId: handle.firstExecutionRunId,
      epoch: 1, status: 'ACTIVE',
    };
    workerRun = worker.run();

    const waiting = await waitForCallback(handle);
    assert.equal(waiting.operationStatus, 'UNKNOWN');
    assert.ok(waiting.outputArtifactId);
    assert.ok(waiting.operationId);

    await handle.signal('durable.callback', { operationId: waiting.operationId });
    const result = await handle.result() as DurableWorkflowResult;
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.validationVerdict, 'pass');
    assert.equal(result.operationId, waiting.operationId);
    assert.equal(result.outputArtifactId, waiting.outputArtifactId);
    assert.ok(result.receiptArtifactId);
    assert.ok(result.validationArtifactId);

    const store = new Store(stateDir, { readOnly: true });
    try {
      assert.equal(store.getOperation(result.operationId)?.status, 'SUCCEEDED');
      assert.equal(store.readVerifiedArtifact(result.outputArtifactId).status, 'verified');
      assert.equal(store.readVerifiedArtifact(result.receiptArtifactId).status, 'verified');
      assert.equal(store.readVerifiedArtifact(result.validationArtifactId).status, 'verified');
    } finally {
      store.close();
    }
    assert.equal(new FakeProvider(providerLedgerPath).effectCount(), 1);
  } finally {
    worker.shutdown();
    if (workerRun) await workerRun;
    await env.teardown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('durable Activity failures retain distinct recovery categories', () => {
  assert.equal(classifyDurableFailure(new Error('TOOL_TRANSIENT: unavailable')), 'TRANSIENT_FAILURE');
  assert.equal(classifyDurableFailure(new Error('FAKE_PROVIDER_REJECTED: no effect')), 'DEFINITIVE_NO_EFFECT');
  assert.equal(classifyDurableFailure(new Error('OPERATION_RECONCILIATION_REQUIRED')), 'OUTCOME_UNKNOWN');
  assert.equal(classifyDurableFailure(new Error('lookup partial-effect')), 'PARTIAL_EFFECT');
  assert.equal(classifyDurableFailure(new Error('POLICY_DENIED: target')), 'POLICY_DENIED');
  assert.equal(classifyDurableFailure(new Error('BUDGET_EXCEEDED: 100')), 'BUDGET_EXHAUSTED');
  const policy = toDurableActivityFailure(new Error('POLICY_DENIED: target'));
  assert.equal(policy.type, 'POLICY_DENIED');
  assert.equal(policy.nonRetryable, true);
  const transient = toDurableActivityFailure(new Error('TOOL_TRANSIENT: unavailable'));
  assert.equal(transient.type, 'TRANSIENT_FAILURE');
  assert.equal(transient.nonRetryable, false);
});
