// Reviewer 報表在交接邊界的驗證：任何不一致都不得被讀成審查通過（M1 規格 §4）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReviewEnvelope, DEV01_LIMITATION, reviewExitCode, validateReviewerReport,
} from '../src/review/report.ts';
import { reviewerReport, type ReportKind, type ReviewerReportFixture } from './helpers/review.ts';

const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const expected = { baseRevision: BASE, candidate: HEAD };
const text = (value: unknown): string => JSON.stringify(value);

function valid(kind: ReportKind) {
  const result = validateReviewerReport(text(reviewerReport(kind, { base: BASE, head: HEAD })), expected);
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result.report;
}

test('合法報表：HUMAN_REVIEW_REQUIRED、NOT_SELECTED、NO_CHANGES 都通過驗證', () => {
  const human = valid('human');
  assert.equal(human.status, 'HUMAN_REVIEW_REQUIRED');
  assert.deepEqual(human.humanReview, [{ path: 'src/a.js', reasons: ['PUBLIC_API_CHANGED'] }]);
  assert.deepEqual(human.notSelected, [{ path: 'docs/notes.md', reasons: [] }]);
  assert.equal(human.mergeBase, BASE);

  const notSelected = valid('not-selected');
  assert.equal(notSelected.status, 'NO_HUMAN_REVIEW');
  assert.deepEqual(notSelected.humanReview, []);
  assert.equal(notSelected.notSelected.length, 1);

  const none = valid('no-changes');
  assert.equal(none.status, 'NO_CHANGES');
  assert.deepEqual([none.humanReview, none.notSelected], [[], []]);
});

test('額外欄位可以忽略', () => {
  const report = reviewerReport('human', { base: BASE, head: HEAD });
  report.extra = { anything: true };
  report.files[0]!.extra = 1;
  assert.equal(validateReviewerReport(text(report), expected).ok, true);
});

type Mutation = [name: string, mutate: (r: ReviewerReportFixture) => unknown, reason: RegExp];
const drop = (target: object, key: string): void => { Reflect.deleteProperty(target, key); };

const MUTATIONS: Mutation[] = [
  ['頂層是 array', () => [], /not an object/],
  ['頂層是 null', () => null, /not an object/],
  ['base.sha 錯', (r) => { r.base.sha = 'a'.repeat(40); }, /base\.sha/],
  ['缺 base', (r) => { drop(r, 'base'); }, /base\.sha/],
  ['head.sha 錯', (r) => { r.head.sha = 'a'.repeat(40); }, /head\.sha/],
  ['mergeBase 錯', (r) => { r.mergeBase = 'a'.repeat(40); }, /mergeBase/],
  ['decision.status 未知', (r) => { r.decision.status = 'APPROVED'; }, /decision\.status/],
  ['缺 decision', (r) => { drop(r, 'decision'); }, /decision\.status/],
  ['decision.reasons 不是字串陣列', (r) => { r.decision.reasons = [1] as never; }, /decision\.reasons/],
  ['decision.files 為負數', (r) => { r.decision.files = -1; }, /decision\.files/],
  ['decision.full 不是整數', (r) => { r.decision.full = 0.5; }, /decision\.full/],
  ['缺 decision.targeted', (r) => { drop(r.decision, 'targeted'); }, /decision\.targeted/],
  ['計數加總與 files 矛盾', (r) => { r.decision.notSelected = 2; }, /add up/],
  ['decision.files 與 files.length 矛盾', (r) => { r.decision.files = 3; r.decision.notSelected = 2; }, /add up/],
  ['files 不是 array', (r) => { r.files = {} as never; }, /files is not an array/],
  ['file 不是 object', (r) => { r.files[1] = 'docs/notes.md' as never; }, /files\[1\]/],
  ['path 空字串', (r) => { r.files[0]!.path = ''; }, /files\[0\]\.path/],
  ['path 重複', (r) => { r.files[1]!.path = 'src/a.js'; }, /duplicate path/],
  ['file decision 未知', (r) => { r.files[1]!.decision = 'SKIPPED'; }, /files\[1\]\.decision/],
  ['needsHuman 不是 boolean', (r) => { r.files[0]!.needsHuman = 'yes' as never; }, /files\[0\]\.needsHuman/],
  ['file reasons 不是字串陣列', (r) => { r.files[0]!.reasons = 'PUBLIC_API_CHANGED' as never; }, /files\[0\]\.reasons/],
  ['NOT_SELECTED 檔案數與 decision.notSelected 矛盾', (r) => {
    r.files[1]!.decision = 'HUMAN_REVIEW_REQUIRED';
  }, /notSelected/],
  ['HUMAN_REVIEW_REQUIRED 但 targeted + full 為 0', (r) => {
    r.decision.full = 0; r.decision.notSelected = 2; r.files[0]!.decision = 'NOT_SELECTED_FOR_HUMAN_REVIEW';
  }, /HUMAN_REVIEW_REQUIRED/],
  ['NOT_SELECTED 但 targeted + full 大於 0', (r) => {
    r.decision.status = 'NOT_SELECTED_FOR_HUMAN_REVIEW';
  }, /HUMAN_REVIEW_REQUIRED/],
  ['缺 human', (r) => { drop(r, 'human'); }, /human\.required/],
  ['human.required 不是 boolean', (r) => { r.human.required = 1 as never; }, /human\.required/],
  ['human.files 與 needsHuman 數矛盾', (r) => { r.human.files = 2; }, /human\.files/],
  ['human.pendingFixes 不是 0', (r) => { r.human.pendingFixes = 1; }, /pendingFixes/],
  ['human.required 與 human.files 矛盾', (r) => { r.human.required = false; }, /human\.required/],
  ['ai 不是 null', (r) => { r.ai = { model: 'x' }; }, /ai must be null/],
  ['缺 ai（不得以預設值補齊）', (r) => { drop(r, 'ai'); }, /ai must be null/],
  // 第一輪審查 M2（V1）：Reviewer 機械選入（decision HUMAN、full 1、status HUMAN），卻標 needsHuman false、human.required false
  ['選入人工的檔案 needsHuman 為 false', (r) => {
    r.files = [r.files[0]!];
    r.files[0]!.needsHuman = false;
    r.decision = { ...r.decision, files: 1, notSelected: 0, full: 1 };
    r.human = { required: false, files: 0, findings: 0, pendingFixes: 0 };
  }, /files\[0\]\.needsHuman does not match its decision/],
  ['未選入的檔案 needsHuman 為 true', (r) => {
    r.files[1]!.needsHuman = true;
    r.human.files = 2;
  }, /files\[1\]\.needsHuman does not match its decision/],
];

