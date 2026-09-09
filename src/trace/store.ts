import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { newId, nowIso } from '../ids.ts';
import type {
  Work, WorkContract, Attempt, DecisionRecord, EvidenceRecord,
  Outcome, WorkState, AttemptStatus,
} from '../types.ts';

// §29：append-only trace + artifact store。MVP 不做 Event Sourcing。
export type EventType =
  | 'work.created' | 'message.received' | 'work_contract.versioned'
  | 'decision.recorded' | 'context_manifest.created'
  | 'skill.admission_allowed' | 'skill.admission_denied'
  | 'prompt.compiled' | 'attempt.started' | 'attempt.completed'
  | 'runtime.protocol_failed' | 'evidence.collected' | 'outcome.decided'
  | 'work.completed' | 'work.blocked' | 'work.state_changed'
  | 'recovery.required'
  | 'usage.note';   // 人對結果的判讀 —— 機器不知道 evidence 判錯了，只有人知道

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
  outcome text not null, reasons text not null, created_at text not null);
create table if not exists messages(
  id text primary key, work_id text, role text not null, text text not null, created_at text not null);
create table if not exists events(
  seq integer primary key autoincrement, type text not null, work_id text,
  attempt_id text, data text not null, created_at text not null);
create table if not exists artifacts(
  id text primary key, kind text not null, hash text not null,
  path text not null, bytes integer not null, created_at text not null);
create index if not exists idx_attempts_work on attempts(work_id);
create index if not exists idx_evidence_attempt on evidence(attempt_id);
create index if not exists idx_events_work on events(work_id);
`;

export class Store {
  readonly db: DatabaseSync;
  readonly artifactDir: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.artifactDir = join(stateDir, 'artifacts');
    mkdirSync(this.artifactDir, { recursive: true });
    this.db = new DatabaseSync(join(stateDir, 'harness.db'));
    this.db.exec('pragma journal_mode = WAL');
    this.db.exec('pragma foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void { this.db.close(); }

  // ---- trace ----
  event(type: EventType, data: unknown, workId?: string, attemptId?: string): void {
    this.db.prepare('insert into events(type, work_id, attempt_id, data, created_at) values (?,?,?,?,?)')
      .run(type, workId ?? null, attemptId ?? null, JSON.stringify(data ?? {}), nowIso());
  }

  events(workId: string): Array<{ seq: number; type: string; data: string; created_at: string; attempt_id: string | null }> {
    return this.db.prepare('select seq, type, data, created_at, attempt_id from events where work_id = ? order by seq')
      .all(workId) as never;
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
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const hash = createHash('sha256').update(buf).digest('hex');
    const id = newId('AR');
    const path = join(this.artifactDir, `${hash.slice(0, 16)}.${ext}`);
    if (!existsSync(path)) writeFileSync(path, buf);
    this.db.prepare('insert into artifacts(id, kind, hash, path, bytes, created_at) values (?,?,?,?,?,?)')
      .run(id, kind, hash, path, buf.length, nowIso());
    return { id, hash, path };
  }

  readArtifact(id: string): string | null {
    const row = this.db.prepare('select path from artifacts where id = ?').get(id) as { path: string } | undefined;
    return row && existsSync(row.path) ? readFileSync(row.path, 'utf8') : null;
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

  // ---- outcome ----
  insertOutcome(workId: string, attemptId: string, outcome: Outcome, reasons: string[]): void {
    this.db.prepare('insert into outcomes(id,work_id,attempt_id,outcome,reasons,created_at) values (?,?,?,?,?,?)')
      .run(newId('O'), workId, attemptId, outcome, JSON.stringify(reasons), nowIso());
    this.event('outcome.decided', { outcome, reasons }, workId, attemptId);
  }

  lastOutcome(workId: string): { outcome: Outcome; reasons: string[]; attemptId: string } | null {
    const r = this.db.prepare('select outcome, reasons, attempt_id from outcomes where work_id = ? order by created_at desc limit 1')
      .get(workId) as { outcome: string; reasons: string; attempt_id: string } | undefined;
    return r ? { outcome: r.outcome as Outcome, reasons: JSON.parse(r.reasons) as string[], attemptId: r.attempt_id } : null;
  }
}
