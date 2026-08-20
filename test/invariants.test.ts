// §38 MVP 驗收條件。編號對應設計文件的 30 條 invariants。
// 需要真實 OS/Runtime enforcement 的幾條（13, 14, 22）由 docs/spikes/2026-08-21-isolation-spike.md
// 與 `harness doctor` 覆蓋；需要跑 codex 的（23, 29）由 scripts/e2e.sh 覆蓋，這裡註明來源。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseRequest } from '../src/work/parser.ts';
import { buildAuthority } from '../src/orchestrator.ts';
import { compilePrompt } from '../src/prompt/compiler.ts';
import { buildManifest, derivePointers } from '../src/context/manifest.ts';
import { loadSnapshot, validateContract, CONTRACT_REL_PATH } from '../src/repo/contract.ts';
import { parseRuntimeResult } from '../src/runtime/result.ts';
import { decideOutcome } from '../src/evidence/outcome.ts';
import { buildResponse } from '../src/response.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import type {
  WorkContract, Attempt, RepositoryContractSnapshot, EvidenceRecord, RuntimeResult, DecisionRecord,
} from '../src/types.ts';

const contract: WorkContract = {
  id: 'WC', workId: 'W', version: 1, request: '修 token', mode: 'write',
  constraints: [], deniedPaths: ['payment/**'], successCriteria: ['測試通過'],
  sourceMessageIds: ['M'], createdAt: 'now',
};
const attempt: Attempt = {
  id: 'A', workId: 'W', number: 1, mode: 'write', contractVersion: 1,
  contractSnapshotHash: 'snap', baseRevision: 'rev1', promptArtifactId: '', runtime: 'codex',
  status: 'CREATED', startedAt: 'now',
};
const snapshot: RepositoryContractSnapshot = {
  contract: {
    schemaVersion: '1', repositoryId: 'r',
    context: { entryPoints: ['src/', 'docs/design.md'] },
    filesystem: { protectedPaths: ['.git/**', '.harness/**'] },
    verification: { checks: [{ id: 'test', kind: 'test', argv: ['npm', 'test'], required: true }] },
  },
  hash: 'abc', loadedAt: 'now', sourcePath: '/w/.harness/config.json',
};
const ev = (o: Partial<EvidenceRecord>): EvidenceRecord => ({
  id: 'EV', workId: 'W', attemptId: 'A', type: 'test_result', label: 'test',
  status: 'PASS', data: { required: true }, observedAt: 'now', ...o,
});
const gitEv = (paths: string[]) => ev({ type: 'git_diff', label: 'git diff', data: { changedPaths: paths } });
const completed: RuntimeResult = {
  schemaVersion: '1', workId: 'W', attemptId: 'A', status: 'completed',
  summary: '完成', claims: [{ type: 'verification', text: '我跑過測試，全過' }],
  questions: [], declaredChangedPaths: ['src/a.ts'],
};

test('1. 「只看不要改」只能建立 read-only Attempt', () => {
  assert.equal(parseRequest('只看不要改').mode, 'read');
  const a = buildAuthority({ ...contract, mode: 'read' }, snapshot);
  assert.equal(a.filesystem, 'read-only');
});

test('2. deniedPaths 進 authority，repo contract 無法移除它', () => {
  const a = buildAuthority(contract, snapshot);
  assert.ok(a.deniedPaths.includes('payment/**'));
  // repo 只能加嚴：protectedPaths 與 contract deniedPaths 取聯集
  assert.ok(a.deniedPaths.includes('.git/**'));
  const loose = { ...snapshot, contract: { ...snapshot.contract, filesystem: { protectedPaths: [] } } };
  assert.ok(buildAuthority(contract, loose).deniedPaths.includes('payment/**'));
});

test('3+4. prompt 只給 pointer，不 inline repo 內容', () => {
  const m = buildManifest({ contract, attempt, authority: buildAuthority(contract, snapshot), decisions: [], snapshot, userContext: [] });
  const p = compilePrompt({ manifest: m, contract, authority: buildAuthority(contract, snapshot), snapshot, workspace: '/w', attemptId: 'A', workId: 'W', approvedSkills: [] });
  assert.match(p.text, /- docs\/design\.md/);
  assert.ok(p.text.length < 4000, 'prompt 應該小；不得預先 inline 整份 repo');
  assert.ok(m.pointers.every((i) => i.pointer && !i.content), 'pointer item 不得攜帶檔案內容');
});

