import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AdapterCapabilitySnapshot } from '../types.ts';
import {
  AdapterDispatchError, type CompensationDispatchRequest, type CompensationLookupOutcome,
  type CompensationReceipt, type OperationAdapter, type OperationDispatchRequest,
  type OperationLookupOutcome, type OperationReceipt,
} from './operations.ts';

interface FakePayload {
  businessId: string;
  value: string;
  behavior?: 'success' | 'fail-before-effect' | 'lose-response-before-effect' | 'lose-response-after-effect';
  lookupDelayCount?: number;
  dispatchDelayMs?: number;
  responseDelayMs?: number;
  lookupDelayMs?: number;
  compensationDelayMs?: number;
  lookupMode?: 'normal' | 'partial' | 'unsupported';
  compensationBehavior?: 'success' | 'fail-before-effect' | 'lose-response-after-effect' | 'unsupported';
}

interface FakeEffect {
  businessId: string;
  idempotencyKey: string;
  canonicalInputHash: string;
  value: string;
  receipt: OperationReceipt;
  lookupCount: number;
  lookupDelayCount: number;
  lookupDelayMs: number;
  compensationDelayMs: number;
  lookupMode: 'normal' | 'partial' | 'unsupported';
  compensationBehavior: 'success' | 'fail-before-effect' | 'lose-response-after-effect' | 'unsupported';
  removed: boolean;
}

interface FakeCompensation {
  idempotencyKey: string;
  externalId: string;
  resourceVersion: string;
  ownershipRef: string;
  receipt: CompensationReceipt;
}

interface FakeLedger { effects: FakeEffect[]; compensations: FakeCompensation[] }

export class FakeProvider implements OperationAdapter {
  readonly capabilities: AdapterCapabilitySnapshot = {
    adapter: 'fake-provider', version: '1', effectType: 'write', retrySafety: 'deduplicated',
    reversibility: 'compensable', lookup: 'supported', postcondition: 'effect exists with matching receipt',
    upperBoundSupport: 'supported', idempotencyKeyTtlMs: 86_400_000,
    completionWindowMs: 5_000,
    cost: {
      mode: 'bounded', resourceKind: 'fake_write', currency: 'unit',
      upperBoundUnits: 10, pricingVersion: 'fake-v1',
    },
  };

  private readonly ledgerPath: string;

  constructor(ledgerPath: string) { this.ledgerPath = ledgerPath; }

  async execute(request: OperationDispatchRequest): Promise<OperationReceipt> {
    const payload = this.payload(request.payload);
    if (payload.dispatchDelayMs) await delay(payload.dispatchDelayMs);
    const ledger = this.readLedger();
    const byKey = ledger.effects.find((effect) => effect.idempotencyKey === request.idempotencyKey);
    const byIdentity = ledger.effects.find((effect) => effect.businessId === payload.businessId);
    const existing = byKey ?? byIdentity;
    if (existing) {
      if (existing.idempotencyKey !== request.idempotencyKey
        || existing.businessId !== payload.businessId
        || existing.canonicalInputHash !== request.canonicalInputHash) {
        throw new AdapterDispatchError('ambiguous', 'FAKE_PROVIDER_PAYLOAD_CONFLICT: identity or key already has another payload');
      }
      return existing.receipt;
    }
    if (payload.behavior === 'fail-before-effect') {
      throw new AdapterDispatchError('definitive-no-effect', 'FAKE_PROVIDER_REJECTED: no effect');
    }
    if (payload.behavior === 'lose-response-before-effect') {
      throw new AdapterDispatchError('ambiguous', 'FAKE_PROVIDER_RESPONSE_LOST: no receipt is available');
    }
    const receipt: OperationReceipt = {
      providerReceiptId: `receipt-${randomUUID()}`,
      externalId: `fake-${payload.businessId}`,
      resourceVersion: 'fake-v1',
      ownershipRef: request.targetScope,
      actualUnits: 7,
    };
    ledger.effects.push({
      businessId: payload.businessId, idempotencyKey: request.idempotencyKey,
      canonicalInputHash: request.canonicalInputHash, value: payload.value, receipt,
      lookupCount: 0, lookupDelayCount: payload.lookupDelayCount ?? 0,
      lookupDelayMs: payload.lookupDelayMs ?? 0,
      compensationDelayMs: payload.compensationDelayMs ?? 0,
      lookupMode: payload.lookupMode ?? 'normal',
      compensationBehavior: payload.compensationBehavior ?? 'success', removed: false,
    });
    this.writeLedger(ledger);
    if (payload.responseDelayMs) await delay(payload.responseDelayMs);
    if (payload.behavior === 'lose-response-after-effect') {
      throw new AdapterDispatchError('ambiguous', 'FAKE_PROVIDER_RESPONSE_LOST: effect may have completed');
    }
    return receipt;
  }

