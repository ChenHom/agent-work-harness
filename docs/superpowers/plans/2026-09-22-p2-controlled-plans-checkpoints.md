# P2 Controlled Plans and Logical Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add versioned milestone plans, append-only logical checkpoints, safe fork/resume semantics, and plan-aware attempt completion without changing repository files during recovery.

**Architecture:** Keep `WorkContract.version` as the goal/authority version and derive stable acceptance criterion IDs from its existing criteria. Put deterministic plan validation in `src/work/plans.ts`, checkpoint integrity and fork/resume rules in `src/trace/checkpoints.ts`, and persistence primitives in `Store`; Orchestrator only binds attempts to the active plan and coordinates terminal transitions. P2 remains single-host and uses the P1 ownership boundary.

**Tech Stack:** Node 24 TypeScript, `node:sqlite`, `node:test`, existing SHA-256 artifact store and ownership runtime.

---

## File map

- `src/types.ts`: plan, milestone, checkpoint, artifact-manifest types; optional plan binding on Attempt.
- `src/trace/migrations.ts`: schema v3 tables and indexes for plans, milestones, checkpoints.
- `src/trace/store.ts`: persistence and compare-and-swap activation/finalization operations.
- `src/work/plans.ts`: criterion IDs, proposal validation, activation, goal amendment rules.
- `src/trace/checkpoints.ts`: append-only checkpoint creation, verified resume, fork identity, dependency invalidation.
- `src/context/manifest.ts`: active plan and milestone projection into authoritative control context.
- `src/orchestrator.ts`: bind attempt to active milestone and keep intermediate milestone success from completing Work.
- `src/cli.ts`, `src/cli-format.ts`: plan/amend/checkpoint commands and read-only display.
- `test/plans.test.ts`, `test/checkpoints.test.ts`: deterministic domain tests.
- Existing migration, attempt-flow, CLI, recovery, and transaction tests: compatibility and atomicity regression coverage.

### Task 1: Schema v3 and typed persistence

**Files:**
- Modify: `src/types.ts`
- Modify: `src/trace/migrations.ts`
- Modify: `src/trace/store.ts`
- Modify: `test/migrations.test.ts`
- Create: `test/plans.test.ts`

- [x] **Step 1: Write failing schema and round-trip tests**

Test that a v2 database migrates without changing existing authoritative rows and adds `plans`, `milestones`, and `checkpoints`. Round-trip this exact shape:

```ts
const plan: WorkPlan = {
  id: 'P-1', workId: 'W-1', version: 1, branchId: 'B-main', contractVersion: 1,
  reason: 'initial plan', changedMilestoneIds: ['M-1', 'M-2'], dependencyImpact: [],
  reusableArtifactIds: [], validationEvidenceIds: [], status: 'PROPOSED',
  createdAt: '2026-09-22T00:00:00.000Z',
};
```

- [x] **Step 2: Verify RED**

Run `node --test test/migrations.test.ts test/plans.test.ts`.
Expected: missing plan types/store methods/tables.

- [x] **Step 3: Add v3 types and schema**

Define `WorkPlan`, `PlanMilestone`, `LogicalCheckpoint`, `CheckpointArtifact`, and their finite statuses. Add optional `planId`, `branchId`, and `milestoneId` to `Attempt`. Store plans/milestones as JSON plus indexed identity/status columns; store checkpoints append-only as JSON. Add a partial unique index allowing one `ACTIVE` plan per work.

- [x] **Step 4: Add Store round-trip methods**

Implement `insertPlan`, `getPlan`, `listPlans`, `insertMilestones`, `getMilestone`, `listMilestones`, `insertCheckpoint`, `getCheckpoint`, and `listCheckpoints`. Reject updates to checkpoint rows; current milestone status remains a mutable projection with append-only events.

- [x] **Step 5: Verify and commit**

Run `npm run typecheck` and `node --test test/migrations.test.ts test/plans.test.ts`.
Commit: `feat: persist versioned plans and logical checkpoints`.

### Task 2: Deterministic plan validation and atomic activation

**Files:**
- Create: `src/work/plans.ts`
- Modify: `src/trace/store.ts`
- Modify: `test/plans.test.ts`

