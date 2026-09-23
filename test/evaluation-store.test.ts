import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { evaluationFixture } from './helpers/evaluation.ts';

const at = '2026-09-23T00:00:00.000Z';

test('evaluation contract, run, and hash-verified verdict round-trip', () => {
  const h = evaluationFixture();
  try {
    h.store.insertEvaluationContract(h.contract);
    h.store.insertEvaluationRun(h.run);
    const accepted = h.store.insertCriterionVerdict({
      id: 'CV-1', workId: h.work.id, evaluationRunId: h.run.id,
      verdict: h.candidate, createdAt: at,
    });
    assert.equal(accepted.verdict.verdict, 'pass');
    assert.deepEqual(h.store.getEvaluationContract(h.contract.id), h.contract);
    assert.deepEqual(h.store.getEvaluationRun(h.run.id), h.run);
    assert.deepEqual(h.store.listCriterionVerdicts(h.run.id), [accepted]);
  } finally { h.store.close(); rmSync(h.state, { recursive: true, force: true }); }
});

test('artifact is read back and hash-checked before an accepted verdict is persisted', () => {
  const h = evaluationFixture();
  try {
    h.store.insertEvaluationContract(h.contract);
    h.store.insertEvaluationRun(h.run);
    writeFileSync(h.artifactPath, 'malicious replacement with different bytes');
    const accepted = h.store.insertCriterionVerdict({
      id: 'CV-CORRUPT', workId: h.work.id, evaluationRunId: h.run.id,
      verdict: h.candidate, createdAt: at,
    });
    assert.equal(accepted.verdict.verdict, 'unknown');
    assert.equal(accepted.verdict.reasonCode, 'ARTIFACT_CORRUPT');
  } finally { h.store.close(); rmSync(h.state, { recursive: true, force: true }); }
});

test('evaluation identities and one-verdict-per-criterion are append-only', () => {
  const h = evaluationFixture();
  try {
    h.store.insertEvaluationContract(h.contract);
    h.store.insertEvaluationRun(h.run);
    h.store.insertCriterionVerdict({
      id: 'CV-1', workId: h.work.id, evaluationRunId: h.run.id,
      verdict: h.candidate, createdAt: at,
    });
    assert.throws(() => h.store.insertEvaluationContract({ ...h.contract, id: 'EC-2' }), /UNIQUE|constraint/i);
    assert.throws(() => h.store.insertCriterionVerdict({
      id: 'CV-2', workId: h.work.id, evaluationRunId: h.run.id,
      verdict: { ...h.candidate, verdict: 'fail', reasonCode: 'VALIDATION_FAILED' }, createdAt: at,
    }), /UNIQUE|constraint/i);
  } finally { h.store.close(); rmSync(h.state, { recursive: true, force: true }); }
});
