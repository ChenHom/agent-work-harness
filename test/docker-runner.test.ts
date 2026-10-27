// Docker runner：離線、唯讀、以 image ID 執行、有 deadline；不需要真的 Docker（PATH 上的 stub）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareReviewer, runReviewer, type PreparedReviewer } from '../src/review/docker-runner.ts';
import { installDockerStub, STUB_IMAGE_ID, STUB_REVISION } from './helpers/docker-stub.ts';

const base = mkdtempSync(join(tmpdir(), 'harness-docker-runner-'));
const stub = installDockerStub(join(base, 'bin'));
process.env.ANTHROPIC_API_KEY = 'test-secret';
const user = { uid: 1000, gid: 1000 };
const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);

function dirs(name: string): { repoDir: string; outputDir: string } {
  const root = join(base, name);
  mkdirSync(join(root, 'repo'), { recursive: true });
  mkdirSync(join(root, 'output'), { recursive: true });
  return { repoDir: join(root, 'repo'), outputDir: join(root, 'output') };
}

async function prepared(): Promise<PreparedReviewer> {
  stub.configure({ inspect: 'ok' });
  const result = await prepareReviewer('reviewer:test', user);
  assert.ok(result.ok, result.ok ? '' : result.detail);
  return result.value;
}

test('prepare：以 inspect 取得 image ID 與 revision label', async () => {
  stub.reset();
  const reviewer = await prepared();
  assert.deepEqual(reviewer, { imageId: STUB_IMAGE_ID, revision: STUB_REVISION, user });
  const [call] = stub.calls();
  assert.deepEqual(call?.argv, ['image', 'inspect', '--format',
    '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}', 'reviewer:test']);
});

test('prepare：未設定 image、uid 0、image 不存在、沒有 revision label 都是 REVIEW_RUNNER_FAILED', async () => {
  stub.reset();
  const unset = await prepareReviewer(undefined, user);
  assert.deepEqual(unset.ok ? null : [unset.code, /reviewerImage/.test(unset.detail)], ['REVIEW_RUNNER_FAILED', true]);
  const root = await prepareReviewer('reviewer:test', { uid: 0, gid: 0 });
  assert.deepEqual(root.ok ? null : [root.code, /uid 0/.test(root.detail)], ['REVIEW_RUNNER_FAILED', true]);
  const unknownUser = await prepareReviewer('reviewer:test', undefined);
  assert.equal(unknownUser.ok ? null : unknownUser.code, 'REVIEW_RUNNER_FAILED');
  assert.deepEqual(stub.calls(), [], '前三種情況不得呼叫 docker');

  stub.configure({ inspect: 'fail' });
  const missing = await prepareReviewer('reviewer:test', user);
  assert.deepEqual(missing.ok ? null : [missing.code, /No such image/.test(missing.detail)], ['REVIEW_RUNNER_FAILED', true]);
  stub.configure({ inspect: 'no-label' });
  const noLabel = await prepareReviewer('reviewer:test', user);
  assert.deepEqual(noLabel.ok ? null : [noLabel.code, /revision label/.test(noLabel.detail)], ['REVIEW_RUNNER_FAILED', true]);
});

test('run：argv 離線、唯讀、以 image ID 執行，不傳 ANTHROPIC 也不加 --ai', async () => {
  const reviewer = await prepared();
  stub.reset();
  stub.configure({ run: 'report', reportText: '{}' });
  const { repoDir, outputDir } = dirs('argv');
  const result = await runReviewer(reviewer, { repoDir, outputDir, baseRevision: BASE, candidate: HEAD, timeoutMs: 10_000 });
  assert.ok(result.ok, result.ok ? '' : result.detail);

  const calls = stub.calls();
  assert.equal(calls.length, 1);
  const { argv, envKeys } = calls[0]!;
  const name = argv[argv.indexOf('--name') + 1]!;
  assert.match(name, /^harness-review-[0-9a-f]+$/);
  assert.deepEqual(argv, [
    'run', '--rm', '--name', name, '--network', 'none', '--read-only', '--pull', 'never',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000',
    '--tmpfs', '/tmp:rw,nosuid,size=256m',
    '-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory', '-e', 'GIT_CONFIG_VALUE_0=/target',
    '-v', `${repoDir}:/target:ro`, '-v', `${outputDir}:/output:rw`,
    STUB_IMAGE_ID, 'node', 'bin/review.js', '--repo', '/target', '--base', BASE, '--head', HEAD,
    '--out', '/output/report.json',
  ]);
  assert.ok(!argv.some((arg) => /ANTHROPIC|test-secret|--ai/.test(arg)));
  assert.ok(!argv.includes('reviewer:test'), '執行時不得用 tag');
  assert.ok(!envKeys.some((key) => key.startsWith('ANTHROPIC')), `docker CLI 收到 ${envKeys.join(',')}`);
});

test('run：container exit 非 0 → REVIEW_RUNNER_FAILED，附 stderr 結尾', async () => {
  const reviewer = await prepared();
  stub.configure({ run: 'exit', exitCode: 2, stderr: 'line 1\nerror: OPTION_MISSING:--base\n' });
  const { repoDir, outputDir } = dirs('exit');
  const result = await runReviewer(reviewer, { repoDir, outputDir, baseRevision: BASE, candidate: HEAD, timeoutMs: 10_000 });
  assert.equal(result.ok ? null : result.code, 'REVIEW_RUNNER_FAILED');
  assert.match(result.ok ? '' : result.detail, /exit 2.*OPTION_MISSING:--base/s);
});

test('run：超過 deadline 以 docker kill 終止 → REVIEW_TIMEOUT', async () => {
  const reviewer = await prepared();
  stub.reset();
  stub.configure({ run: 'hang' });
  const { repoDir, outputDir } = dirs('timeout');
  const started = Date.now();
  const result = await runReviewer(reviewer, { repoDir, outputDir, baseRevision: BASE, candidate: HEAD, timeoutMs: 300 });
  assert.equal(result.ok ? null : result.code, 'REVIEW_TIMEOUT');
  assert.ok(Date.now() - started < 20_000);
  const [run, kill] = stub.calls();
  const name = run!.argv[run!.argv.indexOf('--name') + 1];
  assert.deepEqual(kill?.argv, ['kill', name]);
});

test('run：掛載路徑含 : 或換行時拒絕執行，不呼叫 docker', async () => {
  const reviewer = await prepared();
  stub.reset();
  for (const bad of ['/tmp/a:b', '/tmp/a\nb']) {
    const result = await runReviewer(reviewer, {
      repoDir: bad, outputDir: '/tmp/out', baseRevision: BASE, candidate: HEAD, timeoutMs: 1_000,
    });
    assert.equal(result.ok ? null : result.code, 'REVIEW_RUNNER_FAILED');
  }
  assert.deepEqual(stub.calls(), []);
});
