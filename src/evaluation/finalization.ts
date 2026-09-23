import { decideGlobalVerdict } from './criteria.ts';
import type { Store } from '../trace/store.ts';
import type { CompletionDecisionRecord, WorkState } from '../types.ts';

export interface FinalizeEvaluationInput {
  id: string;
  workId: string;
  evaluationRunId: string;
  expectedWorkState: WorkState;
  createdAt: string;
}

/** Atomically records the decision and, only for global pass, moves the Work to DONE. */
export function finalizeEvaluation(store: Store, input: FinalizeEvaluationInput): CompletionDecisionRecord {
  return store.withTransaction(() => {
    const work = store.getWork(input.workId);
    if (!work || work.state !== input.expectedWorkState) {
      throw new Error(`STATE_CONFLICT: work ${input.workId} expected ${input.expectedWorkState}`);
    }
    const run = store.getEvaluationRun(input.evaluationRunId);
    if (!run || run.workId !== input.workId) {
      throw new Error(`EVALUATION_INVALID: run ${input.evaluationRunId} does not belong to work ${input.workId}`);
    }
    if (run.status !== 'COMPLETED') {
      throw new Error(`EVALUATION_INVALID: run ${run.id} is ${run.status}`);
    }
    const contract = store.getEvaluationContract(run.contractId);
    const currentContract = store.getCurrentEvaluationContract(input.workId);
    if (!contract || currentContract?.id !== contract.id) {
      throw new Error(`EVALUATION_STALE: contract ${run.contractId} is not current`);
    }
    const verdicts = store.listCriterionVerdicts(run.id);
    const reverified = verdicts.map((entry) => {
      const definition = contract.criteria.find((criterion) => criterion.id === entry.verdict.criterionId);
      return definition ? store.validateCriterionVerdict(definition, entry.verdict) : entry.verdict;
    });
    const global = decideGlobalVerdict(contract.criteria, reverified);
    const decision: CompletionDecisionRecord = {
      id: input.id,
      workId: input.workId,
      evaluationRunId: run.id,
      contractId: contract.id,
      policyVersion: global.policyVersion,
      verdict: global.verdict,
      canComplete: global.canComplete,
      reasonCodes: global.reasonCodes,
      criterionVerdictIds: verdicts.map((entry) => entry.id).sort(),
      createdAt: input.createdAt,
    };
    store.insertCompletionDecision(decision);
    if (decision.canComplete) {
      store.transitionWorkState(input.workId, input.expectedWorkState, 'DONE');
    }
    return decision;
  });
}
