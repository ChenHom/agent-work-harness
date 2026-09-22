import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { assertDispatchAuthority, type DispatchAuthority } from '../runtime/dispatch-authority.ts';
import type { RuntimeExecutionIdentity } from './runtime-state.ts';

export interface StagedArtifact {
  workflowId: string;
  runId: string;
  epoch: number;
  name: string;
  relativePath: string;
  absolutePath: string;
  sha256: string;
}

export interface PublishedManifest {
  manifestPath: string;
  workflowId: string;
  runId: string;
  epoch: number;
}

interface IdentityBoundAuthority extends DispatchAuthority {
  readonly identity: RuntimeExecutionIdentity;
}

export class DurablePublisher {
  private readonly workspace: string;

  constructor(workspace: string) {
    this.workspace = resolve(workspace);
  }

  stageArtifact(
    identity: RuntimeExecutionIdentity,
    name: string,
    content: string | Uint8Array,
  ): StagedArtifact {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`PUBLICATION_ARTIFACT_NAME_INVALID: ${name}`);
    const directory = this.stagingDirectory(identity);
    mkdirSync(directory, { recursive: true });
    const absolutePath = join(directory, name);
    const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
    const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
    writeFileSync(temporary, bytes, { flag: 'wx' });
    renameSync(temporary, absolutePath);
    return {
      ...identity, name,
      relativePath: relative(this.workspace, absolutePath),
      absolutePath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  async publishManifest(
    identity: RuntimeExecutionIdentity,
    artifacts: StagedArtifact[],
    authority: IdentityBoundAuthority,
  ): Promise<PublishedManifest> {
    if (authority.identity.workflowId !== identity.workflowId
      || authority.identity.runId !== identity.runId
      || authority.identity.epoch !== identity.epoch) {
      throw new Error('PUBLICATION_AUTHORITY_IDENTITY_MISMATCH');
    }
    await assertDispatchAuthority(authority, 'publish', 'publication admission');
    if (!authority.beginOperation()) throw new Error('OWNER_ACTIVE: another operation is running');
    const manifestPath = this.canonicalManifestPath(identity.workflowId);
    const temporary = `${manifestPath}.${randomUUID()}.tmp`;
    try {
      const entries = artifacts.map((artifact) => this.verifyStagedArtifact(identity, artifact));
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify({
        schemaVersion: '1', ...identity, artifacts: entries,
      }, null, 2)}\n`, { flag: 'wx' });
      await assertDispatchAuthority(authority, 'publish', 'publication commit');
      renameSync(temporary, manifestPath);
      return { manifestPath, ...identity };
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
      authority.endOperation();
    }
  }

  canonicalManifestPath(workflowId: string): string {
    return join(this.workspace, 'durable', encodeURIComponent(workflowId), 'manifest.json');
  }

  private stagingDirectory(identity: RuntimeExecutionIdentity): string {
    return join(
      this.workspace, '.durable-staging', encodeURIComponent(identity.workflowId),
      encodeURIComponent(identity.runId), `epoch-${identity.epoch}`,
    );
  }

  private verifyStagedArtifact(
    identity: RuntimeExecutionIdentity,
    artifact: StagedArtifact,
  ): Pick<StagedArtifact, 'name' | 'relativePath' | 'sha256'> {
    if (artifact.workflowId !== identity.workflowId || artifact.runId !== identity.runId
      || artifact.epoch !== identity.epoch) throw new Error('PUBLICATION_STAGING_IDENTITY_MISMATCH');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifact.name)) {
      throw new Error('PUBLICATION_STAGING_PATH_MISMATCH');
    }
    const expectedPath = join(this.stagingDirectory(identity), artifact.name);
    const expectedRelativePath = relative(this.workspace, expectedPath);
    if (resolve(artifact.absolutePath) !== expectedPath || artifact.relativePath !== expectedRelativePath
      || !lstatSync(expectedPath).isFile()) throw new Error('PUBLICATION_STAGING_PATH_MISMATCH');
    const bytes = readFileSync(expectedPath);
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== artifact.sha256) throw new Error('PUBLICATION_STAGING_HASH_MISMATCH');
    return { name: artifact.name, relativePath: artifact.relativePath, sha256: artifact.sha256 };
  }
}
