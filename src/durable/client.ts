import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { createDurableActivities } from './activities.ts';
import type {
  DurableCallback, DurableWorkflowInput, DurableWorkflowSnapshot,
} from './contracts.ts';
import type {
  RuntimeExecutionIdentity, RuntimeExecutionReader, RuntimeExecutionState,
} from './runtime-state.ts';
import { createDurableWorker } from './worker.ts';

export interface DurableWorkerReady {
  taskQueue: string;
  buildId: string;
}

export interface DurableCommandService {
  start(workflowId: string, input: DurableWorkflowInput): Promise<{ workflowId: string; runId: string }>;
  inspect(workflowId: string): Promise<DurableWorkflowSnapshot>;
  cancel(workflowId: string): Promise<void>;
  callback(workflowId: string, callback: DurableCallback): Promise<void>;
  rollover(workflowId: string): Promise<void>;
  runWorker(ready: (details: DurableWorkerReady) => void): Promise<void>;
}

export interface DurableConnectionSettings {
  address: string;
  namespace: string;
  taskQueue: string;
  tls: boolean;
  apiKey?: string;
  deploymentVersion?: { deploymentName: string; buildId: string };
  providerLedgerPath: string;
}

export function loadDurableConnectionSettings(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): DurableConnectionSettings {
  const deploymentName = env.HARNESS_TEMPORAL_DEPLOYMENT;
  const buildId = env.HARNESS_TEMPORAL_BUILD_ID;
  if (Boolean(deploymentName) !== Boolean(buildId)) {
    throw new Error('HARNESS_TEMPORAL_DEPLOYMENT and HARNESS_TEMPORAL_BUILD_ID must be set together');
  }
  const tlsValue = env.TEMPORAL_TLS?.trim().toLowerCase();
  if (tlsValue && tlsValue !== 'true' && tlsValue !== 'false') {
    throw new Error('TEMPORAL_TLS must be true or false');
  }
  return {
    address: env.TEMPORAL_ADDRESS?.trim() || 'localhost:7233',
    namespace: env.TEMPORAL_NAMESPACE?.trim() || 'default',
    taskQueue: env.HARNESS_TEMPORAL_TASK_QUEUE?.trim() || 'harness-p4',
    tls: tlsValue === 'true' || Boolean(env.TEMPORAL_API_KEY),
    ...(env.TEMPORAL_API_KEY ? { apiKey: env.TEMPORAL_API_KEY } : {}),
    ...(deploymentName && buildId ? { deploymentVersion: { deploymentName, buildId } } : {}),
    providerLedgerPath: env.HARNESS_DURABLE_PROVIDER_LEDGER?.trim()
      || join(stateDir, 'fake-provider', 'durable-ledger.json'),
  };
}

function projectDurableRuntime(
  workflowId: string,
  snapshot: DurableWorkflowSnapshot,
): RuntimeExecutionState | null {
  if (!snapshot.runId || !snapshot.epoch) return null;
  const status: RuntimeExecutionState['status'] = snapshot.status === 'CANCEL_REQUESTED'
    ? 'CANCEL_REQUESTED'
    : snapshot.status === 'QUIESCING' ? 'QUIESCING'
      : snapshot.status === 'RECONCILING' ? 'RECONCILING'
        : snapshot.status === 'WAITING_USER' ? 'WAITING_USER'
          : snapshot.status === 'CANCELLED' ? 'CANCELLED'
            : snapshot.status === 'SUCCEEDED' || snapshot.status === 'FAILED' ? 'COMPLETED'
              : 'ACTIVE';
  return { workflowId, runId: snapshot.runId, epoch: snapshot.epoch, status };
}

export interface DurableRuntimeClient {
  workflow: {
    getHandle(workflowId: string): {
      query<R>(name: string): Promise<R>;
    };
  };
}

export async function readDurableRuntime(
  client: DurableRuntimeClient,
  workflowId: string,
  expected?: RuntimeExecutionIdentity,
): Promise<RuntimeExecutionState | null> {
  if (!expected) return null;
  try {
    const snapshot = await client.workflow.getHandle(workflowId)
      .query<DurableWorkflowSnapshot>('durable.state');
    return projectDurableRuntime(workflowId, snapshot);
  } catch {
    return null;
  }
}

export function temporalRuntimeReader(client: DurableRuntimeClient): RuntimeExecutionReader {
  return (workflowId, expected) => readDurableRuntime(client, workflowId, expected);
}

