import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/trace/store.ts';
import type {
  CriterionDefinition, CriterionVerdictRecord, EvaluationContract, EvaluationRun, Work,
} from '../../src/types.ts';

const at = '2026-09-23T00:00:00.000Z';

export function evaluationFixture(): {
  state: string; store: Store; work: Work; definition: CriterionDefinition;
  contract: EvaluationContract; run: EvaluationRun; candidate: CriterionVerdictRecord; artifactPath: string;
} {
  const state = mkdtempSync(join(tmpdir(), 'harness-evaluation-store-'));
  const store = new Store(state);
  const work: Work = {
    id: 'W-EVAL', title: 'evaluation', repositoryId: 'repo', workspace: '/repo',
    state: 'VERIFYING', currentContractVersion: 1, retryBudget: 1, createdAt: at,
  };
  store.insertWork(work);
  const artifact = store.putArtifact('result', 'requested A', 'txt');
  const definition: CriterionDefinition = {
    schemaVersion: '1', id: 'deliver-a', version: 1, description: 'deliver A',
    kind: 'mechanical', required: true,
    artifactBindings: [{ artifactId: artifact.id, sha256: artifact.hash }],
    validator: { name: 'exact-output', version: '1.0.0', configHash: 'c'.repeat(64) },
  };
  const contract: EvaluationContract = {
    schemaVersion: '1', id: 'EC-1', workId: work.id, version: 1,
    policyVersion: '1', criteria: [definition], createdAt: at,
  };
  const run: EvaluationRun = {
    schemaVersion: '1', id: 'ER-1', workId: work.id, contractId: contract.id,
    evaluator: {
      role: 'validator', name: 'exact-output', version: '1.0.0',
      configVersion: 'validator-config-v1', configHash: 'c'.repeat(64),
      cost: { status: 'unknown' },
    }, status: 'COMPLETED', startedAt: at, completedAt: at,
  };
  const candidate: CriterionVerdictRecord = {
    schemaVersion: '1', criterionId: definition.id, criterionVersion: definition.version,
    kind: definition.kind, required: definition.required,
    artifactBindings: definition.artifactBindings, validator: definition.validator,
    verdict: 'pass', reasonCode: 'VALIDATED', reason: 'exact output matched',
    evidenceArtifactIds: [artifact.id],
  };
  return { state, store, work, definition, contract, run, candidate, artifactPath: artifact.path };
}
