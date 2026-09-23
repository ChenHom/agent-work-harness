# Temporal Durable Runtime Operations

P4 uses Temporal as the only owner of workflow scheduling, Activity retry, timers, signals, Continue-As-New, and cancellation progression. The harness database stores operation, budget, receipt, and artifact records; it is not a queue, timer service, lease coordinator, or cross-host ledger.

## Required service and configuration

Production requires a shared Temporal service reachable by every worker and CLI operator, plus a provider and operation ledger that are also reachable from every worker host. The local file-backed fake provider is test evidence only.

| Variable | Required | Meaning |
|---|---:|---|
| `TEMPORAL_ADDRESS` | yes | Temporal frontend in `host:port` form |
| `TEMPORAL_NAMESPACE` | yes | namespace containing P4 executions |
| `TEMPORAL_TLS` | production | `true` for TLS; defaults to false without an API key |
| `TEMPORAL_API_KEY` | cloud/token auth | bearer API key; implies TLS |
| `HARNESS_TEMPORAL_TASK_QUEUE` | yes | task queue shared by clients and workers |
| `HARNESS_TEMPORAL_DEPLOYMENT` | production | stable Worker Deployment name |
| `HARNESS_TEMPORAL_BUILD_ID` | production | unique immutable build identifier |
| `HARNESS_STATE_DIR` | local fixture only | local operation/artifact projection |
| `HARNESS_DURABLE_PROVIDER_LEDGER` | local fixture only | file-backed fake provider ledger |

Set deployment name and build ID together. Production workers use Temporal Worker Deployment versioning with pinned workflow behavior. Promotion and rollback are operator-plane actions described in [the upgrade runbook](temporal-upgrade.md).

## Start and inspect

Run at least two supervised worker processes for a production task queue:

```sh
harness durable worker
```

The process prints `durable worker ready` after the bundle and worker are created. The process must then remain under a service supervisor with restart-on-failure. Readiness also requires a live Temporal connection and active workflow/activity pollers; a running OS process alone is insufficient.

Start and control a workflow with explicit P4 commands:

```sh
harness durable start <workflowId> workflow.json
harness durable inspect <workflowId>
harness durable callback <workflowId> callback.json
harness durable rollover <workflowId>
harness durable cancel <workflowId>
```

`durable cancel` sends the workflow's durable cancellation signal. It does not use Temporal's immediate cancellation API: the workflow must enter quiescence, reconcile or compensate in-flight effects, and only then return `CANCELLED`. An unresolved outcome remains `WAITING_USER`.

Use the Temporal CLI for service-level inspection:

```sh
temporal operator cluster health --address "$TEMPORAL_ADDRESS"
temporal task-queue describe --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" \
  --task-queue "$HARNESS_TEMPORAL_TASK_QUEUE"
temporal workflow describe --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" \
  --workflow-id <workflowId>
temporal workflow show --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" \
  --workflow-id <workflowId>
```

Pass the environment's supported TLS and authentication flags when the CLI does not read them from its profile.

## Health and alerts

Alert on these conditions:

- no workflow or Activity poller for the task queue;
- rising schedule-to-start latency or task backlog;
- repeated Workflow task failures or nondeterminism errors;
- Activity retries approaching the configured maximum;
- `UNKNOWN`, `RECONCILING`, `QUIESCING`, or `WAITING_USER` older than its recovery SLA;
- callback deadline expiry, callback conflicts, or rapidly growing ignored-callback counts;
- failed compensation or stale publication attempts;
- executions pinned to an old build after its compatibility deadline;
- history approaching rollover limits without Continue-As-New.

Dashboard counts must retain namespace, task queue, workflow type, deployment/build, and failure category. Do not sample authoritative operation, receipt, budget, compensation, or publication events.

## Worker loss and takeover

1. Confirm another worker is polling the same task queue and can reach the same provider/ledger boundary.
2. Inspect the workflow and pending Activity. Do not start a second local scheduler or manually redispatch the operation.
3. Temporal retries an unacknowledged Activity. The Activity reuses the same Work, operation, intent, and idempotency key.
4. A crash-left `DISPATCHED` operation is converted to an unknown reservation state and reconciled by lookup. It is never blindly resent.
5. Verify one provider effect and one logical operation before accepting completion.

The G4 fixture kills one worker after the provider effect but before Activity completion, then starts a second OS process. It proves protocol takeover against one Temporal service and a process-external persistent fake ledger on one machine. A production cross-host claim additionally requires the shared Temporal/provider/ledger topology, network and credential failover, and an operational drill on the deployed infrastructure.

## Temporal service outage

Workers and clients should fail connection/readiness checks while the service is unavailable. Do not fall back to SQLite scheduling or process timers.

1. Stop new workflow submissions if the namespace is unavailable.
2. Keep provider operation and receipt records unchanged; do not infer failure from elapsed wall time.
3. Restore the Temporal service from its supported persistence/backup mechanism.
4. Restore compatible workers and verify task queue pollers.
5. Inspect pending workflows, timers, and Activities before re-enabling submissions.
6. Reconcile any operation whose Activity completion was not acknowledged.

The local G4 test uses a persistent Temporal SQLite database and proves that a callback deadline fires after the dev server and workers restart. It is not a production backup/restore certification.

## Provider outage or uncertain result

1. Stop scheduling new provider writes when the outage is confirmed.
2. Leave completed dispatch intents and reservations durable.
3. For `UNKNOWN`, use the provider lookup path with the original idempotency key. Never call dispatch again merely because a worker or deadline expired.
4. Keep not-found results pending until the provider completion window closes.
5. Route partial effects, unsupported lookup, expired keys, and unresolved compensation to `WAITING_USER`.
6. Resume new writes only after lookup and receipt paths are healthy and the backlog has been reconciled.

## Stuck execution

Collect the workflow ID, current run ID, epoch, deployment/build, pending Activity, operation ID, idempotency key, deadline, and last history event. Then classify the cause:

- **No poller:** restore a compatible worker for the pinned build.
- **Nondeterminism:** stop the new build, replay exported history, and deploy a forward-compatible repair.
- **Pending provider result:** reconcile; do not reset or resend.
- **Callback conflict:** retain both events and resolve in `WAITING_USER`.
- **Old build unavailable:** follow the stuck-build procedure in [the upgrade runbook](temporal-upgrade.md).
- **History growth:** Continue-As-New only at a safe wait boundary with all required carry state.

Never resolve a stuck workflow by deleting history, changing the operation identity, releasing an unknown reservation, or editing SQLite rows to simulate a transition.

## Shutdown and recovery evidence

Graceful worker shutdown uses `SIGTERM` or `SIGINT` and waits for the worker to drain. Forced termination is acceptable only for a controlled failure drill. After any incident, retain:

- Temporal history and describe output;
- deployment/build and application commit;
- worker logs around the last acknowledged task;
- operation attempts, budget reservation, receipt/reconciliation artifacts;
- provider lookup evidence and publication staging/manifests;
- the final recovery action and whether manual intervention was required.
