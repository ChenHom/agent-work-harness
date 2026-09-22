import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatContextDropped, formatPreExistingDirty, formatRecoverySession, formatWorkListRow,
  formatBudget, formatCompensation, formatOperation,
} from '../src/cli-format.ts';
import { main } from '../src/cli.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { Store } from '../src/trace/store.ts';
import { acceptanceCriterionId } from '../src/work/plans.ts';
import type {
  Attempt, BudgetLimit, BudgetReservation, Compensation, GlobalPolicy, Operation, Work, WorkContract,
} from '../src/types.ts';

async function runCli(stateDir: string, args: string[]): Promise<string> {
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
    assert.equal(await main(args, policy), 0);
  } finally {
    console.log = original;
  }
  return `${lines.join('\n')}\n`;
}

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

    const before = new Store(stateDir, { readOnly: true });
    const eventSeq = before.latestEventSeq();
    before.close();
    assert.match(await runCli(stateDir, ['fake', 'operation', 'show', seededWork.id]), /SUCCEEDED.*create:cli/);
    assert.match(await runCli(stateDir, ['fake', 'budget', 'show', seededWork.id]), /spent=10 reserved=0/);
    const after = new Store(stateDir, { readOnly: true });
    assert.equal(after.latestEventSeq(), eventSeq);
    after.close();
    assert.equal(existsSync(join(stateDir, 'execution.lock')), false);
    assert.equal(existsSync(join(stateDir, 'fake-provider', 'ledger.json')), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
