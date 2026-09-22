import type { WorkerDeploymentOptions } from '@temporalio/worker';

export const CURRENT_DURABLE_WORKFLOW_VERSION = 1;
export const DURABLE_ROLLOVER_PATCH_ID = 'p4-durable-rollover-v1';

export interface DurableCompatibility {
  compatible: boolean;
  requiredVersion: number;
  currentVersion: number;
  reason?: string;
}

export function evaluateDurableCompatibility(requiredVersion = 1): DurableCompatibility {
  const compatible = Number.isSafeInteger(requiredVersion)
    && requiredVersion >= 1
    && requiredVersion <= CURRENT_DURABLE_WORKFLOW_VERSION;
  return {
    compatible, requiredVersion, currentVersion: CURRENT_DURABLE_WORKFLOW_VERSION,
    ...(!compatible ? {
      reason: `execution requires workflow version ${requiredVersion}; worker supports through ${CURRENT_DURABLE_WORKFLOW_VERSION}`,
    } : {}),
  };
}

export function durableWorkerDeploymentOptions(
  deploymentName: string,
  buildId: string,
): WorkerDeploymentOptions {
  if (!deploymentName.trim() || !buildId.trim()) throw new Error('DURABLE_DEPLOYMENT_VERSION_REQUIRED');
  return {
    version: { deploymentName, buildId },
    useWorkerVersioning: true,
    defaultVersioningBehavior: 'PINNED',
  };
}