for (const [name, mutate, reason] of MUTATIONS) {
  test(`報表反例：${name} → 不通過`, () => {
    const report = reviewerReport('human', { base: BASE, head: HEAD });
    const replaced = mutate(report);
    const result = validateReviewerReport(text(replaced === undefined ? report : replaced), expected);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, reason);
  });
}

test('報表反例：decision.status 是 NOT_SELECTED，檔案卻標 needsHuman、human.required 為 true（M2 V2）→ 不通過', () => {
  const report = reviewerReport('not-selected', { base: BASE, head: HEAD });
  report.files[0]!.needsHuman = true;
  report.human = { required: true, files: 1, findings: 0, pendingFixes: 0 };
  const result = validateReviewerReport(text(report), expected);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /files\[0\]\.needsHuman does not match its decision/);
});

test('報表反例：沒有檔案卻沒有 NO_CHANGES → 不通過', () => {
  const report = reviewerReport('no-changes', { base: BASE, head: HEAD });
  report.decision.reasons = [];
  const result = validateReviewerReport(text(report), expected);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /NO_CHANGES/);
});

test('報表反例：malformed JSON → 不通過', () => {
  for (const raw of ['', '{', '{"base":', 'not json']) {
    const result = validateReviewerReport(raw, expected);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /JSON/);
  }
});

test('envelope 照 Reviewer 的決策分出人工待辦與未選入，並帶 DEV-01 限制', () => {
  const report = valid('human');
  const envelope = buildReviewEnvelope({
    workId: 'W-1', attemptId: 'A-1', contractVersion: 2, contractSnapshotHash: 's'.repeat(64),
    workspace: '/repo', baseRevision: BASE, candidate: HEAD, resultTree: 't'.repeat(40),
    reviewer: { imageId: `sha256:${'e'.repeat(64)}`, revision: 'f'.repeat(40) },
    rawReport: { sha256: 'r'.repeat(64), artifactId: 'AR-raw' },
    verification: { revision: HEAD, contractHash: 's'.repeat(64), changedPaths: 2, checks: [] },
  }, report, '2026-10-27T00:00:00.000Z');
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.status, 'HUMAN_REVIEW_REQUIRED');
  assert.equal(envelope.mergeBase, BASE);
  assert.deepEqual(envelope.humanReview, [{ path: 'src/a.js', reasons: ['PUBLIC_API_CHANGED'] }]);
  assert.deepEqual(envelope.notSelected, [{ path: 'docs/notes.md', reasons: [] }]);
  assert.deepEqual(envelope.limitations, [DEV01_LIMITATION]);
  assert.match(DEV01_LIMITATION, /^DEV-01: .*not verified safe$/);
  assert.equal(envelope.createdAt, '2026-10-27T00:00:00.000Z');
});

test('exit code：只有 HUMAN_REVIEW_REQUIRED 是 5，其餘有效結果是 0', () => {
  assert.equal(reviewExitCode('HUMAN_REVIEW_REQUIRED'), 5);
  assert.equal(reviewExitCode('NO_HUMAN_REVIEW'), 0);
  assert.equal(reviewExitCode('NO_CHANGES'), 0);
});
