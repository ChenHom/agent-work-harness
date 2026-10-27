import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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

test('H2：git evidence 不採用共用 verification HOME 的全域設定，也不執行 repo 設定的 fsmonitor', { skip }, async () => {
  const r = repo();
  const home = mkdtempSync(join(tmpdir(), 'harness-git-home-'));
  const policy = { ...DEFAULT_POLICY, verificationHome: home };
  // 之前某個 check 寫進共用 HOME 的設定：把新檔排除在 git status 與 git add -A 之外
  writeFileSync(join(home, 'ignore'), 'new.txt\n');
  writeFileSync(join(home, '.gitconfig'), `[core]\n\texcludesFile = ${join(home, 'ignore')}\n`);
  // agent 可寫的 .git/config：fsmonitor 是一支會被 git status 執行的程式
  writeFileSync(join(home, 'fsmonitor.sh'), `#!/bin/sh\necho ran >> ${join(home, 'fsmonitor-ran')}\nexit 1\n`, { mode: 0o755 });
  execFileSync('git', ['config', 'core.fsmonitor', join(home, 'fsmonitor.sh')], { cwd: r });

  const base = await baseRevision(policy, r);
  writeFileSync(join(r, 'new.txt'), 'untracked\n');
  writeFileSync(join(r, 'src/a.ts'), 'export const a = 2;\n');
  const dirty = await snapshotDirty(policy, r);
  const obs = await observeGit(policy, r, base, []);
  assert.deepEqual(dirty.map((d) => d.path).sort(), ['new.txt', 'src/a.ts']);
  assert.deepEqual(obs.changedPaths, ['new.txt', 'src/a.ts']);
  assert.deepEqual(obs.probeErrors, []);
  assert.equal(existsSync(join(home, 'fsmonitor-ran')), false, 'Harness 的 git 不得執行 core.fsmonitor');

  const neutral = ['-c', 'core.excludesFile=/dev/null', '-c', 'core.fsmonitor=false'];
  execFileSync('git', [...neutral, 'add', '-A'], { cwd: r });
  execFileSync('git', [...neutral, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'human'], { cwd: r });
  assert.equal(obs.resultTree, execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: r, encoding: 'utf8' }).trim(),
    'resultTree 必須含 new.txt');
  rmSync(join(r, '..'), { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('L3：dirty 快照本身失敗時留下標記（不是空清單），讓 review fail closed', { skip }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-git-nonrepo-'));
  const dirty = await snapshotDirty(DEFAULT_POLICY, base);
  assert.equal(dirty.length, 1);
  assert.deepEqual([dirty[0]?.path, dirty[0]?.hash], ['', null]);
  assert.match(dirty[0]?.error ?? '', /^git status: exit 128/);
  rmSync(base, { recursive: true, force: true });
});

test('H2：agent 用 replace ref 把自己的 commit 換成 base，git evidence 仍看得到被 commit 的變更', { skip }, async () => {
  const r = repo();
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: r, encoding: 'utf8' }).trim();
  const base = await baseRevision(DEFAULT_POLICY, r);
  mkdirSync(join(r, 'secret'));
  writeFileSync(join(r, 'secret/key.txt'), 'k\n');
  git('add', '-A');
  git('commit', '-qm', 'agent commit');
  const head = git('rev-parse', 'HEAD');
  // HEAD 換成 base；index 與工作樹也回到 base。採用 replace refs 時 git status 與 base..HEAD 都是空的
  git('replace', head, base);
  git('read-tree', 'HEAD');
  rmSync(join(r, 'secret'), { recursive: true });
  assert.equal(git('status', '--porcelain'), '', '採用 replace refs 的 git 看不到這個 commit');

  const obs = await observeGit(DEFAULT_POLICY, r, base, []);
  assert.equal(obs.head, head);
  assert.deepEqual(obs.changedPaths, ['secret/key.txt']);
  assert.deepEqual(obs.probeErrors, []);
  rmSync(join(r, '..'), { recursive: true, force: true });
});
