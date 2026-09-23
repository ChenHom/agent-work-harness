import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { acquireExecutionOwnership } from '../src/runtime/ownership.ts';
import { applyGc, insertTombstone, inspectRecoverability, previewGc, type GcManifest } from '../src/trace/retention.ts';
import { Store } from '../src/trace/store.ts';
import type { WorkState } from '../src/types.ts';

const NOW = Date.parse('2026-12-01T00:00:00.000Z');
const OLD = '2026-01-01T00:00:00.000Z';
const TEN_DAYS_AGO = '2026-11-21T00:00:00.000Z';
const FRESH = '2026-11-30T12:00:00.000Z';

function fixture() {
  const state = mkdtempSync(join(tmpdir(), 'harness-gc-'));
  const store = new Store(state);
  const work = (id: string, workState: WorkState) => store.insertWork({
    id, title: id, repositoryId: 'repo', workspace: state, state: workState,
    currentContractVersion: 1, retryBudget: 0, createdAt: OLD,
  });
  work('W-active', 'ACTIVE'); work('W-wait', 'WAITING_USER'); work('W-done', 'DONE');
  work('W-ten', 'DONE'); work('W-recent', 'FAILED'); work('W-pending', 'DONE');
  const put = (kind: string, text: string) => store.putArtifact(kind, text).id;
  const ids = {
    active: put('attempt_input', 'active input'), wait: put('attempt_input', 'waiting input'),
    doneLog: put('runtime_stdout', 'old stdout'), doneInput: put('attempt_input', 'old input'),
    doneReceipt: put('operation-receipt', 'old receipt'), doneAttempt: put('attempt_input', 'old attempt child'),
    tenLog: put('runtime_stdout', 'ten-day stdout'), tenInput: put('attempt_input', 'ten-day input'),
    recent: put('attempt_input', 'recent input'), pending: put('attempt_input', 'pending input'),
    sharedActive: put('attempt_input', 'shared bytes'), sharedDone: put('attempt_input', 'shared bytes'),
    orphanOld: put('prompt', 'orphan old'), orphanFresh: put('prompt', 'orphan fresh'),
  };
  const ref = (workId: string, artifactId: string) => store.event('usage.note', { kind: 'ref', text: artifactId }, workId);
  ref('W-active', ids.active); ref('W-active', ids.sharedActive); ref('W-wait', ids.wait);
  for (const id of [ids.doneLog, ids.doneInput, ids.doneReceipt, ids.sharedDone]) ref('W-done', id);
  ref('W-ten', ids.tenLog); ref('W-ten', ids.tenInput); ref('W-recent', ids.recent);
  // Child row without work_id: resolved to W-done through its resolved operation.
  store.db.prepare('insert into operations values (?,?,?,?,?,?,?)')
    .run('OP-done', 'W-done', 'intent-done', 'IDEM-done', 'SUCCEEDED', '{}', OLD);
  store.db.prepare('insert into operation_attempts values (?,?,?,?,?,?)')
    .run('OPA-done', 'OP-done', 1, 'SUCCEEDED', JSON.stringify({ inputSnapshot: ids.doneAttempt }), OLD);
  // DONE but its effect is still unknown and past the idempotency window.
  store.db.prepare('insert into operations values (?,?,?,?,?,?,?)').run('OP-pending', 'W-pending', 'intent-pending',
    'IDEM-pending', 'UNKNOWN', JSON.stringify({ dedupeExpiresAt: '2026-02-01T00:00:00.000Z', inputArtifactId: ids.pending }), OLD);

  store.db.prepare('update artifacts set created_at = ?').run(OLD);
  store.db.prepare('update artifacts set created_at = ? where id = ?').run(FRESH, ids.orphanFresh);
  store.db.prepare('update events set created_at = ?').run(OLD);
  store.db.prepare("update events set created_at = ? where work_id = 'W-ten'").run(TEN_DAYS_AGO);
  store.db.prepare("update events set created_at = ? where work_id = 'W-recent'").run(FRESH);
  const path = (id: string) => (store.db.prepare('select path from artifacts where id = ?').get(id) as { path: string }).path;
  return { state, store, ids, path, cleanup: () => { store.close(); rmSync(state, { recursive: true, force: true }); } };
}

const candidateIds = (manifest: GcManifest) => manifest.candidates.flatMap((candidate) => candidate.artifacts.map((artifact) => artifact.id)).sort();
const counts = (store: Store) => ({
  tombstones: (store.db.prepare('select count(*) as n from artifact_tombstones').get() as { n: number }).n,
  runs: (store.db.prepare('select count(*) as n from gc_runs').get() as { n: number }).n,
});

