import { activityInfo } from '@temporalio/activity';
import { FakeProvider } from '../tools/fake-provider.ts';
import { canonicalHash } from '../tools/operations.ts';

interface SpikeDispatchInput {
  businessId: string;
  idempotencyKey: string;
  value: string;
}

export interface SpikeDispatchResult {
  activityAttempt: number;
  providerReceiptId: string;
}

export interface SpikeActivities {
  dispatchEffect(input: SpikeDispatchInput): Promise<SpikeDispatchResult>;
}

export function createSpikeActivities(ledgerPath: string): SpikeActivities {
  const provider = new FakeProvider(ledgerPath);
  return {
    async dispatchEffect(input) {
      const payload = {
        businessId: input.businessId,
        value: input.value,
        behavior: 'lose-response-after-effect' as const,
      };
      const receipt = await provider.execute({
        idempotencyKey: input.idempotencyKey,
        targetScope: 'p4-selection-spike',
        canonicalInputHash: canonicalHash(payload),
        payload,
      });
      return {
        activityAttempt: activityInfo().attempt,
        providerReceiptId: receipt.providerReceiptId,
      };
    },
  };
}
