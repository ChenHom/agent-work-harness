import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { newId, nowIso } from '../ids.ts';
import type { ExecutionOwnership } from '../runtime/ownership.ts';
import type { Store } from './store.ts';

const DAY_MS = 86_400_000;

/**
 * Retention policy v1. `null` means the record class is never collected by this version.
 * Windows run from a Work's last recorded activity; only artifact payload bytes are ever deleted,
 * and each deletion leaves a tombstone (hash, kind, size, time, gc run) in the database.
 */
export const RETENTION_POLICY = {
  version: '1',
  classes: {
    active: ['ACTIVE', 'RUNNING', 'VERIFYING'],
    // Any other state, and DONE/FAILED Work that still has an unresolved effect, is resumable.
    resumable: ['WAITING_USER', 'BLOCKED'],
    archived: ['DONE', 'FAILED'],
  },
  windowsMs: {
    dbRecords: null, receipts: null, idempotencyKeys: null, tombstones: null,
    artifacts: 30 * DAY_MS, rawLogs: 7 * DAY_MS, orphanGrace: DAY_MS,
  },
  rawLogKinds: ['prompt', 'runtime_stdout', 'runtime_stderr', 'runtime_raw_result', 'durable-model-output'],
  effectEvidenceKinds: [
    'operation-input', 'operation-receipt', 'operation-reconciliation',
    'compensation-receipt', 'compensation-reconciliation',
  ],
} as const;

type RetentionClass = 'active' | 'resumable' | 'archived';

export interface GcManifest {
  schemaVersion: '1';
  policyVersion: string;
  /** Also the instant every window is evaluated at. */
  createdAt: string;
  roots: Array<{ id: string; retention: RetentionClass | 'global'; reason: string }>;
  references: Array<{ artifactId: string; retainedBy: string[] }>;
  candidates: Array<{
    path: string; hash: string; bytes: number;
    artifacts: Array<{ id: string; kind: string; reason: string }>;
  }>;
  unsafeRecovery: Array<{ workId: string; recordId: string; reason: string }>;
  hash: string;
}

export interface GcRunResult { gcRunId: string; deletedPaths: string[]; tombstonedArtifactIds: string[] }

interface ArtifactRow { id: string; kind: string; hash: string; path: string; bytes: number; created_at: string }
interface WorkRetention { workId: string; retention: RetentionClass; reason: string; lastActivity: number }
interface UnresolvedEffect { workId: string; recordId: string; dedupeExpiresAt?: string }

const sha256 = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');

/** Unparseable timestamps never expire: retention must fail toward keeping data. */
const time = (iso: string | null | undefined): number => {
  const parsed = Date.parse(iso ?? '');
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
};

function unresolvedEffects(store: Store): UnresolvedEffect[] {
  const rows = store.db.prepare(`
    select work_id, id, json from operations where status not in ('SUCCEEDED', 'FAILED')
    union all select work_id, id, json from compensations where status not in ('SUCCEEDED', 'FAILED')
    union all select work_id, id, json from budget_reservations where status in ('HELD', 'UNKNOWN')
    union all select work_id, id, json from critic_dispatches where status = 'RESERVED'
    union all select work_id, id, json from evaluation_runs where status = 'RUNNING'
    order by 1, 2`).all() as Array<{ work_id: string; id: string; json: string }>;
  return rows.map((row) => ({
    workId: row.work_id, recordId: row.id,
    dedupeExpiresAt: (JSON.parse(row.json) as { dedupeExpiresAt?: string }).dedupeExpiresAt,
  }));
}

function classifyWorks(store: Store): Map<string, WorkRetention> {
  const unresolved = unresolvedEffects(store);
  const rows = store.db.prepare(`
    select w.id, w.state, w.created_at, (select max(e.created_at) from events e where e.work_id = w.id) as last_event
    from works w order by w.id`).all() as Array<{ id: string; state: string; created_at: string; last_event: string | null }>;
  const works = new Map<string, WorkRetention>();
  for (const row of rows) {
    const lastActivity = Math.max(time(row.created_at), row.last_event === null ? 0 : time(row.last_event));
    const pending = unresolved.filter((effect) => effect.workId === row.id).map((effect) => effect.recordId);
    let retention: RetentionClass;
    let reason: string;
    if ((RETENTION_POLICY.classes.active as readonly string[]).includes(row.state)) {
      retention = 'active'; reason = `state ${row.state}`;
    } else if (!(RETENTION_POLICY.classes.archived as readonly string[]).includes(row.state)) {
      retention = 'resumable'; reason = `state ${row.state}`;
    } else if (pending.length > 0) {
      retention = 'resumable'; reason = `state ${row.state} with unresolved ${pending.join(',')}`;
    } else {
      retention = 'archived'; reason = `state ${row.state}, every effect resolved`;
    }
    works.set(row.id, { workId: row.id, retention, reason, lastActivity });
  }
  return works;
}

