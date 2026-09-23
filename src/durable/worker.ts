import { Worker, type NativeConnection } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import type { DurableActivities } from './contracts.ts';
import { durableWorkerDeploymentOptions } from './versioning.ts';

interface DurableWorkerOptions {
  connection: NativeConnection;
  namespace?: string;
  taskQueue: string;
  activities: DurableActivities;
  deploymentVersion?: { deploymentName: string; buildId: string };
}

export function resolveWorkflowPath(baseUrl: string | URL = import.meta.url): string {
  return fileURLToPath(new URL('./workflows.ts', baseUrl));
}

export function createDurableWorker(options: DurableWorkerOptions): Promise<Worker> {
  return Worker.create({
    connection: options.connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue,
    activities: options.activities,
    workflowsPath: resolveWorkflowPath(),
    ...(options.deploymentVersion ? {
      workerDeploymentOptions: durableWorkerDeploymentOptions(
        options.deploymentVersion.deploymentName,
        options.deploymentVersion.buildId,
      ),
    } : {}),
  });
}
