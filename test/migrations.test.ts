import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CURRENT_SCHEMA_VERSION } from '../src/trace/migrations.ts';
import { Store, StoreOpenError } from '../src/trace/store.ts';

test('fresh state is migrated to the current schema', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-migration-'));
  const store = new Store(state);
  try {
    assert.equal((store.db.prepare('pragma user_version').get() as { user_version: number }).user_version,
      CURRENT_SCHEMA_VERSION);
    const table = store.db.prepare(`
      select name from sqlite_master where type = 'table' and name = 'recovery_sessions'
    `).get();
    assert.ok(table);
    const indexes = store.db.prepare(`
      select name from sqlite_master where type = 'index' and tbl_name = 'recovery_sessions' order by name
    `).all() as Array<{ name: string }>;
    assert.ok(indexes.some((row) => row.name === 'idx_recovery_sessions_work'));
    assert.ok(indexes.some((row) => row.name === 'idx_recovery_sessions_attempt'));
    assert.ok(store.db.prepare(`
      select name from sqlite_master where type = 'index' and name = 'idx_outcomes_attempt'
    `).get());
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('v0 migration preserves existing rows and adds finalization evidence storage', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-migration-'));
  const path = join(state, 'harness.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    create table works(
      id text primary key, title text not null, repository_id text not null,
      workspace text not null, state text not null, current_contract_version integer not null,
      retry_budget integer not null, created_at text not null);
    create table outcomes(
      id text primary key, work_id text not null, attempt_id text not null,
      outcome text not null, reasons text not null, created_at text not null);
    insert into works values ('W', 'legacy', 'repo', '/repo', 'ACTIVE', 1, 1, '2026-09-20');
    insert into outcomes values ('O', 'W', 'A', 'FAILED', '["legacy"]', '2026-09-20');
  `);
  legacy.close();

  const store = new Store(state);
  try {
    assert.equal(store.getWork('W')?.title, 'legacy');
    assert.deepEqual(store.lastOutcome('W'), {
      outcome: 'FAILED', reasons: ['legacy'], attemptId: 'A', evidenceIds: [],
    });
    assert.equal((store.db.prepare('pragma user_version').get() as { user_version: number }).user_version,
      CURRENT_SCHEMA_VERSION);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('writable open rejects a newer schema without downgrading it', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-migration-'));
  const path = join(state, 'harness.db');
  const future = new DatabaseSync(path);
  future.exec(`pragma user_version = 999`);
  future.close();

  assert.throws(() => new Store(state), /SCHEMA_TOO_NEW/);
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal((check.prepare('pragma user_version').get() as { user_version: number }).user_version, 999);
  } finally {
    check.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('read-only open reports missing state without creating directories', () => {
  const parent = mkdtempSync(join(tmpdir(), 'harness-read-only-'));
  const state = join(parent, 'missing-state');
  assert.throws(() => new Store(state, { readOnly: true }), (error) => {
    assert.ok(error instanceof StoreOpenError);
    assert.equal(error.code, 'NO_STATE');
    return true;
  });
  assert.equal(existsSync(state), false);
  rmSync(parent, { recursive: true, force: true });
});

test('read-only open does not migrate a v0 database', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-read-only-'));
  const path = join(state, 'harness.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    create table works(
      id text primary key, title text not null, repository_id text not null,
      workspace text not null, state text not null, current_contract_version integer not null,
      retry_budget integer not null, created_at text not null);
    insert into works values ('W', 'legacy', 'repo', '/repo', 'ACTIVE', 1, 1, '2026-09-20');
  `);
  legacy.close();

  const store = new Store(state, { readOnly: true });
  try {
    assert.equal(store.getWork('W')?.title, 'legacy');
    assert.equal((store.db.prepare('pragma user_version').get() as { user_version: number }).user_version, 0);
    assert.equal(store.db.prepare(`
      select name from sqlite_master where type = 'table' and name = 'recovery_sessions'
    `).get(), undefined);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});