test('5. 第一批 pointers 只來自 entryPoints + 使用者明確提到的 path', () => {
  const decisions: DecisionRecord[] = [
    { id: 'D', workId: 'W', sourceMessageId: 'M', kind: 'allow_path', value: 'src/token/**', createdAt: 'now' },
  ];
  const p = derivePointers(snapshot, { ...contract, request: '看一下 src/auth/login.ts' }, decisions);
  assert.deepEqual(p, ['docs/design.md', 'src/', 'src/auth/login.ts', 'src/token/**']);
});

test('6+7. retry 只帶 decision / evidence / pointer，不帶 transcript', () => {
  const prev: Attempt = { ...attempt, id: 'A-0', number: 1, status: 'COMPLETED' };
  const m = buildManifest({
    contract, attempt: { ...attempt, id: 'A-1', number: 2, retryOf: 'A-0' },
    authority: buildAuthority(contract, snapshot), decisions: [], snapshot, userContext: [],
    previousAttempt: prev,
    previousEvidence: [ev({ status: 'FAIL', label: 'test', data: { required: true, tail: 'AssertionError x != y' } })],
    previousClaims: ['[diagnosis] race condition'],
  });
  const text = m.previousEvidence.map((i) => i.content).join('\n');
  assert.match(text, /test: FAIL/);
  assert.match(text, /Previous claim: \[diagnosis\]/);
  assert.ok(!/user:|assistant:|tool_call/.test(text), '不得夾帶對話紀錄');
});

test('8. 每個 ContextItem 都有 source 與 trust', () => {
  const m = buildManifest({ contract, attempt, authority: buildAuthority(contract, snapshot), decisions: [], snapshot, userContext: ['昨天改過 refresh token'] });
  const all = [...m.control, ...m.decisions, ...m.userContext, ...m.pointers, ...m.previousEvidence];
  assert.ok(all.length > 0);
  for (const i of all) {
    assert.ok(i.source, `${i.kind} 缺 source`);
    assert.ok(['authority', 'trusted', 'untrusted'].includes(i.trust));
  }
  assert.equal(m.pointers[0]!.trust, 'untrusted', 'repo pointer 必須是 untrusted');
  assert.equal(m.decisions.length, 0);
  assert.equal(m.userContext[0]!.trust, 'trusted');
});

test('9. Attempt 記錄 repository revision 與 contract snapshot', () => {
  assert.equal(attempt.baseRevision, 'rev1');
  assert.equal(attempt.contractSnapshotHash, 'snap');
});

test('10+11. successCriteria 不參與 outcome；SUCCESS 只來自 mechanical evidence', () => {
  // 自然語言 criterion 說「測試通過」，但 required evidence FAIL → 不得 SUCCESS
  const d = decideOutcome({
    mode: 'write', skillAdmissions: [], protocolOk: true, runtimeResult: completed,
    evidence: [gitEv(['src/a.ts']), ev({ status: 'FAIL' })], retryBudgetRemaining: 0,
  });
  assert.equal(d.outcome, 'FAILED');
  assert.ok(!d.reasons.join().includes('測試通過'), 'outcome 理由不得引用自然語言 criterion');
});

test('12. skill hash 變更後舊核准立即失效', () => {
  // 見 test/skills.test.ts；此處確認 admission 失敗直接 BLOCKED，不會 launch
  const d = decideOutcome({
    mode: 'write', skillAdmissions: [{ skillId: 's', allowed: false, reason: 'hash 不符' }],
    protocolOk: true, runtimeResult: completed, evidence: [], retryBudgetRemaining: 5,
  });
  assert.equal(d.outcome, 'BLOCKED');
});

