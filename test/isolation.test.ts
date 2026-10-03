import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRuntimeDirs } from '../src/runtime/isolation.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';

test('ensureRuntimeDirs atomically refreshes the isolated auth snapshot', () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-auth-'));
  const operatorCodexHome = join(base, 'operator-codex');
  const stateDir = join(base, 'state');
  const policy = {
    ...DEFAULT_POLICY,
    stateDir,
    agentHome: join(stateDir, 'agent-home'),
    codexHome: join(stateDir, 'codex-home'),
    verificationHome: join(stateDir, 'verification-home'),
    skillsDir: join(stateDir, 'skills'),
  };
  try {
    mkdirSync(operatorCodexHome, { recursive: true });
    writeFileSync(join(operatorCodexHome, 'auth.json'), '{"token":"current"}', { mode: 0o600 });
    ensureRuntimeDirs(policy, [], operatorCodexHome);
    const runtimeAuth = join(policy.codexHome, 'auth.json');
    assert.equal(readFileSync(runtimeAuth, 'utf8'), '{"token":"current"}');

    writeFileSync(runtimeAuth, '{"token":"stale"}', { mode: 0o644 });
    ensureRuntimeDirs(policy, [], operatorCodexHome);
    assert.equal(readFileSync(runtimeAuth, 'utf8'), '{"token":"current"}');
    assert.equal(statSync(runtimeAuth).mode & 0o777, 0o600);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
