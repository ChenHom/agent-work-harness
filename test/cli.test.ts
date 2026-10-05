import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatContextDropped, formatPreExistingDirty, formatRecoverySession, formatWorkListRow, workListEntry,
  formatBudget, formatCompensation, formatDurableSnapshot, formatOperation,
} from '../src/cli-format.ts';
import { main } from '../src/cli.ts';
import type { RecoveryBenchmarkReport } from '../src/benchmark/recovery.ts';
import { criterionForCase, parseLabelCorpus, type CalibrationReport } from '../src/evaluation/calibration.ts';
import type { RestoreReport } from '../src/trace/backup.ts';
import type { GcRunResult } from '../src/trace/retention.ts';
import { acquireExecutionOwnership } from '../src/runtime/ownership.ts';
import { richHistory } from './helpers/history.ts';
import {
  loadDurableConnectionSettings, TemporalDurableCommandService, type DurableCommandService,
} from '../src/durable/client.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { Store } from '../src/trace/store.ts';
import { acceptanceCriterionId } from '../src/work/plans.ts';
import type {
  Attempt, BudgetLimit, BudgetReservation, Compensation, GlobalPolicy, Operation, Work, WorkContract,
} from '../src/types.ts';

async function runCli(
  stateDir: string,
  args: string[],
  durable?: DurableCommandService,
): Promise<string> {
  const policy: GlobalPolicy = {
    ...DEFAULT_POLICY,
    stateDir,
    agentHome: join(stateDir, 'agent-home'),
    codexHome: join(stateDir, 'codex-home'),
    verificationHome: join(stateDir, 'verification-home'),
    skillsDir: join(stateDir, 'skills'),
  };
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.join(' ')); };
  try {
    assert.equal(await main(args, policy, durable), 0);
  } finally {
    console.log = original;
  }
  return `${lines.join('\n')}\n`;
}

test('durable mutations require execution ownership while inspect remains available', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-cli-durable-owner-'));
  const stateDir = join(base, 'state');
  const callbackPath = join(base, 'callback.json');
  const inputPath = join(base, 'workflow.json');
  writeFileSync(inputPath, JSON.stringify({
    workId: 'W-owner', epoch: 1, businessId: 'customer-owner', value: 'enabled',
    generatedText: 'output', callbackTimeoutMs: 5_000,
  }));
  writeFileSync(callbackPath, JSON.stringify({
    eventId: 'event-owner', sourceVersion: 1, sequence: 1,
    operationId: 'OP-owner', receiptRef: 'provider:owner',
  }));
  const calls: string[] = [];
  const durable: DurableCommandService = {
    start: async () => { calls.push('start'); return { workflowId: 'WF-owner', runId: 'RUN-owner' }; },
    inspect: async () => { calls.push('inspect'); return { status: 'WAITING_EXTERNAL', epoch: 1 }; },
    callback: async () => { calls.push('callback'); },
    cancel: async () => { calls.push('cancel'); },
    rollover: async () => { calls.push('rollover'); },
    runWorker: async () => { calls.push('worker'); },
  };
  const policy = { ...DEFAULT_POLICY, stateDir };
  const held = acquireExecutionOwnership(stateDir);
  try {
    for (const args of [
      ['durable', 'start', 'WF-owner', inputPath],
      ['durable', 'callback', 'WF-owner', callbackPath],
      ['durable', 'cancel', 'WF-owner'],
      ['durable', 'rollover', 'WF-owner'],
    ]) {
      await assert.rejects(main(args, policy, durable), /OWNER_ACTIVE/);
    }
    assert.deepEqual(calls, []);
    assert.equal(await main(['durable', 'inspect', 'WF-owner'], policy, durable), 0);
    assert.deepEqual(calls, ['inspect']);
  } finally {
    held.release();
    rmSync(base, { recursive: true, force: true });
  }
});

