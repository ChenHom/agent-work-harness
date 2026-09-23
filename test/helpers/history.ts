import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetLedger } from '../../src/budget/ledger.ts';
import { finalizeEvaluation } from '../../src/evaluation/finalization.ts';
import { acquireExecutionOwnership } from '../../src/runtime/ownership.ts';
import { FakeProvider } from '../../src/tools/fake-provider.ts';
import { OperationGateway } from '../../src/tools/gateway.ts';
import { applyGc, previewGc } from '../../src/trace/retention.ts';
import type { Store } from '../../src/trace/store.ts';
import type { Work } from '../../src/types.ts';
import { evaluationFixture } from './evaluation.ts';

const OLD = '2026-01-01T00:00:00.000Z';

interface HistoryIds { operation: string; rawLog: string; oldPayload: string; lostPayload: string }

/**
 * A realistic multi-Work history: a passing evaluation (W-EVAL, DONE), a recovered lost-response
 * operation with budget and a raw log (W-OP), an archived Work whose payload GC deleted (W-OLD),
 * and an active Work whose payload vanished without authority (W-LOST).
 */
export async function richHistory(): Promise<{
  state: string; store: Store; ids: HistoryIds; cleanup: () => void;
}> {
  const h = evaluationFixture();
  const { store, state } = h;
  const ids: HistoryIds = { operation: '', rawLog: '', oldPayload: '', lostPayload: '' };
  store.insertEvaluationContract(h.contract);
  store.insertEvaluationRun(h.run);
  store.insertCriterionVerdict({ id: 'CV-PASS', workId: h.work.id, evaluationRunId: h.run.id, verdict: h.candidate, createdAt: OLD });
  finalizeEvaluation(store, { id: 'CD-PASS', workId: h.work.id, evaluationRunId: h.run.id, expectedWorkState: 'VERIFYING', createdAt: OLD });

  const work = (id: string, workState: Work['state']) => store.insertWork({
    id, title: id, repositoryId: 'repo', workspace: state, state: workState, currentContractVersion: 1, retryBudget: 0, createdAt: OLD,
  });
  work('W-OP', 'ACTIVE'); work('W-OLD', 'DONE'); work('W-LOST', 'ACTIVE');
  const budget = new BudgetLedger(store);
  budget.configureLimit({ workId: 'W-OP', resourceKind: 'fake_write', currency: 'unit', limitUnits: 30, pricingVersion: 'fake-v1' });
  let now = Date.parse('2026-11-30T00:00:00.000Z');
  const gateway = new OperationGateway(store, budget, new FakeProvider(join(state, 'provider-ledger.json')), () => now);
  let active = false;
  const authority = {
    validate: () => true, beginOperation: () => active ? false : (active = true), endOperation: () => { active = false; },
  };
  const operation = gateway.prepare({
    workId: 'W-OP', intentKey: 'create:history', kind: 'fake.create', targetScope: 'history',
    payload: { businessId: 'history', value: 'enabled', behavior: 'lose-response-after-effect' },
    precondition: 'absent', reconciliationStrategy: 'lookup', compensationPolicy: 'remove', authorizationRef: 'contract:history',
  });
  ids.operation = operation.id;
  await gateway.dispatch(operation.id, authority);
  now += 1_000;
  await gateway.reconcile(operation.id, authority);

  const ref = (workId: string, artifactId: string) => store.event('usage.note', { kind: 'ref', text: artifactId }, workId);
  ids.rawLog = store.putArtifact('runtime_stdout', 'W-OP stdout', 'log').id;
  ref('W-OP', ids.rawLog);
  ids.oldPayload = store.putArtifact('attempt_input', 'W-OLD input').id;
  ref('W-OLD', ids.oldPayload);
  const lost = store.putArtifact('attempt_input', 'W-LOST input');
  ids.lostPayload = lost.id;
  ref('W-LOST', ids.lostPayload);

  store.db.prepare("update events set created_at = ? where work_id = 'W-OLD'").run(OLD);
  store.db.prepare('update artifacts set created_at = ? where id = ?').run(OLD, ids.oldPayload);
  const ownership = acquireExecutionOwnership(state);
  try {
    // Real clock: only W-OLD (last activity in January) is past its window.
    applyGc(store, previewGc(store), ownership);
  } finally {
    ownership.release();
  }
  rmSync(lost.path);
  return { state, store, ids, cleanup: () => { store.close(); rmSync(state, { recursive: true, force: true }); } };
}
