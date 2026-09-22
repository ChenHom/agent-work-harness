import { createHash } from 'node:crypto';
import type { AdapterCapabilitySnapshot } from '../types.ts';

export interface OperationDispatchRequest {
  idempotencyKey: string;
  targetScope: string;
  canonicalInputHash: string;
  payload: unknown;
}

export interface OperationReceipt {
  providerReceiptId: string;
  externalId: string;
  resourceVersion: string;
  ownershipRef: string;
  actualUnits: number;
}

export interface CompensationDispatchRequest {
  idempotencyKey: string;
  externalId: string;
  resourceVersion: string;
  ownershipRef: string;
}

export interface CompensationReceipt {
  providerReceiptId: string;
  externalId: string;
  removedVersion: string;
  actualUnits: number;
}

export type CompensationLookupOutcome =
  | { kind: 'confirmed-success'; receipt: CompensationReceipt }
  | { kind: 'confirmed-not-removed' }
  | { kind: 'pending' }
  | { kind: 'partial-effect'; detail: string }
  | { kind: 'unsupported' };

export type OperationLookupOutcome =
  | { kind: 'confirmed-success'; receipt: OperationReceipt }
  | { kind: 'confirmed-no-effect' }
  | { kind: 'pending' }
  | { kind: 'partial-effect'; detail: string }
  | { kind: 'unsupported' };

export interface OperationAdapter {
  readonly capabilities: AdapterCapabilitySnapshot;
  execute(request: OperationDispatchRequest): Promise<OperationReceipt>;
  lookup(request: OperationDispatchRequest, completionWindowClosed: boolean): Promise<OperationLookupOutcome>;
  verifyPostcondition(request: OperationDispatchRequest, receipt: OperationReceipt): Promise<boolean>;
  compensate(request: CompensationDispatchRequest): Promise<CompensationReceipt>;
  lookupCompensation(request: CompensationDispatchRequest): Promise<CompensationLookupOutcome>;
}

export class AdapterDispatchError extends Error {
  readonly outcome: 'definitive-no-effect' | 'ambiguous';

  constructor(outcome: 'definitive-no-effect' | 'ambiguous', message: string) {
    super(message);
    this.outcome = outcome;
  }
}

export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (!item || typeof item !== 'object') return item;
    const object = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => [key, sort(object[key])]));
  };
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value)) as unknown));
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
