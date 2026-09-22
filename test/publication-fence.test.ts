import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DurablePublisher } from '../src/durable/publication.ts';
import { TemporalDispatchAuthority, type RuntimeExecutionState } from '../src/durable/runtime-state.ts';

function readManifestEpoch(path: string): number {
  return (JSON.parse(readFileSync(path, 'utf8')) as { epoch: number }).epoch;
}

test('only the active epoch atomically publishes a manifest while stale staging is retained', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'harness-publication-'));
  const identity1 = { workflowId: 'WF/publication', runId: 'RUN-1', epoch: 1 };
  const identity2 = { workflowId: 'WF/publication', runId: 'RUN-2', epoch: 2 };
  let runtime: RuntimeExecutionState = { ...identity1, status: 'ACTIVE' };
  const publisher = new DurablePublisher(workspace);
  try {
    const epoch1 = publisher.stageArtifact(identity1, 'result.txt', 'epoch one output');
    const published1 = await publisher.publishManifest(
      identity1, [epoch1], new TemporalDispatchAuthority(identity1, () => runtime),
    );
    assert.equal(readManifestEpoch(published1.manifestPath), 1);

    runtime = { ...identity2, status: 'ACTIVE' };
    const epoch2 = publisher.stageArtifact(identity2, 'result.txt', 'epoch two output');
    const published2 = await publisher.publishManifest(
      identity2, [epoch2], new TemporalDispatchAuthority(identity2, () => runtime),
    );
    assert.equal(readManifestEpoch(published2.manifestPath), 2);

    await assert.rejects(
      publisher.publishManifest(
        identity1, [epoch1], new TemporalDispatchAuthority(identity2, () => runtime),
      ),
      /PUBLICATION_AUTHORITY_IDENTITY_MISMATCH/,
    );

    await assert.rejects(
      publisher.publishManifest(
        identity1, [epoch1], new TemporalDispatchAuthority(identity1, () => runtime),
      ),
      /dispatch authority is stale/,
    );
    assert.equal(readManifestEpoch(published2.manifestPath), 2);
    assert.equal(existsSync(epoch1.absolutePath), true, 'stale staging must remain for diagnosis');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('publication rechecks authority at the atomic commit gate', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'harness-publication-race-'));
  const identity = { workflowId: 'WF-race', runId: 'RUN-1', epoch: 1 };
  let validations = 0;
  const publisher = new DurablePublisher(workspace);
  const staged = publisher.stageArtifact(identity, 'result.txt', 'delayed output');
  const authority = {
    identity,
    beginOperation: () => true,
    endOperation: () => {},
    validate: () => { validations += 1; return validations === 1; },
  };
  try {
    await assert.rejects(publisher.publishManifest(identity, [staged], authority), /dispatch authority is stale/);
    assert.equal(existsSync(publisher.canonicalManifestPath(identity.workflowId)), false);
    assert.equal(existsSync(staged.absolutePath), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('publication rejects a forged staging reference even when the staged bytes are valid', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'harness-publication-forged-'));
  const identity = { workflowId: 'WF-forged', runId: 'RUN-1', epoch: 1 };
  const runtime: RuntimeExecutionState = { ...identity, status: 'ACTIVE' };
  const publisher = new DurablePublisher(workspace);
  const staged = publisher.stageArtifact(identity, 'result.txt', 'valid staged output');
  try {
    await assert.rejects(
      publisher.publishManifest(
        identity,
        [{ ...staged, relativePath: '../../outside.txt' }],
        new TemporalDispatchAuthority(identity, () => runtime),
      ),
      /PUBLICATION_STAGING_PATH_MISMATCH/,
    );
    assert.equal(existsSync(staged.absolutePath), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
