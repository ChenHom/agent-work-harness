import type { BudgetLedger } from '../budget/ledger.ts';
import type { Store } from '../trace/store.ts';
import type {
  CriterionDefinition, CriterionReasonCode, CriterionVerdictRecord,
  CriticDispatch, CriticTriggerType, EvaluationRun,
} from '../types.ts';
import { modelBudgetCost, validateModelRoleConfig } from './model-config.ts';
import type { ModelRoleConfig } from './model-config.ts';

export const SUPPORTED_CRITIC_TRIGGERS: CriticTriggerType[] = [
  'milestone_completed', 'retry_exhausted', 'tool_failure', 'evidence_failure',
  'plan_changed', 'budget_acceleration', 'pre_checkpoint', 'pre_finalization', 'periodic',
];

interface CriticPolicy {
  cooldownMs: number;
  periodicIntervalMs: number;
  maxInvocations: number;
}

interface ReserveCriticInput {
  id: string;
  evaluationRunId: string;
  workId: string;
  contractId: string;
  trigger: { type: CriticTriggerType; eventId: string };
  policy: CriticPolicy;
  model: ModelRoleConfig;
}

type ReserveCriticResult =
  | { status: 'scheduled'; dispatch: CriticDispatch }
  | { status: 'suppressed'; reason: 'duplicate' | 'cooldown' | 'periodic_not_due' | 'invocation_limit' };

const validPolicy = (policy: CriticPolicy): void => {
  if (![policy.cooldownMs, policy.periodicIntervalMs, policy.maxInvocations]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('CRITIC_POLICY_INVALID: limits must be non-negative safe integers');
  }
};

export class CriticScheduler {
  private readonly store: Store;
  private readonly budget: BudgetLedger;
  private readonly now: () => string;

  constructor(
    store: Store,
    budget: BudgetLedger,
    now: () => string,
  ) {
    this.store = store;
    this.budget = budget;
    this.now = now;
  }

  reserve(input: ReserveCriticInput): ReserveCriticResult {
    validPolicy(input.policy);
    const model = validateModelRoleConfig(input.model);
    if (model.role !== 'critic') throw new Error(`MODEL_CONFIG_INVALID: ${model.role} cannot dispatch a critic`);
    if (!SUPPORTED_CRITIC_TRIGGERS.includes(input.trigger.type) || !input.trigger.eventId.trim()) {
      throw new Error('CRITIC_TRIGGER_INVALID');
    }
    const contract = this.store.getCurrentEvaluationContract(input.workId);
    if (!contract || contract.id !== input.contractId) {
      throw new Error(`EVALUATION_STALE: contract ${input.contractId} is not current`);
    }
    const at = this.now();
    const nowMs = Date.parse(at);
    if (!Number.isFinite(nowMs)) throw new Error('CRITIC_CLOCK_INVALID');
    const dispatches = this.store.listCriticDispatches(input.workId);
    const triggerKey = `${input.trigger.type}:${input.trigger.eventId}`;
    if (dispatches.some((dispatch) => dispatch.triggerKey === triggerKey)) {
      return { status: 'suppressed', reason: 'duplicate' };
    }
    if (dispatches.length >= input.policy.maxInvocations) {
      return { status: 'suppressed', reason: 'invocation_limit' };
    }
    const last = dispatches.at(-1);
    if (last) {
      const ageMs = nowMs - Date.parse(last.createdAt);
      if (input.trigger.type === 'periodic' && ageMs < input.policy.periodicIntervalMs) {
        return { status: 'suppressed', reason: 'periodic_not_due' };
      }
      if (ageMs < input.policy.cooldownMs) return { status: 'suppressed', reason: 'cooldown' };
    }

    return this.store.withTransaction(() => {
      const reservation = this.budget.reserveInTransaction({
        workId: input.workId, evaluationRunId: input.evaluationRunId, cost: modelBudgetCost(model),
      });
      const dispatch: CriticDispatch = {
        schemaVersion: '1', id: input.id, workId: input.workId, contractId: input.contractId,
        evaluationRunId: input.evaluationRunId, trigger: input.trigger, triggerKey,
        modelConfig: {
          provider: model.provider, model: model.model, configVersion: model.configVersion,
          configHash: model.configHash, resourceKind: model.budget.resourceKind,
          currency: model.budget.currency, upperBoundUnits: model.budget.upperBoundUnits,
          pricingVersion: model.budget.pricingVersion,
        },
        reservationId: reservation.id, status: 'RESERVED', createdAt: at, updatedAt: at,
      };
      this.store.insertCriticDispatch(dispatch);
      return { status: 'scheduled', dispatch };
    });
  }

