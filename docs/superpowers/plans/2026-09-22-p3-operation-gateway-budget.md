# P3 Operation Gateway and Budget Implementation Plan

**Goal:** Add a durable single-host Gateway for one fake write provider so external-effect identity, UNKNOWN reconciliation, compensation, and integer budget accounting remain correct across retries and crashes.

**Architecture:** Keep model/shell execution network-denied. Only `OperationGateway` may invoke an admitted adapter. Persist intent, authorization reference, capability snapshot, and budget reservation before dispatch; persist every attempt and receipt afterward. Provider calls stay outside SQLite transactions. UNKNOWN operations keep their reservation and block redispatch until reconciliation or explicit human resolution.

**Scope:** P3 proves the protocol with a separate durable fake-provider ledger. It does not add a real provider, enable network access, promise arbitrary exactly-once behavior, or claim precise Codex token/cost control.

**Tech Stack:** TypeScript, Node 24, node:sqlite, node:test, existing P1 ownership and schema migration framework.

---

## Task 1: Schema v4 and operation domain records

**Files:** `src/types.ts`, `src/trace/migrations.ts`, `src/trace/store.ts`, `test/migrations.test.ts`, `test/operations.test.ts`

- [x] Add finite operation, operation-attempt, compensation, reservation, and ledger types. Keep money/resource quantities as integer units with explicit kind/currency and pricing version.
- [x] Add schema-v4 tables and indexes for operations, operation attempts, compensation workflows/attempts, budget limits/reservations/ledger.
- [x] Enforce unique logical intent and unique idempotency key; keep attempts and ledger append-only while operation/reservation status is a mutable projection backed by events.
- [x] Test fresh migration, v3 preservation, round trips, uniqueness, and current-schema fail-closed validation.
- [x] Run targeted tests, one full `npm run check`, review against this task, and commit.

## Task 2: Atomic integer budget ledger

**Files:** `src/budget/ledger.ts`, `src/trace/store.ts`, `test/budget-ledger.test.ts`

- [ ] Configure per-Work limits by resource kind and currency. Reject floats, negative quantities, currency mismatch, and unsupported hard caps.
- [ ] Atomically enforce `spent + reserved + requested <= limit` while creating a durable reservation and ledger entry.
- [ ] Settle from verified receipts, release only confirmed-unused reservations, and keep UNKNOWN cost reserved.
- [ ] Make fork/replan reuse the same Work ledger; concurrent reservations must not exceed the limit.
- [ ] Represent Codex usage as `unknown` or `estimated`; never derive token/currency usage from prompt characters.
- [ ] Run targeted tests, one full `npm run check`, review against this task, and commit.

## Task 3: Fake adapter and intent-first Gateway dispatch

**Files:** `src/tools/operations.ts`, `src/tools/gateway.ts`, `src/tools/fake-provider.ts`, `src/trace/store.ts`, `test/operation-recovery.test.ts`

- [ ] Define explicit adapter capabilities: effect type, retry safety, reversibility, lookup support, key TTL, postcondition, upper-bound support, and adapter version.
- [ ] Back the fake provider with a separate durable ledger keyed by business identity and idempotency key.
- [ ] `prepare()` reuses the same operation/idempotency key for the same logical intent and rejects the same identity/key with a different canonical payload.
- [ ] In one local transaction save authorization/capability snapshot, PREPARED intent, and budget reservation. Dispatch only afterward under P1 ownership.
- [ ] Record DISPATCHED before the provider call. Save receipt and postcondition before SUCCEEDED; definitive no-effect errors become FAILED; ambiguous errors/timeouts become UNKNOWN.
- [ ] Prove duplicate delivery produces one provider effect and one settled charge.
- [ ] Run targeted tests, one full `npm run check`, review against this task, and commit.

## Task 4: UNKNOWN reconciliation and expiry policy

**Files:** `src/tools/gateway.ts`, `src/tools/fake-provider.ts`, `src/trace/store.ts`, `test/operation-recovery.test.ts`

- [ ] UNKNOWN may enter RECONCILING but may not dispatch again.
- [ ] Provider lookup outcomes are explicit: confirmed success, confirmed no-effect, pending/not-yet-visible, partial effect, unsupported.
- [ ] Eventually-consistent not-found remains UNKNOWN until the provider completion window closes; only confirmed no-effect becomes FAILED and releases reservation.
- [ ] Expired dedupe keys prohibit redispatch and move unresolved work to manual handling.
- [ ] Simulate provider success followed by lost response, delayed lookup visibility, process restart, and duplicate reconciliation.
- [ ] Run targeted tests, one full `npm run check`, review against this task, and commit.

## Task 5: Durable compensation workflow

**Files:** `src/tools/compensation.ts`, `src/tools/gateway.ts`, `src/tools/fake-provider.ts`, `src/trace/store.ts`, `test/operation-recovery.test.ts`, `test/budget-ledger.test.ts`

- [ ] Compensation is a separate durable workflow referencing the original operation, with its own idempotency key, attempts, receipt, reservation, and terminal/UNKNOWN state.
- [ ] Verify resource identity, ownership, version, authorization, and adapter reversibility before dispatch.
- [ ] Persist compensation intent before calling the provider. A lost response or crash becomes UNKNOWN and requires lookup; it never implies the original effect was removed.
- [ ] Failed/unsupported/irreversible compensation becomes WAITING_USER with retained evidence and cost history.
- [ ] Prove a compensation crash and repeated recovery produce at most one compensating provider effect.
- [ ] Run targeted tests, one full `npm run check`, review against this task, and commit.

## Task 6: CLI, G3 acceptance, and documentation

**Files:** `src/cli.ts`, `src/cli-format.ts`, `test/cli.test.ts`, `docs/usage.md`, `docs/acceptance.md`, `README.md`, `docs/superpowers/plans/2026-09-09-long-running-harness-v2.md`

- [ ] Add ownership-guarded fake-provider commands for budget configuration, prepare/dispatch, reconcile, and compensation; add read-only operation/budget display.
- [ ] Keep fake-provider state outside the harness DB and make CLI restarts reuse it.
- [ ] Add one G3 fixture covering lost success response, duplicate dispatch, expired TTL, eventual consistency, compensation crash, and concurrent budget reservation.
- [ ] Assert each provider business identity has the authorized effect count and the Work ledger never exceeds its hard limit.
- [ ] Test/document that Codex and repository shell remain network-denied and cannot invoke a real external write path; without a real adapter the product states that external side-effect governance is not connected.
- [ ] Document receipt, UNKNOWN, reconciliation, compensation, reservation, and hard-cap limits. Mark only P3/G3 complete; leave P4–P5 unchanged.
- [ ] Run one final `npm run check`, validate Markdown relative links and `git diff --check`, record pass/fail/skip counts, review all G3 items, and commit.

## G3 acceptance checklist

- [ ] Intent, authorization, capability snapshot, and reservation are durable before dispatch.
- [ ] Same logical intent reuses identity/key; same key with different payload is rejected.
- [ ] Provider success with lost response becomes UNKNOWN and reconciles without duplicate effect.
- [ ] Eventual-consistency not-found and expired dedupe windows never trigger blind redispatch.
- [ ] Receipt/postcondition gates SUCCEEDED and budget settlement.
- [ ] UNKNOWN retains reservation; confirmed no-effect releases it.
- [ ] Concurrent reservations cannot exceed the integer hard limit.
- [ ] Compensation has independent identity, attempts, receipt, cost, and UNKNOWN recovery.
- [ ] Provider ledger proves one authorized effect per business identity across duplicate/crash cases.
- [ ] No real external adapter or model/shell bypass path is enabled in P3.
