import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatContextDropped, formatPreExistingDirty, formatWorkListRow } from '../src/cli-format.ts';
import { main } from '../src/cli.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import type { Attempt, GlobalPolicy, Work } from '../src/types.ts';

async function runCli(stateDir: string, args: string[]): Promise<string> {
  const policy: GlobalPolicy = {
    ...DEFAULT_POLICY,
    stateDir,
    agentHome: join(stateDir, 'agent-home'),
    codexHome: join(stateDir, 'codex-home'),
    verificationHome: join(stateDir, 'verification-home'),
    skillsDir: join(stateDir, 'skills'),
  };
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.join(' ')); };
  try {
    assert.equal(await main(args, policy), 0);
  } finally {
    console.log = original;
  }
  return `${lines.join('\n')}\n`;
}

const work: Work = {
  id: 'W-123',
  title: '顯示結果',
  repositoryId: 'harness',
  workspace: '/tmp/harness',
  state: 'DONE',
  currentContractVersion: 1,
  retryBudget: 2,
  createdAt: '2026-08-21T00:00:00.000Z',
};

test('list row includes the last outcome', () => {
  assert.equal(
    formatWorkListRow(work, 'SUCCESS'),
    'W-123  DONE         harness          顯示結果  outcome=SUCCESS',
  );
});

test('list row marks works without an outcome', () => {
  assert.equal(
    formatWorkListRow(work, null),
    'W-123  DONE         harness          顯示結果  outcome=-',
  );
});

const attempt: Attempt = {
  id: 'A-123', workId: work.id, number: 1, mode: 'write', contractVersion: 1,
  contractSnapshotHash: 'snapshot', baseRevision: 'revision', promptArtifactId: 'ART-1',
  runtime: 'codex', status: 'COMPLETED', startedAt: '2026-08-21T00:00:00.000Z',
};

test('show attempt formatting includes pre-existing dirty paths and hashes', () => {
  assert.equal(
    formatPreExistingDirty({
      ...attempt,
      preExistingDirty: [
        { path: 'src/changed.ts', hash: 'abc123' },
        { path: 'new file.txt', hash: null },
      ],
    }),
    '    preExistingDirty: src/changed.ts (hash=abc123), new file.txt (hash=null)',
  );
});

test('show attempt formatting explicitly marks no pre-existing dirty paths', () => {
  assert.equal(formatPreExistingDirty(attempt), '    preExistingDirty: -');
});

test('show attempt formatting includes context dropped statistics', () => {
  assert.equal(
    formatContextDropped({
      ...attempt,
      contextDropped: [
        { priority: 3, count: 4 },
        { priority: 1, count: 2 },
      ],
    }),
    '    contextDropped: priority=3 count=4, priority=1 count=2',
  );
});

test('show attempt formatting explicitly marks context that was not dropped', () => {
  assert.equal(formatContextDropped(attempt), '    contextDropped: -');
});

test('read-only CLI commands show empty state without creating it', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-cli-'));
  const stateDir = join(base, 'missing');
  assert.equal((await runCli(stateDir, ['list'])).trim(), '(沒有 work)');
  assert.match(await runCli(stateDir, ['stats']), /works: 0\s+attempts: 0/);
  assert.equal((await runCli(stateDir, ['notes'])).trim(), '(還沒有任何記錄)');
  assert.equal((await runCli(stateDir, ['skills', 'list'])).trim(), '(registry 為空)');
  assert.equal(existsSync(stateDir), false);
  rmSync(base, { recursive: true, force: true });
});
