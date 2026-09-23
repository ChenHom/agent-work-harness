import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../src/canonical-json.ts';
import { canonicalHash } from '../src/tools/operations.ts';

test('canonical JSON recursively sorts object keys and omits undefined object fields', () => {
  const left = { z: 1, nested: { b: 2, omitted: undefined, a: [{ y: 2, x: 1 }] } };
  const right = { nested: { a: [{ x: 1, y: 2 }], a2: undefined, b: 2 }, z: 1 };

  assert.equal(canonicalJson(left), '{"nested":{"a":[{"x":1,"y":2}],"b":2},"z":1}');
  assert.equal(canonicalJson(right), canonicalJson(left));
  assert.equal(canonicalHash(right), canonicalHash(left));
});
