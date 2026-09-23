import { accessClassOf } from './redaction.ts';
import { referencedArtifactIds, RETENTION_POLICY } from './retention.ts';
import type { Store } from './store.ts';

export interface TraceSpan {
  spanId: string;
  kind: string;
  workId: string;
  startedAt: string;
  /** Authoritative ledger records are never sampled out. */
  authoritative: boolean;
  /** First event of the Work that names this record: what caused it. */
  causationEventSeq: number | null;
  links: Array<{ spanId: string; relation: string }>;
  accessClass?: 'restricted' | 'internal';
}

/** Each source yields id, work_id, at, and link columns; `?` is the Work id. */
const SOURCES: Array<{ kind: string; sql: string; links: Record<string, string> }> = [
  { kind: 'event', sql: "select 'event:' || seq as id, work_id, created_at as at from events where work_id = ?", links: {} },
  {
    kind: 'attempt', links: { retry_of: 'retries' },
    sql: "select id, work_id, started_at as at, json_extract(json, '$.retryOf') as retry_of from attempts where work_id = ?",
  },
  {
    kind: 'plan', links: { parent_plan_id: 'revises', source_checkpoint_id: 'forked_from' },
    sql: 'select id, work_id, created_at as at, parent_plan_id, source_checkpoint_id from plans where work_id = ?',
  },
  {
    kind: 'checkpoint', links: { plan_id: 'checkpoint_of', parent_checkpoint_id: 'follows' },
    sql: 'select id, work_id, created_at as at, plan_id, parent_checkpoint_id from checkpoints where work_id = ?',
  },
  { kind: 'operation', sql: 'select id, work_id, created_at as at from operations where work_id = ?', links: {} },
  {
    kind: 'operation_attempt', links: { operation_id: 'attempt_of' },
    sql: `select a.id, o.work_id, a.dispatched_at as at, a.operation_id from operation_attempts a
      join operations o on o.id = a.operation_id where o.work_id = ?`,
  },
  {
    kind: 'compensation', links: { operation_id: 'compensates' },
    sql: 'select id, work_id, created_at as at, operation_id from compensations where work_id = ?',
  },
  {
    kind: 'compensation_attempt', links: { compensation_id: 'attempt_of' },
    sql: `select a.id, c.work_id, a.dispatched_at as at, a.compensation_id from compensation_attempts a
      join compensations c on c.id = a.compensation_id where c.work_id = ?`,
  },
  {
    kind: 'budget_reservation',
    links: { operation_id: 'reserves_for', compensation_id: 'reserves_for', evaluation_run_id: 'reserves_for' },
    sql: `select id, work_id, created_at as at, operation_id, compensation_id, evaluation_run_id
      from budget_reservations where work_id = ?`,
  },
  {
    kind: 'budget_ledger', links: { reservation_id: 'settles' },
    sql: 'select id, work_id, created_at as at, reservation_id from budget_ledger where work_id = ?',
  },
  { kind: 'evaluation_contract', sql: 'select id, work_id, created_at as at from evaluation_contracts where work_id = ?', links: {} },
  {
    kind: 'evaluation_run', links: { attempt_id: 'evaluates', contract_id: 'under_contract' },
    sql: 'select id, work_id, started_at as at, attempt_id, contract_id from evaluation_runs where work_id = ?',
  },
  {
    kind: 'criterion_verdict', links: { run_id: 'verdict_of' },
    sql: 'select id, work_id, created_at as at, run_id from criterion_verdicts where work_id = ?',
  },
  {
    kind: 'completion_decision', links: { run_id: 'decides' },
    sql: 'select id, work_id, created_at as at, run_id from completion_decisions where work_id = ?',
  },
  {
    kind: 'critic_dispatch', links: { evaluation_run_id: 'dispatches', reservation_id: 'reserved_by' },
    sql: 'select id, work_id, created_at as at, evaluation_run_id, reservation_id from critic_dispatches where work_id = ?',
  },
];

/**
 * Builds the causal span graph of one Work from authoritative records. Sampling only ever drops
 * raw-log artifact spans; every ledger record (events, operations, budget, evaluation) is kept.
 */
export function traceWork(store: Store, workId: string, options: { sampleRate?: number; random?: () => number } = {}): {
  workId: string; spans: TraceSpan[]; sampling: { rate: number; keptOptional: number; droppedOptional: number };
} {
  const rate = options.sampleRate ?? 1;
  if (!(rate >= 0 && rate <= 1)) throw new Error(`TRACE_SAMPLE_RATE_INVALID: ${rate}`);
  const random = options.random ?? Math.random;
  const events = store.db.prepare('select seq, data from events where work_id = ? order by seq')
    .all(workId) as Array<{ seq: number; data: string }>;
  const causation = (id: string): number | null => {
    const event = events.find((candidate) => candidate.data.split(/[^A-Za-z0-9_-]+/).includes(id));
    return event ? Number(event.seq) : null;
  };

  const spans: TraceSpan[] = [];
  for (const source of SOURCES) {
    for (const row of store.db.prepare(source.sql).all(workId) as Array<Record<string, unknown>>) {
      const spanId = String(row.id);
      spans.push({
        spanId, kind: source.kind, workId, startedAt: String(row.at), authoritative: true,
        causationEventSeq: source.kind === 'event' ? Number(spanId.slice('event:'.length)) : causation(spanId),
        links: Object.entries(source.links).flatMap(([column, relation]) =>
          typeof row[column] === 'string' ? [{ spanId: row[column], relation }] : []),
      });
    }
  }
  let keptOptional = 0;
  let droppedOptional = 0;
  const artifactRow = store.db.prepare('select kind, created_at from artifacts where id = ?');
  for (const artifactId of referencedArtifactIds(store, workId)) {
    const artifact = artifactRow.get(artifactId) as { kind: string; created_at: string };
    const authoritative = !(RETENTION_POLICY.rawLogKinds as readonly string[]).includes(artifact.kind);
    if (!authoritative) {
      if (random() >= rate) { droppedOptional += 1; continue; }
      keptOptional += 1;
    }
    spans.push({
      spanId: artifactId, kind: `artifact:${artifact.kind}`, workId, startedAt: artifact.created_at, authoritative,
      causationEventSeq: causation(artifactId), links: [], accessClass: accessClassOf(artifact.kind),
    });
  }
  return { workId, spans, sampling: { rate, keptOptional, droppedOptional } };
}
