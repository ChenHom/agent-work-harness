import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BudgetLedger } from '../budget/ledger.ts';
import { decideGlobalVerdict } from '../evaluation/criteria.ts';
import { CURRENT_SCHEMA_VERSION } from './migrations.ts';
import { accessClassOf } from './redaction.ts';
import { artifactReferences, inspectRecoverability } from './retention.ts';
import { Store } from './store.ts';

const MANIFEST_FILE = 'backup-manifest.json';
const DB_FILE = 'harness.db';

export interface BackupManifest {
  schemaVersion: '1';
  createdAt: string;
  db: { file: string; bytes: number; sha256: string; schemaVersion: number };
  artifacts: Array<{ path: string; sha256: string; bytes: number; accessClass: 'restricted' | 'internal'; artifactIds: string[] }>;
  /** Payloads the source no longer had: restored history that needs them is classified, not repaired. */
  notCopied: Array<{ path: string; artifactIds: string[]; reason: 'tombstoned' | 'missing_at_source' | 'corrupt_at_source' }>;
  /** Causal roots: restore must reproduce exactly these Works, event high-water mark, and row counts. */
  roots: { works: Array<{ id: string; state: string }>; maxEventSeq: number; rowCounts: Record<string, number> };
  hash: string;
}

export interface RestoreReport {
  manifestHash: string;
  fromSchemaVersion: number;
  toSchemaVersion: number;
  artifacts: { verified: number; tombstoned: number; missingAtSource: number };
  audit: { completionDecisions: number; budgetLimits: number };
  works: Array<{ workId: string; replay: 'compatible' | 'expired' | 'unreplayable'; reasons: string[] }>;
}

const sha256 = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');
const bodyHash = (manifest: Omit<BackupManifest, 'hash'>): string => sha256(JSON.stringify(manifest));
const isEmptyOrAbsent = (dir: string): boolean => !existsSync(dir) || readdirSync(dir).length === 0;

function causalRoots(db: DatabaseSync): BackupManifest['roots'] {
  const tables = (db.prepare("select name from sqlite_master where type = 'table' and name != 'sqlite_sequence' order by name")
    .all() as Array<{ name: string }>).map((row) => row.name);
  return {
    works: (db.prepare('select id, state from works order by id').all() as Array<{ id: string; state: string }>)
      .map(({ id, state }) => ({ id, state })),
    maxEventSeq: Number((db.prepare('select coalesce(max(seq), 0) as seq from events').get() as { seq: number }).seq),
    rowCounts: Object.fromEntries(tables.map((table) =>
      [table, Number((db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n)])),
  };
}

/**
 * Consistent DB snapshot (VACUUM INTO) plus every payload it references. Artifact files are immutable
 * and content-addressed, so copying after the snapshot is consistent. The manifest is written last:
 * a directory without a valid manifest is an incomplete backup and cannot be restored.
 */
export function createBackup(store: Store, targetDir: string, now = Date.now()): BackupManifest {
  if (!isEmptyOrAbsent(targetDir)) throw new Error(`BACKUP_TARGET_NOT_EMPTY: ${targetDir}`);
  const staging = `${targetDir}.partial-${randomUUID()}`;
  mkdirSync(join(staging, 'artifacts'), { recursive: true });
  try {
    const dbPath = join(staging, DB_FILE);
    store.db.prepare('vacuum into ?').run(dbPath);
    const snapshot = new DatabaseSync(dbPath, { readOnly: true });
    let body: Omit<BackupManifest, 'hash'>;
    try {
      const hasTombstones = snapshot.prepare("select 1 from sqlite_master where type = 'table' and name = 'artifact_tombstones'").get();
      const tombstoned = new Set(hasTombstones
        ? (snapshot.prepare('select artifact_id from artifact_tombstones').all() as Array<{ artifact_id: string }>).map((row) => row.artifact_id)
        : []);
      const groups = new Map<string, Array<{ id: string; kind: string; hash: string }>>();
      for (const row of snapshot.prepare('select id, kind, hash, path from artifacts order by id').all() as Array<{ id: string; kind: string; hash: string; path: string }>) {
        const name = basename(row.path);
        groups.set(name, [...groups.get(name) ?? [], row]);
      }
      const artifacts: BackupManifest['artifacts'] = [];
      const notCopied: BackupManifest['notCopied'] = [];
      for (const [name, rows] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
        const artifactIds = rows.map((row) => row.id);
        if (rows.every((row) => tombstoned.has(row.id))) { notCopied.push({ path: name, artifactIds, reason: 'tombstoned' }); continue; }
        let content: Buffer;
        try {
          content = readFileSync(join(store.artifactDir, name));
        } catch {
          notCopied.push({ path: name, artifactIds, reason: 'missing_at_source' });
          continue;
        }
        if (sha256(content) !== rows[0]!.hash) { notCopied.push({ path: name, artifactIds, reason: 'corrupt_at_source' }); continue; }
        writeFileSync(join(staging, 'artifacts', name), content);
        const restricted = rows.some((row) => accessClassOf(row.kind) === 'restricted');
        artifacts.push({ path: name, sha256: rows[0]!.hash, bytes: content.length, accessClass: restricted ? 'restricted' : 'internal', artifactIds });
      }
      const dbBytes = readFileSync(dbPath);
      body = {
        schemaVersion: '1', createdAt: new Date(now).toISOString(),
        db: {
          file: DB_FILE, bytes: dbBytes.length, sha256: sha256(dbBytes),
          schemaVersion: (snapshot.prepare('pragma user_version').get() as { user_version: number }).user_version,
        },
        artifacts, notCopied, roots: causalRoots(snapshot),
      };
    } finally {
      snapshot.close();
    }
    const manifest = { ...body, hash: bodyHash(body) };
    writeFileSync(join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true });
    renameSync(staging, targetDir);
    return manifest;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Throws BACKUP_INVALID unless the manifest, DB file, and every copied payload match their hashes. */
export function verifyBackup(backupDir: string): BackupManifest {
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(join(backupDir, MANIFEST_FILE), 'utf8')) as BackupManifest;
  } catch {
    throw new Error('BACKUP_INVALID: manifest missing or unreadable (incomplete backup)');
  }
  const { hash, ...body } = manifest;
  if (bodyHash(body) !== hash) throw new Error('BACKUP_INVALID: manifest hash mismatch');
  // The self-hash is not a signature: names from the manifest must not be able to leave the backup.
  if (manifest.db.file !== DB_FILE) throw new Error(`BACKUP_INVALID: unexpected database file ${manifest.db.file}`);
  const badName = manifest.artifacts.find((artifact) => !/^[0-9a-f]{64}\.[A-Za-z0-9_-]+$/.test(artifact.path)
    || !artifact.path.startsWith(`${artifact.sha256}.`));
  if (badName) throw new Error(`BACKUP_INVALID: artifact name ${badName.path} is not <sha256>.<ext>`);
  const check = (relative: string, bytes: number, expected: string): void => {
    let content: Buffer;
    try {
      content = readFileSync(join(backupDir, relative));
    } catch {
      throw new Error(`BACKUP_INVALID: ${relative} missing`);
    }
    if (content.length !== bytes || sha256(content) !== expected) throw new Error(`BACKUP_INVALID: ${relative} hash mismatch`);
  };
  check(manifest.db.file, manifest.db.bytes, manifest.db.sha256);
  for (const artifact of manifest.artifacts) check(join('artifacts', artifact.path), artifact.bytes, artifact.sha256);
  return manifest;
}