- [x] **Step 1: Write failing validation tests**

Cover stable acceptance IDs; duplicate/missing milestone IDs; missing/self/cyclic dependencies; unknown acceptance IDs; incomplete acceptance coverage; stale contract version; stale parent plan; and two proposals racing to activate from the same parent.

- [x] **Step 2: Verify RED**

Run `node --test test/plans.test.ts`.
Expected: `PlanService` and activation behavior are absent.

- [x] **Step 3: Implement criterion IDs and proposal validation**

Derive IDs as `AC-<first 16 hex chars of SHA-256(canonical criterion text)>`. Require every contract criterion to be referenced by at least one required milestone. Validate the ordered milestone list and dependency graph without adding a general scheduler.

- [x] **Step 4: Implement compare-and-swap activation**

`propose()` freezes `contractVersion` and `parentPlanId`. `activate(planId)` runs in one transaction: current contract must match, the expected parent must still be active, any prior active plan becomes `SUPERSEDED`, and only the candidate becomes `ACTIVE`. A competing candidate receives `PLAN_STALE` and remains proposed.

- [x] **Step 5: Verify and commit**

Run `npm run typecheck` and `node --test test/plans.test.ts test/store-transaction.test.ts`.
Commit: `feat: validate and activate milestone plans`.

### Task 3: Logical checkpoints, verified resume, and fork

**Files:**
- Create: `src/trace/checkpoints.ts`
- Modify: `src/trace/store.ts`
- Create: `test/checkpoints.test.ts`

- [ ] **Step 1: Write failing checkpoint tests**

Cover append-only parent chains, `pending_validation`, missing/corrupt artifacts, same-branch resume, new-branch fork, stale source plan, retained attempt/retry counts, and unchanged dirty workspace files.

- [ ] **Step 2: Verify RED**

Run `node --test test/checkpoints.test.ts`.
Expected: checkpoint service is absent.

- [ ] **Step 3: Implement checkpoint creation and resume**

Create checkpoints only from persisted work/plan/branch refs. Verify every artifact through `readVerifiedArtifact`, save its hash in the manifest, and capture the latest event sequence. `resume()` verifies schema/hash/refs and returns reusable confirmed state on the same branch; it does not run a model, alter files, or change validation status.

- [ ] **Step 4: Implement fork**

`fork()` creates a new branch ID and proposed child plan referencing `sourceCheckpointId`; activation still uses Task 2 compare-and-swap. It never deletes attempts, resets retry counts, rewrites artifacts, or executes Git commands.

- [ ] **Step 5: Verify and commit**

Run `npm run typecheck` and `node --test test/checkpoints.test.ts test/artifact-integrity.test.ts test/recovery.test.ts`.
Commit: `feat: add verified logical checkpoint resume and fork`.

### Task 4: Artifact replacement and downstream staleness

**Files:**
- Modify: `src/trace/checkpoints.ts`
- Modify: `src/trace/store.ts`
- Modify: `test/checkpoints.test.ts`

- [ ] **Step 1: Write failing dependency tests**

Use milestones `M-1 → M-2 → M-3`. Create a checkpoint whose `M-1/build` artifact has hash A, complete downstream milestones, then create a later checkpoint with hash B for the same producer/logical name. Assert `M-2` and `M-3` become `STALE`, the cause chain is recorded, and the old checkpoints remain unchanged.

- [ ] **Step 2: Verify RED**

Run `node --test test/checkpoints.test.ts`.
Expected: downstream statuses remain completed.

- [ ] **Step 3: Implement deterministic invalidation**

Compare checkpoint manifest entries by `(producerMilestoneId, logicalName)`. When the verified hash changes, traverse milestone dependencies in the active plan, mark affected completed milestones `STALE`, and append `dependency.artifact_replaced` plus `milestone.stale` events containing the source artifact and dependency path.

- [ ] **Step 4: Verify and commit**

Run `npm run typecheck` and `node --test test/checkpoints.test.ts test/store-transaction.test.ts`.
Commit: `feat: invalidate milestones after artifact replacement`.

### Task 5: Plan-aware attempts and Work completion

