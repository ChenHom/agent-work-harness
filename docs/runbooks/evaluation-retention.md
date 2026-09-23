# Evaluation, Retention, and Recovery Operations (P5)

P5 adds criterion-level completion, calibrated semantic evaluation, reachability-based GC, redaction, and DB + artifact backup/restore. The completion rule is fixed: any required or hard-constraint `fail` wins, otherwise any required `unknown` (including missing, stale, substituted, or corrupt evidence) blocks `DONE`. Critic confidence and optional criteria never override it. All commands below print JSON unless noted.

## Evaluator incident response

Trigger: a completion later found wrong (`harness note <workId> false-accept ...`), a calibration run whose false-accept count rises for a task type, or a critic returning malformed output.

1. Inspect the Work: `harness eval show <workId>` (contract, runs, per-criterion verdicts with reason codes, completion decisions) and `harness replay inspect <workId>`.
2. If `audit.problems` contains `COMPLETION_REPLAY_MISMATCH` or `DONE_WITHOUT_PASSING_DECISION`, treat the store as tampered or corrupted: stop execution, take a backup, and restore the last verified backup into a new state directory for comparison. Do not edit decision rows in place.
3. If the decision is consistent with its saved verdicts but the verdict itself was wrong, the evaluator is at fault. Stop using that evaluator version for semantic criteria (leave those criteria `unknown`, which blocks `DONE`), add the case to the label corpus with an independent label, and re-run calibration before re-enabling it.
4. Never "fix" a completion by writing a new pass verdict from the same evaluator. A new decision requires a new evaluation run under the current contract.

## Oracle and version changes

- The label corpus (`test/fixtures/evaluation/labels.jsonl`) is the calibration oracle. Only `human-review` and `fixture-author` provenance is accepted; model-produced labels and labels authored by the evaluator under test are rejected (`CALIBRATION_LABEL_NOT_INDEPENDENT`).
- The shipped corpus `2026-09-23.1` was hand-written by the fixture author (a Claude Code session), not human-reviewed. Before calibrating a Claude-based critic against it, have a human review each case and relabel its provenance `human-review`; until then treat such results as weaker evidence.
- Changing a label, adding cases, or changing a rationale requires a new `corpusVersion`. Never mix versions in one file (`CALIBRATION_CORPUS_VERSION_MIXED`).
- Changing a critic's prompt, model, provider, or configuration requires a new evaluator `version`/`configHash`. Calibration groups are keyed by evaluator identity, so old and new results never merge.
- Run `harness report calibration <labels.jsonl> <predictions.jsonl>` and compare `falseAccept`, `falseReject`, and `abstention` per task type with explicit denominators. A `null` rate means the denominator is zero, not zero error. There is deliberately no combined score.

## Long-lived unknowns

`unknown` is a safe state, not an error to hide.

- Evaluation `unknown`: the Work stays out of `DONE`. Resolve by fixing the evidence (restore the artifact, re-run the validator) and recording a new evaluation run, or by amending the contract through the normal contract flow. Do not lower a criterion to optional to get past it.
- Operation `UNKNOWN`: reconcile with `harness fake operation reconcile <operationId>`. Once the idempotency window closes, reconciliation moves to `WAITING_USER`; `harness replay inspect` reports the Work as `unsafe` with `IDEMPOTENCY_WINDOW_EXPIRED:<id>`. Establish the provider-side truth manually before any further action; never re-dispatch.
- Recovery benchmark: `harness report recovery` reports unknown age percentiles and the share resolved within the SLA (`unknown.withinSla`, 10 s logical in `recovery-v1`). A falling `withinSla.rate` or growing `unknown.unresolved` is the signal to investigate provider visibility or reconciliation.

## Retention windows (policy v1)

| Record | Window | Notes |
|---|---|---|
| DB records (events, operations, budgets, evaluations, decisions) | never collected | authoritative ledgers are never sampled or deleted |
| Operation/compensation inputs, receipts, reconciliation evidence | never collected | effect evidence |
| Idempotency keys / dedupe records | never collected | live in operation rows |
| Tombstones and GC evidence | never collected | |
| Artifacts of archived Work | 30 days after last activity | archived = `DONE`/`FAILED` with every effect resolved |
| Raw logs of archived Work (`prompt`, `runtime_*`, model output) | 7 days after last activity | access class `restricted` |
| Unreferenced artifacts | 1 day grace after creation | protects writes not yet referenced |