test('P4 durable CLI keeps Temporal commands explicit and separate from local fake commands', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-cli-p4-'));
  const stateDir = join(base, 'state');
  const inputPath = join(base, 'workflow.json');
  const callbackPath = join(base, 'callback.json');
  writeFileSync(inputPath, JSON.stringify({
    workId: 'W-P4', epoch: 1, businessId: 'customer-p4', value: 'enabled',
    generatedText: 'durable output', callbackTimeoutMs: 5_000,
  }));
  writeFileSync(callbackPath, JSON.stringify({
    eventId: 'event-1', sourceVersion: 1, sequence: 1,
    operationId: 'OP-P4', receiptRef: 'provider:p4',
  }));
  const calls: string[] = [];
  const durable: DurableCommandService = {
    start: async (workflowId, input) => {
      calls.push(`start:${workflowId}:${input.workId}`);
      return { workflowId, runId: 'RUN-P4' };
    },
    inspect: async (workflowId) => {
      calls.push(`inspect:${workflowId}`);
      return { status: 'WAITING_EXTERNAL', runId: 'RUN-P4', epoch: 1, operationId: 'OP-P4' };
    },
    cancel: async (workflowId) => { calls.push(`cancel:${workflowId}`); },
    callback: async (workflowId, callback) => { calls.push(`callback:${workflowId}:${callback.eventId}`); },
    rollover: async (workflowId) => { calls.push(`rollover:${workflowId}`); },
    runWorker: async (ready) => { ready({ taskQueue: 'p4-test', buildId: 'build-test' }); },
  };
  try {
    assert.match(await runCli(stateDir, ['durable', 'start', 'WF-P4', inputPath], durable), /workflow: WF-P4 run=RUN-P4/);
    assert.match(await runCli(stateDir, ['durable', 'inspect', 'WF-P4'], durable), /WAITING_EXTERNAL.*epoch=1.*operation=OP-P4/);
    assert.match(await runCli(stateDir, ['durable', 'callback', 'WF-P4', callbackPath], durable), /callback sent/);
    assert.match(await runCli(stateDir, ['durable', 'cancel', 'WF-P4'], durable), /cancel requested/);
    assert.match(await runCli(stateDir, ['durable', 'rollover', 'WF-P4'], durable), /rollover requested/);
    assert.match(await runCli(stateDir, ['durable', 'worker'], durable), /durable worker ready.*p4-test.*build-test/);
    assert.deepEqual(calls, [
      'start:WF-P4:W-P4', 'inspect:WF-P4', 'callback:WF-P4:event-1',
      'cancel:WF-P4', 'rollover:WF-P4',
    ]);
    assert.equal(formatDurableSnapshot({
      status: 'WAITING_USER', epoch: 2, runId: 'RUN-2', compatibilityReason: 'future schema',
    }), 'WAITING_USER run=RUN-2 epoch=2 operation=- callbacks=0/0 reason=future schema');
    assert.equal(existsSync(join(stateDir, 'execution.lock')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('P4 Temporal connection settings require paired deployment identity and protect API keys with TLS', () => {
  assert.deepEqual(loadDurableConnectionSettings('/state', {
    TEMPORAL_ADDRESS: 'temporal.internal:7233', TEMPORAL_NAMESPACE: 'production',
    TEMPORAL_API_KEY: 'secret', HARNESS_TEMPORAL_TASK_QUEUE: 'p4-production',
    HARNESS_TEMPORAL_DEPLOYMENT: 'harness', HARNESS_TEMPORAL_BUILD_ID: 'build-42',
    HARNESS_DURABLE_PROVIDER_LEDGER: '/provider/ledger.json',
  }), {
    address: 'temporal.internal:7233', namespace: 'production', taskQueue: 'p4-production',
    tls: true, apiKey: 'secret',
    deploymentVersion: { deploymentName: 'harness', buildId: 'build-42' },
    providerLedgerPath: '/provider/ledger.json',
  });
  assert.throws(() => loadDurableConnectionSettings('/state', {
    HARNESS_TEMPORAL_DEPLOYMENT: 'harness-without-build',
  }), /must be set together/);
  assert.throws(() => loadDurableConnectionSettings('/state', {
    TEMPORAL_TLS: 'sometimes',
  }), /must be true or false/);
  const service = new TemporalDurableCommandService('/state', {});
  assert.throws(() => service.start('WF-forged-resume', {
    workId: 'W-forged', epoch: 2, businessId: 'customer', value: 'enabled',
    generatedText: 'output', callbackTimeoutMs: 1_000,
  }), /must start at epoch 1/);
  assert.throws(() => service.callback('WF-invalid-callback', {
    eventId: '', sourceVersion: 0, sequence: -1, operationId: '', receiptRef: '',
  }), /callback requires/);
});

const work: Work = {
  id: 'W-123',
  title: '顯示結果',
  repositoryId: 'harness',
  workspace: '/tmp/harness',
  state: 'DONE',
  currentContractVersion: 1,
  retryBudget: 2,
  createdAt: '2026-08-21T00:00:00.000Z',
};

test('list row includes the last outcome', () => {
  assert.equal(
    formatWorkListRow(work, 'SUCCESS'),
    'W-123  DONE         harness          顯示結果  outcome=SUCCESS',
  );
});

test('list row marks works without an outcome', () => {
  assert.equal(
    formatWorkListRow(work, null),
    'W-123  DONE         harness          顯示結果  outcome=-',
  );
});

const attempt: Attempt = {
  id: 'A-123', workId: work.id, number: 1, mode: 'write', contractVersion: 1,
  contractSnapshotHash: 'snapshot', baseRevision: 'revision', promptArtifactId: 'ART-1',
  runtime: 'codex', status: 'COMPLETED', startedAt: '2026-08-21T00:00:00.000Z',
};

test('list --json entry hides the previous attempt outcome while a retry runs', () => {
  const retry: Attempt = {
    ...attempt, id: 'A-124', number: 2, status: 'RUNNING', phase: 'executing', retryOf: 'A-123',
    startedAt: '2026-08-21T01:00:00.000Z',
    runtimeDispatch: { intentAt: '2026-08-21T01:00:01.000Z', ownershipToken: 'tok', state: 'running', child: { pid: 4242, processStart: '1' } },
  };
  assert.deepEqual(workListEntry({ ...work, state: 'RUNNING' }, retry, { outcome: 'FAILED', reasons: ['tests failed'], attemptId: 'A-123' }), {
    id: 'W-123', title: '顯示結果', repositoryId: 'harness', state: 'RUNNING', createdAt: '2026-08-21T00:00:00.000Z',
    attempt: {
      id: 'A-124', number: 2, status: 'RUNNING', phase: 'executing', startedAt: '2026-08-21T01:00:00.000Z',
      endedAt: null, runtimeState: 'running', childPid: 4242,
    },
    outcome: null,
  });
});

test('list --json entry shows the outcome of the latest attempt and nulls for missing fields', () => {
  const done = workListEntry(work, { ...attempt, endedAt: '2026-08-21T00:05:00.000Z' }, { outcome: 'SUCCESS', reasons: [], attemptId: 'A-123' });
  assert.deepEqual(done.outcome, { outcome: 'SUCCESS', reasons: [] });
  assert.deepEqual(done.attempt, {
    id: 'A-123', number: 1, status: 'COMPLETED', phase: null, startedAt: '2026-08-21T00:00:00.000Z',
    endedAt: '2026-08-21T00:05:00.000Z', runtimeState: null, childPid: null,
  });
  const fresh = workListEntry(work, null, null);
  assert.equal(fresh.attempt, null);
  assert.equal(fresh.outcome, null);
});

test('show attempt formatting includes pre-existing dirty paths and hashes', () => {
  assert.equal(
    formatPreExistingDirty({
      ...attempt,
      preExistingDirty: [
        { path: 'src/changed.ts', hash: 'abc123' },
        { path: 'new file.txt', hash: null },
      ],
    }),
    '    preExistingDirty: src/changed.ts (hash=abc123), new file.txt (hash=null)',
  );
});

test('show attempt formatting explicitly marks no pre-existing dirty paths', () => {
  assert.equal(formatPreExistingDirty(attempt), '    preExistingDirty: -');
});

test('show attempt formatting includes context dropped statistics', () => {
  assert.equal(
    formatContextDropped({
      ...attempt,
      contextDropped: [
        { priority: 3, count: 4 },
        { priority: 1, count: 2 },
      ],
    }),
    '    contextDropped: priority=3 count=4, priority=1 count=2',
  );
});

test('show attempt formatting explicitly marks context that was not dropped', () => {
  assert.equal(formatContextDropped(attempt), '    contextDropped: -');
});

test('show recovery formatting includes session status and evidence', () => {
  assert.equal(formatRecoverySession({
    id: 'RS-1', workId: work.id, attemptId: attempt.id,
    observedAt: '2026-09-22T00:00:00.000Z', evidenceIds: ['E-1'],
    reason: 'OBSERVED: readback only', status: 'OBSERVED',
  }), '- RS-1 OBSERVED attempt=A-123 evidence=E-1: OBSERVED: readback only');
});

test('P3 operation, compensation, and budget rows expose durable identities and balances', () => {
  const operation = {
    id: 'OP-1', status: 'UNKNOWN', intentKey: 'create:1', targetScope: 'customer-1', idempotencyKey: 'IDEM-1',
  } as Operation;
  const compensation = {
    id: 'COMP-1', status: 'PREPARED', operationId: operation.id,
    resourceIdentity: 'fake-customer-1', idempotencyKey: 'IDEM-COMP-1',
  } as Compensation;
  const limit = {
    resourceKind: 'fake_write', currency: 'unit', limitUnits: 30, pricingVersion: 'fake-v1',
  } as BudgetLimit;
  assert.match(formatOperation(operation), /OP-1 UNKNOWN.*IDEM-1/);
  assert.match(formatCompensation(compensation), /COMP-1 PREPARED.*fake-customer-1/);
  assert.equal(formatBudget(limit, [{} as BudgetReservation], 7, 10),
    '- fake_write/unit limit=30 spent=7 reserved=10 available=13 reservations=1 pricing=fake-v1');
});

test('cli runs when invoked through a symlink, as the npm bin link does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-cli-link-'));
  try {
    const link = join(dir, 'harness');
    symlinkSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), link);
    const run = spawnSync(process.execPath, [link], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /harness list \[--json\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read-only CLI commands show empty state without creating it', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-cli-'));
  const stateDir = join(base, 'missing');
  assert.equal((await runCli(stateDir, ['list'])).trim(), '(沒有 work)');
  assert.match(await runCli(stateDir, ['stats']), /works: 0\s+attempts: 0/);
  assert.equal((await runCli(stateDir, ['notes'])).trim(), '(還沒有任何記錄)');
  assert.equal((await runCli(stateDir, ['skills', 'list'])).trim(), '(registry 為空)');
  assert.equal(existsSync(stateDir), false);
  rmSync(base, { recursive: true, force: true });
});

