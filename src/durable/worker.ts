import { Worker, type NativeConnection } from '@temporalio/worker';
import type { DurableActivities } from './contracts.ts';

interface DurableWorkerOptions {
  connection: NativeConnection;
  namespace?: string;
  taskQueue: string;
  activities: DurableActivities;
}

export function createDurableWorker(options: DurableWorkerOptions): Promise<Worker> {
  return Worker.create({
    connection: options.connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue,
    activities: options.activities,
    workflowsPath: new URL('./workflows.ts', import.meta.url).pathname,
  });
}