Active (`ACTIVE`/`RUNNING`/`VERIFYING`) and resumable (`WAITING_USER`/`BLOCKED`, unknown states, or `DONE`/`FAILED` with any unresolved operation, compensation, reservation, critic dispatch, or evaluation run) Work keeps every payload regardless of age.

## GC approval and recovery

1. Preview (read-only, no lock needed): `harness gc preview --out gc-manifest.json`. Review `roots`, `references` (why each payload is kept), `candidates` (with per-artifact reason), and `unsafeRecovery`.
2. Approve by applying the unchanged file: `harness gc apply gc-manifest.json`. Apply needs the execution lock, so it cannot run concurrently with a Work.
3. Apply fails closed and deletes nothing when the manifest was edited (`GC_MANIFEST_TAMPERED`), already applied (`GC_MANIFEST_ALREADY_APPLIED`), any candidate became reachable or changed (`GC_MANIFEST_STALE`), or bytes on disk changed (`GC_PAYLOAD_CHANGED`). Preview again and re-review; never force.
4. Evidence: `gc_runs` stores the full manifest and deleted paths; each deleted artifact gets a tombstone (hash, kind, size, times, deletion id, authority `retention-policy:1`, replay limitation). Reads return `missing` / `deleted_by_retention`.
5. Recovery after a crash during apply: tombstones are committed before files are unlinked. The next preview lists leftover files as candidates with an empty artifact list; apply them normally. Restoring deleted payloads is only possible from a backup taken before the GC.

## Backup schedule and access

- Take a backup at least daily and before every `gc apply`, redaction, schema upgrade, or harness upgrade: `harness backup create <new-dir>`. The target must be empty. The manifest is written last; a directory without `backup-manifest.json` is incomplete and cannot be restored.
- `harness backup verify <dir>` re-hashes the database and every payload. Run it after copying a backup elsewhere and before relying on it.
- Backups contain raw logs. The manifest marks each file's access class; store backups with at least the access controls of the live state directory, restrict `restricted` payloads to operators who may read prompts and tool output, and apply the same retention to backups as to the live store (a redacted payload survives in older backups until those backups expire).

## Restore drill

Run monthly and after every schema change, always into a fresh directory:

```sh
harness backup verify /backups/2026-09-23
harness backup restore /backups/2026-09-23 /tmp/harness-restore-drill
HARNESS_STATE_DIR=/tmp/harness-restore-drill harness replay inspect
```

Restore verifies hashes, runs `integrity_check`, applies supported schema migrations by opening the store, relocates payload paths, requires the Work list, event high-water mark, and per-table row counts to match the manifest, verifies every payload, and runs the audit replay. It calls no model, tool, or provider. Any failure removes everything it wrote. Record in the drill log: backup hash, from/to schema version, artifact counts (verified / tombstoned / missing at source), audit counts, and the per-Work replay classification.

## Redaction

Use when a payload contains a secret or personal data: `harness redact <artifactId> --authority <who approved> --reason <why>`. It needs the execution lock. Every artifact id sharing the same bytes is tombstoned (content addressing would otherwise keep the data readable), the file is deleted, and an `artifact.redacted` event records ids, hash, kind, access class, authority, and reason, never the content. Rows, hashes, timestamps, and causal links remain, so traces and audits still show that the payload existed. Redact the same content in backups separately, or let those backups expire.

## Unreplayable state

`harness replay inspect` and restore classify each Work:

| Classification | Meaning | Action |
|---|---|---|
| `compatible` / `available` | every referenced payload verifies, no expired idempotency window | none |
| `expired` / `unsafe` | payloads deleted on purpose (retention, redaction) or an unresolved effect outlived its idempotency window | history is readable from metadata only; resolve unresolved effects manually |
| `unreplayable` / `unavailable` | a payload is missing or corrupt without a tombstone | restore it from an older backup if one has it; otherwise record the loss |

Missing historical results are never regenerated by calling a model: a regenerated output is a new result, not the lost one. If new work is needed, start a new evaluation run or attempt so it is recorded as new evidence.