test('P2 CLI proposes and activates plans, creates/resumes/forks checkpoints, and show stays read-only', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-cli-p2-'));
  const stateDir = join(base, 'state');
  const store = new Store(stateDir);
  const seededWork: Work = {
    id: 'W-P2', title: 'cli p2', repositoryId: 'harness', workspace: base,
    state: 'ACTIVE', currentContractVersion: 1, retryBudget: 2,
    createdAt: '2026-09-22T00:00:00.000Z',
  };
  const seededContract: WorkContract = {
    id: 'C-P2', workId: seededWork.id, version: 1, request: 'controlled work', mode: 'write',
    constraints: ['never deploy'], deniedPaths: ['secret/**'],
    successCriteria: ['first accepted', 'second accepted'], sourceMessageIds: ['MSG-1'],
    createdAt: '2026-09-22T00:00:00.000Z',
  };
  store.insertWork(seededWork);
  store.insertContract(seededContract);
  const artifact = store.putArtifact('cli_fixture', 'build-v1', 'txt');
  store.close();

  try {
    const planPath = join(base, 'plan.json');
    writeFileSync(planPath, JSON.stringify({
      contractVersion: 1, branchId: 'B-cli', reason: 'cli plan', milestones: [
        { id: 'M-1', objective: 'first', acceptanceCriterionIds: [acceptanceCriterionId('first accepted')] },
        {
          id: 'M-2', objective: 'second', dependsOn: ['M-1'],
          acceptanceCriterionIds: [acceptanceCriterionId('second accepted')],
        },
      ],
    }));
    const proposedOutput = await runCli(stateDir, ['plan', 'propose', seededWork.id, planPath]);
    const planId = proposedOutput.match(/plan: (P-[^\s]+)/)?.[1];
    assert.ok(planId);
    assert.match(await runCli(stateDir, ['plan', 'activate', planId]), /status=ACTIVE/);

    const checkpointPath = join(base, 'checkpoint.json');
    writeFileSync(checkpointPath, JSON.stringify({
      planId, milestoneId: 'M-1', validationStatus: 'validated', validationEvidenceIds: [],
      artifacts: [{ artifactId: artifact.id, logicalName: 'build', producerMilestoneId: 'M-1' }],
    }));
    const checkpointOutput = await runCli(stateDir, ['checkpoint', 'create', seededWork.id, checkpointPath]);
    const checkpointId = checkpointOutput.match(/checkpoint: (CP-[^\s]+)/)?.[1];
    assert.ok(checkpointId);
    assert.match(await runCli(stateDir, ['checkpoint', 'resume', checkpointId]), new RegExp(`branch=B-cli.*plan=${planId}`));

    const forkPath = join(base, 'fork.json');
    writeFileSync(forkPath, JSON.stringify({
      reason: 'cli fork', milestones: [
        { id: 'M-1', objective: 'first fork', acceptanceCriterionIds: [acceptanceCriterionId('first accepted')] },
        {
          id: 'M-2', objective: 'second fork', dependsOn: ['M-1'],
          acceptanceCriterionIds: [acceptanceCriterionId('second accepted')],
        },
      ],
    }));
    const forked = await runCli(stateDir, ['plan', 'fork', checkpointId, forkPath]);
    assert.match(forked, /status=VALIDATED/);
    assert.match(forked, new RegExp(`sourceCheckpoint=${checkpointId}`));

    const before = new Store(stateDir, { readOnly: true });
    const eventCount = before.events(seededWork.id).length;
    before.close();
    const shown = await runCli(stateDir, ['show', seededWork.id]);
    assert.match(shown, /\[active plan\]/);
    assert.match(shown, /M-1.*PENDING/);
    assert.match(shown, /\[checkpoints\]/);
    assert.match(shown, new RegExp(checkpointId));
    const after = new Store(stateDir, { readOnly: true });
    assert.equal(after.events(seededWork.id).length, eventCount);
    after.close();

    assert.match(await runCli(stateDir, [
      'amend', seededWork.id, 'controlled work v2，不要碰 production/**',
    ]), /contract: .* v2/);
    const amended = new Store(stateDir, { readOnly: true });
    const contractV2 = amended.getContract(seededWork.id, 2)!;
    assert.ok(contractV2.constraints.includes('never deploy'));
    assert.ok(contractV2.deniedPaths.includes('secret/**'));
    assert.ok(contractV2.deniedPaths.includes('production/**'));
    amended.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('P3 fake CLI reuses provider state across restarts and keeps display commands read-only', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-cli-p3-'));
  const stateDir = join(base, 'state');
  const store = new Store(stateDir);
  const seededWork: Work = {
    id: 'W-P3', title: 'cli p3', repositoryId: 'harness', workspace: base,
    state: 'ACTIVE', currentContractVersion: 1, retryBudget: 2,
    createdAt: '2026-09-22T00:00:00.000Z',
  };
  store.insertWork(seededWork);
  store.close();
  try {
    assert.match(await runCli(stateDir, [
      'fake', 'budget', 'configure', seededWork.id, 'fake_write', '30', 'fake-v1', 'unit',
    ]), /limit=30/);
    const operationPath = join(base, 'operation.json');
    writeFileSync(operationPath, JSON.stringify({
      intentKey: 'create:cli', kind: 'fake.create', targetScope: 'customer-cli',
      payload: {
        businessId: 'customer-cli', value: 'enabled', behavior: 'lose-response-after-effect',
        compensationBehavior: 'lose-response-after-effect',
      },
      precondition: 'absent', reconciliationStrategy: 'lookup',
      compensationPolicy: 'remove owned resource', authorizationRef: 'contract:C-P3',
    }));
    const prepared = await runCli(stateDir, ['fake', 'operation', 'prepare', seededWork.id, operationPath]);
    const operationId = prepared.match(/(OP-[^\s]+)/)?.[1];
    assert.ok(operationId);
    assert.match(await runCli(stateDir, ['fake', 'operation', 'dispatch', operationId]), /UNKNOWN/);
    assert.match(await runCli(stateDir, ['fake', 'operation', 'reconcile', operationId]), /SUCCEEDED/);

    const compensationPath = join(base, 'compensation.json');
    writeFileSync(compensationPath, JSON.stringify({
      authorizationRef: 'decision:D-P3', resourceIdentity: 'fake-customer-cli',
      ownershipRef: 'customer-cli', targetVersion: 'fake-v1',
    }));
    const compPrepared = await runCli(stateDir, [
      'fake', 'compensation', 'prepare', operationId, compensationPath,
    ]);
    const compensationId = compPrepared.match(/(COMP-[^\s]+)/)?.[1];
    assert.ok(compensationId);
    assert.match(await runCli(stateDir, ['fake', 'compensation', 'dispatch', compensationId]), /UNKNOWN/);
    assert.match(await runCli(stateDir, ['fake', 'compensation', 'reconcile', compensationId]), /SUCCEEDED/);

    const manualOperationPath = join(base, 'manual-operation.json');
    writeFileSync(manualOperationPath, JSON.stringify({
      intentKey: 'create:manual', kind: 'fake.create', targetScope: 'customer-manual',
      payload: {
        businessId: 'customer-manual', value: 'enabled', behavior: 'lose-response-after-effect',
        lookupMode: 'partial',
      },
      precondition: 'absent', reconciliationStrategy: 'lookup',
      compensationPolicy: 'remove owned resource', authorizationRef: 'contract:C-P3',
    }));
    const manualPrepared = await runCli(stateDir, [
      'fake', 'operation', 'prepare', seededWork.id, manualOperationPath,
    ]);
    const manualOperationId = manualPrepared.match(/(OP-[^\s]+)/)?.[1];
    assert.ok(manualOperationId);
    assert.match(await runCli(stateDir, ['fake', 'operation', 'dispatch', manualOperationId]), /UNKNOWN/);
    assert.match(await runCli(stateDir, ['fake', 'operation', 'reconcile', manualOperationId]), /WAITING_USER/);
    const resolutionPath = join(base, 'manual-resolution.json');
    writeFileSync(resolutionPath, JSON.stringify({
      outcome: 'confirmed-success', authorizationRef: 'human-review:TICKET-CLI',
      note: 'provider console confirms the exact resource', receipt: {
        providerReceiptId: 'manual-cli-receipt', externalId: 'fake-customer-manual',
        resourceVersion: 'fake-v1', ownershipRef: 'customer-manual', actualUnits: 7,
      },
    }));
    assert.match(await runCli(stateDir, [
      'fake', 'operation', 'resolve', manualOperationId, resolutionPath,
    ]), /SUCCEEDED/);

    const before = new Store(stateDir, { readOnly: true });
    const eventSeq = before.latestEventSeq();
    before.close();
    assert.match(await runCli(stateDir, ['fake', 'operation', 'show', seededWork.id]), /SUCCEEDED.*create:cli/);
    assert.match(await runCli(stateDir, ['fake', 'budget', 'show', seededWork.id]), /spent=17 reserved=0/);
    const after = new Store(stateDir, { readOnly: true });
    assert.equal(after.latestEventSeq(), eventSeq);
    after.close();
    assert.equal(existsSync(join(stateDir, 'execution.lock')), false);
    assert.equal(existsSync(join(stateDir, 'fake-provider', 'ledger.json')), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('P5 CLI inspects evaluations and replay, runs reports, previews/applies GC, redacts, and backs up/restores', async () => {
  const h = await richHistory();
  const dir = mkdtempSync(join(tmpdir(), 'harness-cli-p5-'));
  const json = async <T>(args: string[]) => JSON.parse(await runCli(h.state, args)) as T;
  try {
    const evaluation = await json<{ contract: { id: string }; runs: Array<{ decision: { verdict: string } }> }>(['eval', 'show', 'W-EVAL']);
    assert.equal(evaluation.contract.id, 'EC-1');
    assert.equal(evaluation.runs[0]?.decision.verdict, 'pass');

    const replay = await json<{ audit: { problems: string[] }; works: Array<{ workId: string; status: string }> }>(['replay', 'inspect']);
    assert.deepEqual(replay.audit.problems, []);
    const status = Object.fromEntries(replay.works.map((work) => [work.workId, work.status]));
    assert.deepEqual(status, { 'W-EVAL': 'available', 'W-LOST': 'unavailable', 'W-OLD': 'unavailable', 'W-OP': 'available' });

    // Read-only preview works while another process owns execution; apply needs the lock itself.
    const orphan = h.store.putArtifact('prompt', 'orphan for cli gc');
    h.store.db.prepare('update artifacts set created_at = ? where id = ?').run('2026-01-01T00:00:00.000Z', orphan.id);
    const held = acquireExecutionOwnership(h.state);
    const manifestPath = join(dir, 'gc.json');
    try {
      assert.match(await runCli(h.state, ['gc', 'preview', '--out', manifestPath]), /manifest [0-9a-f]{64}: 1 payload\(s\)/);
      await assert.rejects(main(['gc', 'apply', manifestPath], { ...DEFAULT_POLICY, stateDir: h.state }), /OWNER_ACTIVE/);
    } finally {
      held.release();
    }
    const applied = await json<GcRunResult>(['gc', 'apply', manifestPath]);
    assert.deepEqual(applied.tombstonedArtifactIds, [orphan.id]);

    const redacted = await json<{ tombstonedArtifactIds: string[] }>(['redact', h.ids.rawLog, '--authority', 'user:ops', '--reason', 'privacy request']);
    assert.deepEqual(redacted.tombstonedArtifactIds, [h.ids.rawLog]);

    assert.match(await runCli(h.state, ['backup', 'create', join(dir, 'backup')]), /backup [0-9a-f]{64}: schema v7/);
    assert.match(await runCli(h.state, ['backup', 'verify', join(dir, 'backup')]), /verified/);
    const restored = await json<RestoreReport>(['backup', 'restore', join(dir, 'backup'), join(dir, 'restored')]);
    const replayability = Object.fromEntries(restored.works.map((work) => [work.workId, work.replay]));
    assert.deepEqual(replayability, { 'W-EVAL': 'compatible', 'W-LOST': 'unreplayable', 'W-OLD': 'expired', 'W-OP': 'expired' });

    const labelsPath = new URL('fixtures/evaluation/labels.jsonl', import.meta.url);
    const cases = parseLabelCorpus(readFileSync(labelsPath, 'utf8'));
    const evaluator = { name: 'abstaining-critic', version: '1', configHash: 'sha256:abstain' };
    const predictionsPath = join(dir, 'predictions.jsonl');
    writeFileSync(predictionsPath, cases.map((labeled) => {
      const definition = criterionForCase(labeled, evaluator);
      return JSON.stringify({ evaluator, caseId: labeled.caseId, verdict: {
        schemaVersion: '1', criterionId: definition.id, criterionVersion: definition.version, kind: definition.kind,
        required: definition.required, artifactBindings: definition.artifactBindings, validator: evaluator,
        verdict: 'unknown', reasonCode: 'EVALUATOR_ABSTAINED', reason: 'abstain', evidenceArtifactIds: [],
      } });
    }).join('\n'));
    const calibration = await json<CalibrationReport>(['report', 'calibration', labelsPath.pathname, predictionsPath]);
    assert.deepEqual(calibration.groups
      .map((group) => [group.abstention.count, group.abstention.denominator]), [[5, 5], [3, 3], [4, 4]]);

    const recovery = await json<{ report: RecoveryBenchmarkReport; runs: unknown[] }>(['report', 'recovery', '--seed', '3', '--runs', '8']);
    assert.equal(recovery.report.runs.total, 8);
    assert.equal(recovery.runs.length, 8);
    assert.equal(recovery.report.manifest.failureSeed, 3);
  } finally {
    h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backup writes require execution ownership while verify remains available', async () => {
  const h = await richHistory();
  const dir = mkdtempSync(join(tmpdir(), 'harness-cli-backup-owner-'));
  const backupDir = join(dir, 'backup');
  const restoreDir = join(dir, 'restored');
  try {
    const created = await runCli(h.state, ['backup', 'create', backupDir]);
    const held = acquireExecutionOwnership(h.state);
    try {
      await assert.rejects(
        main(['backup', 'create', join(dir, 'blocked-backup')], { ...DEFAULT_POLICY, stateDir: h.state }),
        /OWNER_ACTIVE/,
      );
      await assert.rejects(
        main(['backup', 'restore', backupDir, restoreDir], { ...DEFAULT_POLICY, stateDir: h.state }),
        /OWNER_ACTIVE/,
      );
      assert.equal(existsSync(join(dir, 'blocked-backup')), false);
      assert.equal(existsSync(restoreDir), false);
      assert.equal(await runCli(h.state, ['backup', 'verify', backupDir]), `backup ${created.match(/backup ([0-9a-f]{64})/)?.[1]} verified\n`);
    } finally {
      held.release();
    }
  } finally {
    h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list --json prints machine-readable works with their latest attempt', async () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-cli-list-json-'));
  try {
    assert.deepEqual(JSON.parse(await runCli(join(state, 'missing'), ['list', '--json'])), []);
    const seed = new Store(state);
    seed.insertWork({ id: 'W-JSON', title: 'json work', repositoryId: 'repo', workspace: state, state: 'RUNNING',
      currentContractVersion: 1, retryBudget: 1, createdAt: '2026-09-20T00:00:00.000Z' });
    seed.insertAttempt({ ...attempt, id: 'A-J1', workId: 'W-JSON', status: 'COMPLETED', phase: 'terminal' });
    seed.insertOutcome('W-JSON', 'A-J1', 'FAILED', ['tests failed']);
    seed.insertAttempt({ ...attempt, id: 'A-J2', workId: 'W-JSON', number: 2, status: 'RUNNING', phase: 'collecting' });
    seed.close();

    const entries = JSON.parse(await runCli(state, ['list', '--json'])) as Array<ReturnType<typeof workListEntry>>;
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.id, 'W-JSON');
    assert.equal(entry.state, 'RUNNING');
    assert.equal(entry.attempt?.id, 'A-J2');
    assert.equal(entry.attempt?.phase, 'collecting');
    assert.equal(entry.outcome, null);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('read-only commands work on a pre-v7 database without migrating the file', async () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-cli-legacy-'));
  try {
    const seed = new Store(state);
    seed.insertWork({ id: 'W-LEGACY', title: 'legacy work', repositoryId: 'repo', workspace: state, state: 'ACTIVE',
      currentContractVersion: 1, retryBudget: 1, createdAt: '2026-09-20T00:00:00.000Z' });
    seed.insertContract({ id: 'C-LEGACY', workId: 'W-LEGACY', version: 1, request: 'legacy request', mode: 'write',
      constraints: [], deniedPaths: [], successCriteria: ['done'], sourceMessageIds: [], createdAt: '2026-09-20T00:00:00.000Z' });
    // Downgrade to what an older harness left behind: no plan or tombstone tables, user_version 0.
    seed.db.exec('drop table plans; drop table milestones; drop table checkpoints; drop table artifact_tombstones; drop table gc_runs; pragma user_version = 0;');
    seed.close();

    assert.match(await runCli(state, ['show', 'W-LEGACY']), /legacy request/);
    assert.match(await runCli(state, ['list']), /W-LEGACY/);
    const check = new DatabaseSync(join(state, 'harness.db'), { readOnly: true });
    try {
      assert.equal((check.prepare('pragma user_version').get() as { user_version: number }).user_version, 0);
      assert.equal(check.prepare("select 1 from sqlite_master where name = 'plans'").get(), undefined);
    } finally {
      check.close();
    }
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
