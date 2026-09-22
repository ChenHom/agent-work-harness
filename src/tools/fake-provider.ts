import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AdapterCapabilitySnapshot } from '../types.ts';
import {
  AdapterDispatchError, type OperationAdapter, type OperationDispatchRequest, type OperationReceipt,
} from './operations.ts';

interface FakePayload {
  businessId: string;
  value: string;
  behavior?: 'success' | 'fail-before-effect' | 'lose-response-after-effect';
}

interface FakeEffect {
  businessId: string;
  idempotencyKey: string;
  canonicalInputHash: string;
  value: string;
  receipt: OperationReceipt;
}

interface FakeLedger { effects: FakeEffect[] }

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
    const receipt: OperationReceipt = {
      providerReceiptId: `receipt-${randomUUID()}`,
      externalId: `fake-${payload.businessId}`,
      actualUnits: 7,
    };
    ledger.effects.push({
      businessId: payload.businessId, idempotencyKey: request.idempotencyKey,
      canonicalInputHash: request.canonicalInputHash, value: payload.value, receipt,
    });
    this.writeLedger(ledger);
    if (payload.behavior === 'lose-response-after-effect') {
      throw new AdapterDispatchError('ambiguous', 'FAKE_PROVIDER_RESPONSE_LOST: effect may have completed');
    }
    return receipt;
  }

  async verifyPostcondition(request: OperationDispatchRequest, receipt: OperationReceipt): Promise<boolean> {
    const payload = this.payload(request.payload);
    return this.readLedger().effects.some((effect) => effect.businessId === payload.businessId
      && effect.idempotencyKey === request.idempotencyKey
      && effect.canonicalInputHash === request.canonicalInputHash
      && effect.receipt.providerReceiptId === receipt.providerReceiptId);
  }

  effectCount(): number { return this.readLedger().effects.length; }

  private payload(value: unknown): FakePayload {
    const payload = value as Partial<FakePayload>;
    if (!payload || typeof payload.businessId !== 'string' || typeof payload.value !== 'string') {
      throw new AdapterDispatchError('definitive-no-effect', 'FAKE_PROVIDER_INVALID_PAYLOAD');
    }
    return payload as FakePayload;
  }

  private readLedger(): FakeLedger {
    if (!existsSync(this.ledgerPath)) return { effects: [] };
    return JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as FakeLedger;
  }

  private writeLedger(ledger: FakeLedger): void {
    const temporary = join(dirname(this.ledgerPath), `.fake-ledger-${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, this.ledgerPath);
  }
}
