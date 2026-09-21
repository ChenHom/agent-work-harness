import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export interface ProcessIdentity {
  pid: number;
  processStart: string;
}

export interface DriverExecutionState {
  phase: 'not_started' | 'prepared' | 'launching' | 'running' | 'stopped' | 'unknown';
  child: ProcessIdentity | null;
  quiesced: boolean;
}

interface OwnershipMetadata {
  token: string;
  host: string;
  pid: number;
  processStart: string;
  phase: DriverExecutionState['phase'];
  child: ProcessIdentity | null;
  acquiredAt: string;
  updatedAt: string;
}

export interface OwnershipInspection {
  occupied: boolean;
  metadata: OwnershipMetadata | null;
  blockedReason: string | null;
}

export class OwnershipError extends Error {
  readonly code: 'OWNER_ACTIVE' | 'OWNER_UNKNOWN';
  readonly inspection: OwnershipInspection;

  constructor(code: 'OWNER_ACTIVE' | 'OWNER_UNKNOWN', inspection: OwnershipInspection) {
    super(`${code}: ${inspection.blockedReason ?? 'execution ownership is occupied'}`);
    this.code = code;
    this.inspection = inspection;
  }
}

const lockPath = (stateDir: string): string => join(stateDir, 'execution.lock');
const metadataPath = (stateDir: string): string => join(lockPath(stateDir), 'owner.json');

function processStart(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return fields[19] || 'unknown';
  } catch {
    return 'unknown';
  }
}

function readMetadata(stateDir: string): OwnershipMetadata | null {
  try {
    const value = JSON.parse(readFileSync(metadataPath(stateDir), 'utf8')) as Partial<OwnershipMetadata>;
    const phases: DriverExecutionState['phase'][] = ['not_started', 'prepared', 'launching', 'running', 'stopped', 'unknown'];
    const childValid = value.child === null || (typeof value.child === 'object'
      && typeof value.child?.pid === 'number' && typeof value.child.processStart === 'string');
    if (typeof value.token !== 'string' || typeof value.host !== 'string'
      || typeof value.pid !== 'number' || typeof value.processStart !== 'string'
      || !phases.includes(value.phase as DriverExecutionState['phase']) || typeof value.acquiredAt !== 'string'
      || typeof value.updatedAt !== 'string' || !('child' in value) || !childValid) return null;
    return value as OwnershipMetadata;
  } catch {
    return null;
  }
}

function publishMetadata(stateDir: string, metadata: OwnershipMetadata): void {
  const target = metadataPath(stateDir);
  const temporary = join(lockPath(stateDir), `.owner-${metadata.token}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, target);
}

export function inspectExecutionOwnership(stateDir: string): OwnershipInspection {
  if (!existsSync(lockPath(stateDir))) return { occupied: false, metadata: null, blockedReason: null };
  const metadata = readMetadata(stateDir);
  if (!metadata) {
    return { occupied: true, metadata: null, blockedReason: 'OWNER_UNKNOWN: lock metadata is missing or incomplete' };
  }
  const unknown = metadata.phase === 'unknown'
    || (metadata.phase === 'launching' && metadata.child === null);
  return {
    occupied: true,
    metadata,
    blockedReason: unknown
      ? 'OWNER_UNKNOWN: managed child state is not known'
      : `OWNER_ACTIVE: token ${metadata.token} is in phase ${metadata.phase}`,
  };
}

export interface ExecutionOwnership {
  readonly token: string;
  validate(): boolean;
  update(state: DriverExecutionState): boolean;
  release(): boolean;
}

export function acquireExecutionOwnership(stateDir: string): ExecutionOwnership {
  mkdirSync(stateDir, { recursive: true });
  try {
    mkdirSync(lockPath(stateDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const inspection = inspectExecutionOwnership(stateDir);
    throw new OwnershipError(inspection.blockedReason?.startsWith('OWNER_UNKNOWN') ? 'OWNER_UNKNOWN' : 'OWNER_ACTIVE', inspection);
  }

  const token = randomUUID();
  const now = new Date().toISOString();
  publishMetadata(stateDir, {
    token, host: hostname(), pid: process.pid, processStart: processStart(process.pid),
    phase: 'not_started', child: null, acquiredAt: now, updatedAt: now,
  });
  let currentState: DriverExecutionState = { phase: 'not_started', child: null, quiesced: true };

  return {
    token,
    validate(): boolean {
      return readMetadata(stateDir)?.token === token;
    },
    update(state): boolean {
      const current = readMetadata(stateDir);
      if (current?.token !== token) return false;
      publishMetadata(stateDir, { ...current, phase: state.phase, child: state.child, updatedAt: new Date().toISOString() });
      currentState = state;
      return true;
    },
    release(): boolean {
      if (!currentState.quiesced
        || (currentState.phase !== 'stopped' && currentState.phase !== 'not_started' && currentState.phase !== 'prepared')) {
        return false;
      }
      if (readMetadata(stateDir)?.token !== token) return false;
      rmSync(metadataPath(stateDir));
      try {
        rmdirSync(lockPath(stateDir));
        return true;
      } catch {
        return false;
      }
    },
  };
}
