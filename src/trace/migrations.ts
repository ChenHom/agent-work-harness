import type { DatabaseSync } from 'node:sqlite';

export const CURRENT_SCHEMA_VERSION = 2;

const SCHEMA = `
create table if not exists works(
  id text primary key, title text not null, repository_id text not null,
  workspace text not null, state text not null, current_contract_version integer not null,
  retry_budget integer not null, created_at text not null);
create table if not exists contracts(
  id text primary key, work_id text not null, version integer not null,
  json text not null, created_at text not null,
  unique(work_id, version));
create table if not exists attempts(
  id text primary key, work_id text not null, number integer not null,
  json text not null, status text not null, started_at text not null);
create table if not exists decisions(
  id text primary key, work_id text not null, source_message_id text not null,
  kind text not null, value text not null, created_at text not null);
create table if not exists evidence(
  id text primary key, work_id text not null, attempt_id text not null,
  type text not null, label text not null, status text not null,
  data text not null, observed_at text not null);
create table if not exists outcomes(
  id text primary key, work_id text not null, attempt_id text not null,
  outcome text not null, reasons text not null, evidence_ids text not null default '[]',
  finalization_key text, created_at text not null);
create table if not exists messages(
  id text primary key, work_id text, role text not null, text text not null, created_at text not null);
create table if not exists events(
  seq integer primary key autoincrement, type text not null, work_id text,
  attempt_id text, data text not null, created_at text not null);
create table if not exists artifacts(
  id text primary key, kind text not null, hash text not null,
  path text not null, bytes integer not null, created_at text not null);
create table if not exists recovery_sessions(
  id text primary key, work_id text not null, attempt_id text not null,
  observed_at text not null, evidence_ids text not null, reason text not null, status text not null);
create index if not exists idx_attempts_work on attempts(work_id);
create index if not exists idx_evidence_attempt on evidence(attempt_id);
create index if not exists idx_outcomes_attempt on outcomes(attempt_id);
create index if not exists idx_events_work on events(work_id);
create index if not exists idx_recovery_sessions_work on recovery_sessions(work_id, status);
create index if not exists idx_recovery_sessions_attempt on recovery_sessions(attempt_id);
`;

const REQUIRED_TABLES: Record<string, readonly string[]> = {
  works: ['id', 'title', 'repository_id', 'workspace', 'state', 'current_contract_version', 'retry_budget', 'created_at'],
  contracts: ['id', 'work_id', 'version', 'json', 'created_at'],
  attempts: ['id', 'work_id', 'number', 'json', 'status', 'started_at'],
  decisions: ['id', 'work_id', 'source_message_id', 'kind', 'value', 'created_at'],
  evidence: ['id', 'work_id', 'attempt_id', 'type', 'label', 'status', 'data', 'observed_at'],
  outcomes: ['id', 'work_id', 'attempt_id', 'outcome', 'reasons', 'evidence_ids', 'finalization_key', 'created_at'],
  messages: ['id', 'work_id', 'role', 'text', 'created_at'],
  events: ['seq', 'type', 'work_id', 'attempt_id', 'data', 'created_at'],
  artifacts: ['id', 'kind', 'hash', 'path', 'bytes', 'created_at'],
  recovery_sessions: ['id', 'work_id', 'attempt_id', 'observed_at', 'evidence_ids', 'reason', 'status'],
};

const REQUIRED_INDEXES: Record<string, { table: string; columns: readonly string[] }> = {
  idx_attempts_work: { table: 'attempts', columns: ['work_id'] },
  idx_evidence_attempt: { table: 'evidence', columns: ['attempt_id'] },
  idx_outcomes_attempt: { table: 'outcomes', columns: ['attempt_id'] },
  idx_events_work: { table: 'events', columns: ['work_id'] },
  idx_recovery_sessions_work: { table: 'recovery_sessions', columns: ['work_id', 'status'] },
  idx_recovery_sessions_attempt: { table: 'recovery_sessions', columns: ['attempt_id'] },
};

function validateSchema(db: DatabaseSync): void {
  const problems: string[] = [];
  for (const [table, required] of Object.entries(REQUIRED_TABLES)) {
    const actual = new Set((db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name));
    const missing = required.filter((column) => !actual.has(column));
    if (missing.length) problems.push(`${table} missing columns: ${missing.join(', ')}`);
  }
  for (const [name, required] of Object.entries(REQUIRED_INDEXES)) {
    const index = db.prepare(`
      select tbl_name from sqlite_master where type = 'index' and name = ?
    `).get(name) as { tbl_name: string } | undefined;
    const columns = (db.prepare(`pragma index_info(${name})`).all() as Array<{ name: string }>)
      .map((column) => column.name);
    if (!index || index.tbl_name !== required.table || columns.join() !== required.columns.join()) {
      problems.push(`${name} must index ${required.table}(${required.columns.join(', ')})`);
    }
  }
  if (problems.length) throw new Error(`SCHEMA_INVALID: ${problems.join('; ')}`);
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare('pragma user_version').get() as { user_version: number }).user_version;
}

export function rethrowAfterRollback(db: DatabaseSync, error: unknown): never {
  if (db.isTransaction) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AggregateError([error, rollbackError], `transaction failed: ${message}; rollback also failed`);
    }
  }
  throw error;
}

export function migrate(db: DatabaseSync): void {
  const version = userVersion(db);
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`SCHEMA_TOO_NEW: database version ${version}, supported ${CURRENT_SCHEMA_VERSION}`);
  }
  if (version === CURRENT_SCHEMA_VERSION) {
    validateSchema(db);
    return;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(SCHEMA);
    const outcomeColumns = db.prepare('pragma table_info(outcomes)').all() as Array<{ name: string }>;
    if (!outcomeColumns.some((column) => column.name === 'evidence_ids')) {
      db.exec(`alter table outcomes add column evidence_ids text not null default '[]'`);
    }
    if (!outcomeColumns.some((column) => column.name === 'finalization_key')) {
      db.exec('alter table outcomes add column finalization_key text');
    }
    const recoveryColumns = db.prepare('pragma table_info(recovery_sessions)').all() as Array<{ name: string }>;
    const recoveryNames = recoveryColumns.map((column) => column.name);
    const expectedRecoveryNames = [
      'id', 'work_id', 'attempt_id', 'observed_at', 'evidence_ids', 'reason', 'status',
    ];
    if (recoveryNames.join() !== expectedRecoveryNames.join()) {
      const observedAt = recoveryNames.includes('observed_at') ? 'observed_at' : 'created_at';
      const evidenceIds = recoveryNames.includes('evidence_ids') ? 'evidence_ids' : `'[]'`;
      const reason = recoveryNames.includes('reason') ? 'reason' : `'migrated legacy recovery session'`;
      db.exec(`
        alter table recovery_sessions rename to recovery_sessions_legacy;
        create table recovery_sessions(
          id text primary key, work_id text not null, attempt_id text not null,
          observed_at text not null, evidence_ids text not null, reason text not null, status text not null);
        insert into recovery_sessions(id,work_id,attempt_id,observed_at,evidence_ids,reason,status)
          select id,work_id,attempt_id,${observedAt},${evidenceIds},${reason},status
          from recovery_sessions_legacy;
        drop table recovery_sessions_legacy;
        create index idx_recovery_sessions_work on recovery_sessions(work_id, status);
        create index idx_recovery_sessions_attempt on recovery_sessions(attempt_id);
      `);
    }
    validateSchema(db);
    db.exec(`pragma user_version = ${CURRENT_SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    rethrowAfterRollback(db, error);
  }
}