/**
 * Re-derives decisions from saved evidence only; no model, tool, or provider is called. A stored
 * completion that its own saved verdicts do not support, a DONE Work without a passing decision for
 * its current contract, or a budget that does not balance is a problem.
 */
export function auditReplay(store: Store): { completionDecisions: number; budgetLimits: number; problems: string[] } {
  const problems: string[] = [];
  const runIds = (store.db.prepare('select run_id from completion_decisions order by run_id').all() as Array<{ run_id: string }>)
    .map((row) => row.run_id);
  for (const runId of runIds) {
    const decision = store.getCompletionDecision(runId)!;
    const contract = store.getEvaluationContract(decision.contractId);
    if (!contract) { problems.push(`COMPLETION_CONTRACT_MISSING:${decision.id}`); continue; }
    const verdicts = store.listCriterionVerdicts(runId)
      .filter((entry) => decision.criterionVerdictIds.includes(entry.id)).map((entry) => entry.verdict);
    // Finalization may have been stricter (payload damaged at the time); only the unsafe direction is a problem.
    if (decision.canComplete && !decideGlobalVerdict(contract.criteria, verdicts).canComplete) {
      problems.push(`COMPLETION_REPLAY_MISMATCH:${decision.id}`);
    }
  }
  const done = store.db.prepare("select id from works where state = 'DONE' order by id").all() as Array<{ id: string }>;
  for (const { id } of done) {
    const contract = store.getCurrentEvaluationContract(id);
    if (contract && !store.db.prepare('select 1 from completion_decisions where contract_id = ? and verdict = ?').get(contract.id, 'pass')) {
      problems.push(`DONE_WITHOUT_PASSING_DECISION:${id}`);
    }
  }
  const limits = (store.db.prepare('select id from budget_limits order by id').all() as Array<{ id: string }>).map((row) => row.id);
  const ledger = new BudgetLedger(store);
  for (const limitId of limits) {
    const summary = ledger.summary(limitId);
    if (summary.spentUnits < 0 || summary.reservedUnits < 0 || summary.spentUnits + summary.reservedUnits > summary.limitUnits) {
      problems.push(`BUDGET_INVARIANT:${limitId}`);
    }
  }
  return { completionDecisions: runIds.length, budgetLimits: limits.length, problems };
}

