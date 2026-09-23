import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkflowPath } from '../src/durable/worker.ts';

test('workflow path decodes spaces and non-ASCII checkout names', () => {
  const workerUrl = new URL('file:///tmp/harness%20checkout/%E6%B8%AC%E8%A9%A6/src/durable/worker.ts');

  assert.equal(
    resolveWorkflowPath(workerUrl),
    '/tmp/harness checkout/測試/src/durable/workflows.ts',
  );
});