  async lookup(
    request: OperationDispatchRequest,
    completionWindowClosed: boolean,
  ): Promise<OperationLookupOutcome> {
    const payload = this.payload(request.payload);
    const ledger = this.readLedger();
    const effect = ledger.effects.find((candidate) => candidate.idempotencyKey === request.idempotencyKey
      || candidate.businessId === payload.businessId);
    if (!effect) return completionWindowClosed ? { kind: 'confirmed-no-effect' } : { kind: 'pending' };
    if (effect.lookupDelayMs) await delay(effect.lookupDelayMs);
    if (effect.idempotencyKey !== request.idempotencyKey
      || effect.businessId !== payload.businessId
      || effect.canonicalInputHash !== request.canonicalInputHash) {
      return { kind: 'partial-effect', detail: 'provider identity points to a different payload' };
    }
    effect.lookupCount += 1;
    this.writeLedger(ledger);
    if (effect.lookupMode === 'unsupported') return { kind: 'unsupported' };
    if (effect.lookupMode === 'partial') return { kind: 'partial-effect', detail: 'effect is incomplete' };
    if (effect.lookupCount <= effect.lookupDelayCount) return { kind: 'pending' };
    return { kind: 'confirmed-success', receipt: effect.receipt };
  }

  async verifyPostcondition(request: OperationDispatchRequest, receipt: OperationReceipt): Promise<boolean> {
    const payload = this.payload(request.payload);
    return this.readLedger().effects.some((effect) => effect.businessId === payload.businessId
      && effect.idempotencyKey === request.idempotencyKey
      && effect.canonicalInputHash === request.canonicalInputHash
      && effect.receipt.providerReceiptId === receipt.providerReceiptId && !effect.removed);
  }

  async compensate(request: CompensationDispatchRequest): Promise<CompensationReceipt> {
    const ledger = this.readLedger();
    const prior = ledger.compensations.find((item) => item.idempotencyKey === request.idempotencyKey);
    if (prior) {
      if (prior.externalId !== request.externalId || prior.resourceVersion !== request.resourceVersion
        || prior.ownershipRef !== request.ownershipRef) {
        throw new AdapterDispatchError('ambiguous', 'FAKE_COMPENSATION_PAYLOAD_CONFLICT');
      }
      return prior.receipt;
    }
    const effect = ledger.effects.find((item) => item.receipt.externalId === request.externalId);
    if (!effect || effect.receipt.resourceVersion !== request.resourceVersion
      || effect.receipt.ownershipRef !== request.ownershipRef) {
      throw new AdapterDispatchError('definitive-no-effect', 'FAKE_COMPENSATION_TARGET_MISMATCH');
    }
    if (effect.compensationBehavior === 'unsupported') {
      throw new AdapterDispatchError('definitive-no-effect', 'FAKE_COMPENSATION_UNSUPPORTED');
    }
    if (effect.compensationBehavior === 'fail-before-effect') {
      throw new AdapterDispatchError('definitive-no-effect', 'FAKE_COMPENSATION_REJECTED');
    }
    if (effect.compensationDelayMs) await delay(effect.compensationDelayMs);
    const receipt: CompensationReceipt = {
      providerReceiptId: `comp-receipt-${randomUUID()}`, externalId: request.externalId,
      removedVersion: request.resourceVersion, actualUnits: 3,
    };
    effect.removed = true;
    ledger.compensations.push({ ...request, receipt });
    this.writeLedger(ledger);
    if (effect.compensationBehavior === 'lose-response-after-effect') {
      throw new AdapterDispatchError('ambiguous', 'FAKE_COMPENSATION_RESPONSE_LOST');
    }
    return receipt;
  }

  async lookupCompensation(request: CompensationDispatchRequest): Promise<CompensationLookupOutcome> {
    const ledger = this.readLedger();
    const prior = ledger.compensations.find((item) => item.idempotencyKey === request.idempotencyKey);
    if (prior) return { kind: 'confirmed-success', receipt: prior.receipt };
    const effect = ledger.effects.find((item) => item.receipt.externalId === request.externalId);
    if (!effect) return { kind: 'unsupported' };
    if (effect.receipt.resourceVersion !== request.resourceVersion
      || effect.receipt.ownershipRef !== request.ownershipRef) {
      return { kind: 'partial-effect', detail: 'compensation target identity changed' };
    }
    return effect.removed ? { kind: 'pending' } : { kind: 'confirmed-not-removed' };
  }

  effectCount(): number { return this.readLedger().effects.length; }

  lookupCount(): number {
    return this.readLedger().effects.reduce((sum, effect) => sum + effect.lookupCount, 0);
  }

  compensationEffectCount(): number { return this.readLedger().compensations.length; }

  private payload(value: unknown): FakePayload {
    const payload = value as Partial<FakePayload>;
    if (!payload || typeof payload.businessId !== 'string' || typeof payload.value !== 'string') {
      throw new AdapterDispatchError('definitive-no-effect', 'FAKE_PROVIDER_INVALID_PAYLOAD');
    }
    return payload as FakePayload;
  }

  private readLedger(): FakeLedger {
    if (!existsSync(this.ledgerPath)) return { effects: [], compensations: [] };
    return JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as FakeLedger;
  }

  private writeLedger(ledger: FakeLedger): void {
    const temporary = join(dirname(this.ledgerPath), `.fake-ledger-${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, this.ledgerPath);
  }
}
