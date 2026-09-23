import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
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
    const columns = store.db.prepare('pragma table_info(recovery_sessions)').all() as Array<{ name: string }>;
    assert.deepEqual(columns.map((column) => column.name), [
      'id', 'work_id', 'attempt_id', 'observed_at', 'evidence_ids', 'reason', 'status',
    ]);
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

test('v0 migration preserves authoritative row identity, content, and event order', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-migration-'));
  const path = join(state, 'harness.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    create table works(id text primary key,title text not null,repository_id text not null,
      workspace text not null,state text not null,current_contract_version integer not null,
      retry_budget integer not null,created_at text not null);
    create table contracts(id text primary key,work_id text not null,version integer not null,
      json text not null,created_at text not null,unique(work_id,version));
    create table attempts(id text primary key,work_id text not null,number integer not null,
      json text not null,status text not null,started_at text not null);
    create table decisions(id text primary key,work_id text not null,source_message_id text not null,
      kind text not null,value text not null,created_at text not null);
    create table evidence(id text primary key,work_id text not null,attempt_id text not null,
      type text not null,label text not null,status text not null,data text not null,observed_at text not null);
    create table outcomes(id text primary key,work_id text not null,attempt_id text not null,
      outcome text not null,reasons text not null,created_at text not null);
    create table messages(id text primary key,work_id text,role text not null,text text not null,created_at text not null);
    create table events(seq integer primary key autoincrement,type text not null,work_id text,
      attempt_id text,data text not null,created_at text not null);
    create table artifacts(id text primary key,kind text not null,hash text not null,
      path text not null,bytes integer not null,created_at text not null);
    insert into works values ('W-fixed','title','repo','/repo','RUNNING',1,2,'t0');
    insert into contracts values ('C-fixed','W-fixed',1,'{"request":"keep exactly"}','t1');
    insert into attempts values ('A-fixed','W-fixed',1,'{"id":"A-fixed","marker":"keep exactly"}','RUNNING','t2');
    insert into decisions values ('D-fixed','W-fixed','M-fixed','deny_path','secret/**','t3');
    insert into evidence values ('E-fixed','W-fixed','A-fixed','readback','fixed','PASS','{"n":1}','t4');
    insert into outcomes values ('O-fixed','W-fixed','A-fixed','FAILED','["fixed"]','t5');
    insert into messages values ('M-fixed','W-fixed','user','original text','t6');
    insert into artifacts values ('AR-fixed','prompt','abc','/tmp/fixed',3,'t7');
    insert into events(seq,type,work_id,attempt_id,data,created_at) values
      (7,'first','W-fixed','A-fixed','{"order":1}','t8'),
      (11,'second','W-fixed','A-fixed','{"order":2}','t9');
  `);
  const expected: Record<string, unknown[]> = {};
  for (const table of ['works', 'contracts', 'attempts', 'decisions', 'evidence', 'outcomes', 'messages', 'artifacts']) {
    expected[table] = legacy.prepare(`select * from ${table}`).all().map((row) => ({ ...row }));
  }
  expected.events = legacy.prepare('select * from events order by seq').all().map((row) => ({ ...row }));
  legacy.close();

  const store = new Store(state);
  try {
    for (const table of ['works', 'contracts', 'attempts', 'decisions', 'evidence', 'messages', 'artifacts']) {
      assert.deepEqual(store.db.prepare(`select * from ${table}`).all().map((row) => ({ ...row })), expected[table]);
    }
    const migratedOutcome = { ...store.db.prepare('select * from outcomes').get() } as Record<string, unknown>;
    assert.deepEqual(migratedOutcome, { ...(expected.outcomes![0] as object), evidence_ids: '[]', finalization_key: null });
    assert.deepEqual(store.db.prepare('select * from events order by seq').all().map((row) => ({ ...row })), expected.events);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('failed migration rolls back to complete v1 and succeeds after the bad row is repaired', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-migration-'));
  const path = join(state, 'harness.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    create table recovery_sessions(
      id text primary key, work_id text not null, attempt_id text not null,
      status text not null, created_at text, resolved_at text);
    insert into recovery_sessions values ('R-bad','W','A','OPEN',null,null);
    pragma user_version = 1;
  `);
  legacy.close();

  assert.throws(() => new Store(state), /constraint|NOT NULL/i);
  const afterFailure = new DatabaseSync(path);
  try {
    assert.equal((afterFailure.prepare('pragma user_version').get() as { user_version: number }).user_version, 1);
    assert.deepEqual((afterFailure.prepare('pragma table_info(recovery_sessions)').all() as Array<{ name: string }>)
      .map((column) => column.name), ['id', 'work_id', 'attempt_id', 'status', 'created_at', 'resolved_at']);
    assert.equal((afterFailure.prepare('select count(*) as n from recovery_sessions').get() as { n: number }).n, 1);
    assert.equal(afterFailure.prepare("select name from sqlite_master where type='table' and name='works'").get(), undefined);
    afterFailure.prepare("update recovery_sessions set created_at = 't0' where id = 'R-bad'").run();
  } finally {
    afterFailure.close();
  }

  const recovered = new Store(state);
  try {
    assert.equal((recovered.db.prepare('pragma user_version').get() as { user_version: number }).user_version,
      CURRENT_SCHEMA_VERSION);
    assert.equal(recovered.listRecoverySessions('W')[0]!.id, 'R-bad');
  } finally {
    recovered.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('v1 migration preserves recovery rows while replacing the provisional columns', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-migration-'));
  const path = join(state, 'harness.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    create table recovery_sessions(
      id text primary key, work_id text not null, attempt_id text not null,
      status text not null, created_at text not null, resolved_at text);
    insert into recovery_sessions values ('R', 'W', 'A', 'OPEN', '2026-09-20', null);
    pragma user_version = 1;
  `);
  legacy.close();

  const store = new Store(state);
  try {
    assert.deepEqual({ ...store.db.prepare('select * from recovery_sessions').get() }, {
      id: 'R', work_id: 'W', attempt_id: 'A', observed_at: '2026-09-20',
      evidence_ids: '[]', reason: 'migrated legacy recovery session', status: 'OPEN',
    });
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('v2 migration preserves authoritative rows and adds P2 plan tables', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-migration-'));
  const seeded = new Store(state);
  seeded.db.exec(`
    insert into works values ('W-v2','v2 row','repo','/repo','ACTIVE',1,2,'t0');
    insert into events(type,work_id,attempt_id,data,created_at) values ('v2.event','W-v2',null,'{"keep":true}','t1');
    drop table if exists checkpoints;
    drop table if exists milestones;
    drop table if exists plans;
    pragma user_version = 2;
  `);
  seeded.close();

  const migrated = new Store(state);
  try {
    assert.equal(CURRENT_SCHEMA_VERSION, 7);
    assert.equal(migrated.getWork('W-v2')!.title, 'v2 row');
    assert.equal(migrated.events('W-v2')[0]!.type, 'v2.event');
    for (const table of ['plans', 'milestones', 'checkpoints']) {
      assert.ok(migrated.db.prepare(`select name from sqlite_master where type='table' and name=?`).get(table));
    }
  } finally {
    migrated.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('v3 migration preserves authoritative rows and adds P3 operation and budget tables', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-migration-'));
  const seeded = new Store(state);
  seeded.db.exec(`
    insert into works values ('W-v3','v3 row','repo','/repo','ACTIVE',1,2,'t0');
    insert into events(type,work_id,attempt_id,data,created_at) values ('v3.event','W-v3',null,'{"keep":true}','t1');
    drop table if exists budget_ledger;
    drop table if exists budget_reservations;
    drop table if exists budget_limits;
    drop table if exists compensation_attempts;
    drop table if exists compensations;
    drop table if exists operation_attempts;
    drop table if exists operations;
    pragma user_version = 3;
  `);
  seeded.close();

  const migrated = new Store(state);
  try {
    assert.equal(CURRENT_SCHEMA_VERSION, 7);
    assert.equal(migrated.getWork('W-v3')!.title, 'v3 row');
    assert.equal(migrated.events('W-v3')[0]!.type, 'v3.event');
    for (const table of [
      'operations', 'operation_attempts', 'compensations', 'compensation_attempts',
      'budget_limits', 'budget_reservations', 'budget_ledger',
    ]) {
      assert.ok(migrated.db.prepare(`select name from sqlite_master where type='table' and name=?`).get(table));
    }
  } finally {
    migrated.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('v4 migration preserves authoritative rows and adds P5 evaluation ledger tables', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-migration-'));
  const seeded = new Store(state);
  seeded.db.exec(`
    insert into works values ('W-v4','v4 row','repo','/repo','ACTIVE',1,2,'t0');
    insert into events(type,work_id,attempt_id,data,created_at) values ('v4.event','W-v4',null,'{"keep":true}','t1');
    drop table if exists completion_decisions;
    drop table if exists criterion_verdicts;
    drop table if exists evaluation_runs;
    drop table if exists evaluation_contracts;
    pragma user_version = 4;
  `);
  seeded.close();

  const migrated = new Store(state);
  try {
    assert.equal(CURRENT_SCHEMA_VERSION, 7);
    assert.equal(migrated.getWork('W-v4')!.title, 'v4 row');
    assert.equal(migrated.events('W-v4')[0]!.type, 'v4.event');
    for (const table of [
      'evaluation_contracts', 'evaluation_runs', 'criterion_verdicts', 'completion_decisions',
    ]) {
      assert.ok(migrated.db.prepare(`select name from sqlite_master where type='table' and name=?`).get(table));
    }
  } finally {
    migrated.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('v5 migration adds durable critic dispatch ownership without losing budgets', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-migration-'));
  const seeded = new Store(state);
  seeded.db.exec(`
    insert into works values ('W-v5','v5 row','repo','/repo','ACTIVE',1,2,'t0');
    drop table critic_dispatches;
    alter table budget_reservations drop column evaluation_run_id;
    pragma user_version = 5;
  `);
  seeded.close();

  const migrated = new Store(state);
  try {
    assert.equal(CURRENT_SCHEMA_VERSION, 7);
    assert.equal(migrated.getWork('W-v5')!.title, 'v5 row');
    assert.ok(migrated.db.prepare("select name from sqlite_master where type='table' and name='critic_dispatches'").get());
    const columns = migrated.db.prepare('pragma table_info(budget_reservations)').all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'evaluation_run_id'));
  } finally {
    migrated.close();
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

test('malformed v0 schema is rejected without advancing user_version', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-migration-'));
  const path = join(state, 'harness.db');
  const malformed = new DatabaseSync(path);
  malformed.exec('create table works(id text primary key)');
  malformed.close();

  assert.throws(() => new Store(state), /SCHEMA_INVALID/);
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal((check.prepare('pragma user_version').get() as { user_version: number }).user_version, 0);
    assert.deepEqual((check.prepare('pragma table_info(works)').all() as Array<{ name: string }>)
      .map((column) => column.name), ['id']);
  } finally {
    check.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('database marked current is still rejected when required schema is absent', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-migration-'));
  const path = join(state, 'harness.db');
  const malformed = new DatabaseSync(path);
  malformed.exec(`pragma user_version = ${CURRENT_SCHEMA_VERSION}`);
  malformed.close();

  assert.throws(() => new Store(state), /SCHEMA_INVALID/);
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal((check.prepare('pragma user_version').get() as { user_version: number }).user_version,
      CURRENT_SCHEMA_VERSION);
  } finally {
    check.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('current schema rejects contracts without unique(work_id, version)', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-migration-'));
  const initialized = new Store(state);
  initialized.close();
  const path = join(state, 'harness.db');
  const malformed = new DatabaseSync(path);
  malformed.exec(`
    alter table contracts rename to contracts_old;
    create table contracts(
      id text primary key, work_id text not null, version integer not null,
      json text not null, created_at text not null);
    insert into contracts select * from contracts_old;
    drop table contracts_old;
  `);
  malformed.close();

  assert.throws(() => new Store(state), /SCHEMA_INVALID.*contracts.*unique/i);
  rmSync(state, { recursive: true, force: true });
});

test('current schema rejects events without integer primary-key identity', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-migration-'));
  const initialized = new Store(state);
  initialized.close();
  const path = join(state, 'harness.db');
  const malformed = new DatabaseSync(path);
  malformed.exec(`
    alter table events rename to events_old;
    create table events(
      seq text, type text not null, work_id text,
      attempt_id text, data text not null, created_at text not null);
    insert into events select * from events_old;
    drop table events_old;
    create index idx_events_work on events(work_id);
  `);
  malformed.close();

  assert.throws(() => new Store(state), /SCHEMA_INVALID.*events\.seq/i);
  rmSync(state, { recursive: true, force: true });
});

test('read-only open validates a current-version database', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-read-only-'));
  const path = join(state, 'harness.db');
  const malformed = new DatabaseSync(path);
  malformed.exec(`pragma user_version = ${CURRENT_SCHEMA_VERSION}`);
  malformed.close();

  assert.throws(() => new Store(state, { readOnly: true }), /SCHEMA_INVALID/);
  rmSync(state, { recursive: true, force: true });
});

test('read-only open rejects a newer schema without changing its version', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-read-only-'));
  const path = join(state, 'harness.db');
  const future = new DatabaseSync(path);
  future.exec('pragma user_version = 999');
  future.close();

  assert.throws(() => new Store(state, { readOnly: true }), /SCHEMA_TOO_NEW/);
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal((check.prepare('pragma user_version').get() as { user_version: number }).user_version, 999);
  } finally {
    check.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('read-only open of a checkpointed WAL database creates no sidecars', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-read-only-'));
  const writable = new Store(state);
  writable.close();
  const before = readdirSync(state).sort();

  const reader = new Store(state, { readOnly: true });
  reader.close();

  assert.deepEqual(readdirSync(state).sort(), before);
  rmSync(state, { recursive: true, force: true });
});

test('read-only open sees active uncheckpointed WAL data without changing sidecars', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-read-only-'));
  const writer = new Store(state);
  writer.db.exec('pragma wal_autocheckpoint = 0');
  writer.db.exec(`insert into works values ('W', 'latest', 'repo', '/repo', 'ACTIVE', 1, 1, 'now')`);
  const before = readdirSync(state).sort();

  const reader = new Store(state, { readOnly: true });
  try {
    assert.equal(reader.getWork('W')?.title, 'latest');
    assert.deepEqual(readdirSync(state).sort(), before);
  } finally {
    reader.close();
    writer.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('read-only open fails closed for a partial WAL sidecar set without creating files', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-read-only-'));
  const writer = new Store(state);
  writer.db.exec('pragma wal_autocheckpoint = 0');
  writer.db.exec(`insert into works values ('W', 'latest', 'repo', '/repo', 'ACTIVE', 1, 1, 'now')`);
  writer.close();
  const path = join(state, 'harness.db');
  const probe = new DatabaseSync(path);
  probe.exec('pragma journal_mode = WAL; pragma wal_autocheckpoint = 0');
  probe.exec(`insert into works values ('W2', 'uncheckpointed', 'repo', '/repo', 'ACTIVE', 1, 1, 'now')`);
  unlinkSync(`${path}-shm`);
  const before = readdirSync(state).sort();

  assert.throws(() => new Store(state, { readOnly: true }), (error) => {
    assert.ok(error instanceof StoreOpenError);
    assert.equal(error.code, 'READ_ONLY_UNAVAILABLE');
    return true;
  });
  assert.deepEqual(readdirSync(state).sort(), before);
  probe.close();
  rmSync(state, { recursive: true, force: true });
});

test('v6 migration adds retention tombstones and GC evidence without touching existing rows', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-migration-'));
  const seeded = new Store(state);
  seeded.db.exec(`
    insert into works values ('W-v6','v6 row','repo','/repo','DONE',1,2,'t0');
    drop table gc_runs;
    drop table artifact_tombstones;
    pragma user_version = 6;
  `);
  seeded.close();

  const migrated = new Store(state);
  try {
    assert.equal(CURRENT_SCHEMA_VERSION, 7);
    assert.equal(migrated.getWork('W-v6')!.title, 'v6 row');
    for (const table of ['gc_runs', 'artifact_tombstones']) {
      assert.ok(migrated.db.prepare("select name from sqlite_master where type='table' and name=?").get(table), table);
    }
    assert.throws(() => migrated.db.exec(`
      insert into gc_runs values ('GC-1','same','1','{}','[]','t1');
      insert into gc_runs values ('GC-2','same','1','{}','[]','t2');`), /UNIQUE/);
  } finally {
    migrated.close();
    rmSync(state, { recursive: true, force: true });
  }
});
