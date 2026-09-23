import test from 'node:test';
import assert from 'node:assert/strict';
import { readProcessStart } from '../src/runtime/process-identity.ts';

test('process identity reads Linux start ticks and fails closed for a missing process', () => {
  assert.match(readProcessStart(process.pid), /^\d+$/);
  assert.equal(readProcessStart(Number.MAX_SAFE_INTEGER), 'unknown');
});
