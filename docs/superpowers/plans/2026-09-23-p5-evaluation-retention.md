# P5 Evaluation, Benchmark, and Retention Implementation Plan

**Goal:** Add criterion-level completion decisions, calibrated semantic evaluation, reproducible recovery benchmarks, safe retention/GC, and tested backup/restore without allowing an evaluator score, missing evidence, or deleted history to create a false success.

**Architecture:** Deterministic validators and an immutable evaluation contract remain authoritative for mechanical facts and hard constraints. A semantic critic may propose `pass`, `fail`, or `unknown`, but every verdict is bound to a criterion version, exact artifact hashes, validator version/configuration, and saved evidence. The Runtime applies a versioned completion policy; required `unknown` or `fail` blocks `DONE`. Independent human/fixed labels are the calibration oracle. SQLite stores the durable evaluation/retention ledger, while artifact bytes remain content-addressed and hash-verified.

**Scope:** P5 adds an opt-in evaluation contract so legacy P1-P4 work remains compatible. It does not treat one model judging another as independent truth, turn critic scores into probabilities, promise that deleted payloads remain replayable, or claim production backup readiness from an in-process copy test alone. Online model integration remains optional; G5 uses fixed labeled fixtures and fake providers.

**Tech Stack:** TypeScript, Node 24, SQLite, node:test, the existing artifact/store/operation protocols, deterministic JSON fixtures, and shell-free benchmark/backup helpers.

**Low-usage execution rule:** Complete one task at a time. During implementation run only that task's targeted tests, followed by one full `npm run check`. Compare the diff and evidence with the task checklist; correct every mismatch before committing and starting the next task. Do not repeat a full gate unless code changes after it or the gate fails.

---

## Gate 0: Independent truth and completion authority

P5 may claim calibrated semantic evaluation only when the repository contains a versioned labeled corpus whose expected decisions were not produced by the evaluator under test. Until then, semantic results remain `unknown` or advisory and cannot establish completion.

The completion authority must satisfy all of the following:

- each required criterion has one current definition and one accepted verdict for the exact artifact set;
- missing, corrupt, stale, mismatched, or unsupported evidence becomes `unknown`, never implicit `pass`;
- any required `fail` produces global `fail`; otherwise any required `unknown` produces global `unknown`;
- optional criteria cannot override required or hard-constraint results;
- no scalar average, goal score, or model confidence can override the rule table;
- artifact content cannot alter the evaluation contract, authority, validator version, or expected criterion identity.

## Task 1: Criterion contract and deterministic completion policy

**Files:** `src/types.ts`, `src/evaluation/criteria.ts`, `test/criteria.test.ts`

- [x] Define versioned criterion, artifact binding, validator identity, criterion verdict, and global verdict types. Keep semantic confidence informational and out of the completion rule.
- [x] Validate exact criterion ID/version, required/hard flags, validator name/version/config hash, and artifact ID/SHA-256 bindings before accepting a verdict.
- [x] Convert evaluator abstention and missing/corrupt/mismatched evidence to `unknown` with structured reason codes.
- [x] Implement the fixed global rule: required/hard `fail` wins; otherwise required `unknown` or missing verdict blocks completion; only all required `pass` may produce global `pass`.
- [x] Prove “criterion A requested, artifact B delivered” is rejected, optional results cannot mask a hard failure, duplicate/conflicting verdicts fail closed, and no average score participates.
- [x] Run `node --test test/criteria.test.ts`, one full `npm run check`, review this task against Gate 0, and commit.

## Task 2: Durable evaluation ledger and atomic completion gate

**Files:** `src/trace/migrations.ts`, `src/trace/store.ts`, `src/types.ts`, `src/evaluation/finalization.ts`, `test/migrations.test.ts`, `test/evaluation-store.test.ts`, `test/evaluation-finalization.test.ts`