/** Child tables without work_id, resolved through their parent row. */
const PARENTS: Record<string, [column: string, table: string]> = {
  milestones: ['plan_id', 'plans'],
  operation_attempts: ['operation_id', 'operations'],
  compensation_attempts: ['compensation_id', 'compensations'],
};
const NOT_REFERENCES = new Set(['artifacts', 'artifact_tombstones', 'gc_runs', 'sqlite_sequence']);

/**
 * Every artifact id that appears anywhere in any other table's row counts as a reference from the
 * row's Work, or from `global` when no Work can be resolved. A new table is covered automatically.
 */
// ponytail: full-table token scan; add an explicit reference index if the DB outgrows memory.
function scanReferences(store: Store, artifactIds: ReadonlySet<string>): Map<string, Set<string>> {
  const tables = (store.db.prepare("select name from sqlite_master where type = 'table' order by name")
    .all() as Array<{ name: string }>).map((row) => row.name).filter((name) => !NOT_REFERENCES.has(name));
  const ownerOf = new Map<string, Map<string, string>>();
  for (const [, parent] of Object.values(PARENTS)) {
    ownerOf.set(parent, new Map((store.db.prepare(`select id, work_id from ${parent}`)
      .all() as Array<{ id: string; work_id: string }>).map((row) => [row.id, row.work_id])));
  }
  const references = new Map<string, Set<string>>();
  for (const table of tables) {
    for (const row of store.db.prepare(`select * from ${table}`).all() as Array<Record<string, unknown>>) {
      const parent = PARENTS[table];
      const owner = parent ? ownerOf.get(parent[1])?.get(String(row[parent[0]])) : row.work_id;
      const source = typeof owner === 'string' ? owner : 'global';
      for (const token of Object.values(row).map(String).join(' ').split(/[^A-Za-z0-9_-]+/)) {
        if (!artifactIds.has(token)) continue;
        const sources = references.get(token) ?? new Set<string>();
        sources.add(source);
        references.set(token, sources);
      }
    }
  }
  return references;
}

function manifestHash(manifest: Omit<GcManifest, 'hash'>): string {
  return sha256(JSON.stringify(manifest));
}