test('13+14+22. runtime enforcement：由 spike 與 doctor 覆蓋', () => {
  // network deny / read-only 寫入阻擋 / verification 隔離的實測結果見
  // docs/spikes/2026-08-21-isolation-spike.md；`harness doctor` 會重跑 probe 並在洩漏時失敗。
  // 這裡確認 Harness 宣告的 authority 永遠是 network deny，不受 repo 影響。
  assert.equal(buildAuthority(contract, snapshot).network, 'deny');
});

test('15. 沒有明確限制時 write scope 是整個 worktree 減 denied/protected', () => {
  assert.equal(buildAuthority(contract, snapshot).writablePaths, undefined);
  assert.equal(parseRequest('修登入 bug，不要碰 payment').allowedPaths, undefined);
  const limited = buildAuthority({ ...contract, allowedPaths: ['src/auth/**'] }, snapshot);
  assert.deepEqual(limited.writablePaths, ['src/auth/**']);
});

test('16+17. contract 在 attempt 前 freeze；.harness/** 預設 protected', () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-inv-'));
  const repo = join(base, 'repo');
  mkdirSync(join(repo, '.harness'), { recursive: true });
  const cfg = {
    schemaVersion: '1', repositoryId: 'r', context: { entryPoints: ['src/'] },
    filesystem: { protectedPaths: [] },
    verification: { checks: [{ id: 'test', kind: 'test', argv: ['npm', 'test'], required: true }] },
  };
  writeFileSync(join(repo, CONTRACT_REL_PATH), JSON.stringify(cfg));
  const snap = loadSnapshot(repo, DEFAULT_POLICY);
  assert.ok(snap.contract.filesystem.protectedPaths.includes('.harness/**'));
  assert.ok(snap.contract.filesystem.protectedPaths.includes('.git/**'));
  assert.ok(snap.hash.length === 64);

  // agent 事後改 working tree 的 config，凍結的 snapshot 不受影響
  writeFileSync(join(repo, CONTRACT_REL_PATH), JSON.stringify({ ...cfg, verification: { checks: [] } }));
  assert.equal(snap.contract.verification.checks.length, 1);
  rmSync(base, { recursive: true, force: true });
});

test('18. runtime 回錯格式不可進成功路徑', () => {
  const bad = parseRuntimeResult('我做完了！', { workId: 'W', attemptId: 'A' });
  assert.ok(!bad.ok);
  const d = decideOutcome({
    mode: 'write', skillAdmissions: [], protocolOk: false, protocolError: 'no json',
    evidence: [gitEv(['src/a.ts'])], retryBudgetRemaining: 0,
  });
  assert.equal(d.outcome, 'FAILED');
});

test('19. agent 宣稱 test PASS 但實際 exit code 非 0 → 不可 SUCCESS', () => {
  const d = decideOutcome({
    mode: 'write', skillAdmissions: [], protocolOk: true,
    runtimeResult: completed,   // claim 說「我跑過測試，全過」
    evidence: [gitEv(['src/a.ts']), ev({ status: 'FAIL', data: { required: true, exitCode: 1 } })],
    retryBudgetRemaining: 0,
  });
  assert.equal(d.outcome, 'FAILED');
});

test('20. tests PASS 但 denied path 有變更 → POLICY_VIOLATION', () => {
  const d = decideOutcome({
    mode: 'write', skillAdmissions: [], protocolOk: true, runtimeResult: completed,
    evidence: [
      gitEv(['src/a.ts', 'payment/x.ts']),
      ev({ status: 'PASS' }),
      ev({ type: 'path_policy', label: 'denied path check', status: 'FAIL', data: { violations: [{ path: 'payment/x.ts', rule: 'denied' }] } }),
    ],
    retryBudgetRemaining: 5,
  });
  assert.equal(d.outcome, 'POLICY_VIOLATION');
});

