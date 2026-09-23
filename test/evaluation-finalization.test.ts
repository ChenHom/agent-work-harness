import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { finalizeEvaluation } from '../src/evaluation/finalization.ts';
import { evaluationFixture } from './helpers/evaluation.ts';
import type { Attempt, EvidenceRecord } from '../src/types.ts';

const at = '2026-09-23T00:01:00.000Z';

test('opted-in Work cannot bypass evaluation through legacy attempt finalization', () => {
  const h = evaluationFixture();
  try {
    h.store.insertEvaluationContract(h.contract);
    const attempt: Attempt = {
      id: 'A-EVAL', workId: h.work.id, number: 1, mode: 'write', contractVersion: 1,
      contractSnapshotHash: 'contract', baseRevision: 'base', promptArtifactId: '', runtime: 'codex',
      status: 'RUNNING', startedAt: at,
    };
    const evidence: EvidenceRecord = {
      id: 'EV-EVAL', workId: h.work.id, attemptId: attempt.id, type: 'test_result', label: 'tests',
      status: 'PASS', data: { required: true }, observedAt: at,
    };
    h.store.insertAttempt(attempt);
    h.store.insertEvidence(evidence);
    h.store.finalizeAttempt({
      attempt: { ...attempt, status: 'COMPLETED', endedAt: at },
      outcome: 'SUCCESS', reasons: ['mechanical checks passed'], workState: 'DONE',
      evidenceIds: [evidence.id], expectedAttemptStatus: 'RUNNING', expectedWorkState: 'VERIFYING',
    });

    assert.equal(h.store.getWork(h.work.id)?.state, 'VERIFYING');
  } finally { h.store.close(); rmSync(h.state, { recursive: true, force: true }); }
});

test('all required criteria pass before evaluation may move Work to DONE', () => {
  const h = evaluationFixture();
  try {
    h.store.insertEvaluationContract(h.contract); h.store.insertEvaluationRun(h.run);
    h.store.insertCriterionVerdict({ id: 'CV-PASS', workId: h.work.id, evaluationRunId: h.run.id,
      verdict: h.candidate, createdAt: at });
    const decision = finalizeEvaluation(h.store, { id: 'CD-PASS', workId: h.work.id,
      evaluationRunId: h.run.id, expectedWorkState: 'VERIFYING', createdAt: at });
    assert.equal(decision.verdict, 'pass');
    assert.equal(h.store.getWork(h.work.id)?.state, 'DONE');
    assert.deepEqual(h.store.getCompletionDecision(h.run.id), decision);
  } finally { h.store.close(); rmSync(h.state, { recursive: true, force: true }); }
});

test('required unknown is persisted but cannot move Work to DONE', () => {
  const h = evaluationFixture();
  try {
    h.store.insertEvaluationContract(h.contract); h.store.insertEvaluationRun(h.run);
    h.store.insertCriterionVerdict({ id: 'CV-UNKNOWN', workId: h.work.id, evaluationRunId: h.run.id,
      verdict: { ...h.candidate, verdict: 'unknown', reasonCode: 'EVALUATOR_ABSTAINED' }, createdAt: at });
    const decision = finalizeEvaluation(h.store, { id: 'CD-UNKNOWN', workId: h.work.id,
      evaluationRunId: h.run.id, expectedWorkState: 'VERIFYING', createdAt: at });
    assert.equal(decision.verdict, 'unknown');
    assert.equal(h.store.getWork(h.work.id)?.state, 'VERIFYING');
    assert.deepEqual(h.store.getCompletionDecision(h.run.id), decision);
  } finally { h.store.close(); rmSync(h.state, { recursive: true, force: true }); }
});

test('artifact changed after verdict is reverified and blocks DONE', () => {
  const h = evaluationFixture();
  try {
    h.store.insertEvaluationContract(h.contract); h.store.insertEvaluationRun(h.run);
    h.store.insertCriterionVerdict({ id: 'CV-STALE', workId: h.work.id, evaluationRunId: h.run.id,
      verdict: h.candidate, createdAt: at });
    writeFileSync(h.artifactPath, 'changed after validator accepted it');

    const decision = finalizeEvaluation(h.store, { id: 'CD-STALE', workId: h.work.id,
      evaluationRunId: h.run.id, expectedWorkState: 'VERIFYING', createdAt: at });
    assert.equal(decision.verdict, 'unknown');
    assert.equal(h.store.getWork(h.work.id)?.state, 'VERIFYING');
    assert.ok(decision.reasonCodes.includes('ARTIFACT_CORRUPT'));
  } finally { h.store.close(); rmSync(h.state, { recursive: true, force: true }); }
});

test('completion decision and DONE transition roll back atomically', () => {
  const h = evaluationFixture();
  try {
    h.store.insertEvaluationContract(h.contract); h.store.insertEvaluationRun(h.run);
    h.store.insertCriterionVerdict({ id: 'CV-PASS', workId: h.work.id, evaluationRunId: h.run.id,
      verdict: h.candidate, createdAt: at });
    h.store.db.exec(`create trigger reject_evaluation_done before update on works
      when new.state = 'DONE' begin select raise(abort, 'injected evaluation failure'); end`);
    assert.throws(() => finalizeEvaluation(h.store, { id: 'CD-ROLLBACK', workId: h.work.id,
      evaluationRunId: h.run.id, expectedWorkState: 'VERIFYING', createdAt: at }),
    /injected evaluation failure/);
    assert.equal(h.store.getCompletionDecision(h.run.id), null);
    assert.equal(h.store.getWork(h.work.id)?.state, 'VERIFYING');
  } finally { h.store.close(); rmSync(h.state, { recursive: true, force: true }); }
});

test('a stored verdict value outside pass/fail/unknown cannot move Work to DONE', () => {
  const h = evaluationFixture();
  try {
    h.store.insertEvaluationContract(h.contract); h.store.insertEvaluationRun(h.run);
    const stored = h.store.insertCriterionVerdict({ id: 'CV-BAD', workId: h.work.id, evaluationRunId: h.run.id,
      verdict: { ...h.candidate, verdict: 'PASS' as never }, createdAt: at });
    assert.deepEqual([stored.verdict.verdict, stored.verdict.reasonCode], ['unknown', 'EVALUATOR_OUTPUT_INVALID']);
    const decision = finalizeEvaluation(h.store, { id: 'CD-BAD', workId: h.work.id,
      evaluationRunId: h.run.id, expectedWorkState: 'VERIFYING', createdAt: at });
    assert.deepEqual([decision.verdict, decision.canComplete], ['unknown', false]);
    assert.equal(h.store.getWork(h.work.id)?.state, 'VERIFYING');
  } finally { h.store.close(); rmSync(h.state, { recursive: true, force: true }); }
});
