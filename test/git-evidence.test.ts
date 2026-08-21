import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runIsolated } from '../src/evidence/exec.ts';
import { snapshotDirty, observeGit, baseRevision, pathPolicyEvidence } from '../src/evidence/git.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';

/**
 * verification 本身就跑在 bwrap 裡（§20.3），而這些測試會再開一層 bwrap。
 * 巢狀 sandbox 建不起來，所以在隔離環境中要明確跳過，不是靜默失敗。
 * dogfood 第一輪時這件事讓五個 write work 全部誤判成測試失敗。
 * probe 走的是與測試完全相同的執行路徑，才不會像第一版那樣漏判。
 */
const probe = await runIsolated(DEFAULT_POLICY, ['git', '--version'], { workspace: tmpdir(), timeoutMs: 20_000 });
const skip = probe.exitCode === 0 ? false : '隔離執行不可用（多半是巢狀 bwrap），本測試需要未隔離的環境';

function repo(): string {
  const base = mkdtempSync(join(tmpdir(), 'harness-git-'));
  const r = join(base, 'repo');
  mkdirSync(join(r, 'src'), { recursive: true });
  writeFileSync(join(r, 'src/a.ts'), 'export const a = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: r });
  execFileSync('git', ['add', '-A'], { cwd: r });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: r });
  return r;
}

test('attempt 前就存在的未提交變更不算 agent 的變更', { skip }, async () => {
  const r = repo();
  // attempt 之前就髒（例如使用者剛跑過 harness init）
  writeFileSync(join(r, 'preexisting.json'), '{}\n');
  const dirty = await snapshotDirty(DEFAULT_POLICY, r);
  assert.deepEqual(dirty.map((d) => d.path), ['preexisting.json']);

  const base = await baseRevision(DEFAULT_POLICY, r);
  // agent 改了別的檔案
  writeFileSync(join(r, 'src/a.ts'), 'export const a = 2;\n');
  const obs = await observeGit(DEFAULT_POLICY, r, base, dirty);
  assert.deepEqual(obs.changedPaths, ['src/a.ts']);
  assert.deepEqual(obs.preExistingUnchanged, ['preexisting.json']);

  // 沒有這個扣除，preexisting.json 會被誤判成越界
  const policy = { deniedPaths: ['*.json'] };
  assert.deepEqual(pathPolicyEvidence('W', 'A', obs.changedPaths, policy).status, 'PASS');
  rmSync(join(r, '..'), { recursive: true, force: true });
});

test('agent 若動了本來就髒的檔案，仍算這次的變更', { skip }, async () => {
  const r = repo();
  writeFileSync(join(r, 'preexisting.json'), '{}\n');
  const dirty = await snapshotDirty(DEFAULT_POLICY, r);
  const base = await baseRevision(DEFAULT_POLICY, r);

  writeFileSync(join(r, 'preexisting.json'), '{"agent":"was here"}\n');   // 內容 hash 變了
  const obs = await observeGit(DEFAULT_POLICY, r, base, dirty);
  assert.deepEqual(obs.changedPaths, ['preexisting.json']);
  assert.deepEqual(obs.preExistingUnchanged, []);
  rmSync(join(r, '..'), { recursive: true, force: true });
});

test('乾淨 worktree 下觀察不到變更', { skip }, async () => {
  const r = repo();
  const base = await baseRevision(DEFAULT_POLICY, r);
  const obs = await observeGit(DEFAULT_POLICY, r, base, []);
  assert.ok(obs.clean);
  assert.deepEqual(obs.changedPaths, []);
  rmSync(join(r, '..'), { recursive: true, force: true });
});
