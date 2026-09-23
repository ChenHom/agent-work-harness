import { DatabaseSync } from 'node:sqlite';
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { newId, nowIso } from '../ids.ts';
import { acceptCriterionVerdict } from '../evaluation/criteria.ts';
import { CURRENT_SCHEMA_VERSION, migrate, rethrowAfterRollback, validateSchema } from './migrations.ts';
import type {
  Work, WorkContract, Attempt, DecisionRecord, EvidenceRecord,
  Outcome, WorkState, AttemptStatus, RecoverySession,
  WorkPlan, PlanMilestone, LogicalCheckpoint,
  Operation, OperationAttempt, Compensation, CompensationAttempt,
  BudgetLimit, BudgetReservation, BudgetLedgerEntry,
  EvaluationContract, EvaluationRun, StoredCriterionVerdict, CompletionDecisionRecord,
  CriterionDefinition, CriterionVerdictRecord,
  CriticDispatch,
} from '../types.ts';

const ARTIFACT_READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

// §29：append-only trace + artifact store。MVP 不做 Event Sourcing。
export type EventType =
  | 'work.created' | 'message.received' | 'work_contract.versioned'
  | 'decision.recorded' | 'context_manifest.created'
  | 'skill.admission_allowed' | 'skill.admission_denied'
  | 'prompt.compiled' | 'attempt.started' | 'attempt.completed'
  | 'runtime.protocol_failed' | 'evidence.collected' | 'outcome.decided'
  | 'work.completed' | 'work.blocked' | 'work.state_changed'
  | 'recovery.required' | 'recovery.observed'
  | 'plan.proposed' | 'plan.activated' | 'plan.superseded' | 'plan.completed' | 'checkpoint.created'
  | 'dependency.artifact_replaced' | 'milestone.completed' | 'milestone.stale'
  | 'operation.prepared' | 'operation.state_changed' | 'operation.attempt_recorded'
  | 'operation.attempt_state_changed'
  | 'operation.reconciled'
  | 'compensation.prepared' | 'compensation.state_changed' | 'compensation.attempt_recorded'
  | 'compensation.attempt_state_changed' | 'compensation.reconciled'
  | 'budget.limit_configured' | 'budget.reservation_recorded' | 'budget.ledger_recorded'
  | 'evaluation.contract_recorded' | 'evaluation.run_recorded'
  | 'evaluation.verdict_recorded' | 'evaluation.completed'
  | 'critic.dispatch_reserved' | 'critic.dispatch_completed'
  | 'retention.gc_applied' | 'artifact.redacted'
  | 'usage.note';   // 人對結果的判讀 —— 機器不知道 evidence 判錯了，只有人知道

export type VerifiedArtifact =
  | { status: 'verified'; id: string; hash: string; content: Buffer }
  | { status: 'missing' | 'corrupt'; id: string; reason?: string; code?: string };

export class StoreOpenError extends Error {
  readonly code: 'NO_STATE' | 'READ_ONLY_UNAVAILABLE';

  constructor(code: 'NO_STATE' | 'READ_ONLY_UNAVAILABLE', message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (!item || typeof item !== 'object') return item;
    const object = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => [key, sort(object[key])]));
  };
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value)) as unknown));
}

export class Store {
  readonly db: DatabaseSync;
  /** Private migrated copy used when an older schema is opened read-only; removed on close. */
  private readonly snapshotDir: string | undefined;
  readonly artifactDir: string;
  private readonly readOnly: boolean;
  private inTransaction = false;
  private readonly hasOutcomeEvidenceIds: boolean;

  constructor(stateDir: string, options: { readOnly?: boolean } = {}) {
    this.artifactDir = join(stateDir, 'artifacts');
    this.readOnly = options.readOnly === true;
    const path = join(stateDir, 'harness.db');
    if (this.readOnly) {
      if (!existsSync(path)) throw new StoreOpenError('NO_STATE', `no database at ${path}`);
      const walExists = existsSync(`${path}-wal`);
      const shmExists = existsSync(`${path}-shm`);
      if (walExists !== shmExists) {
        throw new StoreOpenError('READ_ONLY_UNAVAILABLE', `incomplete WAL sidecars for ${path}`);
      }
      const immutable = pathToFileURL(path);
      immutable.searchParams.set('immutable', '1');
      this.db = new DatabaseSync(walExists ? path : immutable, { readOnly: true });
      try {
        const version = (this.db.prepare('pragma user_version').get() as { user_version: number }).user_version;
        if (version > CURRENT_SCHEMA_VERSION) {
          throw new Error(`SCHEMA_TOO_NEW: database version ${version}, supported ${CURRENT_SCHEMA_VERSION}`);
        }
        if (version === CURRENT_SCHEMA_VERSION) validateSchema(this.db);
        else {
          // Read-only commands query newer tables and columns, but the file must not be migrated here.
          // Read from a migrated private snapshot instead, reopened read-only so no write can land in it.
          this.snapshotDir = mkdtempSync(join(tmpdir(), 'harness-readonly-'));
          const snapshot = join(this.snapshotDir, 'harness.db');
          this.db.prepare('vacuum into ?').run(snapshot);
          this.db.close();
          const migrating = new DatabaseSync(snapshot);
          try { migrate(migrating); } finally { migrating.close(); }
          this.db = new DatabaseSync(snapshot, { readOnly: true });
        }
      } catch (error) {
        if (this.db.isOpen) this.db.close();
        if (this.snapshotDir) rmSync(this.snapshotDir, { recursive: true, force: true });
        throw error;
      }
    } else {
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(this.artifactDir, { recursive: true });
      this.db = new DatabaseSync(path);
      try {
        migrate(this.db);
        this.db.exec('pragma journal_mode = WAL');
        this.db.exec('pragma foreign_keys = ON');
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
    this.hasOutcomeEvidenceIds = (this.db.prepare('pragma table_info(outcomes)').all() as Array<{ name: string }>)
      .some((column) => column.name === 'evidence_ids');
  }

  close(): void {
    this.db.close();
    if (this.snapshotDir) rmSync(this.snapshotDir, { recursive: true, force: true });
  }

  /** DB-only callback: no filesystem, process, network, or other asynchronous work. */
  withTransaction<T>(fn: () => T): T {
    if (this.inTransaction) throw new Error('nested transaction is not allowed');
    if (Object.prototype.toString.call(fn) === '[object AsyncFunction]') {
      throw new Error('transaction callback must be synchronous and must not return a Promise');
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('transaction callback must be synchronous and must not return a Promise');
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      rethrowAfterRollback(this.db, error);
    } finally {
      this.inTransaction = false;
    }
  }

  // ---- trace ----
  event(type: EventType, data: unknown, workId?: string, attemptId?: string): void {
    this.db.prepare('insert into events(type, work_id, attempt_id, data, created_at) values (?,?,?,?,?)')
      .run(type, workId ?? null, attemptId ?? null, JSON.stringify(data ?? {}), nowIso());
  }

  events(workId: string): Array<{ seq: number; type: string; data: string; created_at: string; attempt_id: string | null }> {
    return this.db.prepare('select seq, type, data, created_at, attempt_id from events where work_id = ? order by seq')
      .all(workId) as never;
  }

  latestEventSeq(): number {
    const row = this.db.prepare('select coalesce(max(seq), 0) as seq from events').get() as { seq: number };
    return Number(row.seq);
  }

  /** 跨 work 的 note 查詢。watch list 的升級判準需要看趨勢，不是單一 work。 */
  notes(kind?: string): Array<{ seq: number; workId: string | null; kind: string; text: string; createdAt: string; title: string | null }> {
    const rows = this.db.prepare(`
      select e.seq, e.work_id, e.data, e.created_at, w.title
      from events e left join works w on w.id = e.work_id
      where e.type = 'usage.note' order by e.seq desc`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const d = JSON.parse(r.data as string) as { kind: string; text: string };
      return {
        seq: Number(r.seq), workId: (r.work_id as string) ?? null,
        kind: d.kind, text: d.text,
        createdAt: r.created_at as string, title: (r.title as string) ?? null,
      };
    }).filter((n) => !kind || n.kind === kind);
  }

  /** 彙總：回答「大量 retry」「outcome 分佈」這類趨勢問題。 */
  stats(): {
    works: number; attempts: number; retries: number;
    outcomes: Array<{ outcome: string; count: number }>;
    notes: Array<{ kind: string; count: number }>;
  } {
    const one = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      works: one('select count(*) as n from works'),
      attempts: one('select count(*) as n from attempts'),
      retries: one(`select count(*) as n from attempts where json_extract(json, '$.retryOf') is not null`),
      outcomes: this.db.prepare(`
        select outcome, count(*) as count from outcomes group by outcome order by count desc`).all() as never,
      notes: this.db.prepare(`
        select json_extract(data, '$.kind') as kind, count(*) as count
        from events where type = 'usage.note' group by kind order by count desc`).all() as never,
    };
  }

