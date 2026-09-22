import { newId, nowIso } from '../ids.ts';
import { Store } from '../trace/store.ts';
import type {
  AdapterCapabilitySnapshot, BudgetLedgerEntry, BudgetLimit, BudgetReservation,
} from '../types.ts';

interface LimitInput {
  workId: string;
  resourceKind: string;
  currency?: string;
  limitUnits: number;
  pricingVersion: string;
}

interface ReservationInput {
  workId: string;
  operationId?: string;
  compensationId?: string;
  cost: AdapterCapabilitySnapshot['cost'];
}

export interface BudgetSummary {
  limitUnits: number;
  reservedUnits: number;
  spentUnits: number;
  availableUnits: number;
}

function units(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`BUDGET_INVALID: ${label} must be a safe integer`);
  if (value < 0) throw new Error(`BUDGET_INVALID: ${label} must not be negative`);
}

export class BudgetLedger {
  private readonly store: Store;

  constructor(store: Store) { this.store = store; }

  configureLimit(input: LimitInput): BudgetLimit {
    units(input.limitUnits, 'limitUnits');
    if (!input.resourceKind.trim()) throw new Error('BUDGET_INVALID: resourceKind is empty');
    if (!input.pricingVersion.trim()) throw new Error('BUDGET_INVALID: pricingVersion is empty');
    if (!this.store.getWork(input.workId)) throw new Error(`BUDGET_WORK_NOT_FOUND: ${input.workId}`);
    const limit: BudgetLimit = {
      id: newId('BL'), workId: input.workId, resourceKind: input.resourceKind,
      currency: input.currency, limitUnits: input.limitUnits,
      pricingVersion: input.pricingVersion, createdAt: nowIso(),
    };
    this.store.withTransaction(() => this.store.insertBudgetLimit(limit));
    return limit;
  }

  reserve(input: ReservationInput): BudgetReservation {
    return this.store.withTransaction(() => this.reserveInTransaction(input));
  }

  /** Caller must already hold Store.withTransaction; used to atomically persist an operation intent. */
  reserveInTransaction(input: ReservationInput): BudgetReservation {
    const { cost } = input;
    if (cost.mode !== 'bounded' || cost.upperBoundUnits === undefined || !cost.pricingVersion) {
      throw new Error(`BUDGET_UNBOUNDED: ${cost.resourceKind} cost is ${cost.mode}`);
    }
    units(cost.upperBoundUnits, 'upperBoundUnits');
    if (Boolean(input.operationId) === Boolean(input.compensationId)) {
      throw new Error('BUDGET_INVALID: exactly one operationId or compensationId is required');
    }
    const limit = this.store.findBudgetLimit(input.workId, cost.resourceKind, cost.currency);
    if (!limit) {
      throw new Error(`BUDGET_LIMIT_NOT_FOUND: ${input.workId}/${cost.resourceKind}/${cost.currency ?? '-'}`);
    }
    if (limit.pricingVersion !== cost.pricingVersion) {
      throw new Error(`BUDGET_PRICING_MISMATCH: ${cost.pricingVersion} != ${limit.pricingVersion}`);
    }
    const before = this.summary(limit.id);
    if (before.spentUnits + before.reservedUnits + cost.upperBoundUnits > limit.limitUnits) {
      throw new Error(`BUDGET_EXCEEDED: ${before.spentUnits} spent + ${before.reservedUnits} reserved`
        + ` + ${cost.upperBoundUnits} requested > ${limit.limitUnits}`);
    }
    const at = nowIso();
    const reservation: BudgetReservation = {
      id: newId('BR'), workId: input.workId, limitId: limit.id,
      operationId: input.operationId, compensationId: input.compensationId,
      amountUnits: cost.upperBoundUnits, status: 'HELD', createdAt: at, updatedAt: at,
    };
    this.store.insertBudgetReservation(reservation);
    this.store.insertBudgetLedgerEntry(this.entry(reservation, 'RESERVE', reservation.amountUnits, 0));
    return reservation;
  }