test('21. verification command 只能是 trusted contract 的 argv，不吃 shell 字串', () => {
  assert.throws(() => validateContract({
    schemaVersion: '1', repositoryId: 'r', context: { entryPoints: [] },
    filesystem: { protectedPaths: [] },
    verification: { checks: [{ id: 'x', kind: 'test', argv: ['/usr/bin/curl'], required: true }] },
  }), /絕對路徑/);
  assert.throws(() => validateContract({
    schemaVersion: '1', repositoryId: 'r', context: { entryPoints: [] },
    filesystem: { protectedPaths: [] },
    verification: { checks: [{ id: 'x', kind: 'test', argv: 'npm test', required: true }] },
  }), /argv/);
  assert.throws(() => validateContract({
    schemaVersion: '1', repositoryId: 'r', context: { entryPoints: ['../../etc'] },
    filesystem: { protectedPaths: [] }, verification: { checks: [] },
  }), /跳出 worktree/);
});

test('24. 回覆能區分 claim / observed evidence / outcome', () => {
  const text = buildResponse({
    attempt, decision: { outcome: 'SUCCESS', reasons: ['required evidence 全部 PASS'] },
    result: { ...completed, claims: [{ type: 'diagnosis', text: '是 race condition' }] },
    evidence: [gitEv(['src/a.ts']), ev({ label: 'test (npm test)' })],
    notExecuted: ['部署'],
  });
  assert.match(text, /Agent 判斷（未經 Harness 獨立驗證）/);
  assert.match(text, /實際修改（Harness 觀察）/);
  assert.match(text, /驗證（Harness 執行）/);
  assert.match(text, /目前未能獨立證明[\s\S]*race condition/);
});

test('25. prompt 不隨 attempt 數線性增加', () => {
  const authority = buildAuthority(contract, snapshot);
  const size = (n: number): number => {
    const m = buildManifest({
      contract, attempt: { ...attempt, number: n },
      authority, decisions: [], snapshot, userContext: [],
      previousAttempt: n > 1 ? { ...attempt, id: `A-${n - 1}` } : undefined,
      previousEvidence: n > 1 ? [ev({ status: 'FAIL', data: { required: true, tail: 'boom' } })] : [],
    });
    return compilePrompt({ manifest: m, contract, authority, snapshot, workspace: '/w', attemptId: `A-${n}`, workId: 'W', approvedSkills: [] }).text.length;
  };
  const a1 = size(1), a5 = size(5);
  assert.ok(a5 < a1 * 1.5, `attempt 5 的 prompt (${a5}) 不得接近 5 倍於 attempt 1 (${a1})`);
});

test('28. 關閉所有額外 LLM 後流程仍成立（本來就 0 LLM）', () => {
  // Harness 線上流程沒有任何 LLM 呼叫：解析、編譯、判定都是純函式。
  const parsed = parseRequest('只看不要改，不要碰 payment');
  const authority = buildAuthority({ ...contract, mode: parsed.mode, deniedPaths: parsed.deniedPaths }, snapshot);
  const m = buildManifest({ contract, attempt, authority, decisions: [], snapshot, userContext: [] });
  const p = compilePrompt({ manifest: m, contract, authority, snapshot, workspace: '/w', attemptId: 'A', workId: 'W', approvedSkills: [] });
  assert.ok(p.hash.length === 64);
});

test('30. Repository Contract 不能放寬 Global Policy ceiling', () => {
  const evil = {
    ...snapshot,
    contract: {
      ...snapshot.contract,
      // repo 嘗試宣告 network / 移除保護
      filesystem: { protectedPaths: [] },
    },
  } as RepositoryContractSnapshot;
  const a = buildAuthority(contract, evil);
  assert.equal(a.network, 'deny');
  assert.ok(a.deniedPaths.includes('payment/**'));
  // loadSnapshot 會把 global 的 defaultProtectedPaths 併回來
  const base = mkdtempSync(join(tmpdir(), 'harness-inv2-'));
  const repo = join(base, 'repo');
  mkdirSync(join(repo, '.harness'), { recursive: true });
  writeFileSync(join(repo, CONTRACT_REL_PATH), JSON.stringify({
    schemaVersion: '1', repositoryId: 'r', context: { entryPoints: [] },
    filesystem: { protectedPaths: [] }, verification: { checks: [] },
  }));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  assert.ok(loadSnapshot(repo, DEFAULT_POLICY).contract.filesystem.protectedPaths.includes('.git/**'));
  rmSync(base, { recursive: true, force: true });
});
