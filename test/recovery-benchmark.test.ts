import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  oracleViolations, runRecoveryBenchmark, summarizeRecoveryBenchmark,
  type RecoveryBenchmarkManifest, type RecoveryRunRecord,
} from '../src/benchmark/recovery.ts';
import { CURRENT_SCHEMA_VERSION } from '../src/trace/migrations.ts';

async function benchmark(seed: number, runs: number) {
  const stateDir = mkdtempSync(join(tmpdir(), 'harness-bench-'));
  try {
    return await runRecoveryBenchmark({ stateDir, seed, runs });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

const manifest = { clock: { pollIntervalMs: 1_000, maxReconcileSteps: 8, unknownSlaMs: 10_000 } } as RecoveryBenchmarkManifest;

const run = (overrides: Partial<RecoveryRunRecord>): RecoveryRunRecord => ({
  runId: 'R', scenario: 'synthetic', outcome: 'succeeded', latencyMs: 0, steps: 1, spentUnits: 0,
  unresolvedReservedUnits: 0, enteredUnknown: false, unknownResolved: false, unknownAgeMs: null,
  recoveryMs: null, duplicateEffects: 0, manualInterventions: 0, constraintViolations: [],
  independentlyAccepted: false, ...overrides,
});

test('summary keeps failed, unknown, budget-blocked, and manual runs and exposes the tail', () => {
  const report = summarizeRecoveryBenchmark(manifest, [
    run({ runId: 'a', outcome: 'succeeded', latencyMs: 10, steps: 2, spentUnits: 7, independentlyAccepted: true }),
    run({ runId: 'b', outcome: 'failed', latencyMs: 20, steps: 2 }),
    run({
      runId: 'c', outcome: 'unknown', latencyMs: 30, steps: 10, unresolvedReservedUnits: 10,
      enteredUnknown: true, unknownAgeMs: 8_000,
    }),
    run({ runId: 'd', outcome: 'budget_blocked', latencyMs: 1, steps: 1 }),
    run({
      runId: 'e', outcome: 'manually_resolved', latencyMs: 400, steps: 5, spentUnits: 7, enteredUnknown: true,
      unknownResolved: true, unknownAgeMs: 20_000, recoveryMs: 350, manualInterventions: 1, independentlyAccepted: true,
    }),
    run({
      runId: 'f', outcome: 'succeeded', latencyMs: 50, steps: 2, spentUnits: 7, enteredUnknown: true,
      unknownResolved: true, unknownAgeMs: 3_000, recoveryMs: 40, duplicateEffects: 1,
      constraintViolations: ['DUPLICATE_EFFECT'],
    }),
  ]);
  assert.deepEqual(report.runs.byOutcome, {
    succeeded: 2, failed: 1, unknown: 1, waiting_user: 0, budget_blocked: 1, manually_resolved: 1,
  });
  assert.equal(report.runs.total, 6);
  assert.deepEqual(report.latencyMs, { samples: 6, p50: 20, p95: 400, p99: 400 });
  assert.deepEqual(report.steps, { samples: 6, p50: 2, p95: 10, p99: 10 });
  assert.deepEqual(report.spentUnits, { samples: 6, p50: 0, p95: 7, p99: 7 });
  assert.deepEqual(report.recoveryMs, { samples: 2, p50: 40, p95: 350, p99: 350 });
  assert.deepEqual(report.cost, {
    totalSpentUnits: 21, totalUnresolvedReservedUnits: 10,
    perIndependentlyAcceptedWork: { spentUnits: 10.5, upperBoundUnits: 15.5 },
  });
  assert.deepEqual(report.unknown, {
    entered: 3, resolved: 2, unresolved: 1,
    withinSla: { count: 1, denominator: 3, rate: 1 / 3 },
    ageMs: { samples: 3, p50: 8_000, p95: 20_000, p99: 20_000 },
  });
  assert.deepEqual(report.recoverySuccess, { count: 1, denominator: 3, rate: 1 / 3 });
  assert.deepEqual(report.duplicateEffects, { runs: 1, effects: 1 });
  assert.deepEqual(report.manualIntervention, { runs: 1, interventions: 1 });
  assert.deepEqual(report.constraintViolations, { runs: 1, byCode: { DUPLICATE_EFFECT: 1 } });
  assert.deepEqual(report.independentlyAccepted, { count: 2, denominator: 6, rate: 1 / 3 });
  assert.ok(!Object.keys(report).some((key) => /score|average|composite/i.test(key)));
});

test('an empty benchmark reports null rates and percentiles instead of zeros', () => {
  const report = summarizeRecoveryBenchmark(manifest, []);
  assert.deepEqual(report.latencyMs, { samples: 0, p50: null, p95: null, p99: null });
  assert.deepEqual(report.independentlyAccepted, { count: 0, denominator: 0, rate: null });
  assert.deepEqual(report.unknown.withinSla, { count: 0, denominator: 0, rate: null });
  assert.deepEqual(report.cost.perIndependentlyAcceptedWork, { spentUnits: null, upperBoundUnits: null });
});

test('the provider-ledger oracle flags false success, lost effects, duplicates, and budget overrun', () => {
  const within = { limitUnits: 30, reservedUnits: 0, spentUnits: 7, availableUnits: 23 };
  assert.deepEqual(oracleViolations('SUCCEEDED', 1, within), []);
  assert.deepEqual(oracleViolations('SUCCEEDED', 0, within), ['FALSE_SUCCESS']);
  assert.deepEqual(oracleViolations('FAILED', 1, within), ['LOST_EFFECT']);
  assert.deepEqual(oracleViolations('SUCCEEDED', 2, within), ['DUPLICATE_EFFECT']);
  assert.deepEqual(oracleViolations(undefined, 0, { ...within, reservedUnits: 24 }), ['BUDGET_OVERRUN']);
});

test('recovery-v1 runs every failure mode through the gateway and measures it against the provider ledger', async () => {
  const { manifest: saved, runs } = await benchmark(42, 16);
  const report = summarizeRecoveryBenchmark(saved, runs);

  assert.equal(saved.failureSeed, 42);
  assert.equal(saved.taskSetVersion, 'recovery-v1');
  assert.equal(saved.storeSchemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(saved.model, null);
  assert.equal(saved.environment.node, process.version);
  assert.match(saved.adapter.capabilitiesHash, /^[0-9a-f]{64}$/);

  assert.deepEqual(report.runs.byScenario, {
    'budget-exhausted': 2, 'clean-success': 2, 'definitive-failure': 2, 'lost-after-effect': 2,
    'lost-before-effect': 2, 'never-visible': 2, 'offline-past-dedupe': 2, 'partial-effect': 2,
  });
  assert.deepEqual(report.runs.byOutcome, {
    succeeded: 4, failed: 4, unknown: 2, waiting_user: 0, budget_blocked: 2, manually_resolved: 4,
  });
  assert.deepEqual(report.independentlyAccepted, { count: 8, denominator: 16, rate: 0.5 });
  assert.deepEqual(report.cost, {
    totalSpentUnits: 56, totalUnresolvedReservedUnits: 20,
    perIndependentlyAcceptedWork: { spentUnits: 7, upperBoundUnits: 9.5 },
  });
  assert.deepEqual({ ...report.unknown, ageMs: undefined }, {
    entered: 10, resolved: 8, unresolved: 2, withinSla: { count: 6, denominator: 10, rate: 0.6 }, ageMs: undefined,
  });
  assert.deepEqual(report.recoverySuccess, { count: 8, denominator: 10, rate: 0.8 });
  assert.deepEqual(report.duplicateEffects, { runs: 0, effects: 0 });
  assert.deepEqual(report.manualIntervention, { runs: 4, interventions: 4 });
  assert.deepEqual(report.constraintViolations, { runs: 0, byCode: {} });

  for (const metric of [report.latencyMs, report.steps]) {
    assert.equal(metric.samples, 16);
    assert.ok(metric.p50! <= metric.p95! && metric.p95! <= metric.p99!);
  }
  assert.equal(report.recoveryMs.samples, 8);
  const of = (scenario: string) => runs.filter((record) => record.scenario === scenario);
  assert.ok(of('lost-before-effect').every((record) => record.outcome === 'failed' && record.unknownAgeMs === 5_000));
  assert.ok(of('never-visible').every((record) => record.outcome === 'unknown' && record.unknownAgeMs === 8_000 && record.steps === 10));
  assert.ok(of('offline-past-dedupe').every((record) => record.outcome === 'manually_resolved' && record.unknownAgeMs! > 86_400_000));
  assert.ok(of('partial-effect').every((record) => record.outcome === 'manually_resolved'));
  assert.ok(of('budget-exhausted').every((record) => record.steps === 1 && record.spentUnits === 0));
});

test('the same failure seed replays the same runs; another seed changes the order', async () => {
  const stable = (records: RecoveryRunRecord[]) => records.map(({ latencyMs: _l, recoveryMs: _r, ...rest }) => rest);
  const first = await benchmark(42, 8);
  const second = await benchmark(42, 8);
  const other = await benchmark(7, 8);
  assert.deepEqual(stable(second.runs), stable(first.runs));
  assert.notDeepEqual(other.runs.map((record) => record.scenario), first.runs.map((record) => record.scenario));
  await assert.rejects(benchmark(1.5, 8), /BENCHMARK_INVALID_OPTIONS/);
  await assert.rejects(benchmark(1, 0), /BENCHMARK_INVALID_OPTIONS/);
});
