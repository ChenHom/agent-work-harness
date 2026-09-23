import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BudgetLedger, type BudgetSummary } from '../budget/ledger.ts';
import type { DispatchAuthority } from '../runtime/dispatch-authority.ts';
import { FakeProvider } from '../tools/fake-provider.ts';
import { OperationGateway } from '../tools/gateway.ts';
import { canonicalHash } from '../tools/operations.ts';
import { CURRENT_SCHEMA_VERSION } from '../trace/migrations.ts';
import { Store } from '../trace/store.ts';
import type { Operation } from '../types.ts';

const RECOVERY_BENCHMARK_VERSION = '1';

/** recovery-v1: every failure mode the fake provider can inject, plus budget exhaustion. */
const SCENARIOS = [
  'clean-success', 'definitive-failure', 'lost-before-effect', 'lost-after-effect',
  'offline-past-dedupe', 'partial-effect', 'budget-exhausted', 'never-visible',
] as const;
type Scenario = typeof SCENARIOS[number];

const OUTCOMES = ['succeeded', 'failed', 'unknown', 'waiting_user', 'budget_blocked', 'manually_resolved'] as const;
type RunOutcome = typeof OUTCOMES[number];

export interface RecoveryBenchmarkManifest {
  schemaVersion: '1';
  benchmarkVersion: string;
  taskSetVersion: string;
  failureSeed: number;
  runCount: number;
  budget: { resourceKind: string; currency: string; limitUnits: number; exhaustedLimitUnits: number; pricingVersion: string };
  adapter: { name: string; version: string; capabilitiesHash: string };
  /** recovery-v1 has no model in the loop; a model-backed task set must record provider/model/config here. */
  model: null;
  oracle: { kind: 'provider-ledger'; version: string };
  environment: { node: string; platform: string; arch: string };
  storeSchemaVersion: number;
  /** Logical clock: unknown age and SLA use it; latency and recovery time are wall-clock measurements. */
  clock: { pollIntervalMs: number; maxReconcileSteps: number; unknownSlaMs: number };
}

export interface RecoveryRunRecord {
  runId: string;
  scenario: string;
  outcome: RunOutcome;
  latencyMs: number;
  steps: number;
  spentUnits: number;
  unresolvedReservedUnits: number;
  enteredUnknown: boolean;
  unknownResolved: boolean;
  unknownAgeMs: number | null;
  recoveryMs: number | null;
  duplicateEffects: number;
  manualInterventions: number;
  constraintViolations: string[];
  independentlyAccepted: boolean;
}

interface Percentiles { samples: number; p50: number | null; p95: number | null; p99: number | null }
interface Ratio { count: number; denominator: number; rate: number | null }

export interface RecoveryBenchmarkReport {
  schemaVersion: '1';
  manifest: RecoveryBenchmarkManifest;
  runs: { total: number; byOutcome: Record<RunOutcome, number>; byScenario: Record<string, number> };
  latencyMs: Percentiles;
  steps: Percentiles;
  spentUnits: Percentiles;
  recoveryMs: Percentiles;
  cost: {
    totalSpentUnits: number;
    totalUnresolvedReservedUnits: number;
    perIndependentlyAcceptedWork: { spentUnits: number | null; upperBoundUnits: number | null };
  };
  unknown: { entered: number; resolved: number; unresolved: number; withinSla: Ratio; ageMs: Percentiles };
  recoverySuccess: Ratio;
  duplicateEffects: { runs: number; effects: number };
  manualIntervention: { runs: number; interventions: number };
  constraintViolations: { runs: number; byCode: Record<string, number> };
  independentlyAccepted: Ratio;
}

const ratio = (count: number, denominator: number): Ratio =>
  ({ count, denominator, rate: denominator === 0 ? null : count / denominator });

/** Nearest-rank percentiles; an empty sample reports null instead of a fabricated zero. */
function percentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (p: number): number | null => sorted.length === 0 ? null : sorted[Math.ceil((p / 100) * sorted.length) - 1] ?? null;
  return { samples: sorted.length, p50: at(50), p95: at(95), p99: at(99) };
}

