import type {
  ArtifactBinding,
  ArtifactObservation,
  CriterionDefinition,
  CriterionReasonCode,
  CriterionVerdictRecord,
  GlobalCriterionDecision,
  ValidatorIdentity,
} from '../types.ts';

const sameValidator = (left: ValidatorIdentity, right: ValidatorIdentity): boolean =>
  left.name === right.name
  && left.version === right.version
  && left.configHash === right.configHash;

const normalizedBindings = (bindings: readonly ArtifactBinding[]): string[] =>
  bindings.map((binding) => `${binding.artifactId}\u0000${binding.sha256}`).sort();

const sameBindings = (left: readonly ArtifactBinding[], right: readonly ArtifactBinding[]): boolean => {
  const normalizedLeft = normalizedBindings(left);
  const normalizedRight = normalizedBindings(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((binding, index) => binding === normalizedRight[index]);
};

const unknownVerdict = (
  definition: CriterionDefinition,
  candidate: CriterionVerdictRecord,
  reasonCode: CriterionReasonCode,
  reason: string,
): CriterionVerdictRecord => ({
  ...candidate,
  criterionId: definition.id,
  criterionVersion: definition.version,
  kind: definition.kind,
  required: definition.required,
  artifactBindings: definition.artifactBindings,
  validator: definition.validator,
  verdict: 'unknown',
  reasonCode,
  reason,
  confidence: undefined,
});

/**
 * Accepts an evaluator result only for the immutable authority supplied by the Runtime.
 * Artifact contents and evaluator output cannot replace any authority field.
 */
export function acceptCriterionVerdict(
  definition: CriterionDefinition,
  candidate: CriterionVerdictRecord,
  observations: readonly ArtifactObservation[],
): CriterionVerdictRecord {
  // Values outside the contract (e.g. 'PASS', '', 'error') must never read as a pass.
  if (!(['pass', 'fail', 'unknown'] as unknown[]).includes(candidate.verdict)) {
    return unknownVerdict(definition, candidate, 'EVALUATOR_OUTPUT_INVALID', 'verdict must be pass, fail, or unknown');
  }
  if (candidate.criterionId !== definition.id) {
    return unknownVerdict(definition, candidate, 'CRITERION_MISMATCH', 'criterion identity does not match');
  }
  if (candidate.criterionVersion !== definition.version) {
    return unknownVerdict(definition, candidate, 'CRITERION_VERSION_MISMATCH', 'criterion version does not match');
  }
  if (candidate.kind !== definition.kind || candidate.required !== definition.required) {
    return unknownVerdict(definition, candidate, 'CRITERION_AUTHORITY_MISMATCH', 'criterion authority fields do not match');
  }
  if (!sameValidator(candidate.validator, definition.validator)) {
    return unknownVerdict(definition, candidate, 'VALIDATOR_MISMATCH', 'validator identity does not match');
  }
  if (!sameBindings(candidate.artifactBindings, definition.artifactBindings)) {
    return unknownVerdict(definition, candidate, 'ARTIFACT_BINDING_MISMATCH', 'artifact bindings do not match');
  }

  for (const binding of definition.artifactBindings) {
    const matchingId = observations.find((observation) => observation.artifactId === binding.artifactId);
    if (!matchingId || matchingId.status === 'missing') {
      return unknownVerdict(definition, candidate, 'ARTIFACT_MISSING', `artifact ${binding.artifactId} is missing`);
    }
    if (matchingId.status === 'corrupt') {
      return unknownVerdict(definition, candidate, 'ARTIFACT_CORRUPT', `artifact ${binding.artifactId} is corrupt`);
    }
    if (matchingId.sha256 !== binding.sha256) {
      return unknownVerdict(definition, candidate, 'ARTIFACT_HASH_MISMATCH', `artifact ${binding.artifactId} hash does not match`);
    }
  }

  return {
    ...candidate,
    artifactBindings: definition.artifactBindings,
    validator: definition.validator,
  };
}

const verdictMatchesDefinition = (
  definition: CriterionDefinition,
  verdict: CriterionVerdictRecord,
): boolean => verdict.criterionId === definition.id
  && verdict.criterionVersion === definition.version
  && verdict.kind === definition.kind
  && verdict.required === definition.required
  && sameValidator(verdict.validator, definition.validator)
  && sameBindings(verdict.artifactBindings, definition.artifactBindings);

/** Fixed policy: failure wins, then uncertainty; diagnostic confidence is intentionally ignored. */
export function decideGlobalVerdict(
  definitions: readonly CriterionDefinition[],
  verdicts: readonly CriterionVerdictRecord[],
): GlobalCriterionDecision {
  const blocking = definitions.filter((definition) => definition.required || definition.kind === 'hard_constraint');
  const reasons: GlobalCriterionDecision['reasonCodes'] = [];
  let hasFailure = false;
  let hasUnknown = false;

  for (const definition of blocking) {
    const matches = verdicts.filter((verdict) => verdict.criterionId === definition.id);
    if (matches.length === 0) {
      hasUnknown = true;
      reasons.push('MISSING_VERDICT');
      continue;
    }
    if (matches.length > 1) {
      hasUnknown = true;
      reasons.push('DUPLICATE_VERDICT');
      continue;
    }

    const verdict = matches[0];
    if (!verdict || !verdictMatchesDefinition(definition, verdict)) {
      hasUnknown = true;
      reasons.push('CRITERION_AUTHORITY_MISMATCH');
      continue;
    }
    if (verdict.verdict === 'pass') continue;
    if (verdict.verdict === 'fail') hasFailure = true;
    else hasUnknown = true; // 'unknown', or any value outside the contract
    reasons.push(verdict.verdict === 'fail' || verdict.verdict === 'unknown' ? verdict.reasonCode : 'EVALUATOR_OUTPUT_INVALID');
  }

  const verdict = hasFailure ? 'fail' : hasUnknown ? 'unknown' : 'pass';
  return { policyVersion: '1', verdict, canComplete: verdict === 'pass', reasonCodes: reasons };
}
