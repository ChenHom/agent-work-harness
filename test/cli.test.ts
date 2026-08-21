import test from 'node:test';
import assert from 'node:assert/strict';
import { formatContextDropped, formatPreExistingDirty, formatWorkListRow } from '../src/cli-format.ts';
import type { Attempt, Work } from '../src/types.ts';

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
