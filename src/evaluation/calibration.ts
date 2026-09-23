import { createHash } from 'node:crypto';
import type {
  ArtifactObservation, CriterionDefinition, CriterionReasonCode, CriterionVerdictRecord, ValidatorIdentity,
} from '../types.ts';
import { acceptCriterionVerdict } from './criteria.ts';

/** Label sources that are independent of any evaluator under test. Model output is never an oracle. */
const INDEPENDENT_SOURCES = ['human-review', 'fixture-author'];

export interface LabeledCase {
  schemaVersion: '1';
  corpusVersion: string;
  caseId: string;
  taskType: string;
  fixtureVersion: string;
  criterion: { id: string; version: number; description: string };
  artifactText: string;
  expected: 'pass' | 'fail';
  rationale: string;
  provenance: { source: string; author: string; labeledAt: string };
}

export interface CalibrationRun {
  evaluator: ValidatorIdentity;
  predictions: Array<{ caseId: string; verdict: CriterionVerdictRecord }>;
}

interface Ratio { count: number; denominator: number; rate: number | null }

type Predicted = 'pass' | 'fail' | 'unknown';
type UnknownReason = CriterionReasonCode | 'MISSING_VERDICT' | 'DUPLICATE_VERDICT';

interface CalibrationGroup {
  evaluator: ValidatorIdentity;
  taskType: string;
  cases: number;
  /** expected label -> accepted evaluator verdict */
  confusion: Record<'pass' | 'fail', Record<Predicted, number>>;
  falseAccept: Ratio;
  falseReject: Ratio;
  abstention: Ratio;
  unknownReasons: Partial<Record<UnknownReason, number>>;
}

export interface CalibrationReport {
  schemaVersion: '1';
  corpusVersion: string;
  fixtureVersions: string[];
  groups: CalibrationGroup[];
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const ratio = (count: number, denominator: number): Ratio =>
  ({ count, denominator, rate: denominator === 0 ? null : count / denominator });

function requireText(value: unknown, field: string, line: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`CALIBRATION_LABEL_INVALID: line ${line} ${field}`);
  }
  return value;
}

export function parseLabelCorpus(jsonl: string): LabeledCase[] {
  const cases: LabeledCase[] = [];
  jsonl.split('\n').forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === '') return;
    const row = JSON.parse(raw) as LabeledCase;
    if (row.schemaVersion !== '1') throw new Error(`CALIBRATION_LABEL_INVALID: line ${line} schemaVersion`);
    for (const field of ['corpusVersion', 'caseId', 'taskType', 'fixtureVersion', 'artifactText', 'rationale'] as const) {
      requireText(row[field], field, line);
    }
    requireText(row.criterion?.id, 'criterion.id', line);
    requireText(row.criterion?.description, 'criterion.description', line);
    if (!Number.isInteger(row.criterion.version) || row.criterion.version < 1) {
      throw new Error(`CALIBRATION_LABEL_INVALID: line ${line} criterion.version`);
    }
    // An oracle label is a definite decision; abstention belongs to the evaluator, never to the label.
    if (row.expected !== 'pass' && row.expected !== 'fail') {
      throw new Error(`CALIBRATION_LABEL_INVALID: line ${line} expected`);
    }
    requireText(row.provenance?.author, 'provenance.author', line);
    requireText(row.provenance?.labeledAt, 'provenance.labeledAt', line);
    if (!INDEPENDENT_SOURCES.includes(row.provenance.source)) {
      throw new Error(`CALIBRATION_LABEL_NOT_INDEPENDENT: line ${line} source ${String(row.provenance.source)}`);
    }
    if (cases.some((existing) => existing.caseId === row.caseId)) {
      throw new Error(`CALIBRATION_CASE_DUPLICATE: line ${line} ${row.caseId}`);
    }
    if (cases.some((existing) => existing.corpusVersion !== row.corpusVersion)) {
      throw new Error(`CALIBRATION_CORPUS_VERSION_MIXED: line ${line}`);
    }
    cases.push(row);
  });
  if (cases.length === 0) throw new Error('CALIBRATION_CORPUS_EMPTY');
  return cases;
}