- [ ] Add append-only evaluation contracts, runs, criterion verdicts, and completion decisions with explicit schema/policy versions and parent/source identities.
- [ ] Store artifact bindings, evaluator/validator identity, model/config identity when applicable, cost status, timestamps, reasons, and evidence references. Reject mutation or conflicting reuse of an evaluation identity.
- [ ] Verify referenced artifacts through the existing hash-checking read path before persisting an accepted verdict; artifact payloads never supply authority fields.
- [ ] Finalize an opted-in Work atomically only when the current contract's required criteria globally pass. Persist `unknown`/`fail` decisions without moving the Work to `DONE`.
- [ ] Keep legacy P1-P4 flows compatible until an evaluation contract is explicitly attached; never infer semantic criteria from free-form success text.
- [ ] Run targeted migration/store/finalization tests, one full `npm run check`, review against this task, and commit.

## Task 3: Semantic critic scheduling, abstention, and cost accounting

**Files:** `src/evaluation/critic.ts`, `src/evaluation/model-config.ts`, `src/trace/store.ts`, `test/semantic-critic.test.ts`, `test/evaluator-cost.test.ts`

- [ ] Define event triggers for milestone completion, retry exhaustion, tool/evidence failure, plan change, budget acceleration, pre-checkpoint, and pre-finalization, with a periodic fallback.
- [ ] Deduplicate equivalent triggers and enforce per-Work cooldown, invocation limit, and cost reservation before dispatch. A periodic trigger must not bypass these controls.
- [ ] Require the critic to return criterion-level `pass`/`fail`/`unknown`, reasons, evidence references, and evaluator version; malformed or unsupported output becomes `unknown`.
- [ ] Store planner/executor/critic role, provider/model/config version, and exact/estimated/unknown cost without deriving tokens or currency from character counts.
- [ ] Keep critic output subordinate to deterministic validation and the completion policy; evaluator confidence is diagnostic only.
- [ ] Run targeted critic/cost tests, one full `npm run check`, review against this task, and commit.

## Task 4: Independent calibration corpus and recovery benchmark

**Files:** `test/fixtures/evaluation/labels.jsonl`, `src/evaluation/calibration.ts`, `src/benchmark/recovery.ts`, `scripts/benchmark-recovery.ts`, `test/calibration.test.ts`, `test/recovery-benchmark.test.ts`

- [ ] Add a versioned fixed corpus with independent expected labels, task type, fixture version, and provenance. Explicitly reject labels generated by the evaluator under test as an oracle.
- [ ] Report false accept, false reject, abstention, and confusion counts grouped by task type and evaluator version, including zero-denominator handling.
- [ ] Aggregate all benchmark runs, including failed, unknown, budget-blocked, and manually resolved runs. Report total cost plus p50/p95/p99 latency, cost, steps, and recovery time.
- [ ] Report unknown age/resolution SLA, duplicate effects, manual intervention, recovery success, constraint violations, and cost per independently accepted Work without a single composite score.
- [ ] Save task-set, budget, model/config, failure seed, oracle, environment, schema, and benchmark implementation versions so runs are comparable.
- [ ] Run targeted calibration/benchmark tests, one full `npm run check`, review against Gate 0, and commit.

## Task 5: Retention manifests and reachability-safe GC

**Files:** `src/trace/retention.ts`, `src/trace/store.ts`, `src/trace/migrations.ts`, `test/retention.test.ts`, `test/gc.test.ts`

- [ ] Define versioned `active`, `resumable`, and `archived` retention classes and windows for DB records, artifacts, raw logs, receipts, idempotency keys, and tombstones.
- [ ] Build a deterministic reachability graph rooted in active/resumable Work, checkpoints, current plans, evaluations, pending operations/compensations, reservations, receipts, and dedupe records.
- [ ] Make GC dry-run the default. Emit a manifest with roots, references, candidates, reason, hash, policy version, and creation time before any deletion.
- [ ] Require an explicit apply step against the unchanged manifest; recheck hashes/reachability transactionally and save deletion evidence. Stale manifests fail closed.
- [ ] Never collect unresolved-effect evidence or keys before their completion/dedupe/recovery horizons. Mark expired recovery as unsafe/unavailable rather than silently continuing.
- [ ] Run targeted retention/GC tests, one full `npm run check`, review that every resumable reference survives, and commit.

