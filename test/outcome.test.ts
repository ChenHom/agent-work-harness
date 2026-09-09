import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideOutcome } from '../src/evidence/outcome.ts';
import type { EvidenceRecord, RuntimeResult } from '../src/types.ts';

const ev = (over: Partial<EvidenceRecord>): EvidenceRecord => ({
  id: 'EV', workId: 'W', attemptId: 'A', type: 'test_result', label: 'test',
  status: 'PASS', data: { required: true }, observedAt: 'now', ...over,
});
const done: RuntimeResult = {
  schemaVersion: '1', workId: 'W', attemptId: 'A', status: 'completed',
  summary: 'ok', claims: [], questions: [], declaredChangedPaths: ['src/a.ts'],
};
const gitEv = (paths: string[]) => ev({ type: 'git_diff', label: 'git diff', data: { changedPaths: paths } });
const pathOk = () => ev({ type: 'path_policy', label: 'denied path check', status: 'PASS', data: {} });

test('required evidence 全 PASS → SUCCESS', () => {
  const d = decideOutcome({ mode: 'write', skillAdmissions: [], protocolOk: true, runtimeResult: done,
    evidence: [gitEv(['src/a.ts']), pathOk(), ev({})], retryBudgetRemaining: 1 });
  assert.equal(d.outcome, 'SUCCESS');
});

test('denied path 被改 → POLICY_VIOLATION（勝過 agent 自述完成）', () => {
  const d = decideOutcome({ mode: 'write', skillAdmissions: [], protocolOk: true, runtimeResult: done,
    evidence: [gitEv(['payment/x.ts']), ev({ type: 'path_policy', status: 'FAIL', data: { violations: [{ path: 'payment/x.ts', rule: 'denied' }] } })],
    retryBudgetRemaining: 1 });
  assert.equal(d.outcome, 'POLICY_VIOLATION');
});

test('skill admission 失敗 → BLOCKED', () => {
  const d = decideOutcome({ mode: 'write', skillAdmissions: [{ skillId: 's', allowed: false, reason: 'hash 不符' }],
    protocolOk: true, runtimeResult: done, evidence: [], retryBudgetRemaining: 1 });
  assert.equal(d.outcome, 'BLOCKED');
});

test('agent 說完成但沒有任何變更 → 不算 SUCCESS', () => {
  const d = decideOutcome({ mode: 'write', skillAdmissions: [], protocolOk: true, runtimeResult: done,
    evidence: [gitEv([]), pathOk()], retryBudgetRemaining: 1 });
  assert.equal(d.outcome, 'RETRYABLE_FAILURE');
});

test('required 測試失敗且無 retry budget → FAILED', () => {
  const d = decideOutcome({ mode: 'write', skillAdmissions: [], protocolOk: true, runtimeResult: done,
    evidence: [gitEv(['src/a.ts']), pathOk(), ev({ status: 'FAIL' })], retryBudgetRemaining: 0 });
  assert.equal(d.outcome, 'FAILED');
});

test('needs_user_decision 透傳', () => {
  const d = decideOutcome({ mode: 'write', skillAdmissions: [], protocolOk: true,
    runtimeResult: { ...done, status: 'needs_user_decision', questions: [{ id: 'Q1', text: '可以改 src/token 嗎？' }] },
    evidence: [gitEv([]), pathOk()], retryBudgetRemaining: 1 });
  assert.equal(d.outcome, 'NEEDS_USER_DECISION');
  assert.match(d.reasons.join(), /src\/token/);
});

test('protocol 失敗 → 有 budget 則 RETRYABLE', () => {
  const d = decideOutcome({ mode: 'read', skillAdmissions: [], protocolOk: false, protocolError: '沒有 JSON',
    evidence: [], retryBudgetRemaining: 1 });
  assert.equal(d.outcome, 'RETRYABLE_FAILURE');
});

test('read attempt 不要求變更', () => {
  const d = decideOutcome({ mode: 'read', skillAdmissions: [], protocolOk: true, runtimeResult: done,
    evidence: [gitEv([]), pathOk()], retryBudgetRemaining: 1 });
  assert.equal(d.outcome, 'SUCCESS');
});

test('fail-closed：git observation INCONCLUSIVE 時 read attempt 不得 SUCCESS', () => {
  const d = decideOutcome({ mode: 'read', skillAdmissions: [], protocolOk: true, runtimeResult: done,
    evidence: [
      ev({ type: 'git_diff', status: 'INCONCLUSIVE', data: { changedPaths: [], probeErrors: ['git status failed'] } }),
      pathOk(),
    ], retryBudgetRemaining: 1 });
  assert.equal(d.outcome, 'RETRYABLE_FAILURE');
});

test('retry budget 用盡後 RETRYABLE 轉 FAILED', () => {
  const base = { mode: 'write' as const, skillAdmissions: [], protocolOk: true, runtimeResult: done,
    evidence: [gitEv(['src/a.ts']), pathOk(), ev({ status: 'FAIL' })] };
  assert.equal(decideOutcome({ ...base, retryBudgetRemaining: 1 }).outcome, 'RETRYABLE_FAILURE');
  assert.equal(decideOutcome({ ...base, retryBudgetRemaining: 0 }).outcome, 'FAILED');
});

test('fail-closed：path policy evidence 缺失時不得 SUCCESS', () => {
  const d = decideOutcome({ mode: 'write', skillAdmissions: [], protocolOk: true, runtimeResult: done,
    evidence: [gitEv(['src/a.ts']), ev({})], retryBudgetRemaining: 0 });   // 沒有 path_policy evidence
  assert.equal(d.outcome, 'FAILED');
  assert.match(d.reasons.join(), /path policy evidence 缺失/);
});

test('fail-closed：path policy INCONCLUSIVE 時不得 SUCCESS', () => {
  const d = decideOutcome({ mode: 'write', skillAdmissions: [], protocolOk: true, runtimeResult: done,
    evidence: [gitEv(['src/a.ts']), ev({ type: 'path_policy', status: 'INCONCLUSIVE', data: {} }), ev({})],
    retryBudgetRemaining: 1 });
  assert.equal(d.outcome, 'RETRYABLE_FAILURE');
});

test('runtime 逾時：即使留下可解析結果也不得 SUCCESS', () => {
  const d = decideOutcome({ mode: 'write', skillAdmissions: [], protocolOk: true, runtimeResult: done,
    evidence: [gitEv(['src/a.ts']), ev({ type: 'path_policy', status: 'PASS', data: {} }), ev({})],
    retryBudgetRemaining: 0, runtimeCrashed: true });
  assert.equal(d.outcome, 'FAILED');
  assert.match(d.reasons.join(), /逾時或被中止/);
});
