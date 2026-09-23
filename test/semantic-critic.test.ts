import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { BudgetLedger } from '../src/budget/ledger.ts';
import {
  CriticScheduler, SUPPORTED_CRITIC_TRIGGERS, parseSemanticCriticOutput,
} from '../src/evaluation/critic.ts';
import { evaluationFixture } from './helpers/evaluation.ts';
import type { ModelRoleConfig } from '../src/evaluation/model-config.ts';

const model: ModelRoleConfig = {
  schemaVersion: '1', role: 'critic', provider: 'test-provider', model: 'critic-v1',
  configVersion: 'prompt-v3', configHash: 'd'.repeat(64),
  budget: { resourceKind: 'critic_tokens', upperBoundUnits: 10, pricingVersion: 'test-v1' },
};
const policy = { cooldownMs: 1_000, periodicIntervalMs: 10_000, maxInvocations: 2 };

test('critic supports every event trigger plus periodic fallback', () => {
  assert.deepEqual(SUPPORTED_CRITIC_TRIGGERS, [
    'milestone_completed', 'retry_exhausted', 'tool_failure', 'evidence_failure',
    'plan_changed', 'budget_acceleration', 'pre_checkpoint', 'pre_finalization', 'periodic',
  ]);
});

test('scheduler deduplicates, cools down, limits invocations, and periodic cannot bypass controls', () => {
  const h = evaluationFixture();
  let now = '2026-09-23T01:00:00.000Z';
  try {
    h.store.insertEvaluationContract(h.contract);
    const ledger = new BudgetLedger(h.store);
    ledger.configureLimit({ workId: h.work.id, resourceKind: 'critic_tokens',
      limitUnits: 100, pricingVersion: 'test-v1' });
    const scheduler = new CriticScheduler(h.store, ledger, () => now);
    const first = scheduler.reserve({ id: 'CDIS-1', evaluationRunId: 'ER-C1', workId: h.work.id,
      contractId: h.contract.id, trigger: { type: 'milestone_completed', eventId: 'EV-1' }, policy, model });
    assert.equal(first.status, 'scheduled');

    const duplicate = scheduler.reserve({ id: 'CDIS-2', evaluationRunId: 'ER-C2', workId: h.work.id,
      contractId: h.contract.id, trigger: { type: 'milestone_completed', eventId: 'EV-1' }, policy, model });
    assert.deepEqual(duplicate, { status: 'suppressed', reason: 'duplicate' });

    const cooldown = scheduler.reserve({ id: 'CDIS-3', evaluationRunId: 'ER-C3', workId: h.work.id,
      contractId: h.contract.id, trigger: { type: 'tool_failure', eventId: 'EV-2' }, policy, model });
    assert.deepEqual(cooldown, { status: 'suppressed', reason: 'cooldown' });

    const earlyPeriodic = scheduler.reserve({ id: 'CDIS-4', evaluationRunId: 'ER-C4', workId: h.work.id,
      contractId: h.contract.id, trigger: { type: 'periodic', eventId: 'PERIOD-1' }, policy, model });
    assert.deepEqual(earlyPeriodic, { status: 'suppressed', reason: 'periodic_not_due' });

    now = '2026-09-23T01:00:11.000Z';
    const periodic = scheduler.reserve({ id: 'CDIS-5', evaluationRunId: 'ER-C5', workId: h.work.id,
      contractId: h.contract.id, trigger: { type: 'periodic', eventId: 'PERIOD-1' }, policy, model });
    assert.equal(periodic.status, 'scheduled');

    now = '2026-09-23T01:00:22.000Z';
    const limited = scheduler.reserve({ id: 'CDIS-6', evaluationRunId: 'ER-C6', workId: h.work.id,
      contractId: h.contract.id, trigger: { type: 'pre_finalization', eventId: 'EV-3' }, policy, model });
    assert.deepEqual(limited, { status: 'suppressed', reason: 'invocation_limit' });
    assert.equal(h.store.listCriticDispatches(h.work.id).length, 2);
  } finally { h.store.close(); rmSync(h.state, { recursive: true, force: true }); }
});

test('budget is reserved durably before a critic dispatch permit is returned', () => {
  const h = evaluationFixture();
  try {
    h.store.insertEvaluationContract(h.contract);
    const ledger = new BudgetLedger(h.store);
    ledger.configureLimit({ workId: h.work.id, resourceKind: 'critic_tokens',
      limitUnits: 5, pricingVersion: 'test-v1' });
    const scheduler = new CriticScheduler(h.store, ledger, () => '2026-09-23T01:00:00.000Z');
    assert.throws(() => scheduler.reserve({ id: 'CDIS-B', evaluationRunId: 'ER-B', workId: h.work.id,
      contractId: h.contract.id, trigger: { type: 'tool_failure', eventId: 'EV-B' }, policy, model }),
    /BUDGET_EXCEEDED/);
    assert.deepEqual(h.store.listCriticDispatches(h.work.id), []);
  } finally { h.store.close(); rmSync(h.state, { recursive: true, force: true }); }
});

test('semantic output is criterion-level; abstention stays unknown and malformed output fails closed', () => {
  const h = evaluationFixture();
  try {
    const semantic = { ...h.definition, kind: 'semantic' as const };
    const abstained = parseSemanticCriticOutput({
      evaluatorVersion: 'critic-1',
      verdicts: [{ criterionId: semantic.id, verdict: 'unknown', reason: 'not enough evidence',
        evidenceArtifactIds: [] }],
    }, [semantic], 'critic-1');
    assert.equal(abstained[0]?.verdict, 'unknown');
    assert.equal(abstained[0]?.reasonCode, 'EVALUATOR_ABSTAINED');

    const malformed = parseSemanticCriticOutput({ evaluatorVersion: 'critic-1', verdicts: 'pass' },
      [semantic], 'critic-1');
    assert.equal(malformed[0]?.verdict, 'unknown');
    assert.equal(malformed[0]?.reasonCode, 'EVALUATOR_OUTPUT_INVALID');

    const wrongVersion = parseSemanticCriticOutput({ evaluatorVersion: 'critic-2', verdicts: [] },
      [semantic], 'critic-1');
    assert.equal(wrongVersion[0]?.reasonCode, 'EVALUATOR_VERSION_MISMATCH');
  } finally { h.store.close(); rmSync(h.state, { recursive: true, force: true }); }
});
