// resultTree：Attempt 結束時的工作樹內容（含 untracked、binary、mode、symlink、刪除），
// 必須等於人 `git add -A && git commit` 得到的 tree，而且計算過程不得寫入使用者 repo。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { skipWithoutSandbox as skip } from './sandbox-probe.ts';
import { baseRevision, gitDiffEvidence, observeGit } from '../src/evidence/git.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' }).trim();

function repo(): string {
  const base = mkdtempSync(join(tmpdir(), 'harness-result-tree-'));
  const r = join(base, 'repo');
  execFileSync('git', ['init', '-q', r]);
  writeFileSync(join(r, '.gitignore'), '*.log\n');
  writeFileSync(join(r, 'a.txt'), 'a\n');
  writeFileSync(join(r, 'run.sh'), 'echo hi\n');
  writeFileSync(join(r, 'gone.txt'), 'bye\n');
  writeFileSync(join(r, 'kept.log'), 'tracked although ignored\n');
  writeFileSync(join(r, 'hidden.txt'), 'skip-worktree before\n');
  git(r, 'add', '-A');
  git(r, 'add', '-f', 'kept.log');
  git(r, 'commit', '-qm', 'init');
  return r;
}

/** 使用者 repo 的可觀察狀態：object 數、index 位元組、status、refs。 */
function repoState(r: string): Record<string, string> {
  return {
    objects: git(r, 'count-objects', '-v'),
    index: createHash('sha256').update(readFileSync(join(r, '.git/index'))).digest('hex'),
    status: git(r, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'),
    refs: git(r, 'for-each-ref'),
    head: git(r, 'rev-parse', 'HEAD'),
  };
}

test('resultTree 等於人 git add -A && git commit 的 tree，且不寫入使用者 repo', { skip }, async () => {
  const r = repo();
  const base = await baseRevision(DEFAULT_POLICY, r);
  writeFileSync(join(r, 'a.txt'), 'a changed\n');                       // 修改
  writeFileSync(join(r, 'new.txt'), 'untracked\n');                     // untracked
  writeFileSync(join(r, 'blob.bin'), Buffer.from([0, 1, 2, 255, 0, 10])); // binary
  chmodSync(join(r, 'run.sh'), 0o755);                                  // mode
  symlinkSync('a.txt', join(r, 'link'));                                // symlink
  rmSync(join(r, 'gone.txt'));                                          // 刪除
  writeFileSync(join(r, 'kept.log'), 'tracked and changed\n');          // 已追蹤但符合 ignore
  writeFileSync(join(r, 'other.log'), 'ignored, never committed\n');    // ignore：不得進 tree

  const before = repoState(r);
  const obs = await observeGit(DEFAULT_POLICY, r, base, []);
  assert.deepEqual(repoState(r), before, 'resultTree 的計算不得改變使用者 repo');
  assert.deepEqual(obs.probeErrors, []);
  assert.match(obs.resultTree ?? '', /^[0-9a-f]{40}$/);

  git(r, 'add', '-A');
  git(r, 'commit', '-qm', 'human commit');
  assert.equal(obs.resultTree, git(r, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(git(r, 'ls-tree', 'HEAD', 'other.log'), '', 'ignored 檔不屬於 candidate');
  assert.match(git(r, 'ls-tree', 'HEAD', 'run.sh'), /^100755 /);
  assert.match(git(r, 'ls-tree', 'HEAD', 'link'), /^120000 /);

  const evidence = gitDiffEvidence('W', 'A', obs, 'AR-diff');
  assert.equal((evidence.data as { resultTree?: string }).resultTree, obs.resultTree);
  assert.equal(evidence.status, 'PASS');
  rmSync(join(r, '..'), { recursive: true, force: true });
});

test('skip-worktree 隱藏的修改仍算進 resultTree', { skip }, async () => {
  const r = repo();
  const base = await baseRevision(DEFAULT_POLICY, r);
  const baseTree = git(r, 'rev-parse', 'HEAD^{tree}');
  git(r, 'update-index', '--skip-worktree', 'hidden.txt');
  writeFileSync(join(r, 'hidden.txt'), 'skip-worktree after\n');

  const obs = await observeGit(DEFAULT_POLICY, r, base, []);
  assert.deepEqual(obs.changedPaths, [], 'git status 看不到 skip-worktree 的修改 —— 這正是 resultTree 要補的洞');
  assert.notEqual(obs.resultTree, baseTree);

  git(r, 'update-index', '--no-skip-worktree', 'hidden.txt');
  git(r, 'add', '-A');
  git(r, 'commit', '-qm', 'human commit');
  assert.equal(obs.resultTree, git(r, 'rev-parse', 'HEAD^{tree}'));
  rmSync(join(r, '..'), { recursive: true, force: true });
});

test('resultTree 算不出來時不寫入 evidence，並留下 probe error', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-result-tree-nonrepo-'));
  const obs = await observeGit(DEFAULT_POLICY, dir, 'UNKNOWN', []);
  assert.equal(obs.resultTree, undefined);
  assert.ok(obs.probeErrors?.some((error) => error.startsWith('git write-tree:')), (obs.probeErrors ?? []).join(' / '));
  const evidence = gitDiffEvidence('W', 'A', obs, 'AR-diff');
  assert.equal('resultTree' in (evidence.data as object), false);
  assert.equal(evidence.status, 'INCONCLUSIVE');
  rmSync(dir, { recursive: true, force: true });
});
