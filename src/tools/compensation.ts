import { newId } from '../ids.ts';
import { assertDispatchAuthority, type DispatchAuthority } from '../runtime/dispatch-authority.ts';
import { BudgetLedger } from '../budget/ledger.ts';
import { Store } from '../trace/store.ts';
import type { Compensation, CompensationAttempt, Operation } from '../types.ts';
import {
  AdapterDispatchError, canonicalJson, type CompensationDispatchRequest,
  type CompensationLookupOutcome, type CompensationReceipt, type OperationAdapter, type OperationReceipt,
} from './operations.ts';

interface PrepareCompensationInput {
  operationId: string;
  authorizationRef: string;
  resourceIdentity: string;
  ownershipRef: string;
  targetVersion: string;
}

export class CompensationWorkflow {
  private readonly store: Store;
  private readonly budget: BudgetLedger;
  private readonly adapter: OperationAdapter;
  private readonly clock: () => number;

  constructor(store: Store, budget: BudgetLedger, adapter: OperationAdapter, clock: () => number = Date.now) {
    this.store = store;
    this.budget = budget;
    this.adapter = adapter;
    this.clock = clock;
  }

  prepare(input: PrepareCompensationInput): Compensation {
    const operation = this.requireOperation(input.operationId);
    const existing = this.store.getCompensationForOperation(operation.id);
    if (existing) {
      if (existing.authorizationRef !== input.authorizationRef
        || existing.resourceIdentity !== input.resourceIdentity
        || existing.ownershipRef !== input.ownershipRef
        || existing.targetVersion !== input.targetVersion) {
        throw new Error(`COMPENSATION_INTENT_CONFLICT: ${operation.id}`);
      }
      return existing;
    }
    if (operation.status !== 'SUCCEEDED') throw new Error(`COMPENSATION_OPERATION_NOT_SUCCEEDED: ${operation.id}`);
    if (!input.authorizationRef.trim()) throw new Error('COMPENSATION_AUTHORIZATION_REQUIRED');
    const receipt = this.originalReceipt(operation);
    if (receipt.externalId !== input.resourceIdentity) throw new Error('COMPENSATION_RESOURCE_IDENTITY_MISMATCH');
    if (receipt.ownershipRef !== input.ownershipRef) throw new Error('COMPENSATION_OWNERSHIP_MISMATCH');
    if (receipt.resourceVersion !== input.targetVersion) throw new Error('COMPENSATION_VERSION_MISMATCH');
    const id = newId('COMP');
    const at = this.nowIso();
    return this.store.withTransaction(() => {
      const reservation = this.budget.reserveInTransaction({
        workId: operation.workId, compensationId: id, cost: operation.capabilities.cost,
      });
      const reversible = operation.capabilities.reversibility === 'compensable';
      const compensation: Compensation = {
        schemaVersion: '1', id, operationId: operation.id, workId: operation.workId,
        idempotencyKey: newId('IDEM-COMP'), authorizationRef: input.authorizationRef,
        resourceIdentity: input.resourceIdentity, ownershipRef: input.ownershipRef,
        targetVersion: input.targetVersion, reservationId: reservation.id,
        status: reversible ? 'PREPARED' : 'WAITING_USER',
        manualReason: reversible ? undefined : 'adapter marks the original effect irreversible',
        createdAt: at, updatedAt: at,
      };
      this.store.insertCompensation(compensation);
      if (!reversible) this.budget.releaseConfirmedUnusedInTransaction(reservation.id);
      return compensation;
    });
  }