test('preview is a dry run with roots, reasons, and only unreachable expired payloads as candidates', () => {
  const { store, ids, path, cleanup } = fixture();
  try {
    const manifest = previewGc(store, NOW);
    assert.deepEqual(candidateIds(manifest), [ids.doneAttempt, ids.doneInput, ids.doneLog, ids.orphanOld, ids.tenLog].sort());
    assert.ok(Object.values(ids).every((id) => existsSync(path(id))));
    assert.deepEqual(counts(store), { tombstones: 0, runs: 0 });

    const { hash, ...body } = manifest;
    assert.equal(hash, createHash('sha256').update(JSON.stringify(body)).digest('hex'));
    assert.equal(manifest.policyVersion, '1');
    assert.equal(manifest.createdAt, new Date(NOW).toISOString());
    const roots = Object.fromEntries(manifest.roots.map((root) => [root.id, root.retention]));
    assert.deepEqual(roots, {
      global: 'global', 'W-active': 'active', 'W-done': 'archived', 'W-pending': 'resumable',
      'W-recent': 'archived', 'W-ten': 'archived', 'W-wait': 'resumable',
    });
    const retained = Object.fromEntries(manifest.references.map((ref) => [ref.artifactId, ref.retainedBy]));
    assert.deepEqual(retained[ids.sharedActive], ['work:W-active:active']);
    assert.deepEqual(retained[ids.doneReceipt], ['effect-evidence:operation-receipt']);
    assert.deepEqual(retained[ids.tenInput], ['work:W-ten:archived-within-window']);
    assert.deepEqual(retained[ids.pending], ['work:W-pending:resumable']);
    assert.deepEqual(retained[ids.orphanFresh], ['orphan-grace']);
    assert.equal(retained[ids.sharedDone], undefined, 'expired id kept alive only by its shared file');
    assert.deepEqual(manifest.unsafeRecovery, [{ workId: 'W-pending', recordId: 'OP-pending', reason: 'IDEMPOTENCY_WINDOW_EXPIRED' }]);
    const reasons = Object.fromEntries(manifest.candidates.flatMap((candidate) => candidate.artifacts).map((artifact) => [artifact.id, artifact.reason]));
    assert.equal(reasons[ids.tenLog], 'work:W-ten archived past raw-log window');
    assert.equal(reasons[ids.doneAttempt], 'work:W-done archived past artifact window');
    assert.equal(reasons[ids.orphanOld], 'unreferenced past orphan grace');
  } finally {
    cleanup();
  }
});

test('apply deletes exactly the manifest payloads and records tombstones and deletion evidence', () => {
  const { state, store, ids, path, cleanup } = fixture();
  const ownership = acquireExecutionOwnership(state);
  try {
    const manifest = previewGc(store, NOW);
    const result = applyGc(store, manifest, ownership, NOW);
    const collected = candidateIds(manifest);
    assert.deepEqual([...result.tombstonedArtifactIds].sort(), collected);
    for (const id of Object.values(ids)) {
      assert.equal(existsSync(path(id)), !collected.includes(id), id);
      const read = store.readVerifiedArtifact(id);
      assert.equal(read.status, collected.includes(id) ? 'missing' : 'verified', id);
      if (collected.includes(id)) assert.equal(read.status === 'missing' && read.reason, 'deleted_by_retention');
    }
    const run = store.db.prepare('select manifest_hash, policy_version, manifest_json, deleted_json from gc_runs where id = ?')
      .get(result.gcRunId) as { manifest_hash: string; policy_version: string; manifest_json: string; deleted_json: string };
    assert.equal(run.manifest_hash, manifest.hash);
    assert.deepEqual(JSON.parse(run.manifest_json), manifest);
    assert.deepEqual(JSON.parse(run.deleted_json), result.deletedPaths);
    const tombstone = store.db.prepare('select hash, kind, deletion_id, cause, authority, reason from artifact_tombstones where artifact_id = ?')
      .get(ids.tenLog) as Record<string, string>;
    assert.deepEqual({ ...tombstone }, {
      hash: basename(path(ids.tenLog)).split('.')[0], kind: 'runtime_stdout', deletion_id: result.gcRunId,
      cause: 'retention', authority: 'retention-policy:1', reason: 'work:W-ten archived past raw-log window',
    });
    assert.equal((store.db.prepare("select count(*) as n from events where type = 'retention.gc_applied' and work_id is null")
      .get() as { n: number }).n, 1);

    assert.equal(inspectRecoverability(store, 'W-done', NOW).status, 'unavailable');
    assert.match(inspectRecoverability(store, 'W-done', NOW).reasons.join(), /deleted_by_retention/);
    assert.deepEqual(inspectRecoverability(store, 'W-active', NOW), { workId: 'W-active', status: 'available', reasons: [] });
    assert.deepEqual(inspectRecoverability(store, 'W-pending', NOW), {
      workId: 'W-pending', status: 'unsafe', reasons: ['IDEMPOTENCY_WINDOW_EXPIRED:OP-pending'],
    });
    assert.deepEqual(candidateIds(previewGc(store, NOW)), [], 'a second preview finds nothing left to collect');
    assert.throws(() => applyGc(store, manifest, ownership, NOW), /GC_MANIFEST_ALREADY_APPLIED/);
  } finally {
    ownership.release();
    cleanup();
  }
});

