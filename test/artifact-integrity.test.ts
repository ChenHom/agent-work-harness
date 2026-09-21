import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Store } from '../src/trace/store.ts';

test('readVerifiedArtifact reports a missing artifact record', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-artifact-'));
  const store = new Store(state);
  try {
    assert.deepEqual(store.readVerifiedArtifact('AR_missing'), {
      status: 'missing', id: 'AR_missing', reason: 'record_missing',
    });
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('readVerifiedArtifact accepts an empty artifact', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-artifact-'));
  const store = new Store(state);
  try {
    const artifact = store.putArtifact('empty', Buffer.alloc(0));
    assert.deepEqual(store.readVerifiedArtifact(artifact.id), {
      status: 'verified', id: artifact.id, hash: artifact.hash, content: Buffer.alloc(0),
    });
    assert.equal(store.readArtifact(artifact.id), '');
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('readVerifiedArtifact reports a missing payload file', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-artifact-'));
  const store = new Store(state);
  try {
    const artifact = store.putArtifact('missing', 'payload');
    rmSync(artifact.path);
    assert.deepEqual(store.readVerifiedArtifact(artifact.id), {
      status: 'missing', id: artifact.id, reason: 'file_missing', code: 'ENOENT',
    });
    assert.equal(store.readArtifact(artifact.id), null);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('readVerifiedArtifact verifies a legacy short-hash payload path', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-artifact-'));
  const store = new Store(state);
  try {
    const content = Buffer.from('legacy payload');
    const hash = createHash('sha256').update(content).digest('hex');
    const path = join(store.artifactDir, `${hash.slice(0, 16)}.txt`);
    writeFileSync(path, content);
    store.db.prepare('insert into artifacts(id, kind, hash, path, bytes, created_at) values (?,?,?,?,?,?)')
      .run('AR_legacy', 'legacy', hash, path, content.length, new Date().toISOString());

    assert.deepEqual(store.readVerifiedArtifact('AR_legacy'), {
      status: 'verified', id: 'AR_legacy', hash, content,
    });
    assert.equal(store.readArtifact('AR_legacy'), 'legacy payload');
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('readVerifiedArtifact rejects a same-length hash mismatch', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-artifact-'));
  const store = new Store(state);
  try {
    const artifact = store.putArtifact('corrupt', 'payload');
    writeFileSync(artifact.path, 'PAYLOAD');

    assert.deepEqual(store.readVerifiedArtifact(artifact.id), {
      status: 'corrupt', id: artifact.id, reason: 'hash_mismatch',
    });
    assert.equal(store.readArtifact(artifact.id), null);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('readVerifiedArtifact rejects a byte-length mismatch', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-artifact-'));
  const store = new Store(state);
  try {
    const artifact = store.putArtifact('truncated', 'payload');
    writeFileSync(artifact.path, 'pay');

    assert.deepEqual(store.readVerifiedArtifact(artifact.id), {
      status: 'corrupt', id: artifact.id, reason: 'byte_length_mismatch',
    });
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('readVerifiedArtifact identifies payload I/O errors', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-artifact-'));
  const store = new Store(state);
  try {
    const artifact = store.putArtifact('unreadable', 'payload');
    rmSync(artifact.path);
    mkdirSync(artifact.path);

    const result = store.readVerifiedArtifact(artifact.id);
    assert.equal(result.status, 'corrupt');
    assert.equal(result.reason, 'io_error');
    assert.ok(result.code);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('readVerifiedArtifact rejects a payload path outside the artifact directory', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-artifact-'));
  const store = new Store(state);
  try {
    const content = Buffer.from('outside payload');
    const hash = createHash('sha256').update(content).digest('hex');
    const path = join(state, 'outside-artifact.txt');
    writeFileSync(path, content);
    store.db.prepare('insert into artifacts(id, kind, hash, path, bytes, created_at) values (?,?,?,?,?,?)')
      .run('AR_outside', 'outside', hash, path, content.length, new Date().toISOString());

    assert.deepEqual(store.readVerifiedArtifact('AR_outside'), {
      status: 'corrupt', id: 'AR_outside', reason: 'invalid_path',
    });
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('putArtifact deduplicates identical payloads at the full SHA-256 path', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-artifact-'));
  const store = new Store(state);
  try {
    const first = store.putArtifact('first', 'same payload');
    const second = store.putArtifact('second', 'same payload');

    assert.notEqual(first.id, second.id);
    assert.equal(first.hash, second.hash);
    assert.equal(first.path, second.path);
    assert.equal(basename(first.path), `${first.hash}.txt`);
    assert.deepEqual(readdirSync(store.artifactDir), [`${first.hash}.txt`]);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('putArtifact keeps identical payloads with different extensions separate', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-artifact-'));
  const store = new Store(state);
  try {
    const text = store.putArtifact('text', 'same payload', 'txt');
    const json = store.putArtifact('json', 'same payload', 'json');

    assert.equal(text.hash, json.hash);
    assert.notEqual(text.path, json.path);
    assert.deepEqual(readdirSync(store.artifactDir).sort(), [`${text.hash}.json`, `${text.hash}.txt`]);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('putArtifact replaces an existing corrupt payload before recording its reference', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-artifact-'));
  const store = new Store(state);
  try {
    const content = Buffer.from('trusted payload');
    const hash = createHash('sha256').update(content).digest('hex');
    const path = join(store.artifactDir, `${hash}.txt`);
    writeFileSync(path, Buffer.alloc(content.length, 0x78));

    const artifact = store.putArtifact('replacement', content);

    assert.equal(artifact.path, path);
    assert.deepEqual(readFileSync(path), content);
    assert.equal(store.readVerifiedArtifact(artifact.id).status, 'verified');
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('putArtifact verifies the final path before recording its reference', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-artifact-'));
  const store = new Store(state);
  const rename = fs.renameSync;
  fs.renameSync = (oldPath, newPath) => {
    rename(oldPath, newPath);
    writeFileSync(newPath, 'TRUSTED PAYLOAD');
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.putArtifact('corrupted-after-rename', 'trusted payload'), /verification failed/);
    assert.equal((store.db.prepare('select count(*) as count from artifacts').get() as { count: number }).count, 0);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('putArtifact replaces a matching symlink before recording its reference', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-artifact-'));
  const store = new Store(state);
  try {
    const content = Buffer.from('trusted payload');
    const hash = createHash('sha256').update(content).digest('hex');
    const path = join(store.artifactDir, `${hash}.txt`);
    const target = join(state, 'outside-artifact.txt');
    writeFileSync(target, content);
    symlinkSync(target, path);

    const artifact = store.putArtifact('replacement', content);

    assert.equal(lstatSync(path).isSymbolicLink(), false);
    writeFileSync(target, 'changed outside payload');
    assert.equal(store.readVerifiedArtifact(artifact.id).status, 'verified');
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('read-only putArtifact does not publish an orphan payload', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-artifact-'));
  const initialized = new Store(state);
  initialized.close();
  const store = new Store(state, { readOnly: true });
  try {
    assert.throws(() => store.putArtifact('blocked', 'payload'), /read-only/i);
    assert.deepEqual(readdirSync(store.artifactDir), []);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('putArtifact leaves a complete orphan and no temporary file when DB insert fails', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-artifact-'));
  const store = new Store(state);
  try {
    store.db.exec(`
      create trigger reject_artifact_insert before insert on artifacts
      begin select raise(abort, 'injected DB insert failure'); end;
    `);
    const content = Buffer.from('published before DB reference');
    const hash = createHash('sha256').update(content).digest('hex');
    const path = join(store.artifactDir, `${hash}.txt`);

    assert.throws(() => store.putArtifact('orphan', content), /injected DB insert failure/);
    assert.deepEqual(readFileSync(path), content);
    assert.deepEqual(readdirSync(store.artifactDir), [`${hash}.txt`]);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});
