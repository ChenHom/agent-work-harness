# P4 Temporal Durable Runtime Implementation Plan

**Goal:** Prove and integrate one durable fake workflow whose schedule, retry, timer, signal, cancellation, and worker takeover semantics have one owner, while preserving the P3 external-effect protocol and making stale-worker publication impossible.

**Architecture:** Select Temporal as the only lifecycle owner, conditional on an executable Gate 0 spike. Workflow history is the authoritative P4 orchestration state. Deterministic Workflow code decides transitions; Activities perform database, model, artifact, and provider I/O. P3 idempotency, receipts, reconciliation, compensation, and budget rules remain the external-write boundary. SQLite may hold local projections and test fixtures, but it is not presented as a shared cross-host ledger. A production G4 claim requires a shared Temporal service and an externally reachable provider/ledger boundary.

**Scope:** P4 integrates one fake workflow end to end. It does not migrate the existing P1-P3 CLI orchestrator, promise exactly-once Activity execution, or declare a single-host SQLite file suitable for cross-host coordination. If Gate 0 cannot execute restart, timer, retry, signal, and replay tests in the available environment, record the evidence and leave P4/G4 blocked.

**Tech Stack:** TypeScript, Node 24, Temporal TypeScript SDK pinned to an evaluated version, node:test, the existing P3 Gateway protocol, and an executable Temporal test server or development server.

**Low-usage execution rule:** Complete one task at a time. During implementation run only the task's targeted tests, followed by one full `npm run check`. Then compare the diff and evidence with that task's checklist; correct any mismatch before committing and starting the next task.

---

## Gate 0: Selection must be executable

Temporal is accepted only if a local executable spike proves all of the following with saved test evidence:

- a Workflow timer survives worker shutdown and resumes after another worker starts;
- an Activity may run again after an unacknowledged completion, while one stable operation identity prevents a second provider effect;
- duplicate and out-of-order signals do not regress workflow state;
- Workflow replay performs no Activity or external provider write;
- cancellation enters quiescence and does not claim completion while an effect is unresolved;
- the project has a documented development/test server command and a production service dependency.

Failure to run the server or any required scenario blocks the selection. Do not replace the missing evidence with mocked SDK calls or a capability table.

## Task 1: ADR and executable Temporal selection spike

**Files:** `package.json`, `package-lock.json`, `docs/adr/0001-temporal-lifecycle-owner.md`, `src/durable/spike-workflow.ts`, `src/durable/spike-activities.ts`, `test/temporal-selection.test.ts`

- [x] Pin compatible Temporal client, worker, workflow, activity, and testing packages. Record Node and server compatibility used by the test.
- [x] Implement the smallest deterministic Workflow and Activity needed to exercise worker restart, durable timer, retry after lost completion acknowledgement, signals, cancellation, and replay.
- [x] Use a stable operation identity and a provider-owned idempotency key in the retry scenario; assert multiple Activity executions produce one provider effect.
- [x] Compare the executable result with the local orchestrator and LangGraph designs. Record why local locking cannot establish cross-host fencing and why checkpoint replay that re-executes nodes is not audit replay.
- [x] Write the ADR with Temporal as the sole lifecycle owner only if Gate 0 passes. Record rejected alternatives, operational prerequisites, and the rule that SDK/Gateway retry must not multiply Temporal retries.
- [x] Run `node --test test/temporal-selection.test.ts`, one full `npm run check`, review this task against Gate 0, and commit. If infrastructure is unavailable, commit only reproducible evidence and mark P4 blocked.

## Task 2: Runtime identity, epoch, and dispatch authority

**Files:** `src/types.ts`, `src/runtime/dispatch-authority.ts`, `src/runtime/ownership.ts`, `src/tools/gateway.ts`, `src/tools/compensation.ts`, `src/durable/runtime-state.ts`, `test/dispatch-authority.test.ts`, `test/temporal-epoch.test.ts`