  async dispatch(compensationId: string, authority: DispatchAuthority): Promise<Compensation> {
    await assertDispatchAuthority(authority, 'dispatch', 'compensation dispatch admission');
    if (!authority.beginOperation()) throw new Error('OWNER_ACTIVE: another operation is running');
    try {
      const current = this.requireCompensation(compensationId);
      if (current.status === 'SUCCEEDED' || current.status === 'WAITING_USER') return current;
      if (current.status === 'UNKNOWN' || current.status === 'RECONCILING') {
        throw new Error(`COMPENSATION_RECONCILIATION_REQUIRED: ${compensationId}`);
      }
      if (current.status !== 'PREPARED') {
        throw new Error(`COMPENSATION_INVALID_STATE: ${compensationId} is ${current.status}`);
      }
      const request = this.request(current);
      const attempt: CompensationAttempt = {
        id: newId('COMPA'), compensationId, number: this.store.listCompensationAttempts(compensationId).length + 1,
        status: 'DISPATCHED', dispatchedAt: this.nowIso(),
      };
      const dispatched: Compensation = { ...current, status: 'DISPATCHED', updatedAt: this.nowIso() };
      this.store.withTransaction(() => {
        this.store.updateCompensation(dispatched);
        this.store.insertCompensationAttempt(attempt);
      });
      try {
        await assertDispatchAuthority(authority, 'dispatch', 'compensation provider dispatch');
        const receipt = await this.adapter.compensate(request);
        if (!await authority.validate('dispatch')) {
          throw new AdapterDispatchError('ambiguous', 'OWNER_UNKNOWN: lost after compensation call');
        }
        return this.recordSuccess(dispatched, attempt, receipt);
      } catch (error) {
        return this.recordFailure(dispatched, attempt, error);
      }
    } finally {
      authority.endOperation();
    }
  }

  async reconcile(compensationId: string, authority: DispatchAuthority): Promise<Compensation> {
    await assertDispatchAuthority(authority, 'reconcile', 'compensation reconciliation admission');
    if (!authority.beginOperation()) throw new Error('OWNER_ACTIVE: another operation is running');
    try {
      const current = this.requireCompensation(compensationId);
      if (current.status === 'SUCCEEDED' || current.status === 'WAITING_USER') return current;
      if (current.status !== 'DISPATCHED' && current.status !== 'UNKNOWN' && current.status !== 'RECONCILING') {
        throw new Error(`COMPENSATION_NOT_RECONCILABLE: ${compensationId} is ${current.status}`);
      }
      const reconciling: Compensation = current.status === 'RECONCILING' ? current
        : { ...current, status: 'RECONCILING', updatedAt: this.nowIso() };
      if (current.status === 'DISPATCHED') {
        const attempt = this.store.listCompensationAttempts(compensationId).at(-1);
        if (!attempt || attempt.status !== 'DISPATCHED') {
          throw new Error(`COMPENSATION_ATTEMPT_NOT_FOUND: ${compensationId}`);
        }
        this.store.withTransaction(() => {
          this.store.updateCompensationAttempt({
            ...attempt, status: 'UNKNOWN', completedAt: this.nowIso(),
            error: 'process stopped after dispatch intent without a durable receipt',
          });
          this.budget.markUnknownInTransaction(this.requireReservation(current));
          this.store.updateCompensation(reconciling);
        });
      } else if (current.status !== 'RECONCILING') {
        this.store.withTransaction(() => this.store.updateCompensation(reconciling));
      }
      let outcome: CompensationLookupOutcome;
      try {
        outcome = await this.adapter.lookupCompensation(this.request(reconciling));
      } catch {
        outcome = { kind: 'pending' };
      }
      await assertDispatchAuthority(authority, 'reconcile', 'compensation reconciliation lookup');
      const artifact = this.store.putArtifact('compensation-reconciliation', canonicalJson(outcome), 'json');
      if (outcome.kind === 'confirmed-success') {
        const succeeded: Compensation = {
          ...reconciling, status: 'SUCCEEDED', lastReconciliationArtifactId: artifact.id, updatedAt: this.nowIso(),
        };
        this.store.withTransaction(() => {
          this.store.updateCompensation(succeeded);
          this.budget.settleInTransaction(this.requireReservation(reconciling), outcome.receipt.actualUnits);
          this.store.event('compensation.reconciled', {
            compensationId, outcome: outcome.kind, artifactId: artifact.id,
          }, current.workId);
        });
        return succeeded;
      }
      if (outcome.kind === 'pending') {
        return this.finishReconciliation(reconciling, artifact.id, 'UNKNOWN', 'provider result is not yet visible', false);
      }
      const confirmedUnused = outcome.kind === 'confirmed-not-removed';
      return this.finishReconciliation(
        reconciling, artifact.id, 'WAITING_USER', `compensation lookup ${outcome.kind}`, confirmedUnused,
      );
    } finally {
      authority.endOperation();
    }
  }

