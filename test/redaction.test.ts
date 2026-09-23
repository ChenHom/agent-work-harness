import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { acquireExecutionOwnership } from '../src/runtime/ownership.ts';
import { traceWork } from '../src/trace/links.ts';
import { accessClassOf, redactArtifact } from '../src/trace/redaction.ts';
import { inspectRecoverability } from '../src/trace/retention.ts';
import { richHistory } from './helpers/history.ts';

test('raw logs are restricted; ledgers, inputs, and receipts are internal', () => {
  for (const kind of ['prompt', 'runtime_stdout', 'runtime_stderr', 'runtime_raw_result', 'durable-model-output']) {
    assert.equal(accessClassOf(kind), 'restricted', kind);
  }
  for (const kind of ['attempt_input', 'operation-receipt', 'result']) assert.equal(accessClassOf(kind), 'internal', kind);
});

test('redaction deletes every copy of the bytes but keeps hash, kind, times, authority, and causal links', async () => {
  const h = await richHistory();
  const ownership = acquireExecutionOwnership(h.state);
  try {
    const secret = 'token=sk-live-SECRET';
    const logged = h.store.putArtifact('runtime_stdout', secret, 'log');
    const copy = h.store.putArtifact('runtime_stdout', secret, 'log');
    h.store.event('usage.note', { kind: 'ref', text: logged.id }, 'W-OP');
    const before = h.store.db.prepare('select id, kind, hash, bytes, created_at from artifacts where id = ?').get(logged.id);

    const result = redactArtifact(h.store, logged.id, { authority: 'user:security-review', reason: 'leaked credential' }, ownership);
    assert.deepEqual(result.tombstonedArtifactIds, [logged.id, copy.id].sort());
    assert.equal(existsSync(logged.path), false);
    for (const id of [logged.id, copy.id]) {
      const read = h.store.readVerifiedArtifact(id);
      assert.equal(read.status === 'missing' && read.reason, 'deleted_by_redaction');
    }
    assert.deepEqual(h.store.db.prepare('select id, kind, hash, bytes, created_at from artifacts where id = ?').get(logged.id), before);
    const tombstone = h.store.db.prepare(`select hash, kind, cause, authority, reason, replay_limitation, deletion_id
      from artifact_tombstones where artifact_id = ?`).get(logged.id) as Record<string, string>;
    assert.deepEqual({ ...tombstone, replay_limitation: undefined }, {
      hash: logged.hash, kind: 'runtime_stdout', cause: 'redaction', authority: 'user:security-review',
      reason: 'leaked credential', replay_limitation: undefined, deletion_id: result.redactionId,
    });
    assert.match(tombstone.replay_limitation!, /replay and re-validation of this artifact are no longer possible/);

    const leaked = h.store.db.prepare(`select count(*) as n from events where data like ?`).get(`%${secret}%`) as { n: number };
    assert.equal(leaked.n, 0, 'the redaction event never carries the content');
    const event = h.store.db.prepare("select data from events where type = 'artifact.redacted'").get() as { data: string };
    assert.deepEqual(JSON.parse(event.data), {
      redactionId: result.redactionId, artifactIds: result.tombstonedArtifactIds, hash: logged.hash, kind: 'runtime_stdout',
      accessClass: 'restricted', authority: 'user:security-review', reason: 'leaked credential',
    });
    const span = traceWork(h.store, 'W-OP').spans.find((candidate) => candidate.spanId === logged.id);
    assert.equal(span?.accessClass, 'restricted', 'the causal span of a redacted payload survives');
    assert.equal(inspectRecoverability(h.store, 'W-OP').status, 'unavailable');
  } finally {
    ownership.release();
    h.cleanup();
  }
});

test('redaction requires ownership and authority, and refuses unknown, repeated, or escaping targets', async () => {
  const h = await richHistory();
  const ownership = acquireExecutionOwnership(h.state);
  try {
    const decision = { authority: 'user:ops', reason: 'privacy request' };
    assert.throws(() => redactArtifact(h.store, h.ids.rawLog, decision, { ...ownership, validate: () => false }), /REDACTION_OWNERSHIP_REQUIRED/);
    assert.throws(() => redactArtifact(h.store, h.ids.rawLog, { authority: ' ', reason: 'x' }, ownership), /REDACTION_AUTHORITY_REQUIRED/);
    assert.throws(() => redactArtifact(h.store, 'AR-missing', decision, ownership), /REDACTION_ARTIFACT_NOT_FOUND/);
    assert.throws(() => redactArtifact(h.store, h.ids.oldPayload, decision, ownership), /REDACTION_ALREADY_DELETED/);

    const path = (h.store.db.prepare('select path from artifacts where id = ?').get(h.ids.rawLog) as { path: string }).path;
    const outside = join(h.state, 'elsewhere', basename(path));
    mkdirSync(join(h.state, 'elsewhere'));
    writeFileSync(outside, 'W-OP stdout');
    h.store.db.prepare('update artifacts set path = ? where id = ?').run(outside, h.ids.rawLog);
    assert.throws(() => redactArtifact(h.store, h.ids.rawLog, decision, ownership), /REDACTION_INVALID_PATH/);
    assert.ok(existsSync(outside) && existsSync(path));
    assert.equal((h.store.db.prepare('select count(*) as n from artifact_tombstones where cause = ?').get('redaction') as { n: number }).n, 0);
  } finally {
    ownership.release();
    h.cleanup();
  }
});
