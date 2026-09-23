import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calibrate, criterionForCase, parseLabelCorpus, type CalibrationRun, type LabeledCase,
} from '../src/evaluation/calibration.ts';
import type { CriterionReasonCode, CriterionVerdictRecord, ValidatorIdentity } from '../src/types.ts';

const corpus = parseLabelCorpus(readFileSync(new URL('fixtures/evaluation/labels.jsonl', import.meta.url), 'utf8'));

const keywordCritic: ValidatorIdentity = { name: 'keyword-critic', version: '1', configHash: 'sha256:keyword-v1' };
const abstainingCritic: ValidatorIdentity = { name: 'abstaining-critic', version: '1', configHash: 'sha256:abstain-v1' };

function verdictFor(
  labeled: LabeledCase,
  evaluator: ValidatorIdentity,
  verdict: CriterionVerdictRecord['verdict'],
  reasonCode: CriterionReasonCode,
): CriterionVerdictRecord {
  const definition = criterionForCase(labeled, evaluator);
  return {
    schemaVersion: '1', criterionId: definition.id, criterionVersion: definition.version,
    kind: definition.kind, required: definition.required, artifactBindings: definition.artifactBindings,
    validator: definition.validator, verdict, reasonCode, reason: 'fixture evaluator', evidenceArtifactIds: [],
  };
}

/** Deliberately naive evaluator under test: trusts any claim that mentions "pass". */
function keywordRun(cases: readonly LabeledCase[]): CalibrationRun {
  return {
    evaluator: keywordCritic,
    predictions: cases.map((labeled) => {
      const text = labeled.artifactText;
      if (text.length < 20) return { caseId: labeled.caseId, verdict: verdictFor(labeled, keywordCritic, 'unknown', 'EVALUATOR_ABSTAINED') };
      const verdict = /pass/i.test(text) ? 'pass' : 'fail';
      return { caseId: labeled.caseId, verdict: verdictFor(labeled, keywordCritic, verdict, verdict === 'pass' ? 'VALIDATED' : 'VALIDATION_FAILED') };
    }),
  };
}

const first = corpus[0]!;
const line = (overrides: Record<string, unknown>): string => JSON.stringify({ ...first, ...overrides });

test('fixed label corpus is versioned, independent, and covers pass and fail per task type', () => {
  assert.equal(corpus.length, 12);
  assert.ok(corpus.every((labeled) => labeled.corpusVersion === '2026-09-23.1' && labeled.fixtureVersion === '1'));
  assert.ok(corpus.every((labeled) => labeled.provenance.source === 'fixture-author'));
  for (const taskType of ['code-change', 'doc-update', 'config-change']) {
    const expected = new Set(corpus.filter((labeled) => labeled.taskType === taskType).map((labeled) => labeled.expected));
    assert.deepEqual([...expected].sort(), ['fail', 'pass'], taskType);
  }
});

test('calibration reports false accept, false reject, abstention, and confusion per task type and evaluator version', () => {
  const report = calibrate(corpus, [keywordRun(corpus), {
    evaluator: abstainingCritic,
    predictions: corpus.map((labeled) => ({
      caseId: labeled.caseId, verdict: verdictFor(labeled, abstainingCritic, 'unknown', 'EVALUATOR_ABSTAINED'),
    })),
  }]);
  assert.equal(report.corpusVersion, '2026-09-23.1');
  assert.deepEqual(report.fixtureVersions, ['1']);
  const summary = report.groups.map((group) => ({
    evaluator: `${group.evaluator.name}@${group.evaluator.version}`, taskType: group.taskType, cases: group.cases,
    confusion: group.confusion, falseAccept: group.falseAccept, falseReject: group.falseReject,
    abstention: group.abstention, unknownReasons: group.unknownReasons,
  }));
  assert.deepEqual(summary, [
    {
      evaluator: 'keyword-critic@1', taskType: 'code-change', cases: 5,
      confusion: { pass: { pass: 2, fail: 0, unknown: 0 }, fail: { pass: 3, fail: 0, unknown: 0 } },
      falseAccept: { count: 3, denominator: 3, rate: 1 }, falseReject: { count: 0, denominator: 2, rate: 0 },
      abstention: { count: 0, denominator: 5, rate: 0 }, unknownReasons: {},
    },
    {
      evaluator: 'keyword-critic@1', taskType: 'config-change', cases: 3,
      confusion: { pass: { pass: 0, fail: 1, unknown: 0 }, fail: { pass: 2, fail: 0, unknown: 0 } },
      falseAccept: { count: 2, denominator: 2, rate: 1 }, falseReject: { count: 1, denominator: 1, rate: 1 },
      abstention: { count: 0, denominator: 3, rate: 0 }, unknownReasons: {},
    },
    {
      evaluator: 'keyword-critic@1', taskType: 'doc-update', cases: 4,
      confusion: { pass: { pass: 0, fail: 2, unknown: 0 }, fail: { pass: 0, fail: 1, unknown: 1 } },
      falseAccept: { count: 0, denominator: 2, rate: 0 }, falseReject: { count: 2, denominator: 2, rate: 1 },
      abstention: { count: 1, denominator: 4, rate: 0.25 }, unknownReasons: { EVALUATOR_ABSTAINED: 1 },
    },
    {
      evaluator: 'abstaining-critic@1', taskType: 'code-change', cases: 5,
      confusion: { pass: { pass: 0, fail: 0, unknown: 2 }, fail: { pass: 0, fail: 0, unknown: 3 } },
      falseAccept: { count: 0, denominator: 3, rate: 0 }, falseReject: { count: 0, denominator: 2, rate: 0 },
      abstention: { count: 5, denominator: 5, rate: 1 }, unknownReasons: { EVALUATOR_ABSTAINED: 5 },
    },
    {
      evaluator: 'abstaining-critic@1', taskType: 'config-change', cases: 3,
      confusion: { pass: { pass: 0, fail: 0, unknown: 1 }, fail: { pass: 0, fail: 0, unknown: 2 } },
      falseAccept: { count: 0, denominator: 2, rate: 0 }, falseReject: { count: 0, denominator: 1, rate: 0 },
      abstention: { count: 3, denominator: 3, rate: 1 }, unknownReasons: { EVALUATOR_ABSTAINED: 3 },
    },
    {
      evaluator: 'abstaining-critic@1', taskType: 'doc-update', cases: 4,
      confusion: { pass: { pass: 0, fail: 0, unknown: 2 }, fail: { pass: 0, fail: 0, unknown: 2 } },
      falseAccept: { count: 0, denominator: 2, rate: 0 }, falseReject: { count: 0, denominator: 2, rate: 0 },
      abstention: { count: 4, denominator: 4, rate: 1 }, unknownReasons: { EVALUATOR_ABSTAINED: 4 },
    },
  ]);
  assert.ok(report.groups.every((group) => !('score' in group) && !('average' in group)));
});