/** The immutable criterion authority for one labeled case, bound to the exact artifact bytes. */
export function criterionForCase(labeled: LabeledCase, evaluator: ValidatorIdentity): CriterionDefinition {
  return {
    schemaVersion: '1', id: labeled.criterion.id, version: labeled.criterion.version,
    description: labeled.criterion.description, kind: 'semantic', required: true,
    artifactBindings: [{ artifactId: `${labeled.caseId}:artifact`, sha256: sha256(labeled.artifactText) }],
    validator: evaluator,
  };
}

function acceptedVerdict(
  labeled: LabeledCase,
  evaluator: ValidatorIdentity,
  predictions: CalibrationRun['predictions'],
): { verdict: Predicted; reason?: UnknownReason } {
  const [match, ...extra] = predictions.filter((prediction) => prediction.caseId === labeled.caseId);
  if (!match) return { verdict: 'unknown', reason: 'MISSING_VERDICT' };
  if (extra.length > 0) return { verdict: 'unknown', reason: 'DUPLICATE_VERDICT' };
  const definition = criterionForCase(labeled, evaluator);
  const observations: ArtifactObservation[] = definition.artifactBindings
    .map((binding) => ({ ...binding, status: 'verified' }));
  const accepted = acceptCriterionVerdict(definition, match.verdict, observations);
  return accepted.verdict === 'unknown'
    ? { verdict: 'unknown', reason: accepted.reasonCode }
    : { verdict: accepted.verdict };
}

/**
 * Compares accepted evaluator verdicts with independent labels. Every prediction goes through the
 * same binding checks as completion, so a mismatched or substituted verdict counts as abstention.
 */
export function calibrate(cases: readonly LabeledCase[], runs: readonly CalibrationRun[]): CalibrationReport {
  if (cases.length === 0) throw new Error('CALIBRATION_CORPUS_EMPTY');
  const groups: CalibrationGroup[] = [];
  for (const { evaluator, predictions } of runs) {
    const selfLabeled = cases.find((labeled) => labeled.provenance.author === evaluator.name);
    if (selfLabeled) {
      throw new Error(`CALIBRATION_LABEL_NOT_INDEPENDENT: ${selfLabeled.caseId} was labeled by ${evaluator.name}`);
    }
    const stray = predictions.find((prediction) => !cases.some((labeled) => labeled.caseId === prediction.caseId));
    if (stray) throw new Error(`CALIBRATION_CASE_UNKNOWN: ${stray.caseId}`);

    for (const taskType of [...new Set(cases.map((labeled) => labeled.taskType))].sort()) {
      const confusion: CalibrationGroup['confusion'] = {
        pass: { pass: 0, fail: 0, unknown: 0 }, fail: { pass: 0, fail: 0, unknown: 0 },
      };
      const unknownReasons: CalibrationGroup['unknownReasons'] = {};
      const typed = cases.filter((labeled) => labeled.taskType === taskType);
      for (const labeled of typed) {
        const { verdict, reason } = acceptedVerdict(labeled, evaluator, predictions);
        confusion[labeled.expected][verdict] += 1;
        if (reason) unknownReasons[reason] = (unknownReasons[reason] ?? 0) + 1;
      }
      const expectedPass = confusion.pass.pass + confusion.pass.fail + confusion.pass.unknown;
      const expectedFail = confusion.fail.pass + confusion.fail.fail + confusion.fail.unknown;
      groups.push({
        evaluator, taskType, cases: typed.length, confusion,
        falseAccept: ratio(confusion.fail.pass, expectedFail),
        falseReject: ratio(confusion.pass.fail, expectedPass),
        abstention: ratio(confusion.pass.unknown + confusion.fail.unknown, typed.length),
        unknownReasons,
      });
    }
  }
  return {
    schemaVersion: '1', corpusVersion: cases[0]!.corpusVersion,
    fixtureVersions: [...new Set(cases.map((labeled) => labeled.fixtureVersion))].sort(), groups,
  };
}