## Task 6: Backup, restore, migration drill, and privacy-preserving traces

**Files:** `src/trace/backup.ts`, `src/trace/links.ts`, `src/trace/redaction.ts`, `src/trace/migrations.ts`, `test/backup-restore.test.ts`, `test/trace-links.test.ts`, `test/redaction.test.ts`

- [ ] Create a consistent DB + artifact backup manifest with schema version, file/content hashes, sizes, and causal root identities. An incomplete or hash-invalid backup must not be restorable.
- [ ] Restore into an empty target, verify every referenced artifact and database invariant, then run supported schema migration and audit replay without model/tool/provider calls.
- [ ] Classify restored work as compatible, expired, or unreplayable with reasons; never regenerate missing historical results by calling a model.
- [ ] Add trace/span links for asynchronous/cross-run causality using Work, operation, and causation-event identities. Authoritative event/operation/budget/evaluation records remain unsampled.
- [ ] Redact or tombstone sensitive payloads while preserving content hash, type, timestamps, causal metadata, deletion authority, and explicit replay limitation. Record access class for raw logs.
- [ ] Run targeted backup/link/redaction tests, one full `npm run check`, review the restore drill against a fresh target, and commit.

## Task 7: CLI, G5 adversarial fixture, runbooks, and final gate

**Files:** `src/cli.ts`, `src/cli-format.ts`, `test/g5-acceptance.test.ts`, `test/cli.test.ts`, `docs/usage.md`, `docs/acceptance.md`, `docs/runbooks/evaluation-retention.md`, `README.md`, `docs/superpowers/plans/2026-09-09-long-running-harness-v2.md`

- [ ] Add explicit commands to inspect evaluations, run calibration/benchmark reports, preview/apply GC manifests, create/verify/restore backups, and inspect replay compatibility.
- [ ] In one G5 fixture prove: A requested/B delivered is rejected; malicious artifact text cannot change authority; required `unknown` blocks `DONE`; optional scores cannot mask hard failure.
- [ ] Prove GC preserves every active/resumable and unresolved-effect reference, refuses a stale manifest, and records applied deletion evidence.
- [ ] Prove a fresh-target DB + artifact restore passes hashes, migrations, audit replay, and completion-policy inspection without an external call.
- [ ] Prove benchmark/calibration reports retain failed/unknown/manual runs, tail percentiles, counts/denominators, fixed versions, and per-group false accept/reject/abstention.
- [ ] Document evaluator incident response, oracle/version changes, long-lived unknowns, retention windows, GC approval/recovery, backup schedule/access, restore drill, redaction, and unreplayable-state handling.
- [ ] Mark P5/G5 complete only when every assertion has executable evidence. Run one final `npm run check`, validate Markdown relative links and `git diff --check`, record pass/fail/skip counts, review all G5 items, and commit.

## G5 acceptance checklist

- [ ] Criterion/artifact/validator bindings reject substitution, corruption, stale versions, and authority injection from artifact content.
- [ ] Required `fail` or `unknown` cannot reach `DONE`; hard constraints cannot be averaged away.
- [ ] Semantic critics may abstain, are triggered and budgeted deterministically, and are calibrated only against independent labels.
- [ ] Evaluation, cost, and completion decisions are immutable, versioned, inspectable, and replayable from saved evidence.
- [ ] Reports include failed and uncertain runs, counts/denominators, tail distributions, manual intervention, duplicate effects, and recovery SLA.
- [ ] GC is reachability-based, dry-run first, stale-manifest safe, and preserves active/resumable/unresolved-effect dependencies.
- [ ] Backup restores both DB and artifacts into a fresh target, verifies hashes, migrates safely, and identifies expired/unreplayable history.
- [ ] Span links preserve asynchronous causality; authoritative ledgers are unsampled; redaction retains causal tombstones without pretending payload replay remains possible.
