import { ApplicationFailure } from '@temporalio/activity';
import { BudgetLedger } from '../budget/ledger.ts';
import { TemporalDispatchAuthority, type RuntimeExecutionReader } from './runtime-state.ts';
import { FakeProvider } from '../tools/fake-provider.ts';
import { OperationGateway } from '../tools/gateway.ts';
import { canonicalJson } from '../tools/operations.ts';
import { Store } from '../trace/store.ts';
import type { Work } from '../types.ts';
import type {
  DispatchOperationResult, DurableActivities, ReconcileOperationResult, ValidateTerminalResult,
} from './contracts.ts';

interface DurableActivityOptions {
  stateDir: string;
  providerLedgerPath: string;
  readRuntime: RuntimeExecutionReader;
}

export type DurableFailureKind =
  | 'TRANSIENT_FAILURE'
  | 'DEFINITIVE_NO_EFFECT'
  | 'OUTCOME_UNKNOWN'
  | 'PARTIAL_EFFECT'
  | 'POLICY_DENIED'
  | 'BUDGET_EXHAUSTED';

export function classifyDurableFailure(error: unknown): DurableFailureKind {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('BUDGET_')) return 'BUDGET_EXHAUSTED';
  if (message.includes('POLICY_DENIED') || message.includes('CONSTRAINT_VIOLATION')) return 'POLICY_DENIED';
  if (message.includes('partial-effect') || message.includes('PARTIAL_EFFECT')) return 'PARTIAL_EFFECT';
  if (message.includes('RECONCILIATION_REQUIRED') || message.includes('OUTCOME_UNKNOWN')) return 'OUTCOME_UNKNOWN';
  if (message.includes('REJECTED') || message.includes('definitive-no-effect')) return 'DEFINITIVE_NO_EFFECT';
  return 'TRANSIENT_FAILURE';
}

export function toDurableActivityFailure(error: unknown): ApplicationFailure {
  const kind = classifyDurableFailure(error);
  const message = error instanceof Error ? error.message : String(error);
  return ApplicationFailure.create({
    message,
    type: kind,
    nonRetryable: kind !== 'TRANSIENT_FAILURE',
  });
}

async function activityBoundary<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) { throw toDurableActivityFailure(error); }
}

export function createDurableActivities(options: DurableActivityOptions): DurableActivities {
  const withStore = async <T>(fn: (store: Store) => Promise<T> | T): Promise<T> => {
    const store = new Store(options.stateDir);
    try { return await fn(store); } finally { store.close(); }
  };

  return {
    generateOutput: (input) => activityBoundary(() => withStore((store) => {
      if (!store.getWork(input.workId)) {
        const work: Work = {
          id: input.workId, title: 'P4 durable fake workflow', repositoryId: 'harness',
          workspace: options.stateDir, state: 'ACTIVE', currentContractVersion: 1,
          retryBudget: 2, createdAt: new Date().toISOString(),
        };
        store.insertWork(work);
      }
      if (!store.findBudgetLimit(input.workId, 'fake_write', 'unit')) {
        new BudgetLedger(store).configureLimit({
          workId: input.workId, resourceKind: 'fake_write', currency: 'unit',
          limitUnits: 100, pricingVersion: 'fake-v1',
        });
      }
      return { outputArtifactId: store.putArtifact('durable-model-output', input.generatedText).id };
    })),

    dispatchOperation: (input) => activityBoundary(() => withStore(async (store): Promise<DispatchOperationResult> => {
      const gateway = gatewayFor(store, options.providerLedgerPath);
      const operation = gateway.prepare({
        workId: input.workId, intentKey: `durable:create:${input.businessId}`,
        kind: 'fake.create', targetScope: input.businessId,
        payload: {
          businessId: input.businessId, value: input.value,
          behavior: 'lose-response-after-effect' as const,
        },
        precondition: 'resource absent', reconciliationStrategy: 'lookup stable idempotency key',
        compensationPolicy: 'remove exact owned version', authorizationRef: `work:${input.workId}`,
      });
      const current = operation.status === 'PREPARED'
        ? await gateway.dispatch(operation.id, new TemporalDispatchAuthority(input.authority, options.readRuntime))
        : operation;
      return {
        operationId: current.id, operationStatus: current.status,
        inputArtifactId: current.inputArtifactId, idempotencyKey: current.idempotencyKey,
      };
    })),

    reconcileOperation: (input) => activityBoundary(() => withStore(async (store): Promise<ReconcileOperationResult> => {
      const operation = await gatewayFor(store, options.providerLedgerPath).reconcile(
        input.operationId,
        new TemporalDispatchAuthority(input.authority, options.readRuntime),
      );
      return {
        operationStatus: operation.status,
        ...(operation.lastReconciliationArtifactId
          ? { receiptArtifactId: operation.lastReconciliationArtifactId } : {}),
      };
    })),

    validateTerminal: (input) => activityBoundary(() => withStore((store): ValidateTerminalResult => {
      const operation = store.getOperation(input.operationId);
      const output = store.readVerifiedArtifact(input.outputArtifactId);
      const receipt = input.receiptArtifactId
        ? store.readVerifiedArtifact(input.receiptArtifactId) : { status: 'missing' as const };
      const verdict = operation?.status === 'SUCCEEDED'
        && output.status === 'verified' && receipt.status === 'verified' ? 'pass' : 'fail';
      const artifact = store.putArtifact('durable-validation', canonicalJson({
        operationId: input.operationId, operationStatus: operation?.status ?? 'missing',
        outputArtifactId: input.outputArtifactId, receiptArtifactId: input.receiptArtifactId,
        verdict,
      }), 'json');
      return { verdict, validationArtifactId: artifact.id };
    })),
  };
}

function gatewayFor(store: Store, providerLedgerPath: string): OperationGateway {
  return new OperationGateway(store, new BudgetLedger(store), new FakeProvider(providerLedgerPath));
}
