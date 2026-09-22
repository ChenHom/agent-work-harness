import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger } from '../src/budget/ledger.ts';
import type { ExecutionOwnership } from '../src/runtime/ownership.ts';
import { CompensationWorkflow } from '../src/tools/compensation.ts';
import { FakeProvider } from '../src/tools/fake-provider.ts';
import { OperationGateway } from '../src/tools/gateway.ts';
import { Store } from '../src/trace/store.ts';
import type { Work } from '../src/types.ts';

function owner(): ExecutionOwnership {
  let active = false;
  return {
    token: 'g3-owner', validate: () => true,
    beginOperation: () => active ? false : (active = true),
    endOperation: () => { active = false; }, update: () => true, release: () => !active,
  };
}

test('G3: lost responses, expiry, compensation crash, and hard-cap contention remain bounded', async () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-g3-'));
  const store = new Store(join(state, 'harness'));
  let now = Date.parse('2026-09-22T00:00:00.000Z');
  try {
    const work: Work = {
      id: 'W-G3', title: 'G3 fixture', repositoryId: 'harness', workspace: state,
      state: 'ACTIVE', currentContractVersion: 1, retryBudget: 2,
      createdAt: new Date(now).toISOString(),
    };
    store.insertWork(work);
    const budget = new BudgetLedger(store);
    const limit = budget.configureLimit({
      workId: work.id, resourceKind: 'fake_write', currency: 'unit',
      limitUnits: 30, pricingVersion: 'fake-v1',
    });
    const provider = new FakeProvider(join(state, 'provider-ledger.json'));
    const gateway = new OperationGateway(store, budget, provider, () => now);
    const prepare = (identity: string, lookupDelayCount: number) => gateway.prepare({
      workId: work.id, intentKey: `create:${identity}`, kind: 'fake.create', targetScope: identity,
      payload: {
        businessId: identity, value: 'enabled', behavior: 'lose-response-after-effect' as const,
        lookupDelayCount, compensationBehavior: 'lose-response-after-effect' as const,
      },
      precondition: 'absent', reconciliationStrategy: 'lookup by durable key',
      compensationPolicy: 'remove exact owned version', authorizationRef: `contract:${identity}`,
    });

    const recoverable = prepare('recoverable', 1);
    assert.equal(prepare('recoverable', 1).idempotencyKey, recoverable.idempotencyKey);
    assert.throws(() => gateway.prepare({
      workId: work.id, intentKey: 'create:recoverable', kind: 'fake.create', targetScope: 'recoverable',
      payload: { businessId: 'recoverable', value: 'different', behavior: 'success' as const },
      precondition: 'absent', reconciliationStrategy: 'lookup', compensationPolicy: 'remove',
      authorizationRef: 'contract:recoverable',
    }), /OPERATION_INTENT_CONFLICT/);
    assert.equal(store.getBudgetReservation(recoverable.reservationId!)?.status, 'HELD');
    assert.equal((await gateway.dispatch(recoverable.id, owner())).status, 'UNKNOWN');
    await assert.rejects(gateway.dispatch(recoverable.id, owner()), /OPERATION_RECONCILIATION_REQUIRED/);
    assert.equal((await gateway.reconcile(recoverable.id, owner())).status, 'UNKNOWN');
    assert.equal((await gateway.reconcile(recoverable.id, owner())).status, 'SUCCEEDED');

    const expired = prepare('expired', 99);
    assert.equal((await gateway.dispatch(expired.id, owner())).status, 'UNKNOWN');
    now = Date.parse(expired.dedupeExpiresAt) + 1;
    assert.equal((await gateway.reconcile(expired.id, owner())).status, 'WAITING_USER');
    assert.equal(store.getBudgetReservation(expired.reservationId!)?.status, 'UNKNOWN');

    const workflow = new CompensationWorkflow(store, budget, provider, () => now);
    const compensation = workflow.prepare({
      operationId: recoverable.id, authorizationRef: 'decision:compensate-recoverable',
      resourceIdentity: 'fake-recoverable', ownershipRef: 'recoverable', targetVersion: 'fake-v1',
    });
    assert.notEqual(compensation.idempotencyKey, recoverable.idempotencyKey);
    assert.throws(() => budget.reserve({
      workId: work.id, operationId: 'OP-competing', cost: recoverable.capabilities.cost,
    }), /BUDGET_EXCEEDED/);

    const dispatchedAt = new Date(now).toISOString();
    store.withTransaction(() => {
      store.updateCompensation({ ...compensation, status: 'DISPATCHED', updatedAt: dispatchedAt });
      store.insertCompensationAttempt({
        id: 'COMPA-G3-crash', compensationId: compensation.id, number: 1,
        status: 'DISPATCHED', dispatchedAt,
      });
    });
    await assert.rejects(provider.compensate({
      idempotencyKey: compensation.idempotencyKey, externalId: compensation.resourceIdentity,
      resourceVersion: compensation.targetVersion, ownershipRef: compensation.ownershipRef,
    }), /FAKE_COMPENSATION_RESPONSE_LOST/);
    assert.equal((await workflow.reconcile(compensation.id, owner())).status, 'SUCCEEDED');
    assert.equal((await workflow.reconcile(compensation.id, owner())).status, 'SUCCEEDED');

    assert.equal(provider.effectCount(), 2);
    assert.equal(provider.compensationEffectCount(), 1);
    const summary = budget.summary(limit.id);
    assert.deepEqual(summary, { limitUnits: 30, spentUnits: 10, reservedUnits: 10, availableUnits: 10 });
    assert.ok(summary.spentUnits + summary.reservedUnits <= summary.limitUnits);
    assert.equal(store.listBudgetLedger(limit.id)
      .filter((entry) => entry.reservationId === compensation.reservationId && entry.kind === 'SETTLE').length, 1);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});
