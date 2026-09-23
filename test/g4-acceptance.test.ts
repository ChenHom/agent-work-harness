import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DurablePublisher } from '../src/durable/publication.ts';
import {
  projectDurableRuntime,
} from '../src/durable/client.ts';
import type { DurableWorkflowResult, DurableWorkflowSnapshot } from '../src/durable/contracts.ts';
import { TemporalDispatchAuthority } from '../src/durable/runtime-state.ts';
import { FakeProvider } from '../src/tools/fake-provider.ts';
import { Store } from '../src/trace/store.ts';

interface WorkerProcess {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
}

function startWorkerProcess(
  address: string,
  stateDir: string,
  providerLedgerPath: string,
  taskQueue: string,
): WorkerProcess {
  const child = spawn(process.execPath, ['src/cli.ts', 'durable', 'worker'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      HARNESS_STATE_DIR: stateDir,
      HARNESS_DURABLE_PROVIDER_LEDGER: providerLedgerPath,
      HARNESS_TEMPORAL_TASK_QUEUE: taskQueue,
      TEMPORAL_ADDRESS: address,
      TEMPORAL_NAMESPACE: 'default',
      TEMPORAL_TLS: 'false',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  return { child, output: () => output };
}

async function waitForWorker(worker: WorkerProcess): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (worker.output().includes('durable worker ready:')) return;
    if (worker.child.exitCode !== null) throw new Error(`worker exited before ready:\n${worker.output()}`);
    await delay(20);
  }
  throw new Error(`worker did not become ready:\n${worker.output()}`);
}

async function stopWorker(worker: WorkerProcess | undefined, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (!worker || worker.child.exitCode !== null) return;
  worker.child.kill(signal);
  await new Promise<void>((resolve) => worker.child.once('exit', () => resolve()));
}

async function waitForSnapshot(
  handle: { query<R>(name: string): Promise<R> },
  predicate: (snapshot: DurableWorkflowSnapshot) => boolean,
  attempts = 1_200,
): Promise<DurableWorkflowSnapshot> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const snapshot = await handle.query<DurableWorkflowSnapshot>('durable.state');
      if (predicate(snapshot)) return snapshot;
      last = snapshot;
    } catch (error) { last = error; }
    await delay(20);
  }
  throw new Error(`workflow state did not match: ${JSON.stringify(last)}`);
}

async function waitForProviderEffect(providerLedgerPath: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (new FakeProvider(providerLedgerPath).effectCount() === 1) return;
    await delay(20);
  }
  throw new Error('provider effect was not written before worker termination');
}