  private recordSuccess(
    compensation: Compensation,
    attempt: CompensationAttempt,
    receipt: CompensationReceipt,
  ): Compensation {
    const artifact = this.store.putArtifact('compensation-receipt', canonicalJson(receipt), 'json');
    const at = this.nowIso();
    const succeeded: Compensation = { ...compensation, status: 'SUCCEEDED', updatedAt: at };
    const completed: CompensationAttempt = {
      ...attempt, status: 'SUCCEEDED', completedAt: at, receiptArtifactId: artifact.id,
    };
    this.store.withTransaction(() => {
      this.store.updateCompensationAttempt(completed);
      this.store.updateCompensation(succeeded);
      this.budget.settleInTransaction(this.requireReservation(compensation), receipt.actualUnits);
    });
    return succeeded;
  }

  private recordFailure(compensation: Compensation, attempt: CompensationAttempt, error: unknown): Compensation {
    const definitive = error instanceof AdapterDispatchError && error.outcome === 'definitive-no-effect';
    const status = definitive ? 'WAITING_USER' : 'UNKNOWN';
    const at = this.nowIso();
    const message = error instanceof Error ? error.message : String(error);
    const updated: Compensation = {
      ...compensation, status, manualReason: definitive ? message : undefined, updatedAt: at,
    };
    const completed: CompensationAttempt = {
      ...attempt, status: definitive ? 'FAILED' : 'UNKNOWN', completedAt: at, error: message,
    };
    this.store.withTransaction(() => {
      this.store.updateCompensationAttempt(completed);
      this.store.updateCompensation(updated);
      const reservation = this.requireReservation(compensation);
      if (definitive) this.budget.releaseConfirmedUnusedInTransaction(reservation);
      else this.budget.markUnknownInTransaction(reservation);
    });
    return updated;
  }

  private finishReconciliation(
    compensation: Compensation,
    artifactId: string,
    status: 'UNKNOWN' | 'WAITING_USER',
    reason: string,
    release: boolean,
  ): Compensation {
    const updated: Compensation = {
      ...compensation, status, lastReconciliationArtifactId: artifactId,
      manualReason: status === 'WAITING_USER' ? reason : undefined, updatedAt: this.nowIso(),
    };
    this.store.withTransaction(() => {
      this.store.updateCompensation(updated);
      if (release) this.budget.releaseConfirmedUnusedInTransaction(this.requireReservation(compensation));
      this.store.event('compensation.reconciled', {
        compensationId: compensation.id, outcome: status, reason, artifactId,
      }, compensation.workId);
    });
    return updated;
  }

  private originalReceipt(operation: Operation): OperationReceipt {
    const successfulAttempt = this.store.listOperationAttempts(operation.id)
      .find((attempt) => attempt.status === 'SUCCEEDED' && attempt.receiptArtifactId);
    const artifactId = successfulAttempt?.receiptArtifactId ?? operation.lastReconciliationArtifactId;
    if (!artifactId) throw new Error(`COMPENSATION_RECEIPT_MISSING: ${operation.id}`);
    const artifact = this.store.readVerifiedArtifact(artifactId);
    if (artifact.status !== 'verified') throw new Error(`COMPENSATION_RECEIPT_${artifact.status.toUpperCase()}: ${operation.id}`);
    const parsed = JSON.parse(artifact.content.toString('utf8')) as unknown;
    const wrapped = parsed as { receipt?: OperationReceipt };
    const receipt = wrapped.receipt ?? parsed as OperationReceipt;
    if (!receipt || typeof receipt.externalId !== 'string' || typeof receipt.resourceVersion !== 'string'
      || typeof receipt.ownershipRef !== 'string') {
      throw new Error(`COMPENSATION_RECEIPT_INVALID: ${operation.id}`);
    }
    return receipt;
  }

  private request(compensation: Compensation): CompensationDispatchRequest {
    return {
      idempotencyKey: compensation.idempotencyKey, externalId: compensation.resourceIdentity,
      resourceVersion: compensation.targetVersion, ownershipRef: compensation.ownershipRef,
    };
  }

  private requireOperation(id: string): Operation {
    const operation = this.store.getOperation(id);
    if (!operation) throw new Error(`OPERATION_NOT_FOUND: ${id}`);
    return operation;
  }

  private requireCompensation(id: string): Compensation {
    const compensation = this.store.getCompensation(id);
    if (!compensation) throw new Error(`COMPENSATION_NOT_FOUND: ${id}`);
    return compensation;
  }

  private requireReservation(compensation: Compensation): string {
    if (!compensation.reservationId) throw new Error(`COMPENSATION_RESERVATION_MISSING: ${compensation.id}`);
    return compensation.reservationId;
  }

  private nowIso(): string { return new Date(this.clock()).toISOString(); }
}
