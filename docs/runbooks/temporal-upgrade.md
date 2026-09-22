# Temporal Worker Upgrade Runbook

This runbook applies to the P4 durable workflow. Temporal Workflow history is the lifecycle source of truth. Do not reset or replace an execution to make a new worker accept incompatible history.

## Release policy

- Keep all Temporal TypeScript packages on the same pinned release. P4 is tested with SDK 1.24.0 and Temporal Server 1.32.0.
- Start production workers with a stable deployment name and a unique build ID through `createDurableWorker({ deploymentVersion: { deploymentName, buildId } })`.
- The worker uses the current `workerDeploymentOptions` API with `useWorkerVersioning: true` and `defaultVersioningBehavior: 'PINNED'`. Every workflow remains pinned unless an operator explicitly changes deployment routing.
- Introduce deterministic Workflow changes behind a stable `patched()` ID. Never branch Workflow code on wall-clock time, environment variables, filesystem state, or an Activity result that is not already in history.
- A workflow input whose `requiredWorkflowVersion` is newer than the worker supports enters `WAITING_USER` before any Activity starts. Route it to a compatible worker or resolve it manually; do not silently restart it with changed input.

Use the Temporal operator plane or CLI to manage deployment versions and routing. The application worker deliberately does not promote itself.

## Pre-deploy gate

1. Assign a unique build ID that identifies the immutable application build.
2. Run lint, type checking, the targeted version/replay tests, and the full project check.
3. Export representative histories for every live workflow path affected by the change.
4. Replay the saved corpus with the candidate Workflow bundle. Replay must not start Activities or write through the Gateway, provider, artifact store, or publisher.
5. Deploy the candidate worker without stopping the current worker.
6. Register the candidate as a deployment version, then shift new executions using the Temporal operator plane only after replay and health checks pass.

The committed baseline is `test/fixtures/histories/durable-success-v1.json`. The automated check is:

```sh
node --test test/workflow-replay.test.ts test/workflow-versioning.test.ts
```

Regenerate a fixture only when intentionally accepting a new baseline:

```sh
HARNESS_HISTORY_OUTPUT=test/fixtures/histories/durable-success-v1.json \
  node --test test/workflow-replay.test.ts
```

Review the regenerated diff before commit. SDK 1.24.0's generic JSON history loader is not used here: the test serializes canonical protobuf JSON and restores it with the same pinned `@temporalio/proto` version before `Worker.runReplayHistory`.

For a production execution, export history with the Temporal CLI or service API and retain the namespace, workflow ID, run ID, deployment/build metadata, export time, and application commit beside the JSON file. Do not include credentials or unredacted sensitive payloads in the repository fixture corpus.

## Compatibility window

Keep the previous worker build running while any open execution is pinned to it or while Temporal reports that version as reachable. The minimum window is the longest of:

- the maximum open workflow duration;
- the callback and reconciliation deadline;
- the operational rollback window;
- the retention period needed to replay affected histories.

Retire a build only after the operator plane shows no reachable pinned execution and the saved history corpus passes on its successor. Continue-As-New creates a new run in the same workflow chain; retain compatibility for both the old run history and the carried state schema.

## Deterministic patch lifecycle

1. Add the new branch with a unique `patched('stable-id')` guard.
2. Replay the existing corpus and deploy it while the old build remains available.
3. After all histories that need the old branch have left the compatibility window, replace the guard with `deprecatePatch('stable-id')` and replay again.
4. Remove the deprecated marker only after no retained history can reference it.

Never rename or reuse a patch ID for another behavior.

## Continue-As-New invariants

Before rollover, verify that the next input retains the same Work identity, budget state, pending operation and idempotency identity, bounded callback dedupe state, deadline, artifact/output references, and reconciliation attempt. The new run increments the runtime epoch and records its new run ID before another external Activity may dispatch. A stale epoch must fail authority checks at dispatch and publication.

Rollover may be requested explicitly by the `durable.rollover` signal or selected when Temporal suggests Continue-As-New or the configured history limit is reached. It may occur only at a safe wait boundary; it does not discard an unresolved effect.

## Rollback

1. Stop routing new executions to the candidate version.
2. Restore the previous deployment version as the target/current version through the Temporal operator plane.
3. Keep both workers available until the candidate version has no reachable pinned executions.
4. Replay histories produced by the candidate against the intended recovery build before moving or terminating executions.
5. Preserve Workflow histories, operation records, receipts, budgets, and staged artifacts. Do not reset an execution or delete history as a rollback mechanism.

If the new code introduced an incompatible history event, deploy a forward-compatible repair worker for that pinned build. A source rollback alone may also be nondeterministic against events already written by the candidate.

## Stuck old build

When an execution remains pinned to an unavailable or unhealthy build:

1. Record namespace, workflow ID, run ID, task queue, deployment version, pending Activity, and last successful event.
2. Restore the exact immutable old build when possible and verify its credentials and task queue polling.
3. If that build cannot be restored, replay the execution history against a repair build before registering or routing it.
4. If replay is incompatible, leave the execution paused and enter explicit manual recovery. Reconcile every pending operation before cancellation, compensation, or migration.
5. Resume only after authority epoch, operation identity, budget, deadline, callback dedupe state, and artifact references have been checked.

Escalate rather than resetting history when no compatible worker exists. An execution that cannot safely continue remains visible as paused/manual work.