export class TemporalDurableCommandService implements DurableCommandService {
  private readonly stateDir: string;
  private readonly settings: DurableConnectionSettings;

  constructor(stateDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.stateDir = stateDir;
    this.settings = loadDurableConnectionSettings(stateDir, env);
  }

  start(workflowId: string, input: DurableWorkflowInput): Promise<{ workflowId: string; runId: string }> {
    validateWorkflowIdentity(workflowId);
    validateWorkflowInput(input);
    return this.withClient(async (client) => {
      const handle = await client.workflow.start('durableFakeWorkflow', {
        taskQueue: this.settings.taskQueue, workflowId, args: [input],
      });
      return { workflowId, runId: handle.firstExecutionRunId };
    });
  }

  inspect(workflowId: string): Promise<DurableWorkflowSnapshot> {
    validateWorkflowIdentity(workflowId);
    return this.withClient((client) => client.workflow.getHandle(workflowId)
      .query<DurableWorkflowSnapshot>('durable.state'));
  }

  cancel(workflowId: string): Promise<void> {
    return this.signal(workflowId, 'durable.cancel');
  }

  callback(workflowId: string, callback: DurableCallback): Promise<void> {
    validateCallback(callback);
    return this.signal(workflowId, 'durable.callback', callback);
  }

  rollover(workflowId: string): Promise<void> {
    return this.signal(workflowId, 'durable.rollover');
  }

  async runWorker(ready: (details: DurableWorkerReady) => void): Promise<void> {
    mkdirSync(this.stateDir, { recursive: true });
    mkdirSync(dirname(this.settings.providerLedgerPath), { recursive: true });
    const connection = await NativeConnection.connect(this.connectionOptions());
    const client = new Client({ connection, namespace: this.settings.namespace });
    const readRuntime = temporalRuntimeReader(client);
    const activities = createDurableActivities({
      stateDir: this.stateDir,
      providerLedgerPath: this.settings.providerLedgerPath,
      readRuntime,
    });
    const worker = await createDurableWorker({
      connection, namespace: this.settings.namespace, taskQueue: this.settings.taskQueue,
      activities, deploymentVersion: this.settings.deploymentVersion,
    });
    const stop = (): void => { worker.shutdown(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      ready({
        taskQueue: this.settings.taskQueue,
        buildId: this.settings.deploymentVersion?.buildId ?? 'unversioned-development',
      });
      await worker.run();
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await connection.close();
    }
  }

  private async signal(workflowId: string, name: string, argument?: unknown): Promise<void> {
    validateWorkflowIdentity(workflowId);
    await this.withClient(async (client) => {
      const handle = client.workflow.getHandle(workflowId);
      if (argument === undefined) await handle.signal(name);
      else await handle.signal(name, argument);
    });
  }

  private async withClient<T>(action: (client: Client) => Promise<T>): Promise<T> {
    const connection = await NativeConnection.connect(this.connectionOptions());
    try {
      return await action(new Client({ connection, namespace: this.settings.namespace }));
    } finally {
      await connection.close();
    }
  }

  private connectionOptions(): {
    address: string;
    tls: boolean;
    apiKey?: string;
  } {
    return {
      address: this.settings.address,
      tls: this.settings.tls,
      ...(this.settings.apiKey ? { apiKey: this.settings.apiKey } : {}),
    };
  }
}

function validateWorkflowIdentity(workflowId: string): void {
  if (!workflowId.trim()) throw new Error('workflowId is required');
}

function validateWorkflowInput(input: DurableWorkflowInput): void {
  if (!input.workId?.trim() || !input.businessId?.trim() || !input.generatedText?.trim()) {
    throw new Error('durable workflow input requires workId, businessId, and generatedText');
  }
  if (input.epoch !== 1 || input.carry) {
    throw new Error('new durable workflow must start at epoch 1 without Continue-As-New carry state');
  }
  if (!Number.isFinite(input.callbackTimeoutMs) || input.callbackTimeoutMs < 1) {
    throw new Error('durable workflow callbackTimeoutMs must be positive');
  }
}

function validateCallback(callback: DurableCallback): void {
  if (!callback.eventId?.trim() || !callback.operationId?.trim() || !callback.receiptRef?.trim()) {
    throw new Error('durable callback requires eventId, operationId, and receiptRef');
  }
  if (!Number.isSafeInteger(callback.sourceVersion) || callback.sourceVersion < 1
    || !Number.isSafeInteger(callback.sequence) || callback.sequence < 0) {
    throw new Error('durable callback sourceVersion and sequence are invalid');
  }
}
