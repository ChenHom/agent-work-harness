import { newId } from '../ids.ts';
import { assertDispatchAuthority, type DispatchAuthority } from '../runtime/dispatch-authority.ts';
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
  private readonly clock: () => number;

  constructor(
    store: Store,
    budget: BudgetLedger,
    adapter: OperationAdapter,
    clock: () => number = Date.now,
  ) {
    this.store = store;
    this.budget = budget;
    this.adapter = adapter;
    this.clock = clock;
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
    const at = this.nowIso();
    const operationId = newId('OP');
    return this.store.withTransaction(() => {
      const reservation = this.budget.reserveInTransaction({
        workId: input.workId, operationId, cost: this.adapter.capabilities.cost,
      });
      const operation: Operation = {
        schemaVersion: '1', id: operationId, workId: input.workId, intentKey: input.intentKey,
        kind: input.kind, targetScope: input.targetScope, canonicalInputHash: inputHash,
        inputArtifactId: artifact.id, idempotencyKey: newId('IDEM'),
        dedupeExpiresAt: new Date(this.clock() + this.adapter.capabilities.idempotencyKeyTtlMs).toISOString(),
        precondition: input.precondition, reconciliationStrategy: input.reconciliationStrategy,
        compensationPolicy: input.compensationPolicy, authorizationRef: input.authorizationRef,
        capabilities: structuredClone(this.adapter.capabilities), reservationId: reservation.id,
        status: 'PREPARED', createdAt: at, updatedAt: at,
      };
      this.store.insertOperation(operation);
      return operation;
    });
  }

  async dispatch(operationId: string, authority: DispatchAuthority): Promise<Operation> {
    await assertDispatchAuthority(authority, 'dispatch', 'operation dispatch admission');
    if (!authority.beginOperation()) throw new Error('OWNER_ACTIVE: another operation is running');
    try {
      const current = this.requireOperation(operationId);
      if (current.status === 'SUCCEEDED' || current.status === 'FAILED') return current;
      if (current.status === 'UNKNOWN' || current.status === 'RECONCILING') {
        throw new Error(`OPERATION_RECONCILIATION_REQUIRED: ${operationId}`);
      }
      if (current.status !== 'PREPARED') {
        throw new Error(`OPERATION_INVALID_STATE: ${operationId} is ${current.status}`);
      }
      await assertDispatchAuthority(authority, 'dispatch', 'operation dispatch intent');
      const request = this.requestFor(current);
      const attempt: OperationAttempt = {
        id: newId('OPA'), operationId, number: this.store.listOperationAttempts(operationId).length + 1,
        status: 'DISPATCHED', dispatchedAt: this.nowIso(),
      };
      const dispatched: Operation = { ...current, status: 'DISPATCHED', updatedAt: this.nowIso() };
      this.store.withTransaction(() => {
        this.store.updateOperation(dispatched, current.status);
        this.store.insertOperationAttempt(attempt);
      });
      try {
        await assertDispatchAuthority(authority, 'dispatch', 'provider dispatch');
        const receipt = await this.adapter.execute(request);
        if (!await authority.validate('dispatch')) {
          throw new AdapterDispatchError('ambiguous', 'OWNER_UNKNOWN: lost after provider call');
        }
        if (!await this.adapter.verifyPostcondition(request, receipt)) {
          throw new AdapterDispatchError('ambiguous', 'OPERATION_POSTCONDITION_FAILED');
        }
        return this.recordSuccess(dispatched, attempt, receipt);
      } catch (error) {
        if ((error instanceof AdapterDispatchError && error.message.startsWith('OWNER_UNKNOWN:'))
          || !await authority.validate('dispatch')) throw error;
        return this.recordFailure(dispatched, attempt, error);
      }
    } finally {
      authority.endOperation();
    }
  }

  async reconcile(operationId: string, authority: DispatchAuthority): Promise<Operation> {
    await assertDispatchAuthority(authority, 'reconcile', 'operation reconciliation admission');
    if (!authority.beginOperation()) throw new Error('OWNER_ACTIVE: another operation is running');
    try {
      const current = this.requireOperation(operationId);
      if (current.status === 'SUCCEEDED' || current.status === 'FAILED' || current.status === 'WAITING_USER') {
        return current;
      }
      if (current.status !== 'DISPATCHED' && current.status !== 'UNKNOWN' && current.status !== 'RECONCILING') {
        throw new Error(`OPERATION_NOT_RECONCILABLE: ${operationId} is ${current.status}`);
      }
      const reconciling: Operation = current.status === 'RECONCILING' ? current
        : { ...current, status: 'RECONCILING', updatedAt: this.nowIso() };
      if (current.status !== 'RECONCILING') {
        this.store.withTransaction(() => {
          this.store.updateOperation(reconciling, current.status);
          if (current.status === 'DISPATCHED') {
            const attempt = this.store.listOperationAttempts(operationId).at(-1);
            if (!attempt || attempt.status !== 'DISPATCHED') {
              throw new Error(`OPERATION_ATTEMPT_NOT_DISPATCHED: ${operationId}`);
            }
            this.store.updateOperationAttempt({
              ...attempt, status: 'UNKNOWN', completedAt: this.nowIso(),
              error: 'worker completion unacknowledged; recovered by reconciliation',
            }, attempt.status);
            this.budget.markUnknownInTransaction(this.requireReservation(current));
          }
        });
      }
      const request = this.requestFor(reconciling);
      const firstDispatch = this.store.listOperationAttempts(operationId)[0];
      if (!firstDispatch) throw new Error(`OPERATION_ATTEMPT_NOT_FOUND: ${operationId}`);
      const completionWindowClosed = this.clock() >= Date.parse(firstDispatch.dispatchedAt)
        + reconciling.capabilities.completionWindowMs;
      let outcome;
      if (reconciling.capabilities.lookup === 'unsupported') outcome = { kind: 'unsupported' } as const;
      else {
        try {
          outcome = await this.adapter.lookup(request, completionWindowClosed);
        } catch {
          outcome = { kind: 'pending' } as const;
        }
      }
      await assertDispatchAuthority(authority, 'reconcile', 'operation reconciliation lookup');
      const artifact = this.store.putArtifact('operation-reconciliation', canonicalJson(outcome), 'json');
      if (outcome.kind === 'confirmed-success') {
        if (!await this.adapter.verifyPostcondition(request, outcome.receipt)) {
          return this.finishReconciliation(reconciling, artifact.id, 'WAITING_USER', 'reconciled receipt failed postcondition');
        }
        const succeeded: Operation = {
          ...reconciling, status: 'SUCCEEDED', lastReconciliationArtifactId: artifact.id,
          updatedAt: this.nowIso(),
        };
        this.store.withTransaction(() => {
          this.store.updateOperation(succeeded, reconciling.status);
          this.budget.settleInTransaction(this.requireReservation(reconciling), outcome.receipt.actualUnits);
          this.store.event('operation.reconciled', { operationId, outcome: outcome.kind, artifactId: artifact.id }, current.workId);
        });
        return succeeded;
      }
      if (outcome.kind === 'confirmed-no-effect') {
        const failed: Operation = {
          ...reconciling, status: 'FAILED', lastReconciliationArtifactId: artifact.id,
          updatedAt: this.nowIso(),
        };
        this.store.withTransaction(() => {
          this.store.updateOperation(failed, reconciling.status);
          this.budget.releaseConfirmedUnusedInTransaction(this.requireReservation(reconciling));
          this.store.event('operation.reconciled', { operationId, outcome: outcome.kind, artifactId: artifact.id }, current.workId);
        });
        return failed;
      }
      const expired = this.clock() >= Date.parse(reconciling.dedupeExpiresAt);
      if (expired || outcome.kind === 'partial-effect' || outcome.kind === 'unsupported') {
        const reason = expired ? 'idempotency key expired while outcome remains unresolved' : `lookup ${outcome.kind}`;
        return this.finishReconciliation(reconciling, artifact.id, 'WAITING_USER', reason);
      }
      return this.finishReconciliation(reconciling, artifact.id, 'UNKNOWN', 'provider result is not yet visible');
    } finally {
      authority.endOperation();
    }
  }

  private recordSuccess(operation: Operation, attempt: OperationAttempt, receipt: OperationReceipt): Operation {
    const artifact = this.store.putArtifact('operation-receipt', canonicalJson(receipt), 'json');
    const at = this.nowIso();
    const succeeded: Operation = { ...operation, status: 'SUCCEEDED', updatedAt: at };
    const completed: OperationAttempt = {
      ...attempt, status: 'SUCCEEDED', completedAt: at, receiptArtifactId: artifact.id,
    };
    this.store.withTransaction(() => {
      this.store.updateOperationAttempt(completed, attempt.status);
      this.store.updateOperation(succeeded, operation.status);
      this.budget.settleInTransaction(this.requireReservation(operation), receipt.actualUnits);
    });
    return succeeded;
  }

  private recordFailure(operation: Operation, attempt: OperationAttempt, error: unknown): Operation {
    const definitive = error instanceof AdapterDispatchError && error.outcome === 'definitive-no-effect';
    const status = definitive ? 'FAILED' : 'UNKNOWN';
    const at = this.nowIso();
    const updated: Operation = { ...operation, status, updatedAt: at };
    const completed: OperationAttempt = {
      ...attempt, status, completedAt: at, error: error instanceof Error ? error.message : String(error),
    };
    this.store.withTransaction(() => {
      this.store.updateOperationAttempt(completed, attempt.status);
      this.store.updateOperation(updated, operation.status);
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

  private requestFor(operation: Operation): OperationDispatchRequest {
    return {
      idempotencyKey: operation.idempotencyKey, targetScope: operation.targetScope,
      canonicalInputHash: operation.canonicalInputHash, payload: this.readInput(operation),
    };
  }

  private finishReconciliation(
    operation: Operation,
    artifactId: string,
    status: 'UNKNOWN' | 'WAITING_USER',
    reason: string,
  ): Operation {
    const updated: Operation = {
      ...operation, status, lastReconciliationArtifactId: artifactId,
      manualReason: status === 'WAITING_USER' ? reason : undefined, updatedAt: this.nowIso(),
    };
    this.store.withTransaction(() => {
      this.store.updateOperation(updated, operation.status);
      this.store.event('operation.reconciled', {
        operationId: operation.id, outcome: status, reason, artifactId,
      }, operation.workId);
    });
    return updated;
  }

  private nowIso(): string { return new Date(this.clock()).toISOString(); }

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
