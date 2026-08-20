import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/trace/store.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import type { GlobalPolicy } from '../src/types.ts';

function repoFixture(base: string): string {
  const repo = join(base, 'repo');
  mkdirSync(join(repo, '.harness'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  writeFileSync(join(repo, '.harness/config.json'), JSON.stringify({
    schemaVersion: '1', repositoryId: 'fixture',
    context: { entryPoints: ['README.md'] },
    filesystem: { protectedPaths: ['secret/**'] },
    verification: { checks: [] },
  }));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });
  return repo;
}

function harness(): { base: string; store: Store; orch: Orchestrator; policy: GlobalPolicy; repo: string } {
  const base = mkdtempSync(join(tmpdir(), 'harness-orch-'));
  const policy: GlobalPolicy = { ...DEFAULT_POLICY, stateDir: join(base, 'state') };
  const store = new Store(policy.stateDir);
  return { base, store, orch: new Orchestrator(policy, store), policy, repo: repoFixture(base) };
}

test('createWork：原文保留、決策入帳、denied 進 contract', () => {
  const h = harness();
  const work = h.orch.createWork({ request: '修 token 過期問題，不要碰 payment，不要部署', workspace: h.repo });
  const c = h.store.getContract(work.id, 1)!;
  assert.equal(c.request, '修 token 過期問題，不要碰 payment，不要部署');
  assert.deepEqual(c.deniedPaths, ['payment/**']);
  assert.deepEqual(c.constraints, ['不要部署']);
  assert.equal(h.store.listDecisions(work.id).length, 2);
  h.store.close(); rmSync(h.base, { recursive: true, force: true });
});

test('answer：新增決策後產生新 contract 版本，既有 deny 不消失', () => {
  const h = harness();
  const work = h.orch.createWork({ request: '修登入問題，不要碰 payment', workspace: h.repo });
  h.orch.answer(work.id, '可以改 src/token');
  const w = h.store.getWork(work.id)!;
  assert.equal(w.currentContractVersion, 2);
  const c = h.store.getContract(work.id, 2)!;
  assert.deepEqual(c.deniedPaths, ['payment/**']);          // 擴權不移除既有 deny
  assert.equal(c.allowedPaths, undefined);                   // §20.1 / D-12
  assert.ok(h.store.listDecisions(work.id).some((d) => d.kind === 'allow_path' && d.value === 'src/token/**'));
  h.store.close(); rmSync(h.base, { recursive: true, force: true });
});

test('crash recovery：殘留 RUNNING → RECOVERY_REQUIRED，不 auto-rerun', () => {
  const h = harness();
  const work = h.orch.createWork({ request: '修東西', workspace: h.repo });
  h.store.insertAttempt({
    id: 'A-stuck', workId: work.id, number: 1, mode: 'write', contractVersion: 1,
    contractSnapshotHash: 'x', baseRevision: 'y', promptArtifactId: '', runtime: 'codex',
    status: 'RUNNING', startedAt: new Date().toISOString(),
  });
  const stuck = h.orch.markCrashedAttempts();
  assert.equal(stuck.length, 1);
  assert.equal(h.store.getAttempt('A-stuck')!.status, 'RECOVERY_REQUIRED');
  assert.equal(h.store.getWork(work.id)!.state, 'BLOCKED');
  assert.ok(h.store.events(work.id).some((e) => e.type === 'recovery.required'));
  h.store.close(); rmSync(h.base, { recursive: true, force: true });
});

test('沒有 .harness/config.json → 不建立 work（REPOSITORY_NOT_INITIALIZED）', () => {
  const h = harness();
  assert.throws(() => h.orch.createWork({ request: 'x', workspace: h.base }), /REPOSITORY_NOT_INITIALIZED|找不到/);
  h.store.close(); rmSync(h.base, { recursive: true, force: true });
});

test('trace 記錄關鍵事件', () => {
  const h = harness();
  const work = h.orch.createWork({ request: '修東西，不要碰 secret', workspace: h.repo });
  const types = h.store.events(work.id).map((e) => e.type);
  assert.ok(types.includes('work.created'));
  assert.ok(types.includes('work_contract.versioned'));
  assert.ok(types.includes('decision.recorded'));
  h.store.close(); rmSync(h.base, { recursive: true, force: true });
});
