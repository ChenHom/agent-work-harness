import type { DatabaseSync } from 'node:sqlite';

export const CURRENT_SCHEMA_VERSION = 5;

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
create table if not exists plans(
  id text primary key, work_id text not null, version integer not null,
  branch_id text not null, contract_version integer not null,
  parent_plan_id text, source_checkpoint_id text, status text not null,
  json text not null, created_at text not null,
  unique(work_id, version));
create table if not exists milestones(
  row_id text primary key, id text not null, plan_id text not null,
  sequence integer not null, status text not null, json text not null,
  unique(plan_id, id), unique(plan_id, sequence));
create table if not exists checkpoints(
  id text primary key, work_id text not null, plan_id text not null,
  branch_id text not null, parent_checkpoint_id text,
  validation_status text not null, json text not null, created_at text not null);
create table if not exists operations(
  id text primary key, work_id text not null, intent_key text not null,
  idempotency_key text not null, status text not null, json text not null, created_at text not null,
  unique(work_id, intent_key), unique(idempotency_key));
create table if not exists operation_attempts(
  id text primary key, operation_id text not null, number integer not null,
  status text not null, json text not null, dispatched_at text not null,
  unique(operation_id, number));
create table if not exists compensations(
  id text primary key, operation_id text not null, work_id text not null,
  idempotency_key text not null, status text not null, json text not null, created_at text not null,
  unique(operation_id), unique(idempotency_key));
create table if not exists compensation_attempts(
  id text primary key, compensation_id text not null, number integer not null,
  status text not null, json text not null, dispatched_at text not null,
  unique(compensation_id, number));
create table if not exists budget_limits(
  id text primary key, work_id text not null, resource_kind text not null, currency text not null,
  json text not null, created_at text not null, unique(work_id, resource_kind, currency));
create table if not exists budget_reservations(
  id text primary key, work_id text not null, limit_id text not null,
  operation_id text, compensation_id text, status text not null, json text not null, created_at text not null);
create table if not exists budget_ledger(
  id text primary key, work_id text not null, limit_id text not null, reservation_id text not null,
  kind text not null, json text not null, created_at text not null);
create table if not exists evaluation_contracts(
  id text primary key, work_id text not null, version integer not null,
  policy_version text not null, json text not null, created_at text not null,
  unique(work_id, version));
create table if not exists evaluation_runs(
  id text primary key, work_id text not null, contract_id text not null,
  attempt_id text, evaluator_version text not null, status text not null,
  json text not null, started_at text not null);
create table if not exists criterion_verdicts(
  id text primary key, work_id text not null, run_id text not null,
  criterion_id text not null, verdict text not null, json text not null, created_at text not null,
  unique(run_id, criterion_id));
create table if not exists completion_decisions(
  id text primary key, work_id text not null, run_id text not null unique,
  contract_id text not null, verdict text not null, policy_version text not null,
  json text not null, created_at text not null);
