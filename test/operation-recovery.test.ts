import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger } from '../src/budget/ledger.ts';
import { FakeProvider } from '../src/tools/fake-provider.ts';
import { OperationGateway } from '../src/tools/gateway.ts';
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