- [ ] Introduce a narrow `DispatchAuthority` contract checked immediately before Gateway/compensation dispatch and before publishing a result.
- [ ] Keep a P1 adapter backed by `ExecutionOwnership`; remove direct file-lock coupling from Gateway and compensation without weakening existing callers.
- [ ] Add a P4 Temporal adapter whose authority is the Workflow execution identity plus monotonically increasing epoch. A stale epoch must fail closed before dispatch or publish.
- [ ] Treat Temporal Workflow history as the authoritative runtime state. Any SQLite runtime row is an explicitly rebuildable projection, not a competing queue, timer, retry controller, or lease owner.
- [ ] Preserve operation identity and budget across epoch changes; takeover never creates a new logical intent or resets Work limits.
- [ ] Run targeted authority/Gateway tests, one full `npm run check`, review against this task, and commit.

## Task 3: Durable fake workflow and Activity boundary

**Files:** `src/durable/workflows.ts`, `src/durable/activities.ts`, `src/durable/contracts.ts`, `src/durable/worker.ts`, `test/durable-workflow.test.ts`

- [ ] Implement the fixed flow: generate saved output, prepare and dispatch one fake provider operation, wait for callback, reconcile uncertain delivery, and validate the terminal result.
- [ ] Keep Workflow code deterministic. Model calls, clocks other than Workflow time, filesystem, database, Gateway, provider, and artifact operations live in Activities.
- [ ] Save result references and receipts before later decisions. Workflow retries reuse the same Work, operation, intent, and idempotency identities.
- [ ] Temporal owns Activity retry/backoff. Gateway refuses UNKNOWN redispatch and only reconciles; adapters do not add another automatic retry loop.
- [ ] Separate retryable transport failure, definitive no-effect failure, unknown outcome, partial effect, policy denial, and budget exhaustion.
- [ ] Run targeted workflow tests, one full `npm run check`, review against this task, and commit.

## Task 4: Durable inbox, callback ordering, and deadlines

**Files:** `src/durable/workflows.ts`, `src/durable/signals.ts`, `src/durable/contracts.ts`, `test/durable-signals.test.ts`, `test/durable-timers.test.ts`

- [ ] Accept callbacks as Temporal signals carrying a stable event ID, source version/sequence, operation identity, and receipt reference.
- [ ] Persist bounded dedupe and ordering state in Workflow history. Duplicate delivery is ignored; stale/out-of-order delivery cannot regress state; a conflicting event becomes explicit manual review.
- [ ] Represent `WAITING_EXTERNAL` and `RETRY_WAIT` with Workflow timers, never process sleeps or model calls.
- [ ] Race callbacks, cancellation, and deadlines deterministically. A late valid callback may resolve an in-flight operation but cannot reopen a finalized transition.
- [ ] Define history-growth limits and Continue-As-New input so required event IDs, outstanding operations, deadlines, budgets, and artifact references survive rollover.
- [ ] Run targeted signal/timer tests, one full `npm run check`, review against this task, and commit.

## Task 5: Cancellation, quiescence, and managed publication

**Files:** `src/durable/workflows.ts`, `src/durable/publication.ts`, `src/durable/contracts.ts`, `test/durable-cancellation.test.ts`, `test/publication-fence.test.ts`

- [ ] Implement `CANCEL_REQUESTED -> QUIESCING -> CANCELLED`. Stop scheduling new model/tool work after the request.
- [ ] Track started Activities and operations until each is completed, definitively absent, reconciled, compensated, or assigned to `WAITING_USER`. UNKNOWN never becomes cancelled merely because a lease or timeout expired.
- [ ] Write each epoch's artifacts to an isolated staging area. Only an active authority may atomically publish a manifest/reference into the canonical workspace.
- [ ] Reject a delayed stale worker at the publish gate and retain its staging output for diagnosis/retention policy. Do not claim database fencing blocks arbitrary direct filesystem writes.
- [ ] Prove cancellation during dispatch, lost response, reconciliation, and compensation produces the documented non-terminal or terminal state.
- [ ] Run targeted cancellation/publication tests, one full `npm run check`, review against this task, and commit.

## Task 6: Version compatibility, safe replay, and history rollover