test('substituted, missing, and duplicate verdicts count as abstention, never as pass', () => {
  const code = corpus.filter((labeled) => labeled.taskType === 'code-change');
  const byId = (caseId: string) => code.find((labeled) => labeled.caseId === caseId)!;
  const honest = keywordRun(code).predictions;
  const run: CalibrationRun = {
    evaluator: keywordCritic,
    predictions: [
      // Verdict for code-01 bound to code-05's artifact bytes: criterion A requested, artifact B judged.
      { caseId: 'code-01', verdict: verdictFor(byId('code-05'), keywordCritic, 'pass', 'VALIDATED') },
      ...honest.filter((prediction) => prediction.caseId === 'code-03'),
      { caseId: 'code-03', verdict: verdictFor(byId('code-03'), keywordCritic, 'fail', 'VALIDATION_FAILED') },
      ...honest.filter((prediction) => ['code-04', 'code-05'].includes(prediction.caseId)),
    ],
  };
  const group = calibrate(code, [run]).groups[0]!;
  assert.deepEqual(group.confusion, { pass: { pass: 1, fail: 0, unknown: 1 }, fail: { pass: 1, fail: 0, unknown: 2 } });
  assert.deepEqual(group.unknownReasons, { ARTIFACT_BINDING_MISMATCH: 1, MISSING_VERDICT: 1, DUPLICATE_VERDICT: 1 });
  assert.deepEqual(group.falseAccept, { count: 1, denominator: 3, rate: 1 / 3 });
  assert.deepEqual(group.abstention, { count: 3, denominator: 5, rate: 0.6 });
});

test('labels produced by a model or by the evaluator under test are rejected as an oracle', () => {
  assert.throws(() => parseLabelCorpus(line({ provenance: { source: 'model', author: 'critic-x', labeledAt: '2026-09-23' } })),
    /CALIBRATION_LABEL_NOT_INDEPENDENT: line 1 source model/);
  const selfLabeled = parseLabelCorpus(line({ provenance: { ...first.provenance, author: 'keyword-critic' } }));
  assert.throws(() => calibrate(selfLabeled, [keywordRun(selfLabeled)]), /CALIBRATION_LABEL_NOT_INDEPENDENT: code-01 was labeled by keyword-critic/);
});

test('corpus and prediction shape errors fail closed', () => {
  assert.throws(() => parseLabelCorpus(line({ expected: 'unknown' })), /CALIBRATION_LABEL_INVALID: line 1 expected/);
  assert.throws(() => parseLabelCorpus(line({ provenance: undefined })), /CALIBRATION_LABEL_INVALID: line 1 provenance.author/);
  assert.throws(() => parseLabelCorpus(`${line({})}\n${line({})}`), /CALIBRATION_CASE_DUPLICATE: line 2 code-01/);
  assert.throws(() => parseLabelCorpus(`${line({})}\n${line({ caseId: 'x', corpusVersion: 'other' })}`), /CALIBRATION_CORPUS_VERSION_MIXED: line 2/);
  assert.throws(() => parseLabelCorpus('\n'), /CALIBRATION_CORPUS_EMPTY/);
  assert.throws(() => calibrate(corpus, [{
    evaluator: keywordCritic,
    predictions: [{ caseId: 'not-labeled', verdict: verdictFor(first, keywordCritic, 'pass', 'VALIDATED') }],
  }]), /CALIBRATION_CASE_UNKNOWN: not-labeled/);
});

test('zero denominators are reported as null rates, not zero or one', () => {
  const passOnly = corpus.filter((labeled) => ['doc-01', 'doc-04'].includes(labeled.caseId));
  const group = calibrate(passOnly, [{ evaluator: keywordCritic, predictions: [] }]).groups[0]!;
  assert.deepEqual(group.falseAccept, { count: 0, denominator: 0, rate: null });
  assert.deepEqual(group.falseReject, { count: 0, denominator: 2, rate: 0 });
  assert.deepEqual(group.abstention, { count: 2, denominator: 2, rate: 1 });
  assert.deepEqual(group.unknownReasons, { MISSING_VERDICT: 2 });
});
