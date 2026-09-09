import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/trace/store.ts';
import type { DecisionRecord, EvidenceRecord } from '../src/types.ts';

test('D-1：相同時間戳的 decisions/evidence 以 id 穩定排序', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-store-order-'));
  const store = new Store(state);
  const timestamp = '2026-09-04T00:00:00.000Z';
  try {
    const decision = (id: string): DecisionRecord => ({
      id, workId: 'W', sourceMessageId: 'M', kind: 'constraint', value: id, createdAt: timestamp,
    });
    store.insertDecision(decision('D-2'));
    store.insertDecision(decision('D-1'));
    assert.deepEqual(store.listDecisions('W').map((d) => d.id), ['D-1', 'D-2']);

    const evidence = (id: string): EvidenceRecord => ({
      id, workId: 'W', attemptId: 'A', type: 'readback', label: id,
      status: 'PASS', data: {}, observedAt: timestamp,
    });
    store.insertEvidence(evidence('EV-2'));
    store.insertEvidence(evidence('EV-1'));
    assert.deepEqual(store.listEvidence('A').map((e) => e.id), ['EV-1', 'EV-2']);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});