test('stale, tampered, unowned, replayed, or changed manifests fail closed without deleting anything', () => {
  const { state, store, ids, path, cleanup } = fixture();
  const ownership = acquireExecutionOwnership(state);
  try {
    const untouched = () => {
      assert.deepEqual(counts(store), { tombstones: 0, runs: 0 });
      assert.ok(Object.values(ids).every((id) => existsSync(path(id))));
    };
    const manifest = previewGc(store, NOW);

    assert.throws(() => applyGc(store, { ...manifest, candidates: manifest.candidates.slice(1) }, ownership, NOW), /GC_MANIFEST_TAMPERED/);
    assert.throws(() => applyGc(store, manifest, { ...ownership, validate: () => false }, NOW), /GC_OWNERSHIP_REQUIRED/);
    untouched();

    // A new reference from live Work makes a candidate reachable again.
    store.event('usage.note', { kind: 'ref', text: ids.orphanOld }, 'W-active');
    assert.throws(() => applyGc(store, manifest, ownership, NOW), /GC_MANIFEST_STALE/);
    untouched();

    const second = previewGc(store, NOW);
    store.setWorkState('W-done', 'ACTIVE');
    assert.throws(() => applyGc(store, second, ownership, NOW), /GC_MANIFEST_STALE/);
    store.setWorkState('W-done', 'DONE');
    store.db.prepare("update events set created_at = ? where work_id = 'W-done'").run(OLD);
    untouched();

    const third = previewGc(store, NOW);
    writeFileSync(path(ids.tenLog), 'tampered bytes');
    assert.throws(() => applyGc(store, third, ownership, NOW), /GC_PAYLOAD_CHANGED/);
    assert.deepEqual(counts(store), { tombstones: 0, runs: 0 });
  } finally {
    ownership.release();
    cleanup();
  }
});

test('interrupted deletion remnants are collected, and rows pointing outside the artifact store never are', () => {
  const { state, store, ids, path, cleanup } = fixture();
  const ownership = acquireExecutionOwnership(state);
  try {
    // Tombstone committed but unlink never happened (crash between commit and rmSync).
    insertTombstone(store, ids.orphanOld, { deletedAt: OLD, deletionId: 'GC-crashed', cause: 'retention', authority: 'test', reason: 'test' });
    // A corrupt row whose path escapes the artifact directory must not map to a same-named store file.
    const inside = path(ids.doneLog);
    const outside = join(state, 'elsewhere', basename(inside));
    mkdirSync(dirname(outside));
    writeFileSync(outside, 'old stdout');
    store.db.prepare('update artifacts set path = ? where id = ?').run(outside, ids.doneLog);

    const manifest = previewGc(store, NOW);
    const remnant = manifest.candidates.find((candidate) => candidate.path === basename(path(ids.orphanOld)));
    assert.deepEqual(remnant?.artifacts, []);
    assert.ok(!manifest.candidates.some((candidate) => candidate.path === basename(inside)));

    applyGc(store, manifest, ownership, NOW);
    assert.equal(existsSync(path(ids.orphanOld)), false);
    assert.equal(existsSync(inside), true);
    assert.equal(existsSync(outside), true);
    assert.equal((store.db.prepare('select count(*) as n from artifact_tombstones where artifact_id = ?').get(ids.orphanOld) as { n: number }).n, 1);
  } finally {
    ownership.release();
    cleanup();
  }
});
