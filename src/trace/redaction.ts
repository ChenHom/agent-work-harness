import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { newId, nowIso } from '../ids.ts';
import type { ExecutionOwnership } from '../runtime/ownership.ts';
import { insertTombstone, RETENTION_POLICY } from './retention.ts';
import type { Store } from './store.ts';

/** Access policy v1: raw logs may hold prompts, secrets from tool output, or model text. */
const ACCESS_POLICY = { version: '1', restrictedKinds: RETENTION_POLICY.rawLogKinds } as const;

export function accessClassOf(kind: string): 'restricted' | 'internal' {
  return (ACCESS_POLICY.restrictedKinds as readonly string[]).includes(kind) ? 'restricted' : 'internal';
}

/**
 * Deletes a sensitive payload and every artifact holding the same bytes, whatever its extension or
 * file name (legacy or current). Rows, hashes, kinds, times, and causal references stay; the tombstone
 * names the deletion authority and that replay of the payload is no longer possible.
 */
export function redactArtifact(
  store: Store,
  artifactId: string,
  decision: { authority: string; reason: string },
  ownership: ExecutionOwnership,
): { redactionId: string; tombstonedArtifactIds: string[] } {
  if (!ownership.validate()) throw new Error('REDACTION_OWNERSHIP_REQUIRED: redaction needs the state execution lock');
  if (!decision.authority.trim() || !decision.reason.trim()) {
    throw new Error('REDACTION_AUTHORITY_REQUIRED: authority and reason must be recorded');
  }
  const target = store.db.prepare('select path, hash, kind from artifacts where id = ?').get(artifactId) as
    { path: string; hash: string; kind: string } | undefined;
  if (!target) throw new Error(`REDACTION_ARTIFACT_NOT_FOUND: ${artifactId}`);
  const redactionId = newId('RED');
  const deletedAt = nowIso();
  const tombstonedArtifactIds = store.withTransaction(() => {
    const rows = store.db.prepare(`select id, path from artifacts where hash = ?
      and id not in (select artifact_id from artifact_tombstones) order by id`).all(target.hash) as Array<{ id: string; path: string }>;
    if (rows.length === 0) throw new Error(`REDACTION_ALREADY_DELETED: ${artifactId}`);
    const escaping = rows.find((row) => dirname(resolve(row.path)) !== resolve(store.artifactDir));
    if (escaping) throw new Error(`REDACTION_INVALID_PATH: ${escaping.id} does not point into the artifact store`);
    const ids = rows.map((row) => row.id);
    for (const id of ids) {
      insertTombstone(store, id, { deletedAt, deletionId: redactionId, cause: 'redaction', ...decision });
    }
    // The event carries identities and hash only, never the redacted content.
    store.event('artifact.redacted', {
      redactionId, artifactIds: ids, hash: target.hash, kind: target.kind,
      accessClass: accessClassOf(target.kind), authority: decision.authority, reason: decision.reason,
    });
    // Unlink under the write lock (see applyGc): a concurrent writer reusing these bytes republishes them.
    for (const path of new Set(rows.map((row) => row.path))) rmSync(path, { force: true });
    return ids;
  });
  return { redactionId, tombstonedArtifactIds };
}
