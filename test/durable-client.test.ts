import assert from 'node:assert/strict';
import test from 'node:test';
import { readDurableRuntime, temporalRuntimeReader } from '../src/durable/client.ts';
import { TemporalDispatchAuthority } from '../src/durable/runtime-state.ts';
import type { DurableWorkflowSnapshot } from '../src/durable/contracts.ts';

function clientReturning(snapshot: DurableWorkflowSnapshot): Parameters<typeof readDurableRuntime>[0] {
  return {
    workflow: {
      getHandle: () => ({
        query: async <T>() => structuredClone(snapshot) as T,
      }),
    },
  };
}

test('production runtime reader blocks dispatch after the workflow requests cancellation', async () => {
  const identity = { workflowId: 'WF-cancel', runId: 'RUN-1', epoch: 3 };
  const client = clientReturning({ ...identity, status: 'CANCEL_REQUESTED' });
  const productionReader = temporalRuntimeReader(client);
  const read = (workflowId: string, expected = identity) => productionReader(workflowId, expected);
  const authority = new TemporalDispatchAuthority(identity, read);

  assert.equal((await read(identity.workflowId))?.status, 'CANCEL_REQUESTED');
  assert.equal(await authority.validate('dispatch'), false);
});

test('production runtime reader fails closed when the durable state query is unavailable', async () => {
  const identity = { workflowId: 'WF-missing', runId: 'RUN-1', epoch: 1 };
  const client: Parameters<typeof readDurableRuntime>[0] = {
    workflow: {
      getHandle: () => ({ query: async () => { throw new Error('query unavailable'); } }),
    },
  };

  assert.equal(await readDurableRuntime(client, identity.workflowId, identity), null);
});