/** mulberry32: small deterministic PRNG so a failure seed replays the same scenario order and parameters. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function payloadFor(scenario: Scenario, businessId: string, random: () => number): Record<string, unknown> {
  const base = { businessId, value: 'enabled' };
  switch (scenario) {
    case 'clean-success': case 'budget-exhausted': return { ...base, behavior: 'success' };
    case 'definitive-failure': return { ...base, behavior: 'fail-before-effect' };
    case 'lost-before-effect': return { ...base, behavior: 'lose-response-before-effect' };
    case 'lost-after-effect': return { ...base, behavior: 'lose-response-after-effect', lookupDelayCount: Math.floor(random() * 4) };
    case 'partial-effect': return { ...base, behavior: 'lose-response-after-effect', lookupMode: 'partial' };
    case 'offline-past-dedupe': case 'never-visible':
      return { ...base, behavior: 'lose-response-after-effect', lookupDelayCount: 1_000 };
  }
}

function localAuthority(): DispatchAuthority {
  let active = false;
  return {
    validate: () => true,
    beginOperation: () => active ? false : (active = true),
    endOperation: () => { active = false; },
  };
}

/** Compares the harness status with what the provider ledger says actually happened. */
export function oracleViolations(status: Operation['status'] | undefined, effects: number, budget: BudgetSummary): string[] {
  return [
    ...status === 'SUCCEEDED' && effects === 0 ? ['FALSE_SUCCESS'] : [],
    ...status === 'FAILED' && effects > 0 ? ['LOST_EFFECT'] : [],
    ...effects > 1 ? ['DUPLICATE_EFFECT'] : [],
    ...budget.spentUnits + budget.reservedUnits > budget.limitUnits ? ['BUDGET_OVERRUN'] : [],
  ];
}

const outcomeOf = (status: Operation['status']): RunOutcome =>
  status === 'SUCCEEDED' ? 'succeeded'
    : status === 'FAILED' ? 'failed'
      : status === 'WAITING_USER' ? 'waiting_user' : 'unknown';

/**
 * Runs the recovery-v1 task set against a fresh store in `stateDir`. The fake provider's own ledger
 * is the oracle: the harness status is compared with the effects that actually happened.
 */
