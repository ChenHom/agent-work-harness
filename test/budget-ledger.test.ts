import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger } from '../src/budget/ledger.ts';
import { Store } from '../src/trace/store.ts';
import type { AdapterCapabilitySnapshot, Work } from '../src/types.ts';

function fixture(limitUnits = 100): { state: string; store: Store; ledger: BudgetLedger; work: Work; limitId: string } {
  const state = mkdtempSync(join(tmpdir(), 'harness-budget-'));
  const store = new Store(state);
  const work: Work = {
    id: 'W-budget', title: 'budget fixture', repositoryId: 'repo', workspace: '/repo',
    state: 'ACTIVE', currentContractVersion: 1, retryBudget: 2,
    createdAt: '2026-09-22T00:00:00.000Z',
  };
  store.insertWork(work);
  const ledger = new BudgetLedger(store);
  const limit = ledger.configureLimit({
    workId: work.id, resourceKind: 'provider_write', currency: 'TWD',
    limitUnits, pricingVersion: 'fake-v1',
  });
  return { state, store, ledger, work, limitId: limit.id };
}

const cost = (units: number): AdapterCapabilitySnapshot['cost'] => ({
  mode: 'bounded', resourceKind: 'provider_write', currency: 'TWD',
  upperBoundUnits: units, pricingVersion: 'fake-v1',
});

test('reservation, UNKNOWN hold, settlement, and confirmed release update integer balances', () => {
  const h = fixture();
  try {
    const first = h.ledger.reserve({ workId: h.work.id, operationId: 'OP-1', cost: cost(40) });
    assert.deepEqual(h.ledger.summary(h.limitId), { limitUnits: 100, reservedUnits: 40, spentUnits: 0, availableUnits: 60 });

    h.ledger.markUnknown(first.id);
    assert.deepEqual(h.ledger.summary(h.limitId), { limitUnits: 100, reservedUnits: 40, spentUnits: 0, availableUnits: 60 });
    h.ledger.settle(first.id, 25);
    assert.deepEqual(h.ledger.summary(h.limitId), { limitUnits: 100, reservedUnits: 0, spentUnits: 25, availableUnits: 75 });

    const second = h.ledger.reserve({ workId: h.work.id, operationId: 'OP-2', cost: cost(30) });
    h.ledger.releaseConfirmedUnused(second.id);
    assert.deepEqual(h.ledger.summary(h.limitId), { limitUnits: 100, reservedUnits: 0, spentUnits: 25, availableUnits: 75 });
    assert.deepEqual(h.store.listBudgetLedger(h.limitId).map((entry) => entry.kind), [
      'RESERVE', 'SETTLE', 'RESERVE', 'RELEASE',
    ]);
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('competing reservations cannot exceed the hard limit and fork/replan cannot reset it', () => {
  const h = fixture(100);
  try {
    h.ledger.reserve({ workId: h.work.id, operationId: 'OP-plan-v1', cost: cost(60) });
    assert.throws(() => h.ledger.reserve({
      workId: h.work.id, operationId: 'OP-plan-v2', cost: cost(50),
    }), /BUDGET_EXCEEDED/);
    assert.equal(h.store.listBudgetReservations(h.limitId).length, 1);
    assert.deepEqual(h.ledger.summary(h.limitId), { limitUnits: 100, reservedUnits: 60, spentUnits: 0, availableUnits: 40 });
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('hard-cap ledger rejects floats, negatives, mismatched pricing, and unbounded usage', () => {
  const h = fixture();
  try {
    assert.throws(() => h.ledger.reserve({
      workId: h.work.id, operationId: 'OP-float', cost: cost(1.5),
    }), /BUDGET_INVALID.*integer/);
    assert.throws(() => h.ledger.reserve({
      workId: h.work.id, operationId: 'OP-negative', cost: cost(-1),
    }), /BUDGET_INVALID/);
    assert.throws(() => h.ledger.reserve({
      workId: h.work.id, operationId: 'OP-price', cost: { ...cost(1), pricingVersion: 'fake-v2' },
    }), /BUDGET_PRICING_MISMATCH/);
    assert.throws(() => h.ledger.reserve({
      workId: h.work.id, operationId: 'OP-currency', cost: { ...cost(1), currency: 'USD' },
    }), /BUDGET_LIMIT_NOT_FOUND|BUDGET_CURRENCY_MISMATCH/);
    assert.throws(() => h.ledger.reserve({
      workId: h.work.id, operationId: 'OP-unknown',
      cost: { mode: 'unknown', resourceKind: 'provider_write' },
    }), /BUDGET_UNBOUNDED/);
    assert.throws(() => h.ledger.reserve({
      workId: h.work.id, operationId: 'OP-estimated',
      cost: { mode: 'estimated', resourceKind: 'provider_write', upperBoundUnits: 1 },
    }), /BUDGET_UNBOUNDED/);
    const bounded = h.ledger.reserve({ workId: h.work.id, operationId: 'OP-bounded', cost: cost(5) });
    assert.throws(() => h.ledger.settle(bounded.id, 6), /BUDGET_RECEIPT_EXCEEDS_RESERVATION/);
    assert.throws(() => h.ledger.settle('BR-missing', 1), /BUDGET_RESERVATION_NOT_FOUND/);
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('limit configuration rejects non-integer and negative units', () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-budget-invalid-'));
  const store = new Store(state);
  try {
    const ledger = new BudgetLedger(store);
    assert.throws(() => ledger.configureLimit({
      workId: 'W', resourceKind: 'provider_write', limitUnits: 2.5, pricingVersion: 'v1',
    }), /BUDGET_INVALID.*integer/);
    assert.throws(() => ledger.configureLimit({
      workId: 'W', resourceKind: 'provider_write', limitUnits: -1, pricingVersion: 'v1',
    }), /BUDGET_INVALID/);
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});