/**
 * Restores into an empty target: verify backup → copy → integrity check → migrate (by opening) →
 * relocate payload paths → re-verify roots and payloads → audit replay → classify replayability.
 * Any failure removes everything written to the target.
 */
export function restoreBackup(backupDir: string, targetDir: string, now = Date.now()): RestoreReport {
  const manifest = verifyBackup(backupDir);
  if (!isEmptyOrAbsent(targetDir)) throw new Error(`RESTORE_TARGET_NOT_EMPTY: ${targetDir}`);
  if (manifest.db.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`RESTORE_SCHEMA_UNSUPPORTED: backup ${manifest.db.schemaVersion}, runtime ${CURRENT_SCHEMA_VERSION}`);
  }
  const existed = existsSync(targetDir);
  mkdirSync(join(targetDir, 'artifacts'), { recursive: true });
  try {
    writeFileSync(join(targetDir, DB_FILE), readFileSync(join(backupDir, manifest.db.file)));
    for (const artifact of manifest.artifacts) {
      writeFileSync(join(targetDir, 'artifacts', basename(artifact.path)), readFileSync(join(backupDir, 'artifacts', basename(artifact.path))));
    }
    const raw = new DatabaseSync(join(targetDir, DB_FILE));
    try {
      const integrity = raw.prepare('pragma integrity_check').all() as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]!.integrity_check !== 'ok') throw new Error('RESTORE_DB_CORRUPT: integrity_check failed');
    } finally {
      raw.close();
    }

    const store = new Store(targetDir); // opening runs the supported schema migration
    try {
      const rows = store.db.prepare('select id, path from artifacts').all() as Array<{ id: string; path: string }>;
      const relocate = store.db.prepare('update artifacts set path = ? where id = ?');
      store.withTransaction(() => {
        for (const row of rows) relocate.run(join(store.artifactDir, basename(row.path)), row.id);
      });

      const roots = causalRoots(store.db);
      if (JSON.stringify(roots.works) !== JSON.stringify(manifest.roots.works) || roots.maxEventSeq !== manifest.roots.maxEventSeq) {
        throw new Error('RESTORE_ROOTS_MISMATCH: restored Works or event high-water mark differ from the backup');
      }
      for (const [table, count] of Object.entries(manifest.roots.rowCounts)) {
        if (roots.rowCounts[table] !== count) throw new Error(`RESTORE_ROOTS_MISMATCH: ${table} has ${roots.rowCounts[table]} rows, backup ${count}`);
      }

      const lost = new Set(manifest.notCopied.filter((entry) => entry.reason !== 'tombstoned').flatMap((entry) => entry.artifactIds));
      const counts = { verified: 0, tombstoned: 0, missingAtSource: 0 };
      for (const row of rows) {
        const artifact = store.readVerifiedArtifact(row.id);
        if (artifact.status === 'verified') counts.verified += 1;
        else if (artifact.reason?.startsWith('deleted_by_')) counts.tombstoned += 1;
        else if (lost.has(row.id)) counts.missingAtSource += 1;
        else throw new Error(`RESTORE_ARTIFACT_INVALID: ${row.id} ${artifact.status} ${artifact.reason ?? ''}`.trim());
      }

      const audit = auditReplay(store);
      if (audit.problems.length > 0) throw new Error(`RESTORE_AUDIT_FAILED: ${audit.problems.join(', ')}`);

      const references = artifactReferences(store);
      const works = manifest.roots.works.map(({ id }) => {
        const { reasons } = inspectRecoverability(store, id, now, references);
        // Retention/redaction deleted payloads on purpose or an idempotency window closed: expired.
        // Anything else missing or corrupt is lost history: unreplayable. Never regenerated.
        const lostHistory = reasons.some((reason) => reason.startsWith('ARTIFACT_') && !reason.includes(':deleted_by_'));
        return { workId: id, replay: lostHistory ? 'unreplayable' as const : reasons.length > 0 ? 'expired' as const : 'compatible' as const, reasons };
      });
      return {
        manifestHash: manifest.hash, fromSchemaVersion: manifest.db.schemaVersion, toSchemaVersion: CURRENT_SCHEMA_VERSION,
        artifacts: counts, audit: { completionDecisions: audit.completionDecisions, budgetLimits: audit.budgetLimits }, works,
      };
    } finally {
      store.close();
    }
  } catch (error) {
    rmSync(targetDir, { recursive: true, force: true });
    if (existed) mkdirSync(targetDir);
    throw error;
  }
}