  // ---- artifacts (§29 大內容不進 event) ----
  putArtifact(kind: string, content: string | Buffer, ext = 'txt'): { id: string; hash: string; path: string } {
    if (!/^[A-Za-z0-9_-]+$/.test(ext)) throw new Error(`invalid artifact extension: ${ext}`);
    if (this.readOnly) throw new Error('read-only store cannot write artifacts');
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const hash = createHash('sha256').update(buf).digest('hex');
    const id = newId('AR');
    const path = join(this.artifactDir, `${hash}.${ext}`);
    this.publishPayload(path, buf, hash);
    this.db.prepare('insert into artifacts(id, kind, hash, path, bytes, created_at) values (?,?,?,?,?,?)')
      .run(id, kind, hash, path, buf.length, nowIso());
    // GC and redaction unlink under the write lock, so a reused file they removed after the publish
    // above is already gone once this insert succeeds: republish rather than keep a row without bytes.
    if (!existsSync(path)) this.publishPayload(path, buf, hash);
    return { id, hash, path };
  }

  /** Writes (or verifies an existing) content-addressed payload and fsyncs it and its directory. */
  private publishPayload(path: string, buf: Buffer, hash: string): void {
    let valid = false;
    try {
      const descriptor = openSync(path, ARTIFACT_READ_FLAGS);
      try {
        if (fstatSync(descriptor).isFile()) {
          const persisted = readFileSync(descriptor);
          valid = persisted.length === buf.length
            && createHash('sha256').update(persisted).digest('hex') === hash;
        }
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ELOOP') throw error;
    }
    if (!valid) {
      const temporaryPath = join(this.artifactDir, `.${hash}.${randomUUID()}.tmp`);
      let descriptor: number | undefined;
      try {
        descriptor = openSync(temporaryPath, 'wx');
        writeFileSync(descriptor, buf);
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporaryPath, path);
      } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        rmSync(temporaryPath, { force: true });
        throw error;
      }
    }
    const fileDescriptor = openSync(path, ARTIFACT_READ_FLAGS);
    try {
      if (!fstatSync(fileDescriptor).isFile()) throw new Error('artifact payload is not a regular file');
      const persisted = readFileSync(fileDescriptor);
      if (persisted.length !== buf.length
        || createHash('sha256').update(persisted).digest('hex') !== hash) {
        throw new Error('artifact payload verification failed after publish');
      }
      fsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }
    const directoryDescriptor = openSync(this.artifactDir, 'r');
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
  }

  readArtifact(id: string): string | null {
    const artifact = this.readVerifiedArtifact(id);
    return artifact.status === 'verified' ? artifact.content.toString('utf8') : null;
  }

  readVerifiedArtifact(id: string): VerifiedArtifact {
    // Retention or redaction deleted the payload on purpose; the tombstone keeps hash/kind/time, never bytes.
    const tombstone = this.db.prepare('select cause from artifact_tombstones where artifact_id = ?').get(id) as
      { cause: string } | undefined;
    if (tombstone) return { status: 'missing', id, reason: `deleted_by_${tombstone.cause}` };
    const row = this.db.prepare('select hash, path, bytes from artifacts where id = ?').get(id) as {
      hash: string; path: string; bytes: number;
    } | undefined;
    if (!row) return { status: 'missing', id, reason: 'record_missing' };
    const artifactDir = resolve(this.artifactDir);
    const path = resolve(row.path);
    if (dirname(path) !== artifactDir) return { status: 'corrupt', id, reason: 'invalid_path' };
    try {
      const descriptor = openSync(path, ARTIFACT_READ_FLAGS);
      let content: Buffer;
      try {
        if (!fstatSync(descriptor).isFile()) {
          return { status: 'corrupt', id, reason: 'non_regular_file' };
        }
        content = readFileSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      if (content.length !== row.bytes) return { status: 'corrupt', id, reason: 'byte_length_mismatch' };
      if (createHash('sha256').update(content).digest('hex') !== row.hash) {
        return { status: 'corrupt', id, reason: 'hash_mismatch' };
      }
      return { status: 'verified', id, hash: row.hash, content };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { status: 'missing', id, reason: 'file_missing', code };
      return { status: 'corrupt', id, reason: 'io_error', code };
    }
  }

  // ---- work ----
  insertWork(w: Work): void {
    this.db.prepare(`insert into works(id,title,repository_id,workspace,state,current_contract_version,retry_budget,created_at)
      values (?,?,?,?,?,?,?,?)`)
      .run(w.id, w.title, w.repositoryId, w.workspace, w.state, w.currentContractVersion, w.retryBudget, w.createdAt);
    this.event('work.created', { id: w.id, title: w.title }, w.id);
  }

  getWork(id: string): Work | null {
    const r = this.db.prepare('select * from works where id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string, title: r.title as string, repositoryId: r.repository_id as string,
      workspace: r.workspace as string, state: r.state as WorkState,
      currentContractVersion: Number(r.current_contract_version),
      retryBudget: Number(r.retry_budget), createdAt: r.created_at as string,
    };
  }

  listWorks(): Work[] {
    const rows = this.db.prepare('select id from works order by created_at desc').all() as Array<{ id: string }>;
    return rows.map((r) => this.getWork(r.id)!).filter(Boolean);
  }

  setWorkState(id: string, state: WorkState): void {
    this.db.prepare('update works set state = ? where id = ?').run(state, id);
    this.event('work.state_changed', { state }, id);
  }

  setContractVersion(id: string, version: number): void {
    this.db.prepare('update works set current_contract_version = ? where id = ?').run(version, id);
  }

  // ---- contract ----
  insertContract(c: WorkContract): void {
    this.db.prepare('insert into contracts(id, work_id, version, json, created_at) values (?,?,?,?,?)')
      .run(c.id, c.workId, c.version, JSON.stringify(c), c.createdAt);
    this.event('work_contract.versioned', { version: c.version, mode: c.mode }, c.workId);
  }

  getContract(workId: string, version: number): WorkContract | null {
    const r = this.db.prepare('select json from contracts where work_id = ? and version = ?')
      .get(workId, version) as { json: string } | undefined;
    return r ? JSON.parse(r.json) as WorkContract : null;
  }

  // ---- decisions ----
  insertDecision(d: DecisionRecord): void {
    this.db.prepare('insert into decisions(id,work_id,source_message_id,kind,value,created_at) values (?,?,?,?,?,?)')
      .run(d.id, d.workId, d.sourceMessageId, d.kind, d.value, d.createdAt);
    this.event('decision.recorded', { kind: d.kind, value: d.value }, d.workId);
  }

  listDecisions(workId: string): DecisionRecord[] {
    const rows = this.db.prepare('select * from decisions where work_id = ? order by created_at, id').all(workId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string, workId: r.work_id as string, sourceMessageId: r.source_message_id as string,
      kind: r.kind as DecisionRecord['kind'], value: r.value as string, createdAt: r.created_at as string,
    }));
  }

  // ---- messages ----
  insertMessage(role: 'user' | 'harness', text: string, workId?: string): string {
    const id = newId('M');
    this.db.prepare('insert into messages(id, work_id, role, text, created_at) values (?,?,?,?,?)')
      .run(id, workId ?? null, role, text, nowIso());
    this.event('message.received', { messageId: id, role }, workId);
    return id;
  }

  getMessage(id: string): { id: string; text: string; role: string } | null {
    return (this.db.prepare('select id, text, role from messages where id = ?').get(id) as never) ?? null;
  }

  // ---- attempts ----
  insertAttempt(a: Attempt): void {
    this.db.prepare('insert into attempts(id, work_id, number, json, status, started_at) values (?,?,?,?,?,?)')
      .run(a.id, a.workId, a.number, JSON.stringify(a), a.status, a.startedAt);
    this.event('attempt.started', { number: a.number, mode: a.mode, baseRevision: a.baseRevision }, a.workId, a.id);
  }

  updateAttempt(a: Attempt): void {
    this.db.prepare('update attempts set json = ?, status = ? where id = ?').run(JSON.stringify(a), a.status, a.id);
  }

  finalizeAttempt(input: {
    attempt: Attempt;
    outcome: Outcome;
    reasons: string[];
    workState: WorkState;
    evidenceIds: string[];
    expectedAttemptStatus: AttemptStatus;
    expectedWorkState: WorkState;
  }): void {
    const evidenceIds = [...new Set(input.evidenceIds)].sort();
    const finalizationKey = createHash('sha256').update(canonicalJson({
      attempt: input.attempt, outcome: input.outcome, reasons: input.reasons,
      workState: input.workState, evidenceIds,
    })).digest('hex');
    this.withTransaction(() => {
      const persistedAttempt = this.getAttempt(input.attempt.id);
      if (!persistedAttempt || persistedAttempt.workId !== input.attempt.workId) {
        throw new Error(`STATE_CONFLICT: attempt ${input.attempt.id} does not belong to work ${input.attempt.workId}`);
      }
      const persistedWork = this.getWork(input.attempt.workId);
      if (!persistedWork) {
        throw new Error(`STATE_CONFLICT: work ${input.attempt.workId} does not exist`);
      }

      const previous = this.db.prepare(`
        select finalization_key from outcomes where attempt_id = ? order by created_at, id limit 1
      `).get(input.attempt.id) as { finalization_key: string | null } | undefined;
      if (previous) {
        if (previous.finalization_key === finalizationKey) return;
        throw new Error(`STATE_CONFLICT: attempt ${input.attempt.id} already has a different finalization`);
      }

      if (persistedAttempt.status !== input.expectedAttemptStatus) {
        throw new Error(`STATE_CONFLICT: attempt ${input.attempt.id} expected ${input.expectedAttemptStatus}, got ${persistedAttempt.status}`);
      }
      if (persistedWork.state !== input.expectedWorkState) {
        throw new Error(`STATE_CONFLICT: work ${input.attempt.workId} expected ${input.expectedWorkState}, got ${persistedWork.state}`);
      }

      const evidence = this.db.prepare('select id from evidence where attempt_id = ? and work_id = ?')
        .all(input.attempt.id, input.attempt.workId) as Array<{ id: string }>;
      const available = new Set(evidence.map((row) => row.id));
      if (evidenceIds.some((id) => !available.has(id))) {
        throw new Error(`STATE_CONFLICT: evidence does not belong to attempt ${input.attempt.id}`);
      }

      const attemptUpdate = this.db.prepare(`
        update attempts set json = ?, status = ? where id = ? and work_id = ? and status = ?
      `).run(JSON.stringify(input.attempt), input.attempt.status, input.attempt.id, input.attempt.workId,
        input.expectedAttemptStatus);
      if (Number(attemptUpdate.changes) !== 1) {
        throw new Error(`STATE_CONFLICT: attempt ${input.attempt.id} changed during finalization`);
      }
      this.event('attempt.completed', { status: input.attempt.status }, input.attempt.workId, input.attempt.id);
      this.db.prepare(`
        insert into outcomes(id,work_id,attempt_id,outcome,reasons,evidence_ids,finalization_key,created_at)
        values (?,?,?,?,?,?,?,?)
      `).run(newId('O'), input.attempt.workId, input.attempt.id, input.outcome,
        JSON.stringify(input.reasons), JSON.stringify(evidenceIds), finalizationKey, nowIso());
      this.event('outcome.decided', {
        outcome: input.outcome, reasons: input.reasons, evidenceIds,
      }, input.attempt.workId, input.attempt.id);

      let workState = input.workState;
      if (input.outcome === 'SUCCESS'
        && input.attempt.planId && input.attempt.branchId && input.attempt.milestoneId) {
        const activePlan = this.getActivePlan(input.attempt.workId);
        const attemptMatchesActivePlan = activePlan?.id === input.attempt.planId
          && activePlan.branchId === input.attempt.branchId
          && activePlan.contractVersion === input.attempt.contractVersion
          && persistedWork.currentContractVersion === input.attempt.contractVersion;
        if (activePlan && attemptMatchesActivePlan) {
          const milestone = this.getMilestone(activePlan.id, input.attempt.milestoneId);
          if (!milestone) {
            throw new Error(`STATE_CONFLICT: milestone ${input.attempt.milestoneId} is absent from active plan`);
          }
          if (milestone.status !== 'COMPLETED') {
            this.setMilestoneStatus(activePlan.id, milestone.id, 'COMPLETED', input.attempt.id);
            this.event('milestone.completed', {
              planId: activePlan.id, milestoneId: milestone.id, attemptId: input.attempt.id,
            }, input.attempt.workId, input.attempt.id);
          }
          const allRequiredComplete = this.listMilestones(activePlan.id)
            .filter((candidate) => candidate.required)
            .every((candidate) => candidate.status === 'COMPLETED');
          workState = allRequiredComplete ? 'DONE' : 'ACTIVE';
          if (allRequiredComplete) {
            const completedPlan: WorkPlan = { ...activePlan, status: 'COMPLETED' };
            const planUpdate = this.db.prepare("update plans set status = 'COMPLETED', json = ? where id = ? and status = 'ACTIVE'")
              .run(JSON.stringify(completedPlan), activePlan.id);
            if (Number(planUpdate.changes) !== 1) {
              throw new Error(`STATE_CONFLICT: plan ${activePlan.id} changed during finalization`);
            }
            this.event('plan.completed', { planId: activePlan.id }, input.attempt.workId, input.attempt.id);
          }
        } else {
          workState = 'ACTIVE';
        }
      }
      if (workState === 'DONE' && this.getCurrentEvaluationContract(input.attempt.workId)) {
        workState = 'VERIFYING';
      }
      const workUpdate = this.db.prepare('update works set state = ? where id = ? and state = ?')
        .run(workState, input.attempt.workId, input.expectedWorkState);
      if (Number(workUpdate.changes) !== 1) {
        throw new Error(`STATE_CONFLICT: work ${input.attempt.workId} changed during finalization`);
      }
      this.event('work.state_changed', { state: workState }, input.attempt.workId);
      if (workState === 'DONE') this.event('work.completed', {}, input.attempt.workId);
      if (input.outcome === 'BLOCKED' || input.outcome === 'POLICY_VIOLATION') {
        this.event('work.blocked', { reasons: input.reasons }, input.attempt.workId);
      }
    });
  }

  getAttempt(id: string): Attempt | null {
    const r = this.db.prepare('select json from attempts where id = ?').get(id) as { json: string } | undefined;
    return r ? JSON.parse(r.json) as Attempt : null;
  }

  listAttempts(workId: string): Attempt[] {
    const rows = this.db.prepare('select json from attempts where work_id = ? order by number').all(workId) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as Attempt);
  }

  attemptsByStatus(status: AttemptStatus): Attempt[] {
    const rows = this.db.prepare('select json from attempts where status = ?').all(status) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as Attempt);
  }

  // ---- evidence ----
  insertEvidence(e: EvidenceRecord): void {
    this.db.prepare('insert into evidence(id,work_id,attempt_id,type,label,status,data,observed_at) values (?,?,?,?,?,?,?,?)')
      .run(e.id, e.workId, e.attemptId, e.type, e.label, e.status, JSON.stringify(e.data), e.observedAt);
    this.event('evidence.collected', { type: e.type, label: e.label, status: e.status }, e.workId, e.attemptId);
  }

  listEvidence(attemptId: string): EvidenceRecord[] {
    const rows = this.db.prepare('select * from evidence where attempt_id = ? order by observed_at, id').all(attemptId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string, workId: r.work_id as string, attemptId: r.attempt_id as string,
      type: r.type as EvidenceRecord['type'], label: r.label as string,
      status: r.status as EvidenceRecord['status'], data: JSON.parse(r.data as string) as unknown,
      observedAt: r.observed_at as string,
    }));
  }

  // ---- recovery ----
  insertRecoverySession(session: RecoverySession): void {
    this.db.prepare(`
      insert into recovery_sessions(id,work_id,attempt_id,observed_at,evidence_ids,reason,status)
      values (?,?,?,?,?,?,?)
    `).run(session.id, session.workId, session.attemptId, session.observedAt,
      JSON.stringify(session.evidenceIds), session.reason, session.status);
    this.event('recovery.observed', {
      recoverySessionId: session.id, status: session.status,
      evidenceIds: session.evidenceIds, reason: session.reason,
    }, session.workId, session.attemptId);
  }

  listRecoverySessions(workId: string): RecoverySession[] {
    const rows = this.db.prepare(`
      select * from recovery_sessions where work_id = ? order by observed_at, rowid
    `).all(workId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      workId: row.work_id as string,
      attemptId: row.attempt_id as string,
      observedAt: row.observed_at as string,
      evidenceIds: JSON.parse(row.evidence_ids as string) as string[],
      reason: row.reason as string,
      status: row.status as RecoverySession['status'],
    }));
  }

  // ---- plans / milestones ----
  insertPlan(plan: WorkPlan): void {
    this.db.prepare(`
      insert into plans(id,work_id,version,branch_id,contract_version,parent_plan_id,
        source_checkpoint_id,status,json,created_at) values (?,?,?,?,?,?,?,?,?,?)
    `).run(plan.id, plan.workId, plan.version, plan.branchId, plan.contractVersion,
      plan.parentPlanId ?? null, plan.sourceCheckpointId ?? null, plan.status,
      JSON.stringify(plan), plan.createdAt);
    this.event('plan.proposed', {
      planId: plan.id, version: plan.version, branchId: plan.branchId,
      contractVersion: plan.contractVersion,
    }, plan.workId);
  }

  getPlan(id: string): WorkPlan | null {
    const row = this.db.prepare('select json from plans where id = ?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as WorkPlan : null;
  }

  listPlans(workId: string): WorkPlan[] {
    const rows = this.db.prepare('select json from plans where work_id = ? order by version, id')
      .all(workId) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as WorkPlan);
  }

  getActivePlan(workId: string): WorkPlan | null {
    const row = this.db.prepare("select json from plans where work_id = ? and status = 'ACTIVE'")
      .get(workId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as WorkPlan : null;
  }

  activatePlan(id: string): WorkPlan {
    return this.withTransaction(() => {
      const candidate = this.getPlan(id);
      if (!candidate) throw new Error(`PLAN_NOT_FOUND: ${id}`);
      if (candidate.status !== 'VALIDATED') {
        throw new Error(`PLAN_INVALID_STATE: ${id} is ${candidate.status}`);
      }
      const work = this.getWork(candidate.workId);
      if (!work) throw new Error(`PLAN_INVALID: work ${candidate.workId} does not exist`);
      if (work.currentContractVersion !== candidate.contractVersion) {
        throw new Error(`PLAN_STALE: contract v${candidate.contractVersion} is not current v${work.currentContractVersion}`);
      }
      const active = this.getActivePlan(candidate.workId);
      if (candidate.parentPlanId) {
        if (active?.id !== candidate.parentPlanId) {
          throw new Error(`PLAN_STALE: parent ${candidate.parentPlanId} is no longer active`);
        }
      } else if (active) {
        throw new Error(`PLAN_STALE: initial proposal expected no active parent, found ${active.id}`);
      }

      if (active) {
        const superseded: WorkPlan = { ...active, status: 'SUPERSEDED' };
        this.db.prepare("update plans set status = 'SUPERSEDED', json = ? where id = ? and status = 'ACTIVE'")
          .run(JSON.stringify(superseded), active.id);
        this.event('plan.superseded', { planId: active.id, successorPlanId: candidate.id }, candidate.workId);
      }
      const activated: WorkPlan = { ...candidate, status: 'ACTIVE', activatedAt: nowIso() };
      const changed = this.db.prepare("update plans set status = 'ACTIVE', json = ? where id = ? and status = 'VALIDATED'")
        .run(JSON.stringify(activated), candidate.id);
      if (Number(changed.changes) !== 1) throw new Error(`PLAN_STALE: candidate ${candidate.id} changed`);
      this.event('plan.activated', {
        planId: activated.id, branchId: activated.branchId, contractVersion: activated.contractVersion,
      }, activated.workId);
      return activated;
    });
  }

  insertMilestones(milestones: readonly PlanMilestone[]): void {
    const insert = this.db.prepare(`
      insert into milestones(row_id,id,plan_id,sequence,status,json) values (?,?,?,?,?,?)
    `);
    for (const milestone of milestones) {
      insert.run(`${milestone.planId}:${milestone.id}`, milestone.id, milestone.planId,
        milestone.sequence, milestone.status, JSON.stringify(milestone));
    }
  }

  getMilestone(planId: string, milestoneId: string): PlanMilestone | null {
    const row = this.db.prepare('select json from milestones where plan_id = ? and id = ?')
      .get(planId, milestoneId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as PlanMilestone : null;
  }

  listMilestones(planId: string): PlanMilestone[] {
    const rows = this.db.prepare('select json from milestones where plan_id = ? order by sequence, id')
      .all(planId) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as PlanMilestone);
  }

  setMilestoneStatus(
    planId: string,
    milestoneId: string,
    status: PlanMilestone['status'],
    completedAttemptId?: string,
    staleReason?: string,
  ): PlanMilestone {
    const current = this.getMilestone(planId, milestoneId);
    if (!current) throw new Error(`MILESTONE_NOT_FOUND: ${planId}/${milestoneId}`);
    const updated: PlanMilestone = {
      ...current, status,
      completedAttemptId: status === 'COMPLETED' ? completedAttemptId : undefined,
      staleReason: status === 'STALE' ? staleReason : undefined,
    };
    const changed = this.db.prepare('update milestones set status = ?, json = ? where plan_id = ? and id = ?')
      .run(status, JSON.stringify(updated), planId, milestoneId);
    if (Number(changed.changes) !== 1) throw new Error(`MILESTONE_STALE: ${planId}/${milestoneId}`);
    return updated;
  }

  // ---- logical checkpoints ----
  insertCheckpoint(checkpoint: LogicalCheckpoint): void {
    this.db.prepare(`
      insert into checkpoints(id,work_id,plan_id,branch_id,parent_checkpoint_id,
        validation_status,json,created_at) values (?,?,?,?,?,?,?,?)
    `).run(checkpoint.id, checkpoint.workId, checkpoint.planId, checkpoint.branchId,
      checkpoint.parentCheckpointId ?? null, checkpoint.validationStatus,
      JSON.stringify(checkpoint), checkpoint.createdAt);
    this.event('checkpoint.created', {
      checkpointId: checkpoint.id, planId: checkpoint.planId, branchId: checkpoint.branchId,
      validationStatus: checkpoint.validationStatus,
    }, checkpoint.workId);
  }

  getCheckpoint(id: string): LogicalCheckpoint | null {
    const row = this.db.prepare('select json from checkpoints where id = ?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as LogicalCheckpoint : null;
  }

  listCheckpoints(workId: string): LogicalCheckpoint[] {
    const rows = this.db.prepare('select json from checkpoints where work_id = ? order by created_at, rowid')
      .all(workId) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as LogicalCheckpoint);
  }

  // ---- P5 evaluation ledger ----
  insertEvaluationContract(contract: EvaluationContract): void {
    if (!this.getWork(contract.workId)) {
      throw new Error(`EVALUATION_INVALID: work ${contract.workId} does not exist`);
    }
    if (contract.criteria.length === 0) throw new Error('EVALUATION_INVALID: contract has no criteria');
    const criterionIds = contract.criteria.map((criterion) => criterion.id);
    if (new Set(criterionIds).size !== criterionIds.length) {
      throw new Error('EVALUATION_INVALID: criterion identities must be unique');
    }
    this.db.prepare(`
      insert into evaluation_contracts(id,work_id,version,policy_version,json,created_at)
      values (?,?,?,?,?,?)
    `).run(contract.id, contract.workId, contract.version, contract.policyVersion,
      JSON.stringify(contract), contract.createdAt);
    this.event('evaluation.contract_recorded', {
      evaluationContractId: contract.id, version: contract.version,
      policyVersion: contract.policyVersion, criterionIds,
    }, contract.workId);
  }

  getEvaluationContract(id: string): EvaluationContract | null {
    const row = this.db.prepare('select json from evaluation_contracts where id = ?')
      .get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as EvaluationContract : null;
  }

  getCurrentEvaluationContract(workId: string): EvaluationContract | null {
    const row = this.db.prepare(`
      select json from evaluation_contracts where work_id = ? order by version desc limit 1
    `).get(workId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as EvaluationContract : null;
  }

  insertEvaluationRun(run: EvaluationRun): void {
    const contract = this.getEvaluationContract(run.contractId);
    if (!contract || contract.workId !== run.workId) {
      throw new Error(`EVALUATION_INVALID: contract ${run.contractId} does not belong to work ${run.workId}`);
    }
    if (run.attemptId) {
      const attempt = this.getAttempt(run.attemptId);
      if (!attempt || attempt.workId !== run.workId) {
        throw new Error(`EVALUATION_INVALID: attempt ${run.attemptId} does not belong to work ${run.workId}`);
      }
    }
    this.db.prepare(`
      insert into evaluation_runs(id,work_id,contract_id,attempt_id,evaluator_version,status,json,started_at)
      values (?,?,?,?,?,?,?,?)
    `).run(run.id, run.workId, run.contractId, run.attemptId ?? null,
      run.evaluator.version, run.status, JSON.stringify(run), run.startedAt);
    this.event('evaluation.run_recorded', {
      evaluationRunId: run.id, evaluationContractId: run.contractId,
      evaluator: run.evaluator, status: run.status,
    }, run.workId, run.attemptId);
  }

  getEvaluationRun(id: string): EvaluationRun | null {
    const row = this.db.prepare('select json from evaluation_runs where id = ?')
      .get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as EvaluationRun : null;
  }

  listEvaluationRuns(workId: string): EvaluationRun[] {
    const rows = this.db.prepare('select json from evaluation_runs where work_id = ? order by started_at, rowid')
      .all(workId) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as EvaluationRun);
  }

  insertCriterionVerdict(entry: StoredCriterionVerdict): StoredCriterionVerdict {
    const run = this.getEvaluationRun(entry.evaluationRunId);
    if (!run || run.workId !== entry.workId) {
      throw new Error(`EVALUATION_INVALID: run ${entry.evaluationRunId} does not belong to work ${entry.workId}`);
    }
    if (run.evaluator.role !== 'validator' && run.evaluator.role !== 'critic') {
      throw new Error(`EVALUATION_ROLE_INVALID: ${run.evaluator.role} cannot record criterion verdicts`);
    }
    const contract = this.getEvaluationContract(run.contractId);
    const definition = contract?.criteria.find((criterion) => criterion.id === entry.verdict.criterionId);
    if (!contract || !definition) {
      throw new Error(`EVALUATION_INVALID: criterion ${entry.verdict.criterionId} is not in contract ${run.contractId}`);
    }
    const accepted: StoredCriterionVerdict = {
      ...entry,
      verdict: this.validateCriterionVerdict(definition, entry.verdict),
    };
    this.db.prepare(`
      insert into criterion_verdicts(id,work_id,run_id,criterion_id,verdict,json,created_at)
      values (?,?,?,?,?,?,?)
    `).run(accepted.id, accepted.workId, accepted.evaluationRunId,
      accepted.verdict.criterionId, accepted.verdict.verdict, JSON.stringify(accepted), accepted.createdAt);
    this.event('evaluation.verdict_recorded', {
      evaluationRunId: accepted.evaluationRunId, criterionVerdictId: accepted.id,
      criterionId: accepted.verdict.criterionId, verdict: accepted.verdict.verdict,
      reasonCode: accepted.verdict.reasonCode,
    }, accepted.workId, run.attemptId);
    return accepted;
  }

  validateCriterionVerdict(
    definition: CriterionDefinition,
    candidate: CriterionVerdictRecord,
  ): CriterionVerdictRecord {
    const observations = definition.artifactBindings.map((binding) => {
      const artifact = this.readVerifiedArtifact(binding.artifactId);
      return artifact.status === 'verified'
        ? { artifactId: binding.artifactId, sha256: artifact.hash, status: 'verified' as const }
        : { artifactId: binding.artifactId, sha256: binding.sha256, status: artifact.status };
    });
    const accepted = acceptCriterionVerdict(definition, candidate, observations);
    if (accepted.verdict === 'unknown') return accepted;
    for (const artifactId of accepted.evidenceArtifactIds) {
      const artifact = this.readVerifiedArtifact(artifactId);
      if (artifact.status !== 'verified') {
        return {
          ...accepted,
          verdict: 'unknown',
          reasonCode: artifact.status === 'missing' ? 'ARTIFACT_MISSING' : 'ARTIFACT_CORRUPT',
          reason: `evidence artifact ${artifactId} is ${artifact.status}`,
          confidence: undefined,
        };
      }
    }
    return accepted;
  }

  listCriterionVerdicts(evaluationRunId: string): StoredCriterionVerdict[] {
    const rows = this.db.prepare('select json from criterion_verdicts where run_id = ? order by created_at, rowid')
      .all(evaluationRunId) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as StoredCriterionVerdict);
  }

  insertCompletionDecision(decision: CompletionDecisionRecord): void {
    this.db.prepare(`
      insert into completion_decisions(id,work_id,run_id,contract_id,verdict,policy_version,json,created_at)
      values (?,?,?,?,?,?,?,?)
    `).run(decision.id, decision.workId, decision.evaluationRunId, decision.contractId,
      decision.verdict, decision.policyVersion, JSON.stringify(decision), decision.createdAt);
    this.event('evaluation.completed', {
      completionDecisionId: decision.id, evaluationRunId: decision.evaluationRunId,
      verdict: decision.verdict, reasonCodes: decision.reasonCodes,
    }, decision.workId);
  }

  getCompletionDecision(evaluationRunId: string): CompletionDecisionRecord | null {
    const row = this.db.prepare('select json from completion_decisions where run_id = ?')
      .get(evaluationRunId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as CompletionDecisionRecord : null;
  }

  transitionWorkState(id: string, expected: WorkState, state: WorkState): void {
    const changed = this.db.prepare('update works set state = ? where id = ? and state = ?')
      .run(state, id, expected);
    if (Number(changed.changes) !== 1) {
      throw new Error(`STATE_CONFLICT: work ${id} expected ${expected}`);
    }
    this.event('work.state_changed', { state }, id);
    if (state === 'DONE') this.event('work.completed', {}, id);
  }

  insertCriticDispatch(dispatch: CriticDispatch): void {
    this.db.prepare(`
      insert into critic_dispatches(id,work_id,contract_id,evaluation_run_id,trigger_key,
        trigger_type,reservation_id,status,json,created_at) values (?,?,?,?,?,?,?,?,?,?)
    `).run(dispatch.id, dispatch.workId, dispatch.contractId, dispatch.evaluationRunId,
      dispatch.triggerKey, dispatch.trigger.type, dispatch.reservationId,
      dispatch.status, JSON.stringify(dispatch), dispatch.createdAt);
    this.event('critic.dispatch_reserved', {
      criticDispatchId: dispatch.id, evaluationRunId: dispatch.evaluationRunId,
      trigger: dispatch.trigger, reservationId: dispatch.reservationId,
    }, dispatch.workId);
  }

  updateCriticDispatch(dispatch: CriticDispatch): void {
    const changed = this.db.prepare(`
      update critic_dispatches set status = ?, json = ? where id = ? and status = 'RESERVED'
    `).run(dispatch.status, JSON.stringify(dispatch), dispatch.id);
    if (Number(changed.changes) !== 1) {
      throw new Error(`CRITIC_DISPATCH_INVALID_STATE: ${dispatch.id}`);
    }
    this.event('critic.dispatch_completed', {
      criticDispatchId: dispatch.id, evaluationRunId: dispatch.evaluationRunId,
      status: dispatch.status,
    }, dispatch.workId);
  }

  getCriticDispatch(id: string): CriticDispatch | null {
    const row = this.db.prepare('select json from critic_dispatches where id = ?')
      .get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as CriticDispatch : null;
  }

  listCriticDispatches(workId: string): CriticDispatch[] {
    const rows = this.db.prepare('select json from critic_dispatches where work_id = ? order by created_at, rowid')
      .all(workId) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as CriticDispatch);
  }

  // ---- operations / external effects ----
  insertOperation(operation: Operation): void {
    this.db.prepare(`
      insert into operations(id,work_id,intent_key,idempotency_key,status,json,created_at)
      values (?,?,?,?,?,?,?)
    `).run(operation.id, operation.workId, operation.intentKey, operation.idempotencyKey,
      operation.status, JSON.stringify(operation), operation.createdAt);
    this.event('operation.prepared', {
      operationId: operation.id, intentKey: operation.intentKey,
      idempotencyKey: operation.idempotencyKey, status: operation.status,
    }, operation.workId);
  }

  updateOperation(operation: Operation, expectedStatus?: Operation['status']): void {
    const changed = expectedStatus === undefined
      ? this.db.prepare('update operations set status = ?, json = ? where id = ? and work_id = ?')
        .run(operation.status, JSON.stringify(operation), operation.id, operation.workId)
      : this.db.prepare('update operations set status = ?, json = ? where id = ? and work_id = ? and status = ?')
        .run(operation.status, JSON.stringify(operation), operation.id, operation.workId, expectedStatus);
    if (Number(changed.changes) !== 1) {
      if (expectedStatus !== undefined) {
        throw new Error(`STATE_CONFLICT: operation ${operation.id} expected ${expectedStatus}, got ${this.getOperation(operation.id)?.status ?? 'missing'}`);
      }
      throw new Error(`OPERATION_NOT_FOUND: ${operation.id}`);
    }
    this.event('operation.state_changed', {
      operationId: operation.id, status: operation.status,
    }, operation.workId);
  }

  getOperation(id: string): Operation | null {
    const row = this.db.prepare('select json from operations where id = ?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as Operation : null;
  }

  findOperationByIntent(workId: string, intentKey: string): Operation | null {
    const row = this.db.prepare('select json from operations where work_id = ? and intent_key = ?')
      .get(workId, intentKey) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as Operation : null;
  }

  findOperationByIdempotencyKey(idempotencyKey: string): Operation | null {
    const row = this.db.prepare('select json from operations where idempotency_key = ?')
      .get(idempotencyKey) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as Operation : null;
  }

  listOperations(workId: string): Operation[] {
    const rows = this.db.prepare('select json from operations where work_id = ? order by created_at, rowid')
      .all(workId) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as Operation);
  }

  insertOperationAttempt(attempt: OperationAttempt): void {
    this.db.prepare(`
      insert into operation_attempts(id,operation_id,number,status,json,dispatched_at)
      values (?,?,?,?,?,?)
    `).run(attempt.id, attempt.operationId, attempt.number, attempt.status,
      JSON.stringify(attempt), attempt.dispatchedAt);
    const operation = this.getOperation(attempt.operationId);
    this.event('operation.attempt_recorded', {
      operationId: attempt.operationId, operationAttemptId: attempt.id,
      number: attempt.number, status: attempt.status,
    }, operation?.workId);
  }

  updateOperationAttempt(attempt: OperationAttempt, expectedStatus?: OperationAttempt['status']): void {
    const changed = expectedStatus === undefined
      ? this.db.prepare('update operation_attempts set status = ?, json = ? where id = ? and operation_id = ?')
        .run(attempt.status, JSON.stringify(attempt), attempt.id, attempt.operationId)
      : this.db.prepare('update operation_attempts set status = ?, json = ? where id = ? and operation_id = ? and status = ?')
        .run(attempt.status, JSON.stringify(attempt), attempt.id, attempt.operationId, expectedStatus);
    if (Number(changed.changes) !== 1) {
      if (expectedStatus !== undefined) {
        throw new Error(`STATE_CONFLICT: operation attempt ${attempt.id} expected ${expectedStatus}`);
      }
      throw new Error(`OPERATION_ATTEMPT_NOT_FOUND: ${attempt.id}`);
    }
    const operation = this.getOperation(attempt.operationId);
    this.event('operation.attempt_state_changed', {
      operationId: attempt.operationId, operationAttemptId: attempt.id,
      number: attempt.number, status: attempt.status,
    }, operation?.workId);
  }

  listOperationAttempts(operationId: string): OperationAttempt[] {
    const rows = this.db.prepare('select json from operation_attempts where operation_id = ? order by number')
      .all(operationId) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as OperationAttempt);
  }

  insertCompensation(compensation: Compensation): void {
    this.db.prepare(`
      insert into compensations(id,operation_id,work_id,idempotency_key,status,json,created_at)
      values (?,?,?,?,?,?,?)
    `).run(compensation.id, compensation.operationId, compensation.workId,
      compensation.idempotencyKey, compensation.status, JSON.stringify(compensation), compensation.createdAt);
    this.event('compensation.prepared', {
      compensationId: compensation.id, operationId: compensation.operationId,
      status: compensation.status,
    }, compensation.workId);
  }

  updateCompensation(compensation: Compensation, expectedStatus?: Compensation['status']): void {
    const changed = expectedStatus === undefined
      ? this.db.prepare('update compensations set status = ?, json = ? where id = ? and work_id = ?')
        .run(compensation.status, JSON.stringify(compensation), compensation.id, compensation.workId)
      : this.db.prepare('update compensations set status = ?, json = ? where id = ? and work_id = ? and status = ?')
        .run(compensation.status, JSON.stringify(compensation), compensation.id, compensation.workId, expectedStatus);
    if (Number(changed.changes) !== 1) {
      if (expectedStatus !== undefined) {
        throw new Error(`STATE_CONFLICT: compensation ${compensation.id} expected ${expectedStatus}, got ${this.getCompensation(compensation.id)?.status ?? 'missing'}`);
      }
      throw new Error(`COMPENSATION_NOT_FOUND: ${compensation.id}`);
    }
    this.event('compensation.state_changed', {
      compensationId: compensation.id, operationId: compensation.operationId, status: compensation.status,
    }, compensation.workId);
  }

  getCompensation(id: string): Compensation | null {
    const row = this.db.prepare('select json from compensations where id = ?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as Compensation : null;
  }

  getCompensationForOperation(operationId: string): Compensation | null {
    const row = this.db.prepare('select json from compensations where operation_id = ?')
      .get(operationId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as Compensation : null;
  }

  insertCompensationAttempt(attempt: CompensationAttempt): void {
    this.db.prepare(`
      insert into compensation_attempts(id,compensation_id,number,status,json,dispatched_at)
      values (?,?,?,?,?,?)
    `).run(attempt.id, attempt.compensationId, attempt.number, attempt.status,
      JSON.stringify(attempt), attempt.dispatchedAt);
    const compensation = this.getCompensation(attempt.compensationId);
    this.event('compensation.attempt_recorded', {
      compensationId: attempt.compensationId, compensationAttemptId: attempt.id,
      number: attempt.number, status: attempt.status,
    }, compensation?.workId);
  }

  updateCompensationAttempt(attempt: CompensationAttempt, expectedStatus?: CompensationAttempt['status']): void {
    const changed = expectedStatus === undefined
      ? this.db.prepare('update compensation_attempts set status = ?, json = ? where id = ? and compensation_id = ?')
        .run(attempt.status, JSON.stringify(attempt), attempt.id, attempt.compensationId)
      : this.db.prepare('update compensation_attempts set status = ?, json = ? where id = ? and compensation_id = ? and status = ?')
        .run(attempt.status, JSON.stringify(attempt), attempt.id, attempt.compensationId, expectedStatus);
    if (Number(changed.changes) !== 1) {
      if (expectedStatus !== undefined) {
        throw new Error(`STATE_CONFLICT: compensation attempt ${attempt.id} expected ${expectedStatus}`);
      }
      throw new Error(`COMPENSATION_ATTEMPT_NOT_FOUND: ${attempt.id}`);
    }
    const compensation = this.getCompensation(attempt.compensationId);
    this.event('compensation.attempt_state_changed', {
      compensationId: attempt.compensationId, compensationAttemptId: attempt.id,
      number: attempt.number, status: attempt.status,
    }, compensation?.workId);
  }

  listCompensationAttempts(compensationId: string): CompensationAttempt[] {
    const rows = this.db.prepare('select json from compensation_attempts where compensation_id = ? order by number')
      .all(compensationId) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as CompensationAttempt);
  }

  // ---- budget records ----
  insertBudgetLimit(limit: BudgetLimit): void {
    this.db.prepare(`
      insert into budget_limits(id,work_id,resource_kind,currency,json,created_at) values (?,?,?,?,?,?)
    `).run(limit.id, limit.workId, limit.resourceKind, limit.currency ?? '', JSON.stringify(limit), limit.createdAt);
    this.event('budget.limit_configured', {
      limitId: limit.id, resourceKind: limit.resourceKind,
      currency: limit.currency, limitUnits: limit.limitUnits,
    }, limit.workId);
  }

  getBudgetLimit(id: string): BudgetLimit | null {
    const row = this.db.prepare('select json from budget_limits where id = ?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as BudgetLimit : null;
  }

  listBudgetLimits(workId: string): BudgetLimit[] {
    const rows = this.db.prepare('select json from budget_limits where work_id = ? order by created_at, rowid')
      .all(workId) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as BudgetLimit);
  }

  findBudgetLimit(workId: string, resourceKind: string, currency?: string): BudgetLimit | null {
    const row = this.db.prepare(`
      select json from budget_limits where work_id = ? and resource_kind = ? and currency = ?
    `).get(workId, resourceKind, currency ?? '') as { json: string } | undefined;
    return row ? JSON.parse(row.json) as BudgetLimit : null;
  }

  insertBudgetReservation(reservation: BudgetReservation): void {
    this.db.prepare(`
      insert into budget_reservations(id,work_id,limit_id,operation_id,compensation_id,
        evaluation_run_id,status,json,created_at) values (?,?,?,?,?,?,?,?,?)
    `).run(reservation.id, reservation.workId, reservation.limitId,
      reservation.operationId ?? null, reservation.compensationId ?? null,
      reservation.evaluationRunId ?? null, reservation.status, JSON.stringify(reservation), reservation.createdAt);
    this.event('budget.reservation_recorded', {
      reservationId: reservation.id, limitId: reservation.limitId,
      amountUnits: reservation.amountUnits, status: reservation.status,
    }, reservation.workId);
  }

  updateBudgetReservation(reservation: BudgetReservation): void {
    const changed = this.db.prepare(`
      update budget_reservations set status = ?, json = ? where id = ? and work_id = ?
    `).run(reservation.status, JSON.stringify(reservation), reservation.id, reservation.workId);
    if (Number(changed.changes) !== 1) throw new Error(`BUDGET_RESERVATION_NOT_FOUND: ${reservation.id}`);
    this.event('budget.reservation_recorded', {
      reservationId: reservation.id, limitId: reservation.limitId,
      amountUnits: reservation.amountUnits, status: reservation.status,
    }, reservation.workId);
  }

  getBudgetReservation(id: string): BudgetReservation | null {
    const row = this.db.prepare('select json from budget_reservations where id = ?')
      .get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as BudgetReservation : null;
  }

  listBudgetReservations(limitId: string): BudgetReservation[] {
    const rows = this.db.prepare('select json from budget_reservations where limit_id = ? order by created_at, rowid')
      .all(limitId) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as BudgetReservation);
  }

  insertBudgetLedgerEntry(entry: BudgetLedgerEntry): void {
    this.db.prepare(`
      insert into budget_ledger(id,work_id,limit_id,reservation_id,kind,json,created_at)
      values (?,?,?,?,?,?,?)
    `).run(entry.id, entry.workId, entry.limitId, entry.reservationId,
      entry.kind, JSON.stringify(entry), entry.createdAt);
    this.event('budget.ledger_recorded', {
      ledgerEntryId: entry.id, limitId: entry.limitId, reservationId: entry.reservationId,
      kind: entry.kind, reservedDeltaUnits: entry.reservedDeltaUnits,
      spentDeltaUnits: entry.spentDeltaUnits,
    }, entry.workId);
  }

  listBudgetLedger(limitId: string): BudgetLedgerEntry[] {
    const rows = this.db.prepare('select json from budget_ledger where limit_id = ? order by created_at, rowid')
      .all(limitId) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as BudgetLedgerEntry);
  }

  // ---- outcome ----
  insertOutcome(workId: string, attemptId: string, outcome: Outcome, reasons: string[]): void {
    this.db.prepare('insert into outcomes(id,work_id,attempt_id,outcome,reasons,evidence_ids,created_at) values (?,?,?,?,?,?,?)')
      .run(newId('O'), workId, attemptId, outcome, JSON.stringify(reasons), '[]', nowIso());
    this.event('outcome.decided', { outcome, reasons }, workId, attemptId);
  }

  lastOutcome(workId: string): { outcome: Outcome; reasons: string[]; attemptId: string; evidenceIds: string[] } | null {
    const evidenceIds = this.hasOutcomeEvidenceIds ? 'evidence_ids' : `'[]' as evidence_ids`;
    const r = this.db.prepare(`
      select outcome, reasons, attempt_id, ${evidenceIds} from outcomes where work_id = ? order by created_at desc limit 1
    `).get(workId) as { outcome: string; reasons: string; attempt_id: string; evidence_ids: string } | undefined;
    return r ? {
      outcome: r.outcome as Outcome, reasons: JSON.parse(r.reasons) as string[],
      attemptId: r.attempt_id, evidenceIds: JSON.parse(r.evidence_ids) as string[],
    } : null;
  }
}