create index if not exists idx_attempts_work on attempts(work_id);
create index if not exists idx_evidence_attempt on evidence(attempt_id);
create index if not exists idx_outcomes_attempt on outcomes(attempt_id);
create index if not exists idx_events_work on events(work_id);
create index if not exists idx_recovery_sessions_work on recovery_sessions(work_id, status);
create index if not exists idx_recovery_sessions_attempt on recovery_sessions(attempt_id);
create index if not exists idx_plans_work on plans(work_id, version);
create unique index if not exists idx_plans_one_active on plans(work_id) where status = 'ACTIVE';
create index if not exists idx_milestones_plan on milestones(plan_id, sequence);
create index if not exists idx_checkpoints_work on checkpoints(work_id, created_at);
create index if not exists idx_checkpoints_plan on checkpoints(plan_id, created_at);
create index if not exists idx_operations_work on operations(work_id, created_at);
create index if not exists idx_operation_attempts_operation on operation_attempts(operation_id, number);
create index if not exists idx_compensations_work on compensations(work_id, created_at);
create index if not exists idx_compensation_attempts_compensation on compensation_attempts(compensation_id, number);
create index if not exists idx_budget_limits_work on budget_limits(work_id, resource_kind);
create index if not exists idx_budget_reservations_limit on budget_reservations(limit_id, status);
create index if not exists idx_budget_ledger_limit on budget_ledger(limit_id, created_at);
create index if not exists idx_evaluation_contracts_work on evaluation_contracts(work_id, version);
create index if not exists idx_evaluation_runs_work on evaluation_runs(work_id, started_at);
create index if not exists idx_criterion_verdicts_run on criterion_verdicts(run_id, created_at);
create index if not exists idx_completion_decisions_work on completion_decisions(work_id, created_at);
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
  plans: {
    id: PK_TEXT, work_id: TEXT, version: INTEGER, branch_id: TEXT, contract_version: INTEGER,
    parent_plan_id: NULLABLE_TEXT, source_checkpoint_id: NULLABLE_TEXT, status: TEXT,
    json: TEXT, created_at: TEXT,
  },
  milestones: {
    row_id: PK_TEXT, id: TEXT, plan_id: TEXT, sequence: INTEGER, status: TEXT, json: TEXT,
  },
  checkpoints: {
    id: PK_TEXT, work_id: TEXT, plan_id: TEXT, branch_id: TEXT,
    parent_checkpoint_id: NULLABLE_TEXT, validation_status: TEXT, json: TEXT, created_at: TEXT,
  },
  operations: {
    id: PK_TEXT, work_id: TEXT, intent_key: TEXT, idempotency_key: TEXT,
    status: TEXT, json: TEXT, created_at: TEXT,
  },
  operation_attempts: {
    id: PK_TEXT, operation_id: TEXT, number: INTEGER, status: TEXT, json: TEXT, dispatched_at: TEXT,
  },
  compensations: {
    id: PK_TEXT, operation_id: TEXT, work_id: TEXT, idempotency_key: TEXT,
    status: TEXT, json: TEXT, created_at: TEXT,
  },
  compensation_attempts: {
    id: PK_TEXT, compensation_id: TEXT, number: INTEGER, status: TEXT, json: TEXT, dispatched_at: TEXT,
  },
  budget_limits: {
    id: PK_TEXT, work_id: TEXT, resource_kind: TEXT, currency: TEXT, json: TEXT, created_at: TEXT,
  },
  budget_reservations: {
    id: PK_TEXT, work_id: TEXT, limit_id: TEXT, operation_id: NULLABLE_TEXT,
    compensation_id: NULLABLE_TEXT, status: TEXT, json: TEXT, created_at: TEXT,
  },
  budget_ledger: {
    id: PK_TEXT, work_id: TEXT, limit_id: TEXT, reservation_id: TEXT,
    kind: TEXT, json: TEXT, created_at: TEXT,
  },
  evaluation_contracts: {
    id: PK_TEXT, work_id: TEXT, version: INTEGER, policy_version: TEXT, json: TEXT, created_at: TEXT,
  },
  evaluation_runs: {
    id: PK_TEXT, work_id: TEXT, contract_id: TEXT, attempt_id: NULLABLE_TEXT,
    evaluator_version: TEXT, status: TEXT, json: TEXT, started_at: TEXT,
  },
  criterion_verdicts: {
    id: PK_TEXT, work_id: TEXT, run_id: TEXT, criterion_id: TEXT,
    verdict: TEXT, json: TEXT, created_at: TEXT,
  },
  completion_decisions: {
    id: PK_TEXT, work_id: TEXT, run_id: TEXT, contract_id: TEXT,
    verdict: TEXT, policy_version: TEXT, json: TEXT, created_at: TEXT,
  },
};