export async function runRecoveryBenchmark(options: {
  stateDir: string;
  seed: number;
  runs: number;
}): Promise<{ manifest: RecoveryBenchmarkManifest; runs: RecoveryRunRecord[] }> {
  if (!Number.isInteger(options.seed) || !Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error('BENCHMARK_INVALID_OPTIONS: seed and runs must be integers and runs >= 1');
  }
  const store = new Store(join(options.stateDir, 'harness'));
  const provider = new FakeProvider(join(options.stateDir, 'provider-ledger.json'));
  const cost = provider.capabilities.cost;
  const manifest: RecoveryBenchmarkManifest = {
    schemaVersion: '1', benchmarkVersion: RECOVERY_BENCHMARK_VERSION, taskSetVersion: 'recovery-v1',
    failureSeed: options.seed, runCount: options.runs,
    budget: {
      resourceKind: cost.resourceKind, currency: cost.currency ?? 'unit', limitUnits: 30,
      exhaustedLimitUnits: 5, pricingVersion: cost.pricingVersion ?? 'unversioned',
    },
    adapter: {
      name: provider.capabilities.adapter, version: provider.capabilities.version,
      capabilitiesHash: canonicalHash(provider.capabilities),
    },
    model: null,
    oracle: { kind: 'provider-ledger', version: '1' },
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    storeSchemaVersion: CURRENT_SCHEMA_VERSION,
    clock: { pollIntervalMs: 1_000, maxReconcileSteps: 8, unknownSlaMs: 10_000 },
  };
  const random = seededRandom(options.seed);
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const budget = new BudgetLedger(store);
  const gateway = new OperationGateway(store, budget, provider, () => now);
  const authority = localAuthority();
  const records: RecoveryRunRecord[] = [];
  let order: Scenario[] = [];
  try {
    for (let index = 0; index < options.runs; index += 1) {
      // Seeded shuffle per cycle: every scenario appears once per cycle, in a seed-dependent order.
      if (order.length === 0) {
        order = [...SCENARIOS];
        for (let i = order.length - 1; i > 0; i -= 1) {
          const j = Math.floor(random() * (i + 1));
          [order[i], order[j]] = [order[j]!, order[i]!];
        }
      }
      const scenario = order.shift()!;
      const runId = `R-${options.seed}-${index}`;
      const workId = `W-BENCH-${options.seed}-${index}`;
      store.insertWork({
        id: workId, title: `recovery benchmark ${scenario}`, repositoryId: 'benchmark',
        workspace: options.stateDir, state: 'ACTIVE', currentContractVersion: 1, retryBudget: 0,
        createdAt: new Date(now).toISOString(),
      });
      const limit = budget.configureLimit({
        workId, resourceKind: cost.resourceKind, currency: manifest.budget.currency,
        limitUnits: scenario === 'budget-exhausted' ? manifest.budget.exhaustedLimitUnits : manifest.budget.limitUnits,
        pricingVersion: manifest.budget.pricingVersion,
      });
      const effectsBefore = provider.effectCount();
      const started = performance.now();
      let steps = 1;
      let operation: Operation | undefined;
      try {
        operation = gateway.prepare({
          workId, intentKey: `create:${runId}`, kind: 'fake.create', targetScope: runId,
          payload: payloadFor(scenario, runId, random), precondition: 'absent',
          reconciliationStrategy: 'lookup by durable key', compensationPolicy: 'remove exact owned version',
          authorizationRef: `benchmark:${runId}`,
        });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('BUDGET_EXCEEDED')) throw error;
      }
      let unknownSince: number | undefined;
      let unknownSinceWall: number | undefined;
      let manuallyResolved = false;
      if (operation) {
        steps += 1;
        operation = await gateway.dispatch(operation.id, authority);
        if (operation.status === 'UNKNOWN') {
          unknownSince = now;
          unknownSinceWall = performance.now();
          if (scenario === 'offline-past-dedupe') now = Date.parse(operation.dedupeExpiresAt) + 1;
        }
        for (let poll = 0; operation.status === 'UNKNOWN' && poll < manifest.clock.maxReconcileSteps; poll += 1) {
          now += manifest.clock.pollIntervalMs;
          steps += 1;
          operation = await gateway.reconcile(operation.id, authority);
        }
        if (operation.status === 'WAITING_USER') {
          const receipt = provider.inspectReceipt(runId);
          if (receipt) {
            steps += 1;
            operation = gateway.resolveWaitingUser(operation.id, {
              outcome: 'confirmed-success', authorizationRef: 'human-review:benchmark-oracle-v1',
              note: 'independent fake provider ledger confirms the exact effect', receipt,
            });
            manuallyResolved = true;
          }
        }
      }
      const finishedWall = performance.now();
      const effects = provider.effectCount() - effectsBefore;
      const summary = budget.summary(limit.id);
      const status = operation?.status;
      const violations = oracleViolations(status, effects, summary);
      const unknownResolved = unknownSince !== undefined && (status === 'SUCCEEDED' || status === 'FAILED');
      records.push({
        runId, scenario, outcome: manuallyResolved ? 'manually_resolved'
          : status ? outcomeOf(status) : 'budget_blocked',
        latencyMs: finishedWall - started, steps,
        spentUnits: summary.spentUnits, unresolvedReservedUnits: summary.reservedUnits,
        enteredUnknown: unknownSince !== undefined, unknownResolved,
        unknownAgeMs: unknownSince === undefined ? null : now - unknownSince,
        recoveryMs: unknownResolved ? finishedWall - unknownSinceWall! : null,
        duplicateEffects: Math.max(0, effects - 1),
        manualInterventions: manuallyResolved || status === 'WAITING_USER' ? 1 : 0,
        constraintViolations: violations,
        independentlyAccepted: status === 'SUCCEEDED' && effects === 1 && violations.length === 0,
      });
    }
  } finally {
    store.close();
  }
  return { manifest, runs: records };
}