  complete(dispatchId: string, run: EvaluationRun): CriticDispatch {
    const dispatch = this.store.getCriticDispatch(dispatchId);
    if (!dispatch || dispatch.status !== 'RESERVED') {
      throw new Error(`CRITIC_DISPATCH_INVALID_STATE: ${dispatchId}`);
    }
    if (run.id !== dispatch.evaluationRunId || run.workId !== dispatch.workId
      || run.contractId !== dispatch.contractId || run.evaluator.role !== 'critic'
      || run.evaluator.provider !== dispatch.modelConfig.provider
      || run.evaluator.model !== dispatch.modelConfig.model
      || run.evaluator.configVersion !== dispatch.modelConfig.configVersion
      || run.evaluator.configHash !== dispatch.modelConfig.configHash
      || run.evaluator.cost.currency !== dispatch.modelConfig.currency) {
      throw new Error('CRITIC_RESULT_IDENTITY_MISMATCH');
    }
    if (run.status !== 'COMPLETED') throw new Error(`CRITIC_RESULT_INVALID_STATE: ${run.status}`);
    const completed: CriticDispatch = { ...dispatch, status: 'COMPLETED', updatedAt: this.now() };
    return this.store.withTransaction(() => {
      this.store.insertEvaluationRun(run);
      if (run.evaluator.cost.status === 'exact') {
        if (run.evaluator.cost.units === undefined) throw new Error('CRITIC_COST_INVALID: exact cost has no units');
        this.budget.settleInTransaction(dispatch.reservationId, run.evaluator.cost.units);
      } else {
        this.budget.markUnknownInTransaction(dispatch.reservationId);
      }
      this.store.updateCriticDispatch(completed);
      return completed;
    });
  }
}

const unknownRecords = (
  definitions: readonly CriterionDefinition[],
  code: Extract<CriterionReasonCode, 'EVALUATOR_OUTPUT_INVALID' | 'EVALUATOR_VERSION_MISMATCH'>,
): CriterionVerdictRecord[] => definitions.map((definition) => ({
  schemaVersion: '1', criterionId: definition.id, criterionVersion: definition.version,
  kind: definition.kind, required: definition.required,
  artifactBindings: definition.artifactBindings, validator: definition.validator,
  verdict: 'unknown', reasonCode: code,
  reason: code === 'EVALUATOR_VERSION_MISMATCH' ? 'evaluator version does not match' : 'evaluator output is invalid',
  evidenceArtifactIds: [],
}));

export function parseSemanticCriticOutput(
  raw: unknown,
  definitions: readonly CriterionDefinition[],
  expectedEvaluatorVersion: string,
): CriterionVerdictRecord[] {
  if (!raw || typeof raw !== 'object') return unknownRecords(definitions, 'EVALUATOR_OUTPUT_INVALID');
  const object = raw as Record<string, unknown>;
  if (object.evaluatorVersion !== expectedEvaluatorVersion) {
    return unknownRecords(definitions, 'EVALUATOR_VERSION_MISMATCH');
  }
  if (!Array.isArray(object.verdicts)) return unknownRecords(definitions, 'EVALUATOR_OUTPUT_INVALID');
  const rows = object.verdicts as unknown[];
  return definitions.map((definition) => {
    const matches = rows.filter((row) => row && typeof row === 'object'
      && (row as Record<string, unknown>).criterionId === definition.id);
    if (matches.length !== 1) return unknownRecords([definition], 'EVALUATOR_OUTPUT_INVALID')[0]!;
    const row = matches[0] as Record<string, unknown>;
    const verdict = row.verdict;
    const reason = row.reason;
    const evidence = row.evidenceArtifactIds;
    const confidence = row.confidence;
    if (!['pass', 'fail', 'unknown'].includes(String(verdict)) || typeof reason !== 'string'
      || !Array.isArray(evidence) || !evidence.every((id) => typeof id === 'string')
      || (confidence !== undefined && typeof confidence !== 'number')) {
      return unknownRecords([definition], 'EVALUATOR_OUTPUT_INVALID')[0]!;
    }
    return {
      schemaVersion: '1', criterionId: definition.id, criterionVersion: definition.version,
      kind: definition.kind, required: definition.required,
      artifactBindings: definition.artifactBindings, validator: definition.validator,
      verdict: verdict as CriterionVerdictRecord['verdict'],
      reasonCode: verdict === 'pass' ? 'VALIDATED'
        : verdict === 'fail' ? 'VALIDATION_FAILED' : 'EVALUATOR_ABSTAINED',
      reason, evidenceArtifactIds: evidence, confidence,
    };
  });
}
