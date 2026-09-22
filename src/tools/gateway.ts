import { newId, nowIso } from '../ids.ts';
import type { ExecutionOwnership } from '../runtime/ownership.ts';
import { BudgetLedger } from '../budget/ledger.ts';
import { Store } from '../trace/store.ts';
import type { Operation, OperationAttempt } from '../types.ts';
import {
  AdapterDispatchError, canonicalHash, canonicalJson,
  type OperationAdapter, type OperationDispatchRequest, type OperationReceipt,
} from './operations.ts';

interface PrepareOperationInput {
  workId: string;
  intentKey: string;
  kind: string;
  targetScope: string;
  payload: unknown;
  precondition: string;
  reconciliationStrategy: string;
  compensationPolicy: string;
  authorizationRef: string;
}

export class OperationGateway {
  private readonly store: Store;
  private readonly budget: BudgetLedger;
  private readonly adapter: OperationAdapter;

  constructor(
    store: Store,
    budget: BudgetLedger,
    adapter: OperationAdapter,
  ) {
    this.store = store;
    this.budget = budget;
    this.adapter = adapter;
  }

  prepare(input: PrepareOperationInput): Operation {
    const inputHash = canonicalHash(input.payload);
    const existing = this.store.findOperationByIntent(input.workId, input.intentKey);
    if (existing) {
      if (existing.kind !== input.kind || existing.targetScope !== input.targetScope
        || existing.canonicalInputHash !== inputHash) {
        throw new Error(`OPERATION_INTENT_CONFLICT: ${input.workId}/${input.intentKey}`);
      }
      return existing;
    }
    if (!this.store.getWork(input.workId)) throw new Error(`OPERATION_WORK_NOT_FOUND: ${input.workId}`);
    const artifact = this.store.putArtifact('operation-input', canonicalJson(input.payload), 'json');
    const at = nowIso();
    const operationId = newId('OP');
    return this.store.withTransaction(() => {
      const reservation = this.budget.reserveInTransaction({
        workId: input.workId, operationId, cost: this.adapter.capabilities.cost,
      });
      const operation: Operation = {
        schemaVersion: '1', id: operationId, workId: input.workId, intentKey: input.intentKey,
        kind: input.kind, targetScope: input.targetScope, canonicalInputHash: inputHash,
        inputArtifactId: artifact.id, idempotencyKey: newId('IDEM'),
        dedupeExpiresAt: new Date(Date.now() + this.adapter.capabilities.idempotencyKeyTtlMs).toISOString(),
        precondition: input.precondition, reconciliationStrategy: input.reconciliationStrategy,
        compensationPolicy: input.compensationPolicy, authorizationRef: input.authorizationRef,
        capabilities: structuredClone(this.adapter.capabilities), reservationId: reservation.id,
        status: 'PREPARED', createdAt: at, updatedAt: at,
      };
      this.store.insertOperation(operation);
      return operation;
    });
  }

  async dispatch(operationId: string, ownership: ExecutionOwnership): Promise<Operation> {
    if (!ownership.validate()) throw new Error('OWNER_UNKNOWN: execution ownership is invalid');
    if (!ownership.beginOperation()) throw new Error('OWNER_ACTIVE: another operation is running');
    try {
      const current = this.requireOperation(operationId);
      if (current.status === 'SUCCEEDED' || current.status === 'FAILED') return current;
      if (current.status !== 'PREPARED' && current.status !== 'UNKNOWN') {
        throw new Error(`OPERATION_INVALID_STATE: ${operationId} is ${current.status}`);
      }
      if (!ownership.validate()) throw new Error('OWNER_UNKNOWN: execution ownership was lost');
      const payload = this.readInput(current);
      const request: OperationDispatchRequest = {
        idempotencyKey: current.idempotencyKey, targetScope: current.targetScope,
        canonicalInputHash: current.canonicalInputHash, payload,
      };
      const attempt: OperationAttempt = {
        id: newId('OPA'), operationId, number: this.store.listOperationAttempts(operationId).length + 1,
        status: 'DISPATCHED', dispatchedAt: nowIso(),
      };
      const dispatched: Operation = { ...current, status: 'DISPATCHED', updatedAt: nowIso() };
      this.store.withTransaction(() => {
        this.store.updateOperation(dispatched);
        this.store.insertOperationAttempt(attempt);
      });
      try {
        const receipt = await this.adapter.execute(request);
        if (!ownership.validate()) throw new AdapterDispatchError('ambiguous', 'OWNER_UNKNOWN: lost after provider call');
        if (!await this.adapter.verifyPostcondition(request, receipt)) {
          throw new AdapterDispatchError('ambiguous', 'OPERATION_POSTCONDITION_FAILED');
        }
        return this.recordSuccess(dispatched, attempt, receipt);
      } catch (error) {
        return this.recordFailure(dispatched, attempt, error);
      }
    } finally {
      ownership.endOperation();
    }
  }

  private recordSuccess(operation: Operation, attempt: OperationAttempt, receipt: OperationReceipt): Operation {
    const artifact = this.store.putArtifact('operation-receipt', canonicalJson(receipt), 'json');
    const at = nowIso();
    const succeeded: Operation = { ...operation, status: 'SUCCEEDED', updatedAt: at };
    const completed: OperationAttempt = {
      ...attempt, status: 'SUCCEEDED', completedAt: at, receiptArtifactId: artifact.id,
    };
    this.store.withTransaction(() => {
      this.store.updateOperationAttempt(completed);
      this.store.updateOperation(succeeded);
      this.budget.settleInTransaction(this.requireReservation(operation), receipt.actualUnits);
    });
    return succeeded;
  }

  private recordFailure(operation: Operation, attempt: OperationAttempt, error: unknown): Operation {
    const definitive = error instanceof AdapterDispatchError && error.outcome === 'definitive-no-effect';
    const status = definitive ? 'FAILED' : 'UNKNOWN';
    const at = nowIso();
    const updated: Operation = { ...operation, status, updatedAt: at };
    const completed: OperationAttempt = {
      ...attempt, status, completedAt: at, error: error instanceof Error ? error.message : String(error),
    };
    this.store.withTransaction(() => {
      this.store.updateOperationAttempt(completed);
      this.store.updateOperation(updated);
      const reservationId = this.requireReservation(operation);
      if (definitive) this.budget.releaseConfirmedUnusedInTransaction(reservationId);
      else this.budget.markUnknownInTransaction(reservationId);
    });
    return updated;
  }

  private readInput(operation: Operation): unknown {
    const artifact = this.store.readVerifiedArtifact(operation.inputArtifactId);
    if (artifact.status !== 'verified') throw new Error(`OPERATION_INPUT_${artifact.status.toUpperCase()}: ${operation.id}`);
    const payload = JSON.parse(artifact.content.toString('utf8')) as unknown;
    if (canonicalHash(payload) !== operation.canonicalInputHash) {
      throw new Error(`OPERATION_INPUT_HASH_MISMATCH: ${operation.id}`);
    }
    return payload;
  }

  private requireOperation(id: string): Operation {
    const operation = this.store.getOperation(id);
    if (!operation) throw new Error(`OPERATION_NOT_FOUND: ${id}`);
    return operation;
  }

  private requireReservation(operation: Operation): string {
    if (!operation.reservationId) throw new Error(`OPERATION_RESERVATION_MISSING: ${operation.id}`);
    return operation.reservationId;
  }
}