function computeManifest(store: Store, now: number, payloadExists: (path: string) => boolean): GcManifest {
  const works = classifyWorks(store);
  const artifacts = store.db.prepare('select id, kind, hash, path, bytes, created_at from artifacts order by id')
    .all() as unknown as ArtifactRow[];
  const tombstoned = new Set((store.db.prepare('select artifact_id from artifact_tombstones')
    .all() as Array<{ artifact_id: string }>).map((row) => row.artifact_id));
  const references = scanReferences(store, new Set(artifacts.map((artifact) => artifact.id)));
  const { windowsMs } = RETENTION_POLICY;

  const decide = (artifact: ArtifactRow): { retainedBy: string[]; reason: string } => {
    const retainedBy: string[] = [];
    const expired: string[] = [];
    if ((RETENTION_POLICY.effectEvidenceKinds as readonly string[]).includes(artifact.kind)) {
      retainedBy.push(`effect-evidence:${artifact.kind}`);
    }
    const rawLog = (RETENTION_POLICY.rawLogKinds as readonly string[]).includes(artifact.kind);
    const window = rawLog ? windowsMs.rawLogs : windowsMs.artifacts;
    for (const source of [...references.get(artifact.id) ?? []].sort()) {
      const work = works.get(source);
      if (!work) retainedBy.push(source === 'global' ? 'global-record' : `unknown-work:${source}`);
      else if (work.retention !== 'archived') retainedBy.push(`work:${source}:${work.retention}`);
      else if (now < work.lastActivity + window) retainedBy.push(`work:${source}:archived-within-window`);
      else expired.push(`work:${source} archived past ${rawLog ? 'raw-log' : 'artifact'} window`);
    }
    if (!references.has(artifact.id) && now < time(artifact.created_at) + windowsMs.orphanGrace) {
      retainedBy.push('orphan-grace');
    }
    return { retainedBy, reason: expired.length > 0 ? expired.join('; ') : 'unreferenced past orphan grace' };
  };

  const retainedRefs: GcManifest['references'] = [];
  const candidates: GcManifest['candidates'] = [];
  const byPath = new Map<string, ArtifactRow[]>();
  for (const artifact of artifacts) byPath.set(artifact.path, [...byPath.get(artifact.path) ?? [], artifact]);
  for (const [path, group] of [...byPath].sort(([left], [right]) => left.localeCompare(right))) {
    // A row pointing outside the artifact directory is corrupt; never derive a deletion target from it.
    if (dirname(resolve(path)) !== resolve(store.artifactDir)) continue;
    const live = group.filter((artifact) => !tombstoned.has(artifact.id));
    const decisions = live.map((artifact) => ({ artifact, ...decide(artifact) }));
    for (const decision of decisions) {
      if (decision.retainedBy.length > 0) retainedRefs.push({ artifactId: decision.artifact.id, retainedBy: decision.retainedBy });
    }
    // Content-addressed: one file backs every artifact id with the same bytes, so all must be collectable.
    if (!decisions.every((decision) => decision.retainedBy.length === 0) || !payloadExists(path)) continue;
    const first = group[0]!;
    candidates.push({
      path: basename(path), hash: first.hash, bytes: first.bytes,
      // Empty when every id is already tombstoned: a remnant left by a GC interrupted before unlink.
      artifacts: decisions.map((decision) => ({ id: decision.artifact.id, kind: decision.artifact.kind, reason: decision.reason })),
    });
  }

  const roots: GcManifest['roots'] = [
    { id: 'global', retention: 'global', reason: 'records without a Work are always retained' },
    ...[...works.values()].map((work) => ({ id: work.workId, retention: work.retention, reason: work.reason })),
  ];
  const unsafeRecovery = unresolvedEffects(store)
    .filter((effect) => effect.dedupeExpiresAt !== undefined && time(effect.dedupeExpiresAt) <= now)
    .map((effect) => ({ workId: effect.workId, recordId: effect.recordId, reason: 'IDEMPOTENCY_WINDOW_EXPIRED' }));
  const body = {
    schemaVersion: '1' as const, policyVersion: RETENTION_POLICY.version, createdAt: new Date(now).toISOString(),
    roots, references: retainedRefs, candidates, unsafeRecovery,
  };
  return { ...body, hash: manifestHash(body) };
}

/** Tombstones keep identity, hash, kind, size and times so causal history survives; bytes do not. */
export function insertTombstone(store: Store, artifactId: string, deletion: {
  deletedAt: string; deletionId: string; cause: 'retention' | 'redaction'; authority: string; reason: string;
}): void {
  store.db.prepare(`insert into artifact_tombstones (artifact_id, hash, kind, bytes, artifact_created_at,
      deleted_at, deletion_id, cause, authority, reason, replay_limitation)
    select id, hash, kind, bytes, created_at, ?, ?, ?, ?, ?, ? from artifacts where id = ?`).run(
    deletion.deletedAt, deletion.deletionId, deletion.cause, deletion.authority, deletion.reason,
    'payload bytes deleted; replay and re-validation of this artifact are no longer possible', artifactId);
}

/** Dry run: computes the manifest and changes nothing. */
export function previewGc(store: Store, now = Date.now()): GcManifest {
  return computeManifest(store, now, (path) => existsSync(path));
}

/**
 * Deletes exactly the manifest's payloads, and only if the manifest is intact and every candidate is
 * still unreachable with unchanged bytes. Deletion evidence and tombstones are committed before unlink.
 */
