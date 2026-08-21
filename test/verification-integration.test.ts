import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectBaseline, runVerification } from '../src/evidence/verification.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { skipWithoutSandbox as skip } from './sandbox-probe.ts';
import type { RepositoryContractSnapshot, VerificationEvidenceData } from '../src/types.ts';

const ALL_RUN = `import { test } from 'node:test';
test('a', () => {});
test('b', () => {});
test('c', () => {});
`;

// agent 動過之後：兩個測試變成有條件 skip（dogfood 中真實發生的形狀）
const TWO_SKIPPED = `import { test } from 'node:test';
const skip = 'sandbox 不支援';
test('a', () => {});
test('b', { skip }, () => {});
test('c', { skip }, () => {});
`;

function fixture(): { repo: string; base: string; snapshot: RepositoryContractSnapshot } {
  const base = mkdtempSync(join(tmpdir(), 'harness-verif-'));
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'package.json'),
    JSON.stringify({ name: 'f', private: true, scripts: { test: 'node --test test/*.test.js' } }));
  writeFileSync(join(repo, 'test/a.test.js'), ALL_RUN);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });

  const snapshot: RepositoryContractSnapshot = {
    contract: {
      schemaVersion: '1', repositoryId: 'f',
      context: { entryPoints: [] }, filesystem: { protectedPaths: [] },
      verification: { checks: [{ id: 'test', kind: 'test', argv: ['npm', 'test'], required: true }] },
    },
    hash: 'contract-hash', loadedAt: 'now', sourcePath: `${repo}/.harness/config.json`,
  };
  return { repo, base, snapshot };
}

const ids = { workId: 'W', attemptId: 'A', baseRevision: 'rev-base', headRevision: 'rev-head' };

test('dogfood false positive：測試被 skip 掉但 exit 0，有 baseline 才抓得到', { skip }, async () => {
  const { repo, base, snapshot } = fixture();

  const baseline = await collectBaseline(DEFAULT_POLICY, snapshot, repo);
  assert.deepEqual(baseline, [{ checkId: 'test', exitCode: 0, executed: 3, skipped: 0 }]);

  // agent 動手：兩個測試變成 skip，npm test 仍然 exit 0
  writeFileSync(join(repo, 'test/a.test.js'), TWO_SKIPPED);

  const withBaseline = await runVerification(DEFAULT_POLICY, snapshot, repo, ids, baseline);
  const e = withBaseline.evidence[0]!;
  const d = e.data as VerificationEvidenceData;
  assert.equal(d.exitCode, 0, '命令本身確實成功 —— 這正是舊判定會誤放行的原因');
  assert.equal(e.status, 'INCONCLUSIVE');
  assert.match(d.reason!, /skip 數量比 baseline 多|執行數量比 baseline 少/);
  assert.equal(withBaseline.allRequiredPassed, false);

  // 對照組：沒有 baseline 就退回舊行為 —— 這就是修掉的那個 false positive
  const withoutBaseline = await runVerification(DEFAULT_POLICY, snapshot, repo, ids, undefined);
  assert.equal(withoutBaseline.evidence[0]!.status, 'PASS');
  assert.equal(withoutBaseline.allRequiredPassed, true);

  rmSync(base, { recursive: true, force: true });
});

test('evidence 綁定 revision 與 contract hash（防 stale evidence）', { skip }, async () => {
  const { repo, base, snapshot } = fixture();
  const v = await runVerification(DEFAULT_POLICY, snapshot, repo, ids, undefined);
  const d = v.evidence[0]!.data as VerificationEvidenceData;
  assert.equal(d.baseRevision, 'rev-base');
  assert.equal(d.headRevision, 'rev-head');
  assert.equal(d.contractHash, 'contract-hash');
  rmSync(base, { recursive: true, force: true });
});

test('沒有變差時仍然 PASS，baseline 不會製造假警報', { skip }, async () => {
  const { repo, base, snapshot } = fixture();
  const baseline = await collectBaseline(DEFAULT_POLICY, snapshot, repo);
  writeFileSync(join(repo, 'test/b.test.js'), `import { test } from 'node:test';\ntest('d', () => {});\n`);
  const v = await runVerification(DEFAULT_POLICY, snapshot, repo, ids, baseline);
  const d = v.evidence[0]!.data as VerificationEvidenceData;
  assert.equal(v.evidence[0]!.status, 'PASS');
  assert.equal(d.executed, 4);   // 測試變多不算變差
  rmSync(base, { recursive: true, force: true });
});
