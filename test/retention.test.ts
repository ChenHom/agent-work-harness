import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewGc, RETENTION_POLICY } from '../src/trace/retention.ts';
import { Store } from '../src/trace/store.ts';

const NOW = Date.parse('2026-12-01T00:00:00.000Z');
const OLD = '2026-01-01T00:00:00.000Z';

test('retention policy v1 names a window for every record class and never collects authoritative ledgers', () => {
  assert.equal(RETENTION_POLICY.version, '1');
  const { windowsMs } = RETENTION_POLICY;
  for (const neverCollected of ['dbRecords', 'receipts', 'idempotencyKeys', 'tombstones'] as const) {
    assert.equal(windowsMs[neverCollected], null, neverCollected);
  }
  assert.ok(windowsMs.orphanGrace > 0 && windowsMs.rawLogs > windowsMs.orphanGrace && windowsMs.artifacts > windowsMs.rawLogs);
  assert.deepEqual(Object.keys(RETENTION_POLICY.classes), ['active', 'resumable', 'archived']);
});

test('unknown states, unparseable times, unresolved reservations/runs, and global records keep payloads', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-retention-'));
  const store = new Store(state);
  try {
    const rows = [
      ['W-paused', 'PAUSED', OLD], ['W-blocked', 'BLOCKED', OLD], ['W-badtime', 'DONE', 'not-a-time'],
      ['W-held', 'DONE', OLD], ['W-running', 'FAILED', OLD], ['W-archived', 'DONE', OLD],
    ] as const;
    const ids: Record<string, string> = {};
    for (const [id, workState, createdAt] of rows) {
      store.db.prepare('insert into works values (?,?,?,?,?,?,?,?)').run(id, id, 'repo', state, workState, 1, 0, createdAt);
      ids[id] = store.putArtifact('attempt_input', `payload ${id}`).id;
      store.db.prepare('insert into events(type, work_id, data, created_at) values (?,?,?,?)')
        .run('usage.note', id, JSON.stringify({ text: ids[id] }), id === 'W-badtime' ? 'garbage' : OLD);
    }
    store.db.prepare('insert into budget_reservations values (?,?,?,?,?,?,?,?,?)')
      .run('RES-held', 'W-held', 'LIM-1', null, null, null, 'HELD', '{}', OLD);
    store.db.prepare('insert into evaluation_runs values (?,?,?,?,?,?,?,?)')
      .run('EVR-running', 'W-running', 'EC-1', null, 'critic@1', 'RUNNING', '{}', OLD);
    ids.global = store.putArtifact('attempt_input', 'global payload').id;
    store.db.prepare('insert into events(type, work_id, data, created_at) values (?,?,?,?)')
      .run('usage.note', null, JSON.stringify({ text: ids.global }), OLD);
    store.db.prepare('update artifacts set created_at = ?').run(OLD);

    const manifest = previewGc(store, NOW);
    const roots = Object.fromEntries(manifest.roots.map((root) => [root.id, `${root.retention}: ${root.reason}`]));
    assert.equal(roots['W-paused'], 'resumable: state PAUSED');
    assert.equal(roots['W-blocked'], 'resumable: state BLOCKED');
    assert.equal(roots['W-held'], 'resumable: state DONE with unresolved RES-held');
    assert.equal(roots['W-running'], 'resumable: state FAILED with unresolved EVR-running');
    const retained = Object.fromEntries(manifest.references.map((ref) => [ref.artifactId, ref.retainedBy]));
    assert.deepEqual(retained[ids['W-badtime']!], ['work:W-badtime:archived-within-window']);
    assert.deepEqual(retained[ids.global], ['global-record']);
    assert.deepEqual(manifest.candidates.flatMap((candidate) => candidate.artifacts.map((artifact) => artifact.id)), [ids['W-archived']]);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});
