import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger } from '../src/budget/ledger.ts';
import { FakeProvider } from '../src/tools/fake-provider.ts';
import { OperationGateway } from '../src/tools/gateway.ts';
import { CompensationWorkflow } from '../src/tools/compensation.ts';
import { Store } from '../src/trace/store.ts';
import type { ExecutionOwnership } from '../src/runtime/ownership.ts';
import type { Work } from '../src/types.ts';

function owner(): ExecutionOwnership {
  let active = false;
  return {
    token: 'owner-test',
    validate: () => true,
    beginOperation: () => active ? false : (active = true),
    endOperation: () => { active = false; },
    update: () => true,
    release: () => !active,
  };
}

function expiringOwner(validations: number): ExecutionOwnership {
  let active = false;
  let calls = 0;
  return {
    token: 'owner-expiring',
    validate: () => ++calls <= validations,
    beginOperation: () => active ? false : (active = true),
    endOperation: () => { active = false; },
    update: () => true,
    release: () => !active,
  };
}

function fixture(): {
  state: string; store: Store; budget: BudgetLedger; provider: FakeProvider; gateway: OperationGateway;
} {
  const state = mkdtempSync(join(tmpdir(), 'harness-gateway-'));
  const store = new Store(join(state, 'harness'));
  const work: Work = {
    id: 'W-gateway', title: 'gateway fixture', repositoryId: 'repo', workspace: '/repo',
    state: 'ACTIVE', currentContractVersion: 1, retryBudget: 2,
    createdAt: '2026-09-22T00:00:00.000Z',
  };
  store.insertWork(work);
  const budget = new BudgetLedger(store);
  budget.configureLimit({
    workId: work.id, resourceKind: 'fake_write', currency: 'unit',
    limitUnits: 100, pricingVersion: 'fake-v1',
  });
  const provider = new FakeProvider(join(state, 'provider-ledger.json'));
  const gateway = new OperationGateway(store, budget, provider);
  return { state, store, budget, provider, gateway };
}

const prepareInput = (behavior: 'success' | 'fail-before-effect' | 'lose-response-before-effect' | 'lose-response-after-effect' = 'success') => ({
  workId: 'W-gateway', intentKey: 'create:customer-7', kind: 'fake.create', targetScope: 'customer-7',
  payload: { businessId: 'customer-7', value: 'enabled', behavior },
  precondition: 'customer absent', reconciliationStrategy: 'lookup by idempotency key',
  compensationPolicy: 'delete created customer', authorizationRef: 'contract:C-1',
});

