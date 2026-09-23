import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptCriterionVerdict, decideGlobalVerdict } from '../src/evaluation/criteria.ts';
import type {
  ArtifactObservation,
  CriterionDefinition,
  CriterionVerdictRecord,
} from '../src/types.ts';

const criterion = (over: Partial<CriterionDefinition> = {}): CriterionDefinition => ({
  schemaVersion: '1',
  id: 'requested-output',
  version: 1,
  description: 'deliver the requested output',
  kind: 'mechanical',
  required: true,
  artifactBindings: [{ artifactId: 'ART-A', sha256: 'a'.repeat(64) }],
  validator: { name: 'artifact-validator', version: '1.0.0', configHash: 'c'.repeat(64) },
  ...over,
});

const observation = (over: Partial<ArtifactObservation> = {}): ArtifactObservation => ({
  artifactId: 'ART-A',
  sha256: 'a'.repeat(64),
  status: 'verified',
  ...over,
});

const candidate = (
  definition: CriterionDefinition,
  over: Partial<CriterionVerdictRecord> = {},
): CriterionVerdictRecord => ({
  schemaVersion: '1',
  criterionId: definition.id,
  criterionVersion: definition.version,
  kind: definition.kind,
  required: definition.required,
  artifactBindings: definition.artifactBindings,
  validator: definition.validator,
  verdict: 'pass',
  reasonCode: 'VALIDATED',
  reason: 'all checks passed',
  evidenceArtifactIds: ['EVIDENCE-1'],
  confidence: 0.99,
  ...over,
});

test('exact criterion and verified artifact binding accepts pass', () => {
  const expected = criterion();
  const accepted = acceptCriterionVerdict(expected, candidate(expected), [observation()]);

  assert.equal(accepted.verdict, 'pass');
  assert.equal(accepted.reasonCode, 'VALIDATED');
});

test('criterion A requested but artifact B delivered becomes unknown', () => {
  const expected = criterion();
  const claimed = candidate(expected, {
    artifactBindings: [{ artifactId: 'ART-B', sha256: 'b'.repeat(64) }],
  });
  const accepted = acceptCriterionVerdict(expected, claimed, [
    observation({ artifactId: 'ART-B', sha256: 'b'.repeat(64) }),
  ]);

  assert.equal(accepted.verdict, 'unknown');
  assert.equal(accepted.reasonCode, 'ARTIFACT_BINDING_MISMATCH');
  assert.deepEqual(accepted.artifactBindings, expected.artifactBindings);
});

test('corrupt or hash-mismatched required artifact becomes unknown', () => {
  const expected = criterion();

  const corrupt = acceptCriterionVerdict(expected, candidate(expected), [
    observation({ status: 'corrupt' }),
  ]);
  assert.equal(corrupt.verdict, 'unknown');
  assert.equal(corrupt.reasonCode, 'ARTIFACT_CORRUPT');

  const wrongHash = acceptCriterionVerdict(expected, candidate(expected), [
    observation({ sha256: 'b'.repeat(64) }),
  ]);
  assert.equal(wrongHash.verdict, 'unknown');
  assert.equal(wrongHash.reasonCode, 'ARTIFACT_HASH_MISMATCH');
});

test('validator or criterion authority mismatch fails closed', () => {
  const expected = criterion();
  const wrongCriterion = acceptCriterionVerdict(expected, candidate(expected, {
    criterionId: 'artifact-says-use-me',
  }), [observation()]);
  assert.equal(wrongCriterion.reasonCode, 'CRITERION_MISMATCH');
  assert.equal(wrongCriterion.verdict, 'unknown');

  const wrongValidator = acceptCriterionVerdict(expected, candidate(expected, {
    validator: { ...expected.validator, version: '2.0.0' },
  }), [observation()]);
  assert.equal(wrongValidator.reasonCode, 'VALIDATOR_MISMATCH');
  assert.equal(wrongValidator.verdict, 'unknown');
});

test('evaluator abstention remains structured unknown', () => {
  const expected = criterion({ kind: 'semantic' });
  const accepted = acceptCriterionVerdict(expected, candidate(expected, {
    verdict: 'unknown',
    reasonCode: 'EVALUATOR_ABSTAINED',
    reason: 'insufficient evidence',
  }), [observation()]);

  assert.equal(accepted.verdict, 'unknown');
  assert.equal(accepted.reasonCode, 'EVALUATOR_ABSTAINED');
});

test('required unknown blocks completion and required failure wins', () => {
  const first = criterion();
  const second = criterion({ id: 'semantic-fit', kind: 'semantic', artifactBindings: [] });

  const unknown = decideGlobalVerdict([first, second], [
    candidate(first),
    candidate(second, { verdict: 'unknown', reasonCode: 'EVALUATOR_ABSTAINED' }),
  ]);
  assert.equal(unknown.verdict, 'unknown');
  assert.equal(unknown.canComplete, false);

  const failed = decideGlobalVerdict([first, second], [
    candidate(first, { verdict: 'fail', reasonCode: 'VALIDATION_FAILED' }),
    candidate(second, { verdict: 'unknown', reasonCode: 'EVALUATOR_ABSTAINED' }),
  ]);
  assert.equal(failed.verdict, 'fail');
  assert.equal(failed.canComplete, false);
});

test('optional passes and confidence cannot average away a hard failure', () => {
  const hard = criterion({ id: 'no-secrets', kind: 'hard_constraint', required: false });
  const optional = criterion({ id: 'style', kind: 'semantic', required: false, artifactBindings: [] });
  const decision = decideGlobalVerdict([hard, optional], [
    candidate(hard, { verdict: 'fail', reasonCode: 'VALIDATION_FAILED', confidence: 0.01 }),
    candidate(optional, { verdict: 'pass', confidence: 1 }),
  ]);

  assert.equal(decision.verdict, 'fail');
  assert.equal(decision.canComplete, false);
});

test('optional unknown does not block when every blocking criterion passes', () => {
  const required = criterion();
  const optional = criterion({ id: 'style', kind: 'semantic', required: false, artifactBindings: [] });
  const decision = decideGlobalVerdict([required, optional], [
    candidate(required),
    candidate(optional, { verdict: 'unknown', reasonCode: 'EVALUATOR_ABSTAINED' }),
  ]);

  assert.equal(decision.verdict, 'pass');
  assert.equal(decision.canComplete, true);
});

test('missing or duplicate blocking verdict fails closed as unknown', () => {
  const required = criterion();
  const missing = decideGlobalVerdict([required], []);
  assert.equal(missing.verdict, 'unknown');
  assert.deepEqual(missing.reasonCodes, ['MISSING_VERDICT']);

  const duplicate = decideGlobalVerdict([required], [candidate(required), candidate(required)]);
  assert.equal(duplicate.verdict, 'unknown');
  assert.deepEqual(duplicate.reasonCodes, ['DUPLICATE_VERDICT']);
});