**Files:**
- Modify: `src/context/manifest.ts`
- Modify: `src/orchestrator.ts`
- Modify: `src/trace/store.ts`
- Modify: `test/attempt-flow.test.ts`
- Modify: `test/compiler.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Cover: active plan requires a milestone selection; attempt freezes plan/branch/milestone; plan and milestone appear in control context; first required milestone SUCCESS leaves Work `ACTIVE`; final required milestone SUCCESS makes Work `DONE`; stale-plan success cannot satisfy the active plan; failed attempts do not complete milestones.

- [ ] **Step 2: Verify RED**

Run `node --test test/attempt-flow.test.ts test/compiler.test.ts`.
Expected: attempts have no plan binding and first success completes Work.

- [ ] **Step 3: Bind preparation to active plan**

Extend `runAttempt`/`retry` options with `milestoneId`. Resolve the active plan before input snapshot creation, validate the milestone belongs to it, and persist plan/branch/milestone IDs in Attempt and authoritative manifest control items.

- [ ] **Step 4: Atomically complete milestones**

Extend terminal finalization so a successful planned attempt marks its milestone complete in the same transaction. Work becomes `DONE` only when every required milestone of the still-active plan is complete and the completing attempt passed the repository mechanical checks; otherwise it returns to `ACTIVE`.

- [ ] **Step 5: Verify and commit**

Run `npm run typecheck` and `node --test test/attempt-flow.test.ts test/compiler.test.ts test/store-transaction.test.ts`.
Commit: `feat: bind attempts and completion to active milestones`.

### Task 6: Goal amendment, CLI, G2 acceptance, and documentation

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli-format.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/plans.test.ts`
- Modify: `test/checkpoints.test.ts`
- Modify: `docs/usage.md`
- Modify: `docs/acceptance.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-09-long-running-harness-v2.md`

- [ ] **Step 1: Write failing amendment and CLI tests**

Cover user-authored `amend` creating a new WorkContract version while preserving accumulated constraints; JSON-file plan proposal/activation; `show` displaying active plan, milestone status, and checkpoints; checkpoint resume/fork output; and read-only display causing no events.

- [ ] **Step 2: Verify RED**

Run `node --test test/cli.test.ts test/plans.test.ts test/checkpoints.test.ts`.
Expected: P2 commands are unavailable.

- [ ] **Step 3: Implement mutation commands under P1 ownership**

Add `amend`, `plan propose|activate|fork`, and `checkpoint create|resume` as mutating commands. Add plan/checkpoint sections to read-only `show`. User amendment may change request and add restrictions, but cannot silently remove existing constraints or denied paths.

- [ ] **Step 4: Run the real two-milestone harness acceptance fixture**

Use this repository as the Work workspace. Activate a plan with two required milestones, checkpoint the first, fork from it, verify the original dirty file hash is unchanged, finish the fork, and assert the old branch result cannot complete the active Work. Record exact automated fixtures rather than keeping disposable runtime state.

- [ ] **Step 5: Complete G2 docs and plan checkboxes**

Document the difference between resume, fork, audit replay, and re-execution; state that checkpoints are logical and never imply Git rollback; record schema/test environment and G2 evidence. Mark only P2/G2 complete; leave P3–P5 unchanged.

- [ ] **Step 6: Final verification and commit**

Run `npm run check`, then Markdown relative-link and `git diff --check` validation. Record pass/fail/skip counts.
Commit: `docs: record controlled plan and checkpoint guarantees`.

## G2 acceptance checklist

- [ ] User amendment creates a new immutable WorkContract version and preserves restrictions.
- [ ] Plans freeze contractVersion; deterministic validation rejects missing criteria and dependency cycles.
- [ ] Two competing proposals cannot both activate.
- [ ] Resume keeps branch identity; fork creates a new identity and plan lineage.
- [ ] Fork preserves attempts/retry accounting and never modifies dirty workspace files.
- [ ] Intermediate milestone success does not complete Work; only the active plan can complete it.
- [ ] Replaced dependency artifacts mark downstream milestones stale with a traceable cause chain.
- [ ] Checkpoints remain append-only and `pending_validation` is never treated as acceptance.