test('prepare snapshots capabilities and atomically reserves budget while reusing logical intent', () => {
  const h = fixture();
  try {
    const operation = h.gateway.prepare(prepareInput());
    const replay = h.gateway.prepare(prepareInput());
    assert.equal(replay.id, operation.id);
    assert.equal(replay.idempotencyKey, operation.idempotencyKey);
    assert.equal(operation.status, 'PREPARED');
    assert.equal(operation.authorizationRef, 'contract:C-1');
    assert.deepEqual(operation.capabilities, h.provider.capabilities);
    assert.equal(h.store.getBudgetReservation(operation.reservationId!)?.status, 'HELD');
    assert.throws(() => h.gateway.prepare({
      ...prepareInput(), payload: { businessId: 'customer-7', value: 'disabled', behavior: 'success' as const },
    }), /OPERATION_INTENT_CONFLICT/);
    assert.equal(h.store.listOperations('W-gateway').length, 1);
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('dispatch records intent before the call, verifies receipt/postcondition, and settles once', async () => {
  const h = fixture();
  try {
    const operation = h.gateway.prepare(prepareInput());
    const succeeded = await h.gateway.dispatch(operation.id, owner());
    assert.equal(succeeded.status, 'SUCCEEDED');
    const attempts = h.store.listOperationAttempts(operation.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, 'SUCCEEDED');
    assert.ok(attempts[0]?.receiptArtifactId);
    assert.equal(h.provider.effectCount(), 1);
    const reservation = h.store.getBudgetReservation(operation.reservationId!);
    assert.equal(reservation?.status, 'SETTLED');
    assert.equal(reservation?.settledUnits, 7);

    const replay = await h.gateway.dispatch(operation.id, owner());
    assert.equal(replay.status, 'SUCCEEDED');
    assert.equal(h.provider.effectCount(), 1);
    assert.equal(h.store.listBudgetLedger(reservation.limitId).filter((entry) => entry.kind === 'SETTLE').length, 1);
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('definitive no-effect failure releases reservation', async () => {
  const h = fixture();
  try {
    const operation = h.gateway.prepare(prepareInput('fail-before-effect'));
    const failed = await h.gateway.dispatch(operation.id, owner());
    assert.equal(failed.status, 'FAILED');
    assert.equal(h.provider.effectCount(), 0);
    assert.equal(h.store.getBudgetReservation(operation.reservationId!)?.status, 'RELEASED');
    assert.equal(h.store.listOperationAttempts(operation.id)[0]?.status, 'FAILED');
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('worker that loses authority after a provider call leaves dispatch state for reconciliation', async () => {
  const h = fixture();
  try {
    const operation = h.gateway.prepare(prepareInput());

    await assert.rejects(h.gateway.dispatch(operation.id, expiringOwner(3)), /OWNER_UNKNOWN/);

    assert.equal(h.provider.effectCount(), 1);
    assert.equal(h.store.getOperation(operation.id)!.status, 'DISPATCHED');
    assert.equal(h.store.listOperationAttempts(operation.id)[0]!.status, 'DISPATCHED');
    assert.equal(h.store.getBudgetReservation(operation.reservationId!)!.status, 'HELD');
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('UNKNOWN prohibits redispatch and reconciliation settles one provider effect and charge', async () => {
  const h = fixture();
  try {
    const operation = h.gateway.prepare(prepareInput('lose-response-after-effect'));
    const unknown = await h.gateway.dispatch(operation.id, owner());
    assert.equal(unknown.status, 'UNKNOWN');
    assert.equal(h.provider.effectCount(), 1);
    assert.equal(h.store.getBudgetReservation(operation.reservationId!)?.status, 'UNKNOWN');

    await assert.rejects(h.gateway.dispatch(operation.id, owner()), /OPERATION_RECONCILIATION_REQUIRED/);
    const recovered = await h.gateway.reconcile(operation.id, owner());
    assert.equal(recovered.status, 'SUCCEEDED');
    assert.equal(h.provider.effectCount(), 1);
    const reservation = h.store.getBudgetReservation(operation.reservationId!)!;
    assert.equal(reservation.status, 'SETTLED');
    assert.equal(h.store.listBudgetLedger(reservation.limitId).filter((entry) => entry.kind === 'SETTLE').length, 1);
    assert.deepEqual(h.store.listOperationAttempts(operation.id).map((attempt) => attempt.status), ['UNKNOWN']);
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('stale reconciliation cannot overwrite a concurrently settled operation', async () => {
  const h = fixture();
  try {
    const operation = h.gateway.prepare(prepareInput('lose-response-after-effect'));
    assert.equal((await h.gateway.dispatch(operation.id, owner())).status, 'UNKNOWN');
    h.provider.lookup = async () => {
      const reconciling = h.store.getOperation(operation.id)!;
      assert.equal(reconciling.status, 'RECONCILING');
      h.store.withTransaction(() => {
        h.store.updateOperation({ ...reconciling, status: 'SUCCEEDED', updatedAt: new Date().toISOString() });
        h.budget.settleInTransaction(operation.reservationId!, 7);
      });
      return { kind: 'pending' };
    };

    await assert.rejects(h.gateway.reconcile(operation.id, owner()), /STATE_CONFLICT/);
    assert.equal(h.store.getOperation(operation.id)!.status, 'SUCCEEDED');
    assert.equal(h.store.getBudgetReservation(operation.reservationId!)!.status, 'SETTLED');
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('crash-left DISPATCHED operation reconciles the existing effect without redispatch', async () => {
  const h = fixture();
  try {
    const input = prepareInput();
    const operation = h.gateway.prepare(input);
    const dispatchedAt = new Date().toISOString();
    h.store.withTransaction(() => {
      h.store.updateOperation({ ...operation, status: 'DISPATCHED', updatedAt: dispatchedAt });
      h.store.insertOperationAttempt({
        id: 'OPA-crash', operationId: operation.id, number: 1,
        status: 'DISPATCHED', dispatchedAt,
      });
    });
    await h.provider.execute({
      idempotencyKey: operation.idempotencyKey,
      targetScope: operation.targetScope,
      canonicalInputHash: operation.canonicalInputHash,
      payload: input.payload,
    });

    const recovered = await h.gateway.reconcile(operation.id, owner());
    assert.equal(recovered.status, 'SUCCEEDED');
    assert.equal(h.provider.effectCount(), 1);
    const attempt = h.store.listOperationAttempts(operation.id)[0];
    assert.equal(attempt?.status, 'UNKNOWN');
    assert.match(attempt?.error ?? '', /completion unacknowledged/);
    assert.equal(h.store.getBudgetReservation(operation.reservationId!)?.status, 'SETTLED');
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('delayed lookup visibility survives restart and duplicate reconciliation is harmless', async () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-reconcile-restart-'));
  const harnessState = join(state, 'harness');
  const providerPath = join(state, 'provider-ledger.json');
  let store = new Store(harnessState);
  try {
    const work: Work = {
      id: 'W-restart', title: 'restart fixture', repositoryId: 'repo', workspace: '/repo',
      state: 'ACTIVE', currentContractVersion: 1, retryBudget: 2, createdAt: '2026-09-22T00:00:00.000Z',
    };
    store.insertWork(work);
    let budget = new BudgetLedger(store);
    budget.configureLimit({
      workId: work.id, resourceKind: 'fake_write', currency: 'unit', limitUnits: 100, pricingVersion: 'fake-v1',
    });
    let provider = new FakeProvider(providerPath);
    let gateway = new OperationGateway(store, budget, provider);
    const operation = gateway.prepare({
      ...prepareInput('lose-response-after-effect'), workId: work.id,
      payload: {
        businessId: 'customer-7', value: 'enabled', behavior: 'lose-response-after-effect' as const,
        lookupDelayCount: 1,
      },
    });
    assert.equal((await gateway.dispatch(operation.id, owner())).status, 'UNKNOWN');
    store.close();

    store = new Store(harnessState);
    budget = new BudgetLedger(store);
    provider = new FakeProvider(providerPath);
    gateway = new OperationGateway(store, budget, provider);
    assert.equal((await gateway.reconcile(operation.id, owner())).status, 'UNKNOWN');
    assert.equal((await gateway.reconcile(operation.id, owner())).status, 'SUCCEEDED');
    assert.equal((await gateway.reconcile(operation.id, owner())).status, 'SUCCEEDED');
    assert.equal(provider.effectCount(), 1);
    assert.equal(provider.lookupCount(), 2);
    const reservation = store.getBudgetReservation(operation.reservationId!)!;
    assert.equal(store.listBudgetLedger(reservation.limitId).filter((entry) => entry.kind === 'SETTLE').length, 1);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('not-found stays UNKNOWN inside completion window then confirmed no-effect releases budget', async () => {
  const h = fixture();
  let now = Date.parse('2026-09-22T00:00:00.000Z');
  const gateway = new OperationGateway(h.store, h.budget, h.provider, () => now);
  try {
    const operation = gateway.prepare(prepareInput('lose-response-before-effect'));
    assert.equal((await gateway.dispatch(operation.id, owner())).status, 'UNKNOWN');
    now += 1_000;
    assert.equal((await gateway.reconcile(operation.id, owner())).status, 'UNKNOWN');
    assert.equal(h.store.getBudgetReservation(operation.reservationId!)?.status, 'UNKNOWN');
    now += 5_000;
    assert.equal((await gateway.reconcile(operation.id, owner())).status, 'FAILED');
    assert.equal(h.store.getBudgetReservation(operation.reservationId!)?.status, 'RELEASED');
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('expired dedupe key moves an unresolved lookup to manual handling without redispatch', async () => {
  const h = fixture();
  let now = Date.parse('2026-09-22T00:00:00.000Z');
  const gateway = new OperationGateway(h.store, h.budget, h.provider, () => now);
  try {
    const operation = gateway.prepare({
      ...prepareInput('lose-response-after-effect'),
      payload: {
        businessId: 'customer-7', value: 'enabled', behavior: 'lose-response-after-effect' as const,
        lookupDelayCount: 99,
      },
    });
    assert.equal((await gateway.dispatch(operation.id, owner())).status, 'UNKNOWN');
    now = Date.parse(operation.dedupeExpiresAt) + 1;
    const waiting = await gateway.reconcile(operation.id, owner());
    assert.equal(waiting.status, 'WAITING_USER');
    assert.match(waiting.manualReason ?? '', /idempotency key expired/);
    assert.equal(h.provider.effectCount(), 1);
    assert.equal(h.store.getBudgetReservation(operation.reservationId!)?.status, 'UNKNOWN');
    await assert.rejects(gateway.dispatch(operation.id, owner()), /OPERATION_INVALID_STATE/);
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('partial and unsupported lookup outcomes require manual handling without releasing budget', async () => {
  for (const lookupMode of ['partial', 'unsupported'] as const) {
    const h = fixture();
    try {
      const operation = h.gateway.prepare({
        ...prepareInput('lose-response-after-effect'), intentKey: `create:${lookupMode}`,
        targetScope: `customer-${lookupMode}`,
        payload: {
          businessId: `customer-${lookupMode}`, value: 'enabled',
          behavior: 'lose-response-after-effect' as const, lookupMode,
        },
      });
      assert.equal((await h.gateway.dispatch(operation.id, owner())).status, 'UNKNOWN');
      const waiting = await h.gateway.reconcile(operation.id, owner());
      assert.equal(waiting.status, 'WAITING_USER');
      assert.match(waiting.manualReason ?? '', new RegExp(lookupMode));
      assert.equal(h.store.getBudgetReservation(operation.reservationId!)?.status, 'UNKNOWN');
    } finally {
      h.store.close();
      rmSync(h.state, { recursive: true, force: true });
    }
  }
});

test('fake provider persists dedupe identity and rejects payload conflicts', async () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-fake-provider-'));
  const path = join(state, 'ledger.json');
  try {
    const first = new FakeProvider(path);
    const request = {
      idempotencyKey: 'idem-1', targetScope: 'customer-1',
      canonicalInputHash: 'hash-a', payload: { businessId: 'customer-1', value: 'on', behavior: 'success' as const },
    };
    await first.execute(request);
    const reopened = new FakeProvider(path);
    const duplicate = await reopened.execute(request);
    assert.equal(duplicate.actualUnits, 7);
    assert.equal(reopened.effectCount(), 1);
    await assert.rejects(reopened.execute({
      ...request, canonicalInputHash: 'hash-b', payload: { ...request.payload, value: 'off' },
    }), /FAKE_PROVIDER_PAYLOAD_CONFLICT/);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('compensation validates the original receipt and persists its own intent and reservation', async () => {
  const h = fixture();
  try {
    const operation = h.gateway.prepare(prepareInput());
    assert.equal((await h.gateway.dispatch(operation.id, owner())).status, 'SUCCEEDED');
    const workflow = new CompensationWorkflow(h.store, h.budget, h.provider);
    assert.throws(() => workflow.prepare({
      operationId: operation.id, authorizationRef: 'decision:D-1',
      resourceIdentity: 'wrong-resource', ownershipRef: 'customer-7', targetVersion: 'fake-v1',
    }), /COMPENSATION_RESOURCE_IDENTITY_MISMATCH/);
    assert.throws(() => workflow.prepare({
      operationId: operation.id, authorizationRef: 'decision:D-1',
      resourceIdentity: 'fake-customer-7', ownershipRef: 'wrong-owner', targetVersion: 'fake-v1',
    }), /COMPENSATION_OWNERSHIP_MISMATCH/);
    assert.throws(() => workflow.prepare({
      operationId: operation.id, authorizationRef: 'decision:D-1',
      resourceIdentity: 'fake-customer-7', ownershipRef: 'customer-7', targetVersion: 'fake-v2',
    }), /COMPENSATION_VERSION_MISMATCH/);

    const compensation = workflow.prepare({
      operationId: operation.id, authorizationRef: 'decision:D-1',
      resourceIdentity: 'fake-customer-7', ownershipRef: 'customer-7', targetVersion: 'fake-v1',
    });
    assert.equal(compensation.status, 'PREPARED');
    assert.notEqual(compensation.idempotencyKey, operation.idempotencyKey);
    assert.equal(h.store.getBudgetReservation(compensation.reservationId!)?.status, 'HELD');
    assert.equal(workflow.prepare({
      operationId: operation.id, authorizationRef: 'decision:D-1',
      resourceIdentity: 'fake-customer-7', ownershipRef: 'customer-7', targetVersion: 'fake-v1',
    }).id, compensation.id);
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('lost compensation response survives restart and repeated recovery removes at most once', async () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-compensation-restart-'));
  const harnessState = join(state, 'harness');
  const providerPath = join(state, 'provider-ledger.json');
  let store = new Store(harnessState);
  try {
    const work: Work = {
      id: 'W-comp', title: 'compensation fixture', repositoryId: 'repo', workspace: '/repo',
      state: 'ACTIVE', currentContractVersion: 1, retryBudget: 2, createdAt: '2026-09-22T00:00:00.000Z',
    };
    store.insertWork(work);
    let budget = new BudgetLedger(store);
    budget.configureLimit({
      workId: work.id, resourceKind: 'fake_write', currency: 'unit', limitUnits: 100, pricingVersion: 'fake-v1',
    });
    let provider = new FakeProvider(providerPath);
    const gateway = new OperationGateway(store, budget, provider);
    const operation = gateway.prepare({
      ...prepareInput(), workId: work.id,
      payload: {
        businessId: 'customer-7', value: 'enabled', behavior: 'success' as const,
        compensationBehavior: 'lose-response-after-effect' as const,
      },
    });
    await gateway.dispatch(operation.id, owner());
    let workflow = new CompensationWorkflow(store, budget, provider);
    const compensation = workflow.prepare({
      operationId: operation.id, authorizationRef: 'decision:D-compensate',
      resourceIdentity: 'fake-customer-7', ownershipRef: 'customer-7', targetVersion: 'fake-v1',
    });
    const dispatchedAt = new Date().toISOString();
    store.withTransaction(() => {
      store.updateCompensation({ ...compensation, status: 'DISPATCHED', updatedAt: dispatchedAt });
      store.insertCompensationAttempt({
        id: 'COMPA-crash', compensationId: compensation.id, number: 1,
        status: 'DISPATCHED', dispatchedAt,
      });
    });
    await assert.rejects(provider.compensate({
      idempotencyKey: compensation.idempotencyKey, externalId: compensation.resourceIdentity,
      resourceVersion: compensation.targetVersion, ownershipRef: compensation.ownershipRef,
    }), /FAKE_COMPENSATION_RESPONSE_LOST/);
    assert.equal(provider.compensationEffectCount(), 1);
    store.close();

    store = new Store(harnessState);
    budget = new BudgetLedger(store);
    provider = new FakeProvider(providerPath);
    workflow = new CompensationWorkflow(store, budget, provider);
    assert.equal((await workflow.reconcile(compensation.id, owner())).status, 'SUCCEEDED');
    assert.equal((await workflow.reconcile(compensation.id, owner())).status, 'SUCCEEDED');
    assert.equal(provider.compensationEffectCount(), 1);
    assert.equal(store.listCompensationAttempts(compensation.id)[0]?.status, 'UNKNOWN');
    const reservation = store.getBudgetReservation(compensation.reservationId!)!;
    assert.equal(reservation.status, 'SETTLED');
    assert.equal(reservation.settledUnits, 3);
    assert.equal(store.listBudgetLedger(reservation.limitId)
      .filter((entry) => entry.reservationId === reservation.id && entry.kind === 'SETTLE').length, 1);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test('stale compensation reconciliation cannot overwrite a concurrently settled result', async () => {
  const h = fixture();
  try {
    const operation = h.gateway.prepare({
      ...prepareInput(),
      payload: {
        businessId: 'customer-7', value: 'enabled', behavior: 'success' as const,
        compensationBehavior: 'lose-response-after-effect' as const,
      },
    });
    await h.gateway.dispatch(operation.id, owner());
    const workflow = new CompensationWorkflow(h.store, h.budget, h.provider);
    const compensation = workflow.prepare({
      operationId: operation.id, authorizationRef: 'decision:D-compensate',
      resourceIdentity: 'fake-customer-7', ownershipRef: 'customer-7', targetVersion: 'fake-v1',
    });
    assert.equal((await workflow.dispatch(compensation.id, owner())).status, 'UNKNOWN');
    h.provider.lookupCompensation = async () => {
      const reconciling = h.store.getCompensation(compensation.id)!;
      assert.equal(reconciling.status, 'RECONCILING');
      h.store.withTransaction(() => {
        h.store.updateCompensation({
          ...reconciling, status: 'SUCCEEDED', updatedAt: new Date().toISOString(),
        });
        h.budget.settleInTransaction(compensation.reservationId!, 3);
      });
      return { kind: 'pending' };
    };

    await assert.rejects(workflow.reconcile(compensation.id, owner()), /STATE_CONFLICT/);
    assert.equal(h.store.getCompensation(compensation.id)!.status, 'SUCCEEDED');
    assert.equal(h.store.getBudgetReservation(compensation.reservationId!)!.status, 'SETTLED');
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('compensation worker that loses authority leaves dispatch state for reconciliation', async () => {
  const h = fixture();
  try {
    const operation = h.gateway.prepare(prepareInput());
    await h.gateway.dispatch(operation.id, owner());
    const workflow = new CompensationWorkflow(h.store, h.budget, h.provider);
    const compensation = workflow.prepare({
      operationId: operation.id, authorizationRef: 'decision:D-compensate',
      resourceIdentity: 'fake-customer-7', ownershipRef: 'customer-7', targetVersion: 'fake-v1',
    });

    await assert.rejects(workflow.dispatch(compensation.id, expiringOwner(2)), /OWNER_UNKNOWN/);

    assert.equal(h.provider.compensationEffectCount(), 1);
    assert.equal(h.store.getCompensation(compensation.id)!.status, 'DISPATCHED');
    assert.equal(h.store.listCompensationAttempts(compensation.id)[0]!.status, 'DISPATCHED');
    assert.equal(h.store.getBudgetReservation(compensation.reservationId!)!.status, 'HELD');
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('unsupported and irreversible compensation wait for a person with durable cost history', async () => {
  for (const mode of ['unsupported', 'irreversible'] as const) {
    const h = fixture();
    try {
      const operation = h.gateway.prepare({
        ...prepareInput(), intentKey: `create:${mode}`, targetScope: `customer-${mode}`,
        payload: {
          businessId: `customer-${mode}`, value: 'enabled', behavior: 'success' as const,
          compensationBehavior: mode === 'unsupported' ? 'unsupported' as const : 'success' as const,
        },
      });
      const succeeded = await h.gateway.dispatch(operation.id, owner());
      if (mode === 'irreversible') {
        h.store.updateOperation({
          ...succeeded, capabilities: { ...succeeded.capabilities, reversibility: 'irreversible' },
        });
      }
      const workflow = new CompensationWorkflow(h.store, h.budget, h.provider);
      const compensation = workflow.prepare({
        operationId: operation.id, authorizationRef: 'decision:D-compensate',
        resourceIdentity: `fake-customer-${mode}`, ownershipRef: `customer-${mode}`, targetVersion: 'fake-v1',
      });
      const waiting = mode === 'unsupported' ? await workflow.dispatch(compensation.id, owner()) : compensation;
      assert.equal(waiting.status, 'WAITING_USER');
      assert.ok(waiting.manualReason);
      assert.equal(h.store.getBudgetReservation(compensation.reservationId!)?.status, 'RELEASED');
      assert.deepEqual(h.store.listBudgetLedger(
        h.store.getBudgetReservation(compensation.reservationId!)!.limitId,
      ).slice(-2).map((entry) => entry.kind), ['RESERVE', 'RELEASE']);
    } finally {
      h.store.close();
      rmSync(h.state, { recursive: true, force: true });
    }
  }
});