const REQUIRED_INDEXES: Record<string, { table: string; columns: readonly string[] }> = {
  idx_attempts_work: { table: 'attempts', columns: ['work_id'] },
  idx_evidence_attempt: { table: 'evidence', columns: ['attempt_id'] },
  idx_outcomes_attempt: { table: 'outcomes', columns: ['attempt_id'] },
  idx_events_work: { table: 'events', columns: ['work_id'] },
  idx_recovery_sessions_work: { table: 'recovery_sessions', columns: ['work_id', 'status'] },
  idx_recovery_sessions_attempt: { table: 'recovery_sessions', columns: ['attempt_id'] },
  idx_plans_work: { table: 'plans', columns: ['work_id', 'version'] },
  idx_milestones_plan: { table: 'milestones', columns: ['plan_id', 'sequence'] },
  idx_checkpoints_work: { table: 'checkpoints', columns: ['work_id', 'created_at'] },
  idx_checkpoints_plan: { table: 'checkpoints', columns: ['plan_id', 'created_at'] },
  idx_operations_work: { table: 'operations', columns: ['work_id', 'created_at'] },
  idx_operation_attempts_operation: { table: 'operation_attempts', columns: ['operation_id', 'number'] },
  idx_compensations_work: { table: 'compensations', columns: ['work_id', 'created_at'] },
  idx_compensation_attempts_compensation: { table: 'compensation_attempts', columns: ['compensation_id', 'number'] },
  idx_budget_limits_work: { table: 'budget_limits', columns: ['work_id', 'resource_kind'] },
  idx_budget_reservations_limit: { table: 'budget_reservations', columns: ['limit_id', 'status'] },
  idx_budget_ledger_limit: { table: 'budget_ledger', columns: ['limit_id', 'created_at'] },
  idx_evaluation_contracts_work: { table: 'evaluation_contracts', columns: ['work_id', 'version'] },
  idx_evaluation_runs_work: { table: 'evaluation_runs', columns: ['work_id', 'started_at'] },
  idx_criterion_verdicts_run: { table: 'criterion_verdicts', columns: ['run_id', 'created_at'] },
  idx_completion_decisions_work: { table: 'completion_decisions', columns: ['work_id', 'created_at'] },
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
  const hasUnique = (table: string, columns: string): boolean => {
    const indexes = db.prepare(`pragma index_list(${table})`).all() as Array<{
      name: string; unique: number; partial: number;
    }>;
    return indexes.some((index) => index.unique === 1 && index.partial === 0
      && (db.prepare('select name from pragma_index_info(?) order by seqno').all(index.name) as Array<{ name: string }>)
        .map((column) => column.name).join() === columns);
  };
  if (!hasUnique('contracts', 'work_id,version')) problems.push('contracts must have unique(work_id, version)');
  if (!hasUnique('plans', 'work_id,version')) problems.push('plans must have unique(work_id, version)');
  if (!hasUnique('milestones', 'plan_id,id')) problems.push('milestones must have unique(plan_id, id)');
  if (!hasUnique('milestones', 'plan_id,sequence')) problems.push('milestones must have unique(plan_id, sequence)');
  if (!hasUnique('operations', 'work_id,intent_key')) problems.push('operations must have unique(work_id, intent_key)');
  if (!hasUnique('operations', 'idempotency_key')) problems.push('operations must have unique(idempotency_key)');
  if (!hasUnique('operation_attempts', 'operation_id,number')) {
    problems.push('operation_attempts must have unique(operation_id, number)');
  }
  if (!hasUnique('compensations', 'operation_id')) problems.push('compensations must have unique(operation_id)');
  if (!hasUnique('compensations', 'idempotency_key')) problems.push('compensations must have unique(idempotency_key)');
  if (!hasUnique('compensation_attempts', 'compensation_id,number')) {
    problems.push('compensation_attempts must have unique(compensation_id, number)');
  }
  if (!hasUnique('budget_limits', 'work_id,resource_kind,currency')) {
    problems.push('budget_limits must have unique(work_id, resource_kind, currency)');
  }
  if (!hasUnique('evaluation_contracts', 'work_id,version')) {
    problems.push('evaluation_contracts must have unique(work_id, version)');
  }
  if (!hasUnique('criterion_verdicts', 'run_id,criterion_id')) {
    problems.push('criterion_verdicts must have unique(run_id, criterion_id)');
  }
  if (!hasUnique('completion_decisions', 'run_id')) {
    problems.push('completion_decisions must have unique(run_id)');
  }
  const planIndexes = db.prepare('pragma index_list(plans)').all() as Array<{
    name: string; unique: number; partial: number;
  }>;
  const activePlanIndex = planIndexes.find((index) => index.name === 'idx_plans_one_active');
  const activeColumns = activePlanIndex
    ? (db.prepare('select name from pragma_index_info(?) order by seqno').all(activePlanIndex.name) as Array<{ name: string }>)
      .map((column) => column.name).join()
    : '';
  const activeSql = (db.prepare("select sql from sqlite_master where type='index' and name='idx_plans_one_active'")
    .get() as { sql?: string } | undefined)?.sql ?? '';
  if (!activePlanIndex || activePlanIndex.unique !== 1 || activePlanIndex.partial !== 1
    || activeColumns !== 'work_id' || !/where\s+status\s*=\s*'ACTIVE'/i.test(activeSql)) {
    problems.push("idx_plans_one_active must uniquely index plans(work_id) where status = 'ACTIVE'");
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
