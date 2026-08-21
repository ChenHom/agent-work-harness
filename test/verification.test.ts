import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCompleteness, decideCheckStatus } from '../src/evidence/verification.ts';
import type { IsolatedRun } from '../src/evidence/exec.ts';
import type { VerificationBaseline } from '../src/types.ts';

const run = (o: Partial<IsolatedRun> = {}): IsolatedRun => ({
  argv: ['npm', 'test'], exitCode: 0, signal: null, timedOut: false,
  outputTruncated: false, stdout: '', stderr: '', durationMs: 10, ...o,
});

test('parseCompleteness：node:test', () => {
  const out = ['✔ something', 'ℹ tests 72', 'ℹ suites 0', 'ℹ pass 69', 'ℹ fail 0', 'ℹ skipped 3'].join('\n');
  assert.deepEqual(parseCompleteness(out), { executed: 69, skipped: 3 });
});

test('parseCompleteness：pytest', () => {
  assert.deepEqual(parseCompleteness('=== 5 passed, 2 skipped in 0.30s ==='), { executed: 5, skipped: 2 });
  assert.deepEqual(parseCompleteness('=== 3 failed, 5 passed in 1.2s ==='), { executed: 8, skipped: 0 });
});

test('parseCompleteness：解析不出來就是 undefined，不猜', () => {
  assert.equal(parseCompleteness('BUILD SUCCESSFUL in 3s'), undefined);
  assert.equal(parseCompleteness(''), undefined);
});

// ---- 這是 dogfood 真正踩到的那個 false positive ----
test('dogfood 回歸：exit 0 但 skip 比 baseline 多 → INCONCLUSIVE 而不是 PASS', () => {
  const baseline: VerificationBaseline = { checkId: 'test', exitCode: 0, executed: 63, skipped: 0 };
  const d = decideCheckStatus(run({ exitCode: 0 }), { executed: 55, skipped: 8 }, baseline);
  assert.equal(d.status, 'INCONCLUSIVE');
  assert.match(d.reason!, /比 baseline 少|skip 數量比 baseline 多/);
});

test('沒有變差就是 PASS', () => {
  const baseline: VerificationBaseline = { checkId: 'test', exitCode: 0, executed: 63, skipped: 0 };
  assert.equal(decideCheckStatus(run(), { executed: 63, skipped: 0 }, baseline).status, 'PASS');
  // 測試變多不算變差
  assert.equal(decideCheckStatus(run(), { executed: 70, skipped: 0 }, baseline).status, 'PASS');
});

test('未知不等於失敗：baseline 缺席時退回現行行為', () => {
  assert.equal(decideCheckStatus(run({ exitCode: 0 }), { executed: 55, skipped: 8 }, undefined).status, 'PASS');
  assert.equal(decideCheckStatus(run({ exitCode: 1 }), undefined, undefined).status, 'FAIL');
});

test('未知不等於失敗：runner 解析不出 completeness 時不判失敗', () => {
  const baseline: VerificationBaseline = { checkId: 'test', exitCode: 0, executed: 63, skipped: 0 };
  assert.equal(decideCheckStatus(run({ exitCode: 0 }), undefined, baseline).status, 'PASS');
});

test('不完整不等於通過：timeout 與輸出超限都是 INCONCLUSIVE', () => {
  assert.equal(decideCheckStatus(run({ timedOut: true, exitCode: null }), undefined, undefined).status, 'INCONCLUSIVE');
  const truncated = decideCheckStatus(run({ outputTruncated: true, exitCode: null }), undefined, undefined);
  assert.equal(truncated.status, 'INCONCLUSIVE');
  assert.match(truncated.reason!, /行程被終止/);
});

test('exit 非 0 一律 FAIL，不因 baseline 本來也 FAIL 而放行', () => {
  const failing: VerificationBaseline = { checkId: 'test', exitCode: 1, executed: 60, skipped: 0 };
  assert.equal(decideCheckStatus(run({ exitCode: 1 }), { executed: 60, skipped: 0 }, failing).status, 'FAIL');
});
