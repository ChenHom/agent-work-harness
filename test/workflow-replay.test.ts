import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import proto from '@temporalio/proto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { createDurableActivities } from '../src/durable/activities.ts';
import type { DurableWorkflowResult, DurableWorkflowSnapshot } from '../src/durable/contracts.ts';
import type { RuntimeExecutionState } from '../src/durable/runtime-state.ts';
import { createDurableWorker } from '../src/durable/worker.ts';
import { FakeProvider } from '../src/tools/fake-provider.ts';

function filesystemSnapshot(root: string): Array<[string, string]> {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((path) => [
      relative(root, path),
      `${statSync(path).size}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`,
    ]);
}

test('serialized durable history replays without Activity, provider, artifact, or publication writes', {
  timeout: 60_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-durable-replay-'));
  const stateDir = join(root, 'state');
  const providerLedgerPath = join(root, 'provider.json');
  const committedHistoryPath = new URL('./fixtures/histories/durable-success-v1.json', import.meta.url).pathname;
  const historyPath = process.env.HARNESS_HISTORY_OUTPUT ?? join(root, 'durable-success-history.json');
  const env = await TestWorkflowEnvironment.createLocal();
  const taskQueue = `durable-replay-${Date.now()}`;
  const workflowId = 'durable-replay-fixture-v1';
  let runtime: RuntimeExecutionState | null = null;
  const activities = createDurableActivities({ stateDir, providerLedgerPath, readRuntime: () => runtime });
  const worker = await createDurableWorker({
    connection: env.nativeConnection, namespace: env.namespace, taskQueue, activities,
  });
  const workerRun = worker.run();
  let workerStopped = false;
  try {
    const handle = await env.client.workflow.start('durableFakeWorkflow', {
      taskQueue, workflowId,
      args: [{
        workId: 'W-replay', epoch: 1, businessId: 'customer-replay', value: 'enabled',
        generatedText: 'replay output', callbackTimeoutMs: 5_000,
      }],
    });
    runtime = { workflowId, runId: handle.firstExecutionRunId, epoch: 1, status: 'ACTIVE' };
    let waiting: DurableWorkflowSnapshot | undefined;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try {
        const snapshot = await handle.query<DurableWorkflowSnapshot>('durable.state');
        if (snapshot.status === 'WAITING_EXTERNAL') { waiting = snapshot; break; }
      } catch { /* query handler is not installed until the first Workflow task */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(waiting?.operationId);
    await handle.signal('durable.callback', {
      eventId: 'replay-callback', sourceVersion: 1, sequence: 1,
      operationId: waiting.operationId, receiptRef: 'provider:replay',
    });
    assert.equal((await handle.result() as DurableWorkflowResult).status, 'SUCCEEDED');
    const history = await handle.fetchHistory();
    const historyType = proto.temporal.api.history.v1.History;
    const historyJson = historyType.toObject(historyType.fromObject(history), {
      longs: String, enums: String, bytes: String, json: true,
    });
    mkdirSync(dirname(historyPath), { recursive: true });
    writeFileSync(historyPath, `${JSON.stringify(historyJson, null, 2)}\n`);
    const savedHistory = JSON.parse(readFileSync(historyPath, 'utf8')) as Record<string, unknown>;
    const restoredHistory = historyType.fromObject(savedHistory);
    const before = filesystemSnapshot(root);

    worker.shutdown();
    await workerRun;
    workerStopped = true;
    await Worker.runReplayHistory({
      workflowsPath: new URL('../src/durable/workflows.ts', import.meta.url).pathname,
    }, restoredHistory, workflowId);
    const committedHistory = historyType.fromObject(
      JSON.parse(readFileSync(committedHistoryPath, 'utf8')) as Record<string, unknown>,
    );
    await Worker.runReplayHistory({
      workflowsPath: new URL('../src/durable/workflows.ts', import.meta.url).pathname,
    }, committedHistory, workflowId);

    assert.deepEqual(filesystemSnapshot(root), before);
    assert.equal(new FakeProvider(providerLedgerPath).effectCount(), 1);
  } finally {
    if (!workerStopped) {
      worker.shutdown();
      await workerRun;
    }
    await env.teardown();
    rmSync(root, { recursive: true, force: true });
  }
});