**Files:** `src/durable/workflows.ts`, `src/durable/versioning.ts`, `test/workflow-replay.test.ts`, `test/workflow-versioning.test.ts`, `docs/runbooks/temporal-upgrade.md`

- [ ] Record Worker build/version policy using the selected SDK's current supported deployment/versioning API. Pin behavior changes in deterministic Workflow code.
- [ ] Save representative histories and replay them under the new worker without executing Activities, Gateway calls, provider writes, or publication.
- [ ] Route incompatible executions to a compatible worker or explicit paused/manual state; never silently reset them under new code.
- [ ] Exercise Continue-As-New while preserving Work identity, budget, pending operations, signal dedupe horizon, deadlines, and artifact/receipt references.
- [ ] Document deploy, rollback, compatibility window, history export/replay, and stuck old-build recovery.
- [ ] Run targeted replay/version tests, one full `npm run check`, review against this task, and commit.

## Task 7: CLI, G4 fixture, operations runbook, and final gate

**Files:** `src/cli.ts`, `src/cli-format.ts`, `src/durable/client.ts`, `test/g4-acceptance.test.ts`, `test/cli.test.ts`, `docs/usage.md`, `docs/acceptance.md`, `docs/runbooks/temporal-operations.md`, `README.md`, `docs/superpowers/plans/2026-09-09-long-running-harness-v2.md`

- [ ] Add explicit commands for starting/inspecting/cancelling/signalling the P4 fake workflow and starting a worker. Keep legacy local commands clearly separate.
- [ ] Run two worker processes against one Temporal service and the same externally reachable fake provider boundary. Terminate the first during Activity execution and let the second take over.
- [ ] In one G4 fixture prove: stale worker cannot publish; takeover reuses identity and creates one provider effect; duplicate/out-of-order callbacks cause one valid transition; a deadline fires after worker/server restart; cancellation waits for unresolved effects; compatible old history completes or pauses explicitly.
- [ ] Document required Temporal service, namespace/task queue, TLS/auth/environment, worker health, alerting, queue backlog, stuck execution, reconciliation, provider outage, and recovery commands.
- [ ] State the deployment limitation precisely: passing a local multi-worker fixture proves the protocol boundary, while a production cross-host claim additionally requires the shared service/provider topology and operational drill described in the runbook.
- [ ] Mark P4/G4 complete only when every Gate 0 and G4 assertion has executable evidence. Otherwise list the exact unmet assertion and leave the checkbox open.
- [ ] Run one final `npm run check`, validate Markdown relative links and `git diff --check`, record pass/fail/skip counts, review all G4 items, and commit.

## G4 acceptance checklist

- [ ] Temporal is the only schedule/retry/timer/signal/cancel owner for the P4 path.
- [ ] Workflow replay and audit replay perform no external write.
- [ ] Activity re-execution reuses one operation identity and provider idempotency key.
- [ ] A stale epoch cannot dispatch or publish, including after the stale worker resumes.
- [ ] Multiple workers can take over through the shared Temporal service without duplicate provider effect.
- [ ] Duplicate, delayed, and out-of-order callbacks produce one valid state transition and retain conflict evidence.
- [ ] Workflow timers and deadlines survive worker/server restart.
- [ ] Cancellation reaches `CANCELLED` only after in-flight and cleanup responsibility is resolved.
- [ ] Compatible old executions complete under an allowed build; incompatible ones pause explicitly.
- [ ] Continue-As-New preserves identity, budgets, pending effects, deadline, dedupe horizon, and artifact references.
- [ ] Platform and provider outages have tested, actionable runbooks.
- [ ] SQLite is not represented as a shared cross-host coordination or ledger service.

## Selection evidence sources

- Temporal Activities and idempotency: <https://docs.temporal.io/activity-definition>
- Temporal Workflow determinism and versioning: <https://docs.temporal.io/workflow-definition>
- Temporal Continue-As-New: <https://docs.temporal.io/workflow-execution/continue-as-new>
- LangGraph persistence boundaries: <https://docs.langchain.com/oss/python/langgraph/persistence>
- LangGraph time travel re-execution behavior: <https://docs.langchain.com/oss/python/langgraph/use-time-travel>