export function applyGc(store: Store, manifest: GcManifest, ownership: ExecutionOwnership, now = Date.now()): GcRunResult {
  if (!ownership.validate()) throw new Error('GC_OWNERSHIP_REQUIRED: apply needs the state execution lock');
  const { hash, ...body } = manifest;
  if (manifestHash(body) !== hash) throw new Error('GC_MANIFEST_TAMPERED: manifest hash does not match its content');
  if (manifest.policyVersion !== RETENTION_POLICY.version) {
    throw new Error(`GC_POLICY_MISMATCH: manifest ${manifest.policyVersion}, runtime ${RETENTION_POLICY.version}`);
  }
  // The execution lock excludes a concurrent GC, so checking once before any file access is enough.
  if (store.db.prepare('select 1 from gc_runs where manifest_hash = ?').get(hash)) {
    throw new Error(`GC_MANIFEST_ALREADY_APPLIED: ${hash}`);
  }
  for (const candidate of manifest.candidates) {
    const path = join(store.artifactDir, candidate.path);
    let content: Buffer;
    try {
      content = readFileSync(path);
    } catch {
      throw new Error(`GC_MANIFEST_STALE: ${candidate.path} is no longer present`);
    }
    if (content.length !== candidate.bytes || sha256(content) !== candidate.hash) {
      throw new Error(`GC_PAYLOAD_CHANGED: ${candidate.path}`);
    }
  }
  const gcRunId = newId('GC');
  const appliedAt = nowIso();
  const tombstonedArtifactIds = manifest.candidates.flatMap((candidate) => candidate.artifacts.map((artifact) => artifact.id));
  store.withTransaction(() => {
    // Candidate paths were verified above; recomputation only needs to agree on reachability.
    const current = new Map(computeManifest(store, now, () => true).candidates.map((candidate) => [candidate.path, candidate]));
    for (const candidate of manifest.candidates) {
      const latest = current.get(candidate.path);
      const ids = (entry: GcManifest['candidates'][number]) => entry.artifacts.map((artifact) => artifact.id).join();
      if (!latest || latest.hash !== candidate.hash || ids(latest) !== ids(candidate)) {
        throw new Error(`GC_MANIFEST_STALE: ${candidate.path} is reachable or changed since preview`);
      }
    }
    store.db.prepare(`insert into gc_runs(id, manifest_hash, policy_version, manifest_json, deleted_json, applied_at)
      values (?,?,?,?,?,?)`).run(gcRunId, hash, manifest.policyVersion, JSON.stringify(manifest),
      JSON.stringify(manifest.candidates.map((candidate) => candidate.path)), appliedAt);
    for (const candidate of manifest.candidates) {
      for (const artifact of candidate.artifacts) {
        insertTombstone(store, artifact.id, {
          deletedAt: appliedAt, deletionId: gcRunId, cause: 'retention',
          authority: `retention-policy:${manifest.policyVersion}`, reason: artifact.reason,
        });
      }
    }
    store.event('retention.gc_applied', {
      gcRunId, manifestHash: hash, policyVersion: manifest.policyVersion,
      deletedPaths: manifest.candidates.length, tombstones: tombstonedArtifactIds.length,
    });
  });
  // ponytail: a crash here leaves tombstoned bytes on disk; the next preview lists them as remnants.
  for (const candidate of manifest.candidates) rmSync(join(store.artifactDir, candidate.path), { force: true });
  return { gcRunId, deletedPaths: manifest.candidates.map((candidate) => candidate.path), tombstonedArtifactIds };
}

/** Artifact id → Work ids (or `global`) whose records mention it. One full scan; reuse it across Works. */
export function artifactReferences(store: Store): Map<string, Set<string>> {
  return scanReferences(store, new Set((store.db.prepare('select id from artifacts').all() as Array<{ id: string }>).map((row) => row.id)));
}

/** Artifact ids that any record owned by the Work mentions. */
export function referencedArtifactIds(store: Store, workId: string, references = artifactReferences(store)): string[] {
  return [...references].filter(([, sources]) => sources.has(workId)).map(([artifactId]) => artifactId).sort();
}

/**
 * Whether a Work's history can still be resumed or replayed. Deleted or damaged payloads make it
 * `unavailable`; an unresolved effect past its idempotency window makes it `unsafe`.
 */
export function inspectRecoverability(store: Store, workId: string, now = Date.now(), references = artifactReferences(store)): {
  workId: string; status: 'available' | 'unsafe' | 'unavailable'; reasons: string[];
} {
  const unavailable = referencedArtifactIds(store, workId, references).flatMap((artifactId) => {
    const artifact = store.readVerifiedArtifact(artifactId);
    return artifact.status === 'verified' ? [] : [`ARTIFACT_${artifact.status.toUpperCase()}:${artifactId}:${artifact.reason ?? 'unknown'}`];
  });
  const unsafe = unresolvedEffects(store)
    .filter((effect) => effect.workId === workId && effect.dedupeExpiresAt !== undefined && time(effect.dedupeExpiresAt) <= now)
    .map((effect) => `IDEMPOTENCY_WINDOW_EXPIRED:${effect.recordId}`);
  return {
    workId,
    status: unavailable.length > 0 ? 'unavailable' : unsafe.length > 0 ? 'unsafe' : 'available',
    reasons: [...unavailable, ...unsafe],
  };
}
