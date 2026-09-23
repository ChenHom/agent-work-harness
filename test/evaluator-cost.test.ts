import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { BudgetLedger } from '../src/budget/ledger.ts';
import { CriticScheduler } from '../src/evaluation/critic.ts';
import { validateModelRoleConfig } from '../src/evaluation/model-config.ts';
import { evaluationFixture } from './helpers/evaluation.ts';
import type { EvaluationRun } from '../src/types.ts';

const at = '2026-09-23T02:00:00.000Z';

test('model role config preserves role/provider/model/config and requires a bounded dispatch cost', () => {
  const config = validateModelRoleConfig({
    schemaVersion: '1', role: 'critic', provider: 'provider', model: 'model-v2',
    configVersion: 'prompt-v4', configHash: 'a'.repeat(64),
    budget: { resourceKind: 'critic_tokens', currency: 'TOK', upperBoundUnits: 20, pricingVersion: 'p1' },
  });
  assert.equal(config.role, 'critic');
  assert.equal(config.provider, 'provider');
  assert.equal(config.model, 'model-v2');
  assert.equal(config.configVersion, 'prompt-v4');
  assert.throws(() => validateModelRoleConfig({ ...config,
    budget: { ...config.budget, upperBoundUnits: undefined as never } }), /MODEL_CONFIG_INVALID/);
});

test('exact critic cost settles reservation; estimated cost remains held as unknown', () => {
  const h = evaluationFixture();
  try {
    h.store.insertEvaluationContract(h.contract);
    const ledger = new BudgetLedger(h.store);
    const limit = ledger.configureLimit({ workId: h.work.id, resourceKind: 'critic_tokens', currency: 'TOK',
      limitUnits: 100, pricingVersion: 'p1' });
    const scheduler = new CriticScheduler(h.store, ledger, () => at);
    const model = validateModelRoleConfig({
      schemaVersion: '1', role: 'critic', provider: 'provider', model: 'model-v2',
      configVersion: 'prompt-v4', configHash: 'a'.repeat(64),
      budget: { resourceKind: 'critic_tokens', currency: 'TOK', upperBoundUnits: 20, pricingVersion: 'p1' },
    });
    const scheduled = scheduler.reserve({ id: 'CDIS-COST-1', evaluationRunId: 'ER-COST-1', workId: h.work.id,
      contractId: h.contract.id, trigger: { type: 'pre_finalization', eventId: 'EV-COST-1' },
      policy: { cooldownMs: 0, periodicIntervalMs: 1, maxInvocations: 2 }, model });
    assert.equal(scheduled.status, 'scheduled');
    if (scheduled.status !== 'scheduled') return;
    const exact: EvaluationRun = {
      schemaVersion: '1', id: 'ER-COST-1', workId: h.work.id, contractId: h.contract.id,
      evaluator: { role: 'critic', name: 'semantic-critic', version: 'critic-1', provider: 'provider',
        model: 'model-v2', configVersion: 'prompt-v4', configHash: 'a'.repeat(64),
        cost: { status: 'exact', units: 12, currency: 'TOK' } },
      status: 'COMPLETED', startedAt: at, completedAt: at,
    };
    scheduler.complete(scheduled.dispatch.id, exact);
    assert.deepEqual(ledger.summary(limit.id), { limitUnits: 100, reservedUnits: 0, spentUnits: 12, availableUnits: 88 });

    const later = new CriticScheduler(h.store, ledger, () => '2026-09-23T02:01:00.000Z');
    const second = later.reserve({ id: 'CDIS-COST-2', evaluationRunId: 'ER-COST-2', workId: h.work.id,
      contractId: h.contract.id, trigger: { type: 'tool_failure', eventId: 'EV-COST-2' },
      policy: { cooldownMs: 0, periodicIntervalMs: 1, maxInvocations: 2 }, model });
    assert.equal(second.status, 'scheduled');
    if (second.status !== 'scheduled') return;
    later.complete(second.dispatch.id, { ...exact, id: 'ER-COST-2',
      evaluator: { ...exact.evaluator, cost: { status: 'estimated', units: 9, currency: 'TOK' } } });
    assert.equal(h.store.getBudgetReservation(second.dispatch.reservationId)?.status, 'UNKNOWN');
    assert.equal(h.store.getEvaluationRun('ER-COST-2')?.evaluator.cost.status, 'estimated');
    assert.equal(h.store.getEvaluationRun('ER-COST-2')?.evaluator.configVersion, 'prompt-v4');
  } finally { h.store.close(); rmSync(h.state, { recursive: true, force: true }); }
});

test('planner, executor, and critic identities retain versioned model config and cost status', () => {
  const h = evaluationFixture();
  try {
    h.store.insertEvaluationContract(h.contract);
    const roles = ['planner', 'executor', 'critic'] as const;
    const statuses = ['unknown', 'estimated', 'exact'] as const;
    roles.forEach((role, index) => h.store.insertEvaluationRun({
      ...h.run,
      id: `ER-${role}`,
      evaluator: {
        role, name: `${role}-model`, version: 'eval-v1', provider: 'provider', model: `${role}-v1`,
        configVersion: 'config-v7', configHash: String(index).repeat(64),
        cost: { status: statuses[index]!, units: index === 0 ? undefined : index, currency: 'TOK' },
      },
    }));

    const stored = h.store.listEvaluationRuns(h.work.id);
    assert.deepEqual(stored.map((run) => [run.evaluator.role, run.evaluator.configVersion, run.evaluator.cost.status]), [
      ['planner', 'config-v7', 'unknown'],
      ['executor', 'config-v7', 'estimated'],
      ['critic', 'config-v7', 'exact'],
    ]);
    assert.throws(() => h.store.insertCriterionVerdict({ id: 'CV-PLANNER', workId: h.work.id,
      evaluationRunId: 'ER-planner', verdict: h.candidate, createdAt: at }), /EVALUATION_ROLE_INVALID/);
  } finally { h.store.close(); rmSync(h.state, { recursive: true, force: true }); }
});