/**
 * Aggregates every run, including failed, unknown, budget-blocked, and manually resolved ones.
 * Metrics stay separate with explicit denominators; there is deliberately no composite score.
 */
export function summarizeRecoveryBenchmark(
  manifest: RecoveryBenchmarkManifest,
  runs: readonly RecoveryRunRecord[],
): RecoveryBenchmarkReport {
  const count = (predicate: (run: RecoveryRunRecord) => boolean): number => runs.filter(predicate).length;
  const sum = (pick: (run: RecoveryRunRecord) => number): number => runs.reduce((total, run) => total + pick(run), 0);
  const byOutcome = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, count((run) => run.outcome === outcome)])) as Record<RunOutcome, number>;
  const byScenario: Record<string, number> = {};
  const byCode: Record<string, number> = {};
  for (const run of runs) {
    byScenario[run.scenario] = (byScenario[run.scenario] ?? 0) + 1;
    for (const code of run.constraintViolations) byCode[code] = (byCode[code] ?? 0) + 1;
  }
  const entered = runs.filter((run) => run.enteredUnknown);
  const resolved = entered.filter((run) => run.unknownResolved);
  const accepted = count((run) => run.independentlyAccepted);
  const totalSpentUnits = sum((run) => run.spentUnits);
  const totalUnresolvedReservedUnits = sum((run) => run.unresolvedReservedUnits);
  return {
    schemaVersion: '1', manifest,
    runs: { total: runs.length, byOutcome, byScenario },
    latencyMs: percentiles(runs.map((run) => run.latencyMs)),
    steps: percentiles(runs.map((run) => run.steps)),
    spentUnits: percentiles(runs.map((run) => run.spentUnits)),
    recoveryMs: percentiles(resolved.flatMap((run) => run.recoveryMs === null ? [] : [run.recoveryMs])),
    cost: {
      totalSpentUnits, totalUnresolvedReservedUnits,
      perIndependentlyAcceptedWork: accepted === 0
        ? { spentUnits: null, upperBoundUnits: null }
        : { spentUnits: totalSpentUnits / accepted, upperBoundUnits: (totalSpentUnits + totalUnresolvedReservedUnits) / accepted },
    },
    unknown: {
      entered: entered.length, resolved: resolved.length, unresolved: entered.length - resolved.length,
      withinSla: ratio(resolved.filter((run) => run.unknownAgeMs !== null && run.unknownAgeMs <= manifest.clock.unknownSlaMs).length, entered.length),
      ageMs: percentiles(entered.flatMap((run) => run.unknownAgeMs === null ? [] : [run.unknownAgeMs])),
    },
    recoverySuccess: ratio(resolved.filter((run) => run.constraintViolations.length === 0).length, entered.length),
    duplicateEffects: { runs: count((run) => run.duplicateEffects > 0), effects: sum((run) => run.duplicateEffects) },
    manualIntervention: { runs: count((run) => run.manualInterventions > 0), interventions: sum((run) => run.manualInterventions) },
    constraintViolations: { runs: count((run) => run.constraintViolations.length > 0), byCode },
    independentlyAccepted: ratio(accepted, runs.length),
  };
}

/** Runs recovery-v1 in a throwaway state directory; returns the aggregate and every raw run record. */
export async function benchmarkRecoveryReport(options: { seed: number; runs: number }): Promise<{
  report: RecoveryBenchmarkReport; runs: RecoveryRunRecord[];
}> {
  const stateDir = mkdtempSync(join(tmpdir(), 'harness-recovery-bench-'));
  try {
    const { manifest, runs } = await runRecoveryBenchmark({ stateDir, ...options });
    return { report: summarizeRecoveryBenchmark(manifest, runs), runs };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}
