import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRuntimeResult, extractJsonObject } from '../src/runtime/result.ts';

const expect = { workId: 'W-1', attemptId: 'A-1' };
const good = {
  schemaVersion: '1', workId: 'W-1', attemptId: 'A-1', status: 'completed',
  summary: 'done', claims: [{ type: 'change', text: 'fixed', relatedPaths: ['src/a.ts'] }],
  questions: [], declaredChangedPaths: ['src/a.ts'],
};

test('接受夾在 prose 中的 JSON', () => {
  const r = parseRuntimeResult(`分析完成。\n${JSON.stringify(good)}\n以上。`, expect);
  assert.ok(r.ok && r.result.status === 'completed');
});

test('接受 code fence', () => {
  const r = parseRuntimeResult('```json\n' + JSON.stringify(good) + '\n```', expect);
  assert.ok(r.ok);
});

test('attemptId 不符 → PROTOCOL_FAILED', () => {
  const r = parseRuntimeResult(JSON.stringify({ ...good, attemptId: 'A-9' }), expect);
  assert.ok(!r.ok && /attemptId 不符/.test(r.error));
});

test('缺欄位 → 明確錯誤，不猜測', () => {
  const r = parseRuntimeResult(JSON.stringify({ schemaVersion: '1', workId: 'W-1', attemptId: 'A-1' }), expect);
  assert.ok(!r.ok && /status 不合法/.test(r.error));
});

test('沒有 JSON → 明確錯誤', () => {
  assert.equal(extractJsonObject('完全沒有 JSON'), null);
  const r = parseRuntimeResult('完全沒有 JSON', expect);
  assert.ok(!r.ok);
});

test('多個 JSON 取最後一個帶 schemaVersion 的', () => {
  const r = parseRuntimeResult(`{"a":1}\n{"noise":true}\n${JSON.stringify(good)}`, expect);
  assert.ok(r.ok && r.result.summary === 'done');
});