test('G4 durable runtime survives process and server takeover with fenced effects and explicit recovery', {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-g4-'));
  const stateDir = join(root, 'state');
  const providerLedgerPath = join(root, 'provider', 'ledger.json');
  const workspace = join(root, 'workspace');
  const databasePath = join(root, 'temporal.sqlite');
  const taskQueue = `g4-${Date.now()}`;
  let env = await TestWorkflowEnvironment.createLocal({ server: { dbFilename: databasePath } });
  const originalPort = Number(env.address.slice(env.address.lastIndexOf(':') + 1));
  let worker1: WorkerProcess | undefined;
  let worker2: WorkerProcess | undefined;
  let worker3: WorkerProcess | undefined;
  try {
    worker1 = startWorkerProcess(env.address, stateDir, providerLedgerPath, taskQueue);
    await waitForWorker(worker1);

    const workflowId = `g4-takeover-${Date.now()}`;
    const takeover = await env.client.workflow.start('durableFakeWorkflow', {
      taskQueue, workflowId,
      args: [{
        workId: 'W-G4-takeover', epoch: 1, businessId: 'customer-g4-takeover',
        value: 'enabled', generatedText: 'takeover output', callbackTimeoutMs: 30_000,
        providerResponseDelayMs: 2_000,
      }],
    });
    const dispatching = await waitForSnapshot(takeover, (snapshot) => snapshot.status === 'DISPATCHING');
    assert.equal(dispatching.epoch, 1);
    await waitForProviderEffect(providerLedgerPath);
    await stopWorker(worker1, 'SIGKILL');
    worker1 = undefined;

    worker2 = startWorkerProcess(env.address, stateDir, providerLedgerPath, taskQueue);
    await waitForWorker(worker2);
    let waiting: DurableWorkflowSnapshot;
    try {
      waiting = await waitForSnapshot(takeover, (snapshot) => snapshot.status === 'WAITING_EXTERNAL', 300);
    } catch (error) {
      throw new Error(`${String(error)}\nworker2 output:\n${worker2.output()}`);
    }
    assert.ok(waiting.operationId);
    assert.ok(waiting.outputArtifactId);
    assert.equal(new FakeProvider(providerLedgerPath).effectCount(), 1);
    const store = new Store(stateDir, { readOnly: true });
    try {
      assert.equal(store.listOperations('W-G4-takeover').length, 1);
      const limit = store.findBudgetLimit('W-G4-takeover', 'fake_write', 'unit');
      assert.ok(limit);
      assert.equal(store.listBudgetReservations(limit.id).length, 1);
    } finally { store.close(); }

    await takeover.signal('durable.callback', {
      eventId: 'g4-stale', sourceVersion: 0, sequence: 0,
      operationId: waiting.operationId, receiptRef: 'provider:stale',
    });
    await takeover.signal('durable.callback', {
      eventId: 'g4-stale', sourceVersion: 0, sequence: 0,
      operationId: waiting.operationId, receiptRef: 'provider:stale',
    });
    await takeover.signal('durable.rollover');
    const continued = await waitForSnapshot(takeover, (snapshot) => snapshot.epoch === 2);
    assert.ok(continued.runId);
    assert.notEqual(continued.runId, waiting.runId);
    assert.equal(continued.operationId, waiting.operationId);
    assert.equal(continued.outputArtifactId, waiting.outputArtifactId);
    assert.equal(continued.ignoredCallbackCount, 2);

    const readRuntime = async () => projectDurableRuntime(
      workflowId,
      await env.client.workflow.getHandle(workflowId).query<DurableWorkflowSnapshot>('durable.state'),
    );
    const publisher = new DurablePublisher(workspace);
    assert.ok(waiting.runId);
    const oldIdentity = { workflowId, runId: waiting.runId, epoch: 1 };
    const currentIdentity = { workflowId, runId: continued.runId, epoch: 2 };
    const staleArtifact = publisher.stageArtifact(oldIdentity, 'result.txt', 'stale result');
    const currentArtifact = publisher.stageArtifact(currentIdentity, 'result.txt', 'current result');
    await publisher.publishManifest(
      currentIdentity, [currentArtifact], new TemporalDispatchAuthority(currentIdentity, readRuntime),
    );
    await assert.rejects(
      publisher.publishManifest(
        oldIdentity, [staleArtifact], new TemporalDispatchAuthority(oldIdentity, readRuntime),
      ),
      /dispatch authority is stale/,
    );

    await takeover.signal('durable.callback', {
      eventId: 'g4-valid', sourceVersion: 1, sequence: 1,
      operationId: continued.operationId, receiptRef: 'provider:valid',
    });
    const takeoverResult = await takeover.result() as DurableWorkflowResult;
    assert.equal(takeoverResult.status, 'SUCCEEDED');
    assert.equal(takeoverResult.acceptedCallbackCount, 1);
    assert.equal(takeoverResult.ignoredCallbackCount, 2);
    assert.equal(new FakeProvider(providerLedgerPath).effectCount(), 1);

    const incompatible = await env.client.workflow.execute('durableFakeWorkflow', {
      taskQueue, workflowId: `g4-incompatible-${Date.now()}`,
      args: [{
        workId: 'W-G4-incompatible', epoch: 1, businessId: 'customer-g4-incompatible',
        value: 'enabled', generatedText: 'must pause', callbackTimeoutMs: 1_000,
        requiredWorkflowVersion: 2,
      }],
    }) as DurableWorkflowResult;
    assert.equal(incompatible.status, 'WAITING_USER');
    assert.match(incompatible.compatibilityReason ?? '', /requires workflow version/);
    assert.equal(new FakeProvider(providerLedgerPath).effectCount(), 1);

    const cancelId = `g4-cancel-${Date.now()}`;
    const cancellation = await env.client.workflow.start('durableFakeWorkflow', {
      taskQueue, workflowId: cancelId,
      args: [{
        workId: 'W-G4-cancel', epoch: 1, businessId: 'customer-g4-cancel', value: 'enabled',
        generatedText: 'cancel output', callbackTimeoutMs: 30_000,
        lookupDelayCount: 5, maxReconcileAttempts: 1,
      }],
    });
    await waitForSnapshot(cancellation, (snapshot) => snapshot.status === 'WAITING_EXTERNAL');
    await cancellation.signal('durable.cancel');
    const cancelled = await cancellation.result() as DurableWorkflowResult;
    assert.equal(cancelled.status, 'WAITING_USER');
    assert.equal(cancelled.operationStatus, 'UNKNOWN');

    const deadlineId = `g4-deadline-${Date.now()}`;
    const deadline = await env.client.workflow.start('durableFakeWorkflow', {
      taskQueue, workflowId: deadlineId,
      args: [{
        workId: 'W-G4-deadline', epoch: 1, businessId: 'customer-g4-deadline', value: 'enabled',
        generatedText: 'deadline output', callbackTimeoutMs: 600,
      }],
    });
    await waitForSnapshot(deadline, (snapshot) => snapshot.status === 'WAITING_EXTERNAL');
    await stopWorker(worker2, 'SIGKILL');
    worker2 = undefined;
    await env.teardown();
    await delay(800);

    env = await TestWorkflowEnvironment.createLocal({
      server: { dbFilename: databasePath, port: originalPort },
    });
    worker3 = startWorkerProcess(env.address, stateDir, providerLedgerPath, taskQueue);
    await waitForWorker(worker3);
    const deadlineResult = await env.client.workflow.getHandle(deadlineId).result() as DurableWorkflowResult;
    assert.equal(deadlineResult.status, 'WAITING_USER');
    assert.equal(new FakeProvider(providerLedgerPath).effectCount(), 3);
  } finally {
    await stopWorker(worker1, 'SIGKILL');
    await stopWorker(worker2, 'SIGKILL');
    await stopWorker(worker3);
    await env.teardown().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
