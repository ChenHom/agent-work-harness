import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { skipWithoutSandbox as skip } from './sandbox-probe.ts';
import { snapshotDirty, observeGit, baseRevision, pathPolicyEvidence } from '../src/evidence/git.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';

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

test('非 Git workspace 的觀測失敗必須留下 probe error', { skip }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-git-nonrepo-'));
  const obs = await observeGit(DEFAULT_POLICY, base, 'UNKNOWN', []);
  assert.ok(obs.probeErrors?.length, 'git probe 失敗不可被當成空結果');
  rmSync(base, { recursive: true, force: true });
});

test('git diff 觀測不受 repository textconv 影響', { skip }, async () => {
  const r = repo();
  writeFileSync(join(r, '.gitattributes'), 'src/constant.txt diff=constant\n');
  writeFileSync(join(r, 'src/constant.txt'), 'before\n');
  execFileSync('git', ['add', '-A'], { cwd: r });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'attributes'], { cwd: r });
  execFileSync('git', ['config', 'diff.constant.textconv', 'printf constant'], { cwd: r });

  const base = await baseRevision(DEFAULT_POLICY, r);
  writeFileSync(join(r, 'src/constant.txt'), 'after\n');
  const obs = await observeGit(DEFAULT_POLICY, r, base, []);

  assert.match(obs.diff, /-before/);
  assert.match(obs.diff, /\+after/);
  rmSync(join(r, '..'), { recursive: true, force: true });
});