  markUnknown(reservationId: string): BudgetReservation {
    return this.store.withTransaction(() => this.markUnknownInTransaction(reservationId));
  }

  markUnknownInTransaction(reservationId: string): BudgetReservation {
    const current = this.requireReservation(reservationId);
    if (current.status !== 'HELD' && current.status !== 'UNKNOWN') {
      throw new Error(`BUDGET_INVALID_STATE: ${reservationId} is ${current.status}`);
    }
    if (current.status === 'UNKNOWN') return current;
    const updated: BudgetReservation = { ...current, status: 'UNKNOWN', updatedAt: nowIso() };
    this.store.updateBudgetReservation(updated);
    return updated;
  }

  settle(reservationId: string, actualUnits: number): BudgetReservation {
    units(actualUnits, 'actualUnits');
    return this.store.withTransaction(() => this.settleInTransaction(reservationId, actualUnits));
  }

  settleInTransaction(reservationId: string, actualUnits: number): BudgetReservation {
    units(actualUnits, 'actualUnits');
    const current = this.requireOpenReservation(reservationId);
    if (actualUnits > current.amountUnits) {
      throw new Error(`BUDGET_RECEIPT_EXCEEDS_RESERVATION: ${actualUnits} > ${current.amountUnits}`);
    }
    const updated: BudgetReservation = {
      ...current, status: 'SETTLED', settledUnits: actualUnits, updatedAt: nowIso(),
    };
    this.store.updateBudgetReservation(updated);
    this.store.insertBudgetLedgerEntry(this.entry(current, 'SETTLE', -current.amountUnits, actualUnits));
    return updated;
  }

  releaseConfirmedUnused(reservationId: string): BudgetReservation {
    return this.store.withTransaction(() => this.releaseConfirmedUnusedInTransaction(reservationId));
  }

  releaseConfirmedUnusedInTransaction(reservationId: string): BudgetReservation {
    const current = this.requireOpenReservation(reservationId);
    const updated: BudgetReservation = { ...current, status: 'RELEASED', updatedAt: nowIso() };
    this.store.updateBudgetReservation(updated);
    this.store.insertBudgetLedgerEntry(this.entry(current, 'RELEASE', -current.amountUnits, 0));
    return updated;
  }

  summary(limitId: string): BudgetSummary {
    const limit = this.store.getBudgetLimit(limitId);
    if (!limit) throw new Error(`BUDGET_LIMIT_NOT_FOUND: ${limitId}`);
    let reservedUnits = 0;
    let spentUnits = 0;
    for (const entry of this.store.listBudgetLedger(limitId)) {
      reservedUnits += entry.reservedDeltaUnits;
      spentUnits += entry.spentDeltaUnits;
    }
    return {
      limitUnits: limit.limitUnits,
      reservedUnits,
      spentUnits,
      availableUnits: limit.limitUnits - reservedUnits - spentUnits,
    };
  }

  private requireReservation(id: string): BudgetReservation {
    const reservation = this.store.getBudgetReservation(id);
    if (!reservation) throw new Error(`BUDGET_RESERVATION_NOT_FOUND: ${id}`);
    return reservation;
  }

  private requireOpenReservation(id: string): BudgetReservation {
    const reservation = this.requireReservation(id);
    if (reservation.status !== 'HELD' && reservation.status !== 'UNKNOWN') {
      throw new Error(`BUDGET_INVALID_STATE: ${id} is ${reservation.status}`);
    }
    return reservation;
  }

  private entry(
    reservation: BudgetReservation,
    kind: BudgetLedgerEntry['kind'],
    reservedDeltaUnits: number,
    spentDeltaUnits: number,
  ): BudgetLedgerEntry {
    return {
      id: newId('BLE'), workId: reservation.workId, limitId: reservation.limitId,
      reservationId: reservation.id, kind, reservedDeltaUnits, spentDeltaUnits, createdAt: nowIso(),
    };
  }
}
