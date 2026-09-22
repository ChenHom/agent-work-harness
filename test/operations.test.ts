import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/trace/store.ts';
import type {
  AdapterCapabilitySnapshot, BudgetLedgerEntry, BudgetLimit, BudgetReservation,
  Compensation, CompensationAttempt, Operation, OperationAttempt, Work,
} from '../src/types.ts';

const capabilities: AdapterCapabilitySnapshot = {
  adapter: 'fake', version: '1', effectType: 'write', retrySafety: 'deduplicated',
  reversibility: 'compensable', lookup: 'supported', postcondition: 'resource exists',
  upperBoundSupport: 'supported', idempotencyKeyTtlMs: 60_000,
  completionWindowMs: 5_000,
  cost: { mode: 'bounded', resourceKind: 'provider_write', currency: 'TWD', upperBoundUnits: 10, pricingVersion: 'fake-v1' },
};

function fixture(): { state: string; store: Store; work: Work } {
  const state = mkdtempSync(join(tmpdir(), 'harness-operation-store-'));
  const store = new Store(state);
  const work: Work = {
    id: 'W-op', title: 'operation fixture', repositoryId: 'repo', workspace: '/repo',
    state: 'ACTIVE', currentContractVersion: 1, retryBudget: 2,
    createdAt: '2026-09-22T00:00:00.000Z',
  };
  store.insertWork(work);
  return { state, store, work };
}

test('operation, compensation, reservation, and ledger records round-trip', () => {
  const h = fixture();
  try {
    const limit: BudgetLimit = {
      id: 'BL-1', workId: h.work.id, resourceKind: 'provider_write', currency: 'TWD',
      limitUnits: 100, pricingVersion: 'fake-v1', createdAt: '2026-09-22T00:01:00.000Z',
    };
    const reservation: BudgetReservation = {
      id: 'BR-1', workId: h.work.id, limitId: limit.id, operationId: 'OP-1',
      amountUnits: 10, status: 'HELD', createdAt: '2026-09-22T00:02:00.000Z',
      updatedAt: '2026-09-22T00:02:00.000Z',
    };
    const operation: Operation = {
      schemaVersion: '1', id: 'OP-1', workId: h.work.id, intentKey: 'deploy:resource-1',
      kind: 'fake.create', targetScope: 'resource-1', canonicalInputHash: 'hash-a',
      inputArtifactId: 'AR-input', idempotencyKey: 'idem-op-1',
      dedupeExpiresAt: '2026-09-22T01:00:00.000Z', precondition: 'resource absent',
      reconciliationStrategy: 'lookup by idempotency key', compensationPolicy: 'delete owned resource',
      authorizationRef: 'contract:C-1', capabilities, reservationId: reservation.id,
      status: 'PREPARED', createdAt: '2026-09-22T00:02:00.000Z', updatedAt: '2026-09-22T00:02:00.000Z',
    };
    const operationAttempt: OperationAttempt = {
      id: 'OPA-1', operationId: operation.id, number: 1, status: 'DISPATCHED',
      dispatchedAt: '2026-09-22T00:03:00.000Z',
    };
    const compensation: Compensation = {
      schemaVersion: '1', id: 'COMP-1', operationId: operation.id, workId: h.work.id,
      idempotencyKey: 'idem-comp-1', authorizationRef: 'decision:D-1', targetVersion: 'provider-v1',
      reservationId: 'BR-2', status: 'PREPARED', createdAt: '2026-09-22T00:04:00.000Z',
      updatedAt: '2026-09-22T00:04:00.000Z',
    };
    const compensationAttempt: CompensationAttempt = {
      id: 'COMPA-1', compensationId: compensation.id, number: 1, status: 'DISPATCHED',
      dispatchedAt: '2026-09-22T00:05:00.000Z',
    };
    const ledger: BudgetLedgerEntry = {
      id: 'BLE-1', workId: h.work.id, limitId: limit.id, reservationId: reservation.id,
      kind: 'RESERVE', reservedDeltaUnits: 10, spentDeltaUnits: 0,
      createdAt: '2026-09-22T00:02:00.000Z',
    };

    h.store.insertBudgetLimit(limit);
    h.store.insertOperation(operation);
    h.store.insertBudgetReservation(reservation);
    h.store.insertOperationAttempt(operationAttempt);
    h.store.insertCompensation(compensation);
    h.store.insertCompensationAttempt(compensationAttempt);
    h.store.insertBudgetLedgerEntry(ledger);

    assert.deepEqual(h.store.getBudgetLimit(limit.id), limit);
    assert.deepEqual(h.store.getOperation(operation.id), operation);
    assert.deepEqual(h.store.listOperations(h.work.id), [operation]);
    assert.deepEqual(h.store.listOperationAttempts(operation.id), [operationAttempt]);
    assert.deepEqual(h.store.getCompensation(compensation.id), compensation);
    assert.deepEqual(h.store.listCompensationAttempts(compensation.id), [compensationAttempt]);
    assert.deepEqual(h.store.getBudgetReservation(reservation.id), reservation);
    assert.deepEqual(h.store.listBudgetLedger(limit.id), [ledger]);
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});

test('logical intent, idempotency key, attempt number, and work resource limit are unique', () => {
  const h = fixture();
  try {
    const operation: Operation = {
      schemaVersion: '1', id: 'OP-1', workId: h.work.id, intentKey: 'intent-1', kind: 'fake.create',
      targetScope: 'resource-1', canonicalInputHash: 'hash-a', inputArtifactId: 'AR-input',
      idempotencyKey: 'idem-1', dedupeExpiresAt: '2026-09-22T01:00:00.000Z', precondition: 'absent',
      reconciliationStrategy: 'lookup', compensationPolicy: 'compensate', authorizationRef: 'C-1',
      capabilities, status: 'PREPARED', createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    };
    h.store.insertOperation(operation);
    assert.throws(() => h.store.insertOperation({ ...operation, id: 'OP-2', idempotencyKey: 'idem-2' }), /unique|constraint/i);
    assert.throws(() => h.store.insertOperation({ ...operation, id: 'OP-3', intentKey: 'intent-3' }), /unique|constraint/i);
    const attempt: OperationAttempt = {
      id: 'OPA-1', operationId: operation.id, number: 1, status: 'UNKNOWN',
      dispatchedAt: '2026-09-22T00:01:00.000Z', error: 'lost response',
    };
    h.store.insertOperationAttempt(attempt);
    assert.throws(() => h.store.insertOperationAttempt({ ...attempt, id: 'OPA-2' }), /unique|constraint/i);
    const limit: BudgetLimit = {
      id: 'BL-1', workId: h.work.id, resourceKind: 'provider_write', currency: 'TWD',
      limitUnits: 100, pricingVersion: 'fake-v1', createdAt: '2026-09-22T00:00:00.000Z',
    };
    h.store.insertBudgetLimit(limit);
    assert.throws(() => h.store.insertBudgetLimit({ ...limit, id: 'BL-2' }), /unique|constraint/i);
  } finally {
    h.store.close();
    rmSync(h.state, { recursive: true, force: true });
  }
});
