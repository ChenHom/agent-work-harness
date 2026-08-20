import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesGlob, checkPaths } from '../src/repo/paths.ts';

test('** 跨層、* 單層', () => {
  assert.ok(matchesGlob('payment/api/x.ts', 'payment/**'));
  assert.ok(matchesGlob('payment/x.ts', 'payment/**'));
  assert.ok(matchesGlob('payment', 'payment/**'));
  assert.ok(!matchesGlob('payments/x.ts', 'payment/**'));
  assert.ok(matchesGlob('src/a.ts', 'src/*.ts'));
  assert.ok(!matchesGlob('src/deep/a.ts', 'src/*.ts'));
  assert.ok(matchesGlob('.git/config', '.git/**'));
  assert.ok(matchesGlob('.harness/config.json', '.harness/**'));
});

test('deny 優先於 allow', () => {
  const v = checkPaths(['payment/x.ts', 'src/auth/a.ts', 'other/b.ts'], {
    deniedPaths: ['payment/**'],
    allowedPaths: ['src/auth/**'],
  });
  assert.deepEqual(v.map((x) => [x.path, x.rule]), [
    ['payment/x.ts', 'denied'],
    ['other/b.ts', 'outside_allowed'],
  ]);
});

test('沒有 allowedPaths 時整個 worktree 可寫（§20.1）', () => {
  const v = checkPaths(['anything/deep/x.ts'], { deniedPaths: ['.git/**'] });
  assert.deepEqual(v, []);
});

test('看不懂的 pattern 不亂匹配', () => {
  assert.ok(!matchesGlob('src/a.ts', 'src/a.ts/'));
  assert.ok(!matchesGlob('src/a.ts', ''));
});
