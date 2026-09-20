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

interface ColumnRequirement {
  type: 'TEXT' | 'INTEGER';
  notNull: 0 | 1;
  primaryKey: 0 | 1;
  defaultValue?: string | null;
}

const PK_TEXT: ColumnRequirement = { type: 'TEXT', notNull: 0, primaryKey: 1 };
const TEXT: ColumnRequirement = { type: 'TEXT', notNull: 1, primaryKey: 0 };
const NULLABLE_TEXT: ColumnRequirement = { type: 'TEXT', notNull: 0, primaryKey: 0 };
const INTEGER: ColumnRequirement = { type: 'INTEGER', notNull: 1, primaryKey: 0 };

const REQUIRED_TABLES: Record<string, Record<string, ColumnRequirement>> = {
  works: {
    id: PK_TEXT, title: TEXT, repository_id: TEXT, workspace: TEXT, state: TEXT,
    current_contract_version: INTEGER, retry_budget: INTEGER, created_at: TEXT,
  },
  contracts: { id: PK_TEXT, work_id: TEXT, version: INTEGER, json: TEXT, created_at: TEXT },
  attempts: { id: PK_TEXT, work_id: TEXT, number: INTEGER, json: TEXT, status: TEXT, started_at: TEXT },
  decisions: { id: PK_TEXT, work_id: TEXT, source_message_id: TEXT, kind: TEXT, value: TEXT, created_at: TEXT },
  evidence: {
    id: PK_TEXT, work_id: TEXT, attempt_id: TEXT, type: TEXT, label: TEXT,
    status: TEXT, data: TEXT, observed_at: TEXT,
  },
  outcomes: {
    id: PK_TEXT, work_id: TEXT, attempt_id: TEXT, outcome: TEXT, reasons: TEXT,
    evidence_ids: { ...TEXT, defaultValue: `'[]'` }, finalization_key: NULLABLE_TEXT, created_at: TEXT,
  },
  messages: { id: PK_TEXT, work_id: NULLABLE_TEXT, role: TEXT, text: TEXT, created_at: TEXT },
  events: {
    seq: { type: 'INTEGER', notNull: 0, primaryKey: 1 }, type: TEXT,
    work_id: NULLABLE_TEXT, attempt_id: NULLABLE_TEXT, data: TEXT, created_at: TEXT,
  },
  artifacts: { id: PK_TEXT, kind: TEXT, hash: TEXT, path: TEXT, bytes: INTEGER, created_at: TEXT },
  recovery_sessions: {
    id: PK_TEXT, work_id: TEXT, attempt_id: TEXT, observed_at: TEXT,
    evidence_ids: TEXT, reason: TEXT, status: TEXT,
  },
};

const REQUIRED_INDEXES: Record<string, { table: string; columns: readonly string[] }> = {
  idx_attempts_work: { table: 'attempts', columns: ['work_id'] },
  idx_evidence_attempt: { table: 'evidence', columns: ['attempt_id'] },
  idx_outcomes_attempt: { table: 'outcomes', columns: ['attempt_id'] },
  idx_events_work: { table: 'events', columns: ['work_id'] },
  idx_recovery_sessions_work: { table: 'recovery_sessions', columns: ['work_id', 'status'] },
  idx_recovery_sessions_attempt: { table: 'recovery_sessions', columns: ['attempt_id'] },
};

export function validateSchema(db: DatabaseSync): void {
  const problems: string[] = [];
  for (const [table, required] of Object.entries(REQUIRED_TABLES)) {
    const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
    }>;
    const actual = new Map(columns.map((column) => [column.name, column]));
    for (const [name, expected] of Object.entries(required)) {
      const column = actual.get(name);
      if (!column) {
        problems.push(`${table}.${name} is missing`);
        continue;
      }
      if (column.type.toUpperCase() !== expected.type
        || column.notnull !== expected.notNull
        || column.pk !== expected.primaryKey) {
        problems.push(`${table}.${name} must be ${expected.type} notnull=${expected.notNull} pk=${expected.primaryKey}`);
      }
      if ('defaultValue' in expected && column.dflt_value !== expected.defaultValue) {
        problems.push(`${table}.${name} must default to ${String(expected.defaultValue)}`);
      }
    }
  }
  for (const [name, required] of Object.entries(REQUIRED_INDEXES)) {
    const index = (db.prepare(`pragma index_list(${required.table})`).all() as Array<{
      name: string; unique: number; partial: number;
    }>).find((candidate) => candidate.name === name);
    const columns = (db.prepare(`pragma index_info(${name})`).all() as Array<{ name: string }>)
      .map((column) => column.name);
    if (!index || index.unique !== 0 || index.partial !== 0 || columns.join() !== required.columns.join()) {
      problems.push(`${name} must index ${required.table}(${required.columns.join(', ')})`);
    }
  }
  const contractIndexes = db.prepare('pragma index_list(contracts)').all() as Array<{
    name: string; unique: number; partial: number;
  }>;
  const hasContractVersionUnique = contractIndexes.some((index) => index.unique === 1 && index.partial === 0
    && (db.prepare('select name from pragma_index_info(?) order by seqno').all(index.name) as Array<{ name: string }>)
      .map((column) => column.name).join() === 'work_id,version');
  if (!hasContractVersionUnique) problems.push('contracts must have unique(work_id, version)');
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
