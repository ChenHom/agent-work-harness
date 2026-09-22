import assert from 'node:assert/strict';
import test from 'node:test';
import { localDispatchAuthority } from '../src/runtime/dispatch-authority.ts';
import type { ExecutionOwnership } from '../src/runtime/ownership.ts';
import {
  nextRuntimeEpoch, TemporalDispatchAuthority, type RuntimeExecutionState,
} from '../src/durable/runtime-state.ts';

test('local dispatch authority preserves ExecutionOwnership validation and serialization', async () => {
  let valid = true;
  let active = false;
  const ownership: ExecutionOwnership = {
    token: 'local-token',
    validate: () => valid,
    beginOperation: () => active ? false : (active = true),
    endOperation: () => { active = false; },
    update: () => true,
    release: () => !active,
  };
  const authority = localDispatchAuthority(ownership);
  assert.equal(await authority.validate('dispatch'), true);
  assert.equal(authority.beginOperation(), true);
  assert.equal(authority.beginOperation(), false);
  authority.endOperation();
  valid = false;
  assert.equal(await authority.validate('reconcile'), false);
});

test('Temporal dispatch authority fences stale run and epoch identities', async () => {
  let state: RuntimeExecutionState = {
    workflowId: 'WF-1', runId: 'RUN-1', epoch: 1, status: 'ACTIVE',
  };
  const authority = new TemporalDispatchAuthority(
    { workflowId: 'WF-1', runId: 'RUN-1', epoch: 1 },
    () => state,
  );
  assert.equal(await authority.validate('dispatch'), true);
  state = nextRuntimeEpoch(state, 'RUN-2');
  assert.deepEqual(state, { workflowId: 'WF-1', runId: 'RUN-2', epoch: 2, status: 'ACTIVE' });
  assert.equal(await authority.validate('dispatch'), false);
  assert.equal(await authority.validate('publish'), false);
});

test('Temporal authority allows quiescent reconciliation but blocks new dispatch and publish', async () => {
  const state: RuntimeExecutionState = {
    workflowId: 'WF-2', runId: 'RUN-1', epoch: 4, status: 'QUIESCING',
  };
  const authority = new TemporalDispatchAuthority(
    { workflowId: state.workflowId, runId: state.runId, epoch: state.epoch },
    () => state,
  );
  assert.equal(await authority.validate('reconcile'), true);
  assert.equal(await authority.validate('dispatch'), false);
  assert.equal(await authority.validate('publish'), false);
});

test('runtime epoch transition rejects invalid state and increments without changing workflow identity', () => {
  assert.throws(() => nextRuntimeEpoch({
    workflowId: 'WF', runId: 'RUN', epoch: 0, status: 'ACTIVE',
  }, 'RUN-2'), /RUNTIME_EPOCH_INVALID/);
  assert.throws(() => new TemporalDispatchAuthority(
    { workflowId: 'WF', runId: '', epoch: 1 }, () => null,
  ), /RUNTIME_EXECUTION_ID_REQUIRED/);
});
