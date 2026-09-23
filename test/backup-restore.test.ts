import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { finalizeEvaluation } from '../src/evaluation/finalization.ts';
import { auditReplay, createBackup, restoreBackup, verifyBackup, type BackupManifest } from '../src/trace/backup.ts';
import { CURRENT_SCHEMA_VERSION } from '../src/trace/migrations.ts';
import { Store } from '../src/trace/store.ts';
import { evaluationFixture } from './helpers/evaluation.ts';
import { richHistory } from './helpers/history.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'harness-backup-'));
const rehash = ({ hash: _stale, ...body }: BackupManifest): BackupManifest =>
  ({ ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') });

test('restore drill: a fresh target passes hashes, roots, audit replay, and classifies replayability without external calls', async () => {
  const h = await richHistory();
  const dir = scratch();
  const realFetch = globalThis.fetch;
  try {
    const manifest = createBackup(h.store, join(dir, 'backup'));
    assert.equal(manifest.db.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(manifest.roots.works.map((work) => work.id), ['W-EVAL', 'W-LOST', 'W-OLD', 'W-OP']);
    const notCopied = Object.fromEntries(manifest.notCopied.map((entry) => [entry.artifactIds.join(), entry.reason]));
    assert.deepEqual(notCopied, { [h.ids.oldPayload]: 'tombstoned', [h.ids.lostPayload]: 'missing_at_source' });
    assert.equal(manifest.artifacts.find((artifact) => artifact.artifactIds.includes(h.ids.rawLog))?.accessClass, 'restricted');
    assert.deepEqual(verifyBackup(join(dir, 'backup')), manifest);

    globalThis.fetch = () => { throw new Error('restore must not call the network'); };
    const report = restoreBackup(join(dir, 'backup'), join(dir, 'restored'));
    assert.equal(report.manifestHash, manifest.hash);
    assert.deepEqual({ from: report.fromSchemaVersion, to: report.toSchemaVersion }, { from: CURRENT_SCHEMA_VERSION, to: CURRENT_SCHEMA_VERSION });
    assert.deepEqual(report.audit, { completionDecisions: 1, budgetLimits: 1 });
    assert.equal(report.artifacts.tombstoned, 1);
    assert.equal(report.artifacts.missingAtSource, 1);
    assert.equal(report.artifacts.verified, manifest.artifacts.reduce((total, artifact) => total + artifact.artifactIds.length, 0));
    const replay = Object.fromEntries(report.works.map((work) => [work.workId, work.replay]));
    assert.deepEqual(replay, { 'W-EVAL': 'compatible', 'W-LOST': 'unreplayable', 'W-OLD': 'expired', 'W-OP': 'compatible' });
    assert.match(report.works.find((work) => work.workId === 'W-OLD')!.reasons.join(), /deleted_by_retention/);
    assert.match(report.works.find((work) => work.workId === 'W-LOST')!.reasons.join(), /file_missing/);

    const restored = new Store(join(dir, 'restored'));
    try {
      assert.equal(restored.getWork('W-EVAL')!.state, 'DONE');
      assert.equal(restored.getCompletionDecision('ER-1')!.verdict, 'pass');
      assert.equal(restored.readVerifiedArtifact(h.ids.rawLog).status, 'verified');
      assert.deepEqual(auditReplay(restored).problems, []);
    } finally {
      restored.close();
    }
  } finally {
    globalThis.fetch = realFetch;
    h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore runs the supported schema migration for an older backup', () => {
  const h = evaluationFixture();
  const dir = scratch();
  try {
    h.store.insertEvaluationContract(h.contract);
    h.store.insertEvaluationRun(h.run);
    h.store.insertCriterionVerdict({ id: 'CV-PASS', workId: h.work.id, evaluationRunId: h.run.id, verdict: h.candidate, createdAt: 't' });
    finalizeEvaluation(h.store, { id: 'CD-PASS', workId: h.work.id, evaluationRunId: h.run.id, expectedWorkState: 'VERIFYING', createdAt: 't' });
    h.store.db.exec('drop table gc_runs; drop table artifact_tombstones; pragma user_version = 6;');
    const manifest = createBackup(h.store, join(dir, 'backup'));
    assert.equal(manifest.db.schemaVersion, 6);

    const report = restoreBackup(join(dir, 'backup'), join(dir, 'restored'));
    assert.deepEqual({ from: report.fromSchemaVersion, to: report.toSchemaVersion }, { from: 6, to: CURRENT_SCHEMA_VERSION });
    assert.deepEqual(report.works, [{ workId: 'W-EVAL', replay: 'compatible', reasons: [] }]);
    const restored = new Store(join(dir, 'restored'));
    try {
      assert.ok(restored.db.prepare("select 1 from sqlite_master where name = 'artifact_tombstones'").get());
    } finally {
      restored.close();
    }
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incomplete, hash-invalid, tampered, too-new, or occupied-target backups are never restored', async () => {
  const h = await richHistory();
  const dir = scratch();
  try {
    const backup = join(dir, 'backup');
    const manifest = createBackup(h.store, backup);
    const target = join(dir, 'target');
    const refused = (pattern: RegExp) => {
      assert.throws(() => restoreBackup(backup, target), pattern);
      assert.ok(!existsSync(target) || readdirSync(target).length === 0, 'failed restore leaves nothing behind');
    };
    const manifestPath = join(backup, 'backup-manifest.json');
    const original = readFileSync(manifestPath, 'utf8');

    writeFileSync(manifestPath, JSON.stringify({ ...manifest, createdAt: 'forged' }));
    refused(/BACKUP_INVALID: manifest hash mismatch/);
    writeFileSync(manifestPath, JSON.stringify(rehash({ ...manifest, db: { ...manifest.db, schemaVersion: CURRENT_SCHEMA_VERSION + 1 } })));
    refused(/RESTORE_SCHEMA_UNSUPPORTED/);
    writeFileSync(manifestPath, JSON.stringify(rehash({ ...manifest, db: { ...manifest.db, file: '../../outside.db' } })));
    refused(/BACKUP_INVALID: unexpected database file/);
    const escaping = { ...manifest.artifacts[0]!, path: '../../escape.txt' };
    writeFileSync(manifestPath, JSON.stringify(rehash({ ...manifest, artifacts: [escaping, ...manifest.artifacts.slice(1)] })));
    refused(/BACKUP_INVALID: artifact name/);
    const forgedRoots = { ...manifest.roots, works: [...manifest.roots.works, { id: 'W-FORGED', state: 'DONE' }] };
    writeFileSync(manifestPath, JSON.stringify(rehash({ ...manifest, roots: forgedRoots })));
    refused(/RESTORE_ROOTS_MISMATCH: restored Works/);
    writeFileSync(manifestPath, JSON.stringify(rehash({ ...manifest, roots: { ...manifest.roots, rowCounts: { ...manifest.roots.rowCounts, events: 1 } } })));
    refused(/RESTORE_ROOTS_MISMATCH: events has/);
    writeFileSync(manifestPath, original);

    const dbFile = join(backup, 'harness.db');
    const dbBytes = readFileSync(dbFile);
    writeFileSync(dbFile, Buffer.concat([dbBytes, Buffer.from('x')]));
    refused(/BACKUP_INVALID: harness.db hash mismatch/);
    writeFileSync(dbFile, dbBytes);

    const payload = join(backup, 'artifacts', manifest.artifacts[0]!.path);
    const bytes = readFileSync(payload);
    writeFileSync(payload, 'corrupted');
    refused(/BACKUP_INVALID: .* hash mismatch/);
    writeFileSync(payload, bytes);

    mkdirSync(target);
    writeFileSync(join(target, 'occupied'), 'x');
    assert.throws(() => restoreBackup(backup, target), /RESTORE_TARGET_NOT_EMPTY/);
    assert.ok(existsSync(join(target, 'occupied')), 'an occupied target is never touched');
    rmSync(target, { recursive: true });

    unlinkSync(manifestPath);
    refused(/BACKUP_INVALID: manifest missing or unreadable \(incomplete backup\)/);
    assert.throws(() => createBackup(h.store, backup), /BACKUP_TARGET_NOT_EMPTY/);
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.partial-')), [], 'no partial backup left behind');
  } finally {
    h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit replay rejects completions and budgets that saved evidence does not support, and restore fails closed', async () => {
  const h = await richHistory();
  const dir = scratch();
  try {
    assert.deepEqual(auditReplay(h.store).problems, []);
    h.store.db.prepare("update criterion_verdicts set json = json_set(json, '$.verdict.verdict', 'fail')").run();
    h.store.db.prepare("update budget_ledger set json = json_set(json, '$.spentDeltaUnits', 999) where kind = 'SETTLE'").run();
    h.store.db.prepare("insert into evaluation_contracts values ('EC-OP', 'W-OP', 1, '1', ?, 't')")
      .run(JSON.stringify({ schemaVersion: '1', id: 'EC-OP', workId: 'W-OP', version: 1, policyVersion: '1', criteria: [], createdAt: 't' }));
    h.store.setWorkState('W-OP', 'DONE');
    const { problems } = auditReplay(h.store);
    assert.ok(problems.includes('COMPLETION_REPLAY_MISMATCH:CD-PASS'), problems.join());
    assert.ok(problems.includes('DONE_WITHOUT_PASSING_DECISION:W-OP'), problems.join());
    assert.ok(problems.some((problem) => problem.startsWith('BUDGET_INVARIANT:')), problems.join());

    createBackup(h.store, join(dir, 'backup'));
    assert.throws(() => restoreBackup(join(dir, 'backup'), join(dir, 'restored')), /RESTORE_AUDIT_FAILED/);
    assert.equal(existsSync(join(dir, 'restored')), false);
  } finally {
    h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('payloads written before v7 with 16-hex names back up, verify, and restore', () => {
  const dir = scratch();
  const store = new Store(join(dir, 'source'));
  try {
    const artifact = store.putArtifact('attempt_input', 'written by master');
    const legacyPath = join(store.artifactDir, `${artifact.hash.slice(0, 16)}.txt`);
    renameSync(artifact.path, legacyPath);
    store.db.prepare('update artifacts set path = ? where id = ?').run(legacyPath, artifact.id);
    const manifest = createBackup(store, join(dir, 'backup'));
    assert.deepEqual(manifest.artifacts.map((entry) => entry.path), [basename(legacyPath)]);
    assert.equal(verifyBackup(join(dir, 'backup')).hash, manifest.hash);
    const report = restoreBackup(join(dir, 'backup'), join(dir, 'restored'));
    assert.equal(report.artifacts.verified, 1);
    const restored = new Store(join(dir, 'restored'));
    try {
      assert.equal(restored.readArtifact(artifact.id), 'written by master');
    } finally {
      restored.close();
    }
    // A name that is not a prefix of the recorded hash is still refused.
    const manifestPath = join(dir, 'backup', 'backup-manifest.json');
    writeFileSync(manifestPath, JSON.stringify(rehash({ ...manifest, artifacts: [{ ...manifest.artifacts[0]!, path: `${'0'.repeat(16)}.txt` }] })));
    assert.throws(() => verifyBackup(join(dir, 'backup')), /BACKUP_INVALID: artifact name/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
