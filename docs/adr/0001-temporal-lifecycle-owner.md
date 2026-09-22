# ADR 0001: Temporal owns the P4 durable lifecycle

- Status: Accepted for the bounded P4 path
- Date: 2026-09-22
- Decision gate: executable selection test required

## Context

P1-P3 deliberately use a single-host file lock and SQLite state. That boundary is sufficient for local recovery and the external-effect protocol, but it cannot prove persistent timers, cross-worker takeover, or stale-worker fencing across hosts. Extending it would require this project to implement a durable queue, distributed leases, workflow history, replay compatibility, signals, timers, and cancellation recovery.

P4 needs one owner for scheduling, Activity retry, timers, signals, and cancellation. The P3 Gateway remains responsible for operation identity, provider idempotency, receipts, unknown-outcome reconciliation, compensation, and budget admission.

## Decision

Temporal is the only lifecycle owner for the bounded P4 fake-workflow path.

- Temporal Workflow history is the authoritative orchestration state.
- Workflow code is deterministic and contains transition decisions only.
- Model, filesystem, database, Gateway, provider, and artifact I/O run as Activities.
- Temporal owns Activity retry and backoff. The Gateway does not redispatch an UNKNOWN operation; adapters do not add another retry loop.
- Activity execution is at least once. Every external write therefore uses the stable P3 operation identity and provider idempotency key.
- SQLite may be used for local projections and fixtures. It is not a shared cross-host queue, lease service, or ledger.
- Workflow replay is compatibility validation and must not execute Activities. Audit replay reads saved results and likewise performs no external writes.
- A production G4 claim requires a shared Temporal service and an externally reachable provider/ledger boundary. The local selection test establishes the protocol and worker-takeover boundary, not a deployed multi-host topology.

The dependency versions selected by the executable spike are:

```text
Node.js >= 24
@temporalio/client 1.24.0
@temporalio/worker 1.24.0
@temporalio/workflow 1.24.0
@temporalio/activity 1.24.0
@temporalio/testing 1.24.0
Temporal CLI 1.9.1
Temporal Server 1.32.0
```

## Executable evidence

Run:

```bash
npm run test:temporal-selection
```

`TestWorkflowEnvironment.createLocal()` starts the official full local development server version selected for the pinned SDK. On the accepted run it reported Temporal CLI 1.9.1 with Server 1.32.0 and proved:

1. An Activity wrote one provider effect, then simulated a lost completion response. Temporal retried the Activity, whose second attempt reused the same idempotency key. The Activity attempt was 2 and the provider effect count remained 1.
2. Duplicate and stale callback signals were ignored. One current callback caused one accepted transition.
3. The completed Workflow history replayed with `Worker.runReplayHistory`; provider effect count did not change.
4. Worker 1 stopped while a Workflow timer was pending. After the deadline elapsed, Worker 2 took over the same task queue and observed `DEADLINE_EXCEEDED`.
5. Cancellation of a Workflow with an unresolved external result entered `QUIESCING` and then `WAITING_USER`; it did not report `CANCELLED`.

The test needs permission to launch the local Temporal server process and may download the pinned test dependency on first use. Production needs a separately operated Temporal service, namespace, authenticated connection, worker deployment, and monitoring; the embedded development server is not a production dependency.

## Alternatives

### Extend the local orchestrator

Rejected for P4. The present ownership rule intentionally refuses timeout takeover because a dead lease does not prove the old process stopped. Adding cross-host takeover would require rebuilding the lifecycle facilities listed above, and a shared SQLite file would still not be a safe distributed authority.

### LangGraph with a persistent checkpointer

Rejected as the lifecycle owner. A persistent checkpointer can retain graph state, but a separate execution service must still own workers, timers, retry, cancellation, and fencing. LangGraph time travel re-executes downstream nodes, so it cannot serve as side-effect-free audit replay unless every external effect is separately guarded. That composition adds another scheduler boundary without removing Temporal's required responsibilities.

## Consequences

P4 code and deployment now depend on Temporal. Workflow determinism and code-version compatibility become release requirements. Activity implementations must assume repeat execution. The P1-P3 local path remains supported and separate while the bounded P4 workflow is built and verified.

This decision does not complete G4. Epoch fencing, durable inbox semantics, cancellation quiescence, managed publication, Worker version compatibility, Continue-As-New, the full two-worker fixture, and operational runbooks remain required by the P4 implementation plan.

## References

- Temporal Activities: <https://docs.temporal.io/activity-definition>
- Temporal Workflow determinism and versioning: <https://docs.temporal.io/workflow-definition>
- Temporal Continue-As-New: <https://docs.temporal.io/workflow-execution/continue-as-new>
- LangGraph persistence: <https://docs.langchain.com/oss/python/langgraph/persistence>
- LangGraph time travel: <https://docs.langchain.com/oss/python/langgraph/use-time-travel>
