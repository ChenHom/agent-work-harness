import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BudgetLedger } from '../src/budget/ledger.ts';
import {
  nextRuntimeEpoch, TemporalDispatchAuthority, type RuntimeExecutionState,
} from '../src/durable/runtime-state.ts';
import { FakeProvider } from '../src/tools/fake-provider.ts';
import { OperationGateway } from '../src/tools/gateway.ts';
import type { OperationAdapter } from '../src/tools/operations.ts';
import { Store } from '../src/trace/store.ts';
import type { Work } from '../src/types.ts';

function fixture(adapterFactory?: (provider: FakeProvider) => OperationAdapter) {
  const stateDir = mkdtempSync(join(tmpdir(), 'harness-temporal-epoch-'));
  const store = new Store(join(stateDir, 'harness'));
  const work: Work = {
    id: 'W-epoch', title: 'epoch fixture', repositoryId: 'repo', workspace: stateDir,
    state: 'ACTIVE', currentContractVersion: 1, retryBudget: 2,
    createdAt: '2026-09-22T00:00:00.000Z',
  };
  store.insertWork(work);
  const budget = new BudgetLedger(store);
  budget.configureLimit({
    workId: work.id, resourceKind: 'fake_write', currency: 'unit',
    limitUnits: 100, pricingVersion: 'fake-v1',
  });
  const provider = new FakeProvider(join(stateDir, 'provider-ledger.json'));
  const gateway = new OperationGateway(store, budget, adapterFactory?.(provider) ?? provider);
  const prepare = () => gateway.prepare({
    workId: work.id, intentKey: 'create:epoch-resource', kind: 'fake.create',
    targetScope: 'epoch-resource',
    payload: { businessId: 'epoch-resource', value: 'created', behavior: 'success' as const },
    precondition: 'absent', reconciliationStrategy: 'lookup stable identity',
    compensationPolicy: 'remove exact version', authorizationRef: 'contract:epoch',
  });
  return { stateDir, store, provider, gateway, prepare };
}

test('stale Temporal epoch is rejected before Gateway dispatch', async () => {
  const h = fixture();
  try {
    const operation = h.prepare();
    const state: RuntimeExecutionState = {
      workflowId: 'WF-epoch', runId: 'RUN-2', epoch: 2, status: 'ACTIVE',
    };
    const stale = new TemporalDispatchAuthority(
      { workflowId: 'WF-epoch', runId: 'RUN-1', epoch: 1 }, () => state,
    );
    await assert.rejects(h.gateway.dispatch(operation.id, stale), /dispatch authority is stale/);
    assert.equal(h.provider.effectCount(), 0);
    assert.equal(h.store.getOperation(operation.id)?.status, 'PREPARED');
    assert.equal(h.store.listOperationAttempts(operation.id).length, 0);
  } finally {
    h.store.close();
    rmSync(h.stateDir, { recursive: true, force: true });
  }
});

test('epoch loss after provider call becomes UNKNOWN and the next epoch reconciles the same effect', async () => {
  let state: RuntimeExecutionState = {
    workflowId: 'WF-epoch', runId: 'RUN-1', epoch: 1, status: 'ACTIVE',
  };
  const h = fixture((provider) => ({
    capabilities: provider.capabilities,
    async execute(request) {
      const receipt = await provider.execute(request);
      state = nextRuntimeEpoch(state, 'RUN-2');
      return receipt;
    },
    lookup: (request, closed) => provider.lookup(request, closed),
    verifyPostcondition: (request, receipt) => provider.verifyPostcondition(request, receipt),
    compensate: (request) => provider.compensate(request),
    lookupCompensation: (request) => provider.lookupCompensation(request),
  }));
  try {
    const operation = h.prepare();
    const epoch1 = new TemporalDispatchAuthority(
      { workflowId: 'WF-epoch', runId: 'RUN-1', epoch: 1 }, () => state,
    );
    const unknown = await h.gateway.dispatch(operation.id, epoch1);
    assert.equal(unknown.status, 'UNKNOWN');
    assert.equal(h.provider.effectCount(), 1);

    const epoch2 = new TemporalDispatchAuthority(
      { workflowId: 'WF-epoch', runId: 'RUN-2', epoch: 2 }, () => state,
    );
    const recovered = await h.gateway.reconcile(operation.id, epoch2);
    assert.equal(recovered.status, 'SUCCEEDED');
    assert.equal(recovered.id, operation.id);
    assert.equal(recovered.idempotencyKey, operation.idempotencyKey);
    assert.equal(h.provider.effectCount(), 1);
    assert.equal(h.store.listOperationAttempts(operation.id).length, 1);
    assert.equal(h.store.getBudgetReservation(operation.reservationId!)?.status, 'SETTLED');
  } finally {
    h.store.close();
    rmSync(h.stateDir, { recursive: true, force: true });
  }
});
