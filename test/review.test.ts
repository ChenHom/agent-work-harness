// `harness review` 端到端（不含真的 Docker）：Attempt 由 fake driver 產生、evidence 與 verification
// 走真實 bwrap，Reviewer 由 PATH 上的 stub docker 扮演。每個錯誤代碼對應一個 exit code，
// 而且任何失敗都不得保存成功結果（M1 規格 §2～§6）。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { Orchestrator, type RuntimeDriver } from '../src/orchestrator.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { CONTRACT_REL_PATH } from '../src/repo/contract.ts';
import type { ReviewEnvelope } from '../src/review/report.ts';
import { Store } from '../src/trace/store.ts';
import type { GlobalPolicy, Outcome } from '../src/types.ts';
import { installDockerStub, STUB_IMAGE_ID, STUB_REVISION } from './helpers/docker-stub.ts';
import { reviewerReport, reviewerReportFor, type ReportKind } from './helpers/review.ts';
import { skipWithoutSandbox as skip } from './sandbox-probe.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'harness-review-'));
const docker = installDockerStub(join(ROOT, 'bin'));
process.env.ANTHROPIC_API_KEY = 'test-secret';
after(() => rmSync(ROOT, { recursive: true, force: true }));

const CHECK = { id: 'content', kind: 'test', argv: ['sh', '-c', 'grep -q ok src/a.txt'], required: true };
const SHA = /^[0-9a-f]{40}$/;

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' }).trim();

const reportText = (kind: ReportKind): string => JSON.stringify(reviewerReport(kind, { base: '__BASE__', head: '__HEAD__' }));

interface Case {
  policy: GlobalPolicy;
  repo: string;
  workId: string;
  attemptId: string;
  outcome: Outcome;
  base: string;
}

let caseSeq = 0;

/** 建 fixture repo，以 fake driver 跑一次 Attempt（evidence 與 verification 是真的）。 */
async function attempt(opts: {
  checks?: unknown[];
  files?: Record<string, string>;
  beforeAttempt?: (repo: string) => void;
  agent?: (repo: string) => void;
  status?: 'completed' | 'blocked';
  /** 共用的 Harness state dir（例如兩件 Work 共用同一個 verification HOME）。 */
  state?: string;
  /** `git init` 的額外參數（例如 --object-format=sha256）。 */
  init?: string[];
} = {}): Promise<Case> {
  const root = join(ROOT, `case-${++caseSeq}`);
  const repo = join(root, 'repo');
  const files: Record<string, string> = {
    'README.md': '# fixture\n',
    'src/a.txt': 'base\n',
    [CONTRACT_REL_PATH]: JSON.stringify({
      schemaVersion: '1', repositoryId: 'fixture',
      context: { entryPoints: ['README.md'] },
      filesystem: { protectedPaths: ['secret/**'] },
      verification: { checks: opts.checks ?? [CHECK] },
    }),
    ...opts.files,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, 'init', '-q', ...opts.init ?? []);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  opts.beforeAttempt?.(repo);

  const state = opts.state ?? join(root, 'state');
  const policy: GlobalPolicy = {
    ...DEFAULT_POLICY, stateDir: state,
    agentHome: join(state, 'agent-home'), codexHome: join(state, 'codex-home'),
    verificationHome: join(state, 'verification-home'), skillsDir: join(state, 'skills'),
    reviewerImage: 'reviewer:test', reviewTimeoutMs: 10_000,
  };
  const store = new Store(state);
  const ids = { workId: '' };
  const agent = opts.agent ?? ((dir: string) => {
    writeFileSync(join(dir, 'src/a.txt'), 'ok\n');
    writeFileSync(join(dir, 'src/new.txt'), 'new\n');
  });
  const driver: RuntimeDriver = {
    prepare: (input) => ({ attemptId: input.attemptId }) as never,
    async run(run, onState) {
      const attemptId = (run as unknown as { attemptId: string }).attemptId;
      agent(repo);
      const child = { pid: process.pid, processStart: 'fixture' };
      onState?.({ phase: 'running', child, quiesced: false });
      onState?.({ phase: 'stopped', child, quiesced: true });
      return {
        exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1,
        lastMessage: JSON.stringify({
          schemaVersion: '1', workId: ids.workId, attemptId, status: opts.status ?? 'completed',
          summary: 'done', claims: [], questions: [], declaredChangedPaths: [],
        }),
      };
    },
  };
  try {
    const orch = new Orchestrator(policy, store, () => {}, { driver });
    const work = orch.createWork({ request: '修一個 bug', workspace: repo });
    ids.workId = work.id;
    const report = await orch.runAttempt(work.id, { noBaseline: true });
    return {
      policy, repo, workId: work.id, attemptId: report.attempt.id,
      outcome: report.decision.outcome, base: report.attempt.baseRevision,
    };
  } finally {
    store.close();
  }
}

const commit = (repo: string): string => { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'human'); return git(repo, 'rev-parse', 'HEAD'); };

async function cli(policy: GlobalPolicy, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const original = { log: console.log, error: console.error, write: process.stderr.write.bind(process.stderr) };
  console.log = (...values: unknown[]) => { out.push(values.join(' ')); };
  console.error = (...values: unknown[]) => { err.push(values.join(' ')); };
  process.stderr.write = (chunk: string | Uint8Array) => { err.push(String(chunk)); return true; };
  try {
    return { code: await main(args, policy), stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    console.log = original.log;
    console.error = original.error;
    process.stderr.write = original.write;
  }
}

const review = (c: Case, head: string, extra: string[] = [], policy = c.policy) =>
  cli(policy, ['review', c.workId, '--attempt', c.attemptId, '--head', head, ...extra]);

function withStore<T>(c: Case, read: (store: Store) => T): T {
  const store = new Store(c.policy.stateDir, { readOnly: true });
  try { return read(store); } finally { store.close(); }
}

const reviewEvents = (c: Case, type: string) => withStore(c, (store) => store.events(c.workId)
  .filter((event) => event.type === type).map((event) => JSON.parse(event.data) as Record<string, string>));
const reviewArtifacts = (c: Case) => withStore(c, (store) => (store.db.prepare(
  "select kind from artifacts where kind like 'review_%' order by kind").all() as Array<{ kind: string }>).map((row) => row.kind));
const reviewWork = (c: Case): string[] => {
  const dir = join(c.policy.stateDir, 'review-work');
  return existsSync(dir) ? readdirSync(dir) : [];
};

/** 使用者 repo 的可觀察狀態：Harness 不得改 index、refs、工作樹或 object DB。 */
function repoState(repo: string): Record<string, string> {
  return {
    objects: git(repo, 'count-objects', '-v'),
    index: createHash('sha256').update(readFileSync(join(repo, '.git/index'))).digest('hex'),
    status: git(repo, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'),
    refs: git(repo, 'for-each-ref'),
    head: git(repo, 'rev-parse', 'HEAD'),
  };
}

/** 失敗時：stderr 帶 code、沒有成功結果、暫存目錄已清掉、留下 review.failed。 */
function assertFailed(c: Case, result: { code: number; stderr: string }, exitCode: 1 | 2 | 3, code: string): void {
  assert.equal(result.code, exitCode, result.stderr);
  const prefix = exitCode === 2 ? `BLOCKED ${code}: ` : `${code}: `;
  assert.ok(result.stderr.split('\n').some((line) => line.startsWith(prefix)), result.stderr);
  assert.deepEqual(reviewEvents(c, 'review.completed'), []);
  assert.deepEqual(reviewArtifacts(c), []);
  assert.deepEqual(reviewWork(c), []);
  assert.equal(reviewEvents(c, 'review.failed').at(-1)?.code, code);
}

let committed: Promise<Case & { head: string }> | undefined;
/** 共用：一個已由人 commit 的 SUCCESS Attempt。只給不會保存成功結果的測試用。 */
function committedCase(): Promise<Case & { head: string }> {
  committed ??= attempt().then((c) => ({ ...c, head: commit(c.repo) }));
  return committed;
}

// ---------------------------------------------------------------- 成功路徑

let reviewed: (Case & { head: string; envelopeSha256: string; reportSha256: string }) | undefined;

test('exit 5：有人工待辦；envelope 綁定 attempt、candidate 與 image ID，使用者 repo 不變', { skip }, async () => {
  const c = await attempt();
  assert.equal(c.outcome, 'SUCCESS');
  const head = commit(c.repo);
  const resultTree = git(c.repo, 'rev-parse', 'HEAD^{tree}');
  docker.reset();
  docker.configure({ run: 'report', reportText: reportText('human') });
  const before = repoState(c.repo);
  const attemptRow = withStore(c, (store) => JSON.stringify([store.getAttempt(c.attemptId), store.attemptOutcomes(c.attemptId)]));

  const result = await review(c, head, ['--json']);
  assert.equal(result.code, 5, result.stderr);
  assert.deepEqual(repoState(c.repo), before, 'review 不得改變使用者 repo');
  assert.equal(withStore(c, (store) => JSON.stringify([store.getAttempt(c.attemptId), store.attemptOutcomes(c.attemptId)])),
    attemptRow, '不得改寫既有 Attempt 與 outcome');

  const envelope = JSON.parse(result.stdout) as ReviewEnvelope;
  assert.equal(envelope.schemaVersion, 1);
  assert.deepEqual(
    [envelope.workId, envelope.attemptId, envelope.contractVersion, envelope.workspace],
    [c.workId, c.attemptId, 1, c.repo]);
  assert.deepEqual([envelope.baseRevision, envelope.candidate, envelope.mergeBase, envelope.resultTree],
    [c.base, head, c.base, resultTree]);
  assert.deepEqual(envelope.reviewer, { imageId: STUB_IMAGE_ID, revision: STUB_REVISION });
  assert.equal(envelope.status, 'HUMAN_REVIEW_REQUIRED');
  assert.deepEqual(envelope.humanReview, [{ path: 'src/a.txt', reasons: ['PUBLIC_API_CHANGED'] }]);
  assert.deepEqual(envelope.notSelected, [{ path: 'src/new.txt', reasons: [] }]);
  assert.match(envelope.limitations[0] ?? '', /^DEV-01: /);
  assert.equal(envelope.verification.revision, head);
  assert.equal(envelope.verification.changedPaths, 2);
  assert.deepEqual(envelope.verification.checks.map((check) => [check.checkId, check.required, check.status]),
    [['content', true, 'PASS']]);

  // stub docker 收到的 argv：離線、候選副本唯讀、以 image ID 執行、沒有任何 ANTHROPIC
  const calls = docker.calls();
  assert.deepEqual(calls.map((call) => call.argv[0]), ['image', 'run']);
  const run = calls[1]!.argv;
  assert.equal(run[run.indexOf('--network') + 1], 'none');
  const target = run.find((arg, index) => run[index - 1] === '--mount' && arg.endsWith(',dst=/target,readonly'));
  assert.match(target ?? '', new RegExp(`^type=bind,src=${join(c.policy.stateDir, 'review-work')}/[0-9a-f-]+/repo,dst=/target,readonly$`));
  assert.equal(run[run.indexOf('node') - 1], STUB_IMAGE_ID);
  assert.ok(!run.includes('reviewer:test'));
  assert.deepEqual(run.slice(run.indexOf('--base')), ['--base', c.base, '--head', head, '--out', '/output/report.json']);
  for (const call of calls) {
    assert.ok(!call.argv.some((arg) => /ANTHROPIC|test-secret|--ai/.test(arg)));
    assert.ok(!call.envKeys.some((key) => key.startsWith('ANTHROPIC')));
  }
  assert.deepEqual(reviewWork(c), [], '暫存目錄一律清掉');

  const [event] = reviewEvents(c, 'review.completed');
  assert.ok(event);
  assert.deepEqual([event.attemptId, event.candidate, event.status], [c.attemptId, head, 'HUMAN_REVIEW_REQUIRED']);
  assert.equal(event.envelopeSha256, createHash('sha256').update(result.stdout).digest('hex'), '--json 印出的就是保存的 envelope');
  assert.equal(event.reportSha256, envelope.rawReport.sha256);
  assert.equal(event.reportArtifactId, envelope.rawReport.artifactId);
  assert.deepEqual(reviewArtifacts(c), ['review_envelope', 'review_report']);
  reviewed = { ...c, head, envelopeSha256: event.envelopeSha256, reportSha256: event.reportSha256 };
});

test('show：顯示 review 的 status、candidate、兩個 sha256、reviewer 與待辦／未選入清單', { skip }, async () => {
  assert.ok(reviewed);
  const shown = await cli(reviewed.policy, ['show', reviewed.workId]);
  assert.equal(shown.code, 0, shown.stderr);
  const block = shown.stdout.slice(shown.stdout.indexOf('[review]'));
  assert.match(block, /^\[review\]\nstatus: HUMAN_REVIEW_REQUIRED$/m);
  assert.match(block, new RegExp(`^candidate: ${reviewed.head}  attempt: ${reviewed.attemptId}$`, 'm'));
  assert.match(block, new RegExp(`^envelope sha256: ${reviewed.envelopeSha256}$`, 'm'));
  assert.match(block, new RegExp(`^report sha256: ${reviewed.reportSha256}$`, 'm'));
  assert.match(block, new RegExp(`^reviewer: ${STUB_IMAGE_ID} revision=${STUB_REVISION}$`, 'm'));
  assert.match(block, /^人工待辦（Reviewer 選入）:\n- src\/a\.txt: PUBLIC_API_CHANGED$/m);
  assert.match(block, /^機械審查未選入，fact layer 尚未接入（DEV-01）；不代表已驗證安全:\n- src\/new\.txt$/m);
});

test('show：envelope 被竄改、報表被刪除 → REVIEW_ARTIFACT_INVALID，不顯示成成功', { skip }, async () => {
  assert.ok(reviewed);
  const paths = withStore(reviewed, (store) => Object.fromEntries((store.db.prepare(
    "select kind, path from artifacts where kind like 'review_%'").all() as Array<{ kind: string; path: string }>)
    .map((row) => [row.kind, row.path])));
  const envelopePath = paths.review_envelope!;
  const reportPath = paths.review_report!;
  const original = readFileSync(envelopePath);

  writeFileSync(envelopePath, original.toString('utf8').replace('HUMAN_REVIEW_REQUIRED', 'NO_HUMAN_REVIEW'));
  const tampered = await cli(reviewed.policy, ['show', reviewed.workId]);
  assert.match(tampered.stdout, /^\[review\]\nREVIEW_ARTIFACT_INVALID: envelope artifact /m);
  assert.doesNotMatch(tampered.stdout, /^status: /m);
  writeFileSync(envelopePath, original);

  const report = readFileSync(reportPath);
  rmSync(reportPath);
  const missing = await cli(reviewed.policy, ['show', reviewed.workId]);
  assert.match(missing.stdout, /^\[review\]\nREVIEW_ARTIFACT_INVALID: report artifact missing/m);
  assert.doesNotMatch(missing.stdout, /^status: /m);
  writeFileSync(reportPath, report);

  const restored = await cli(reviewed.policy, ['show', reviewed.workId]);
  assert.match(restored.stdout, /^status: HUMAN_REVIEW_REQUIRED$/m);
});

test('exit 0：Reviewer 沒有選入人工待辦；未選入的檔案帶 DEV-01 標示', { skip }, async () => {
  const c = await attempt();
  const head = commit(c.repo);
  docker.configure({ run: 'report', reportText: reportText('not-selected') });
  const result = await review(c, head);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^status: NO_HUMAN_REVIEW$/m);
  assert.match(result.stdout, /^人工待辦（Reviewer 選入）:\n\(none\)$/m);
  assert.match(result.stdout, /^機械審查未選入，fact layer 尚未接入（DEV-01）；不代表已驗證安全:\n- src\/a\.txt\n- src\/new\.txt$/m);
  assert.equal(reviewEvents(c, 'review.completed')[0]?.status, 'NO_HUMAN_REVIEW');
  const shown = await cli(c.policy, ['show', c.workId]);
  assert.match(shown.stdout, /^\[review\]\nstatus: NO_HUMAN_REVIEW$/m);
});

test('show：沒有 review 時明確標示 (none)', { skip }, async () => {
  const c = await committedCase();
  const shown = await cli(c.policy, ['show', c.workId]);
  assert.match(shown.stdout, /^\[review\]\n\(none\)$/m);
});

// ---------------------------------------------------------------- 用法與前提（exit 1／2）

test('用法錯誤 → exit 1：缺參數、未知旗標、多餘位置參數', { skip }, async () => {
  const c = await committedCase();
  for (const args of [
    ['review'],
    ['review', c.workId, '--head', c.head],
    ['review', c.workId, '--attempt', c.attemptId],
    ['review', c.workId, '--attempt', c.attemptId, '--head', c.head, '--force'],
    ['review', c.workId, 'extra', '--attempt', c.attemptId, '--head', c.head],
  ]) {
    const result = await cli(c.policy, args);
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stderr, /用法：harness review/);
  }
  assert.deepEqual(reviewEvents(c, 'review.completed'), []);
});

test('CANDIDATE_NOT_SHA → exit 2：不接受 branch、HEAD、縮寫、大寫', { skip }, async () => {
  const c = await committedCase();
  docker.reset();
  for (const head of ['master', 'HEAD', c.head.slice(0, 12), c.head.toUpperCase(), `${c.head}0`]) {
    assertFailed(c, await review(c, head), 2, 'CANDIDATE_NOT_SHA');
  }
  assert.deepEqual(docker.calls(), []);
});

test('找不到 work → exit 1；ATTEMPT_NOT_FOUND → exit 1；ATTEMPT_WORK_MISMATCH → exit 2', { skip }, async () => {
  const c = await committedCase();
  const missingWork = await cli(c.policy, ['review', 'W-missing', '--attempt', c.attemptId, '--head', c.head]);
  assert.equal(missingWork.code, 1);
  assert.match(missingWork.stderr, /^WORK_NOT_FOUND: /m);

  assertFailed(c, await review({ ...c, attemptId: 'A-missing' }, c.head), 1, 'ATTEMPT_NOT_FOUND');

  const store = new Store(c.policy.stateDir);
  let other: string;
  try {
    other = new Orchestrator(c.policy, store).createWork({ request: '另一件事', workspace: c.repo }).id;
  } finally { store.close(); }
  const mismatch = await cli(c.policy, ['review', other, '--attempt', c.attemptId, '--head', c.head]);
  assert.equal(mismatch.code, 2);
  assert.match(mismatch.stderr, /^BLOCKED ATTEMPT_WORK_MISMATCH: /m);
});

test('ATTEMPT_NOT_SUCCESS → exit 2', { skip }, async () => {
  const c = await attempt({ status: 'blocked' });
  assert.equal(c.outcome, 'BLOCKED');
  assertFailed(c, await review(c, git(c.repo, 'rev-parse', 'HEAD')), 2, 'ATTEMPT_NOT_SUCCESS');
});

test('PRE_EXISTING_DIRTY → exit 2：Attempt 開始前就有修改', { skip }, async () => {
  const c = await attempt({ beforeAttempt: (repo) => writeFileSync(join(repo, 'notes.txt'), 'user edit\n') });
  assert.equal(c.outcome, 'SUCCESS', '既有修改未再變動時 Attempt 本身可以成功');
  assertFailed(c, await review(c, commit(c.repo)), 2, 'PRE_EXISTING_DIRTY');
});

test('ATTEMPT_RESULT_UNRECORDED → exit 2：沒有 resultTree 的舊 Attempt', { skip }, async () => {
  const c = await attempt();
  const head = commit(c.repo);
  const store = new Store(c.policy.stateDir);
  try {
    store.db.prepare("update evidence set data = json_remove(data, '$.resultTree') where attempt_id = ? and type = 'git_diff'")
      .run(c.attemptId);
  } finally { store.close(); }
  assertFailed(c, await review(c, head), 2, 'ATTEMPT_RESULT_UNRECORDED');
});

test('CONTRACT_STALE → exit 2：Work Contract 在 Attempt 之後改版', { skip }, async () => {
  const c = await attempt();
  const head = commit(c.repo);
  assert.equal((await cli(c.policy, ['amend', c.workId, '改成另一個目標'])).code, 0);
  assertFailed(c, await review(c, head), 2, 'CONTRACT_STALE');
});

test('WORKSPACE_NOT_GIT_ROOT → exit 2：workspace 不是 repository 根目錄', { skip }, async () => {
  const c = await attempt();
  const head = commit(c.repo);
  const store = new Store(c.policy.stateDir);
  try {
    store.db.prepare('update works set workspace = ? where id = ?').run(join(c.repo, 'src'), c.workId);
  } finally { store.close(); }
  assertFailed(c, await review(c, head), 2, 'WORKSPACE_NOT_GIT_ROOT');
});

test('CANDIDATE_NOT_FOUND → exit 2：SHA 不存在，或沒有被任何 ref 指到', { skip }, async () => {
  const c = await committedCase();
  assertFailed(c, await review(c, '0123456789abcdef0123456789abcdef01234567'), 2, 'CANDIDATE_NOT_FOUND');

  // 與 candidate 同 tree、同 parent，但不掛任何 ref：乾淨副本裡不會有它
  docker.configure({ run: 'report', reportText: reportText('human') });
  const dangling = git(c.repo, 'commit-tree', `${c.head}^{tree}`, '-p', c.base, '-m', 'dangling');
  const result = await review(c, dangling);
  assertFailed(c, result, 2, 'CANDIDATE_NOT_FOUND');
  assert.match(result.stderr, /not reachable from any ref/);
});

test('CANDIDATE_TREE_MISMATCH → exit 2：人在 commit 前另外修改', { skip }, async () => {
  const c = await attempt();
  writeFileSync(join(c.repo, 'src/extra.txt'), 'human edit\n');
  assertFailed(c, await review(c, commit(c.repo)), 2, 'CANDIDATE_TREE_MISMATCH');
});

test('CANDIDATE_NOT_DESCENDANT → exit 2：同 tree 但不是從 baseRevision 長出來', { skip }, async () => {
  const c = await committedCase();
  const orphan = git(c.repo, 'commit-tree', `${c.head}^{tree}`, '-m', 'orphan');
  assert.match(orphan, SHA);
  assertFailed(c, await review(c, orphan), 2, 'CANDIDATE_NOT_DESCENDANT');
});

// ---------------------------------------------------------------- 執行失敗（exit 3）

test('VERIFICATION_FAILED → exit 3：required check 在乾淨副本失敗，Reviewer 不會被執行', { skip }, async () => {
  // check 依賴一個被 ignore 的本機檔案：工作樹上通過，乾淨副本裡沒有它
  const c = await attempt({
    checks: [{ ...CHECK, argv: ['sh', '-c', 'grep -q ok src/a.txt && test -f local.env'] }],
    files: { '.gitignore': 'local.env\n' },
    beforeAttempt: (repo) => writeFileSync(join(repo, 'local.env'), 'TOKEN=x\n'),
  });
  assert.equal(c.outcome, 'SUCCESS');
  docker.reset();
  docker.configure({ run: 'report', reportText: reportText('human') });
  const result = await review(c, commit(c.repo));
  assertFailed(c, result, 3, 'VERIFICATION_FAILED');
  assert.match(result.stderr, /content/);
  assert.deepEqual(docker.calls().map((call) => call.argv[0]), ['image']);
});

test('VERIFICATION_FAILED → exit 3：path policy 對 base..candidate 重新評估（skip-worktree 繞過 git status）', { skip }, async () => {
  const c = await attempt({
    files: { 'secret/key.txt': 'v1\n' },
    beforeAttempt: (repo) => { git(repo, 'update-index', '--skip-worktree', 'secret/key.txt'); },
    agent: (repo) => {
      writeFileSync(join(repo, 'src/a.txt'), 'ok\n');
      writeFileSync(join(repo, 'secret/key.txt'), 'v2\n');
    },
  });
  assert.equal(c.outcome, 'SUCCESS', 'git status 看不到 skip-worktree 的修改，Attempt 的 path policy 沒抓到');
  git(c.repo, 'update-index', '--no-skip-worktree', 'secret/key.txt');
  docker.configure({ run: 'report', reportText: reportText('human') });
  const result = await review(c, commit(c.repo));
  assertFailed(c, result, 3, 'VERIFICATION_FAILED');
  assert.match(result.stderr, /secret\/key\.txt/);
});

test('VERIFICATION_FAILED → exit 3：Attempt 凍結的 contract 快照不見了，不改用 workspace 現在的 contract', { skip }, async () => {
  const c = await attempt();
  const head = commit(c.repo);
  const snapshotPath = withStore(c, (store) => (store.db.prepare('select path from artifacts where id = ?')
    .get(store.getAttempt(c.attemptId)!.inputSnapshotArtifactId!) as { path: string }).path);
  rmSync(snapshotPath);
  docker.reset();
  docker.configure({ run: 'report', reportText: reportText('human') });
  const result = await review(c, head);
  assertFailed(c, result, 3, 'VERIFICATION_FAILED');
  assert.match(result.stderr, /frozen repository contract unavailable: input snapshot missing/);
  assert.deepEqual(docker.calls(), []);
});

test('REVIEW_RUNNER_FAILED → exit 3：未設定 image、image 不存在、container exit 非 0', { skip }, async () => {
  const c = await committedCase();
  assertFailed(c, await review(c, c.head, [], { ...c.policy, reviewerImage: undefined }), 3, 'REVIEW_RUNNER_FAILED');
  docker.configure({ inspect: 'fail' });
  assertFailed(c, await review(c, c.head), 3, 'REVIEW_RUNNER_FAILED');
  docker.configure({ run: 'exit', exitCode: 2, stderr: 'error: boom\n' });
  const exited = await review(c, c.head);
  assertFailed(c, exited, 3, 'REVIEW_RUNNER_FAILED');
  assert.match(exited.stderr, /error: boom/);
});

test('REVIEW_TIMEOUT → exit 3：超過 reviewTimeoutMs 以 docker kill 終止', { skip }, async () => {
  const c = await committedCase();
  docker.reset();
  docker.configure({ run: 'hang' });
  assertFailed(c, await review(c, c.head, [], { ...c.policy, reviewTimeoutMs: 300 }), 3, 'REVIEW_TIMEOUT');
  assert.deepEqual(docker.calls().map((call) => call.argv[0]), ['image', 'run', 'kill', 'rm']);
});

test('REVIEW_REPORT_INVALID → exit 3：malformed、不存在、審錯 head、過大、symlink', { skip }, async () => {
  const c = await committedCase();
  const wrongHead = JSON.stringify(reviewerReport('human', { base: '__BASE__', head: 'a'.repeat(40) }));
  for (const [config, policy] of [
    [{ run: 'report', reportText: '{' }, c.policy],
    [{ run: 'no-report' }, c.policy],
    [{ run: 'report', reportText: wrongHead }, c.policy],
    [{ run: 'report', reportText: reportText('human') }, { ...c.policy, maxReviewReportBytes: 64 }],
    [{ run: 'symlink', reportText: reportText('human') }, c.policy],
  ] as const) {
    docker.configure(config);
    assertFailed(c, await review(c, c.head, [], policy), 3, 'REVIEW_REPORT_INVALID');
  }
});

test('REVIEW_STALE → exit 3：審查期間 attempt 有變化，不保存成功結果', { skip }, async () => {
  const c = await attempt();
  const head = commit(c.repo);
  docker.configure({
    run: 'report', reportText: reportText('human'),
    sql: {
      db: join(c.policy.stateDir, 'harness.db'),
      statement: `update attempts set json = json_set(json, '$.failureReason', 'changed during review') where id = '${c.attemptId}'`,
    },
  });
  assertFailed(c, await review(c, head), 3, 'REVIEW_STALE');
});

// ---------------------------------------------------------------- 第一輪審查的回歸測試

/** 預設 agent 的變更，再加上把 check 腳本換成 agent 寫的內容。 */
const agentWithCheck = (script: string) => (repo: string): void => {
  writeFileSync(join(repo, 'src/a.txt'), 'ok\n');
  writeFileSync(join(repo, 'src/new.txt'), 'new\n');
  writeFileSync(join(repo, 'check.sh'), script);
};
const SCRIPT_CHECK = { ...CHECK, argv: ['sh', 'check.sh'] };
const humanPaths = (stdout: string): string[] => (JSON.parse(stdout) as ReviewEnvelope).humanReview.map((file) => file.path);

// 只在 HEAD 有 parent 的副本（review 的乾淨副本是 detached 的 candidate）把 candidate 換成 base 的 tree
const REPLACE_CANDIDATE = `if git rev-parse -q --verify HEAD~1 >/dev/null 2>&1; then
  fake=$(git -c user.name=x -c user.email=x@x commit-tree "HEAD~1^{tree}" -p HEAD~1 -m fake) && git replace HEAD "$fake"
fi
`;

// 把 candidate 標成 shallow（沒有 parent）：GIT_NO_REPLACE_OBJECTS 擋不住，只有不共用副本才擋得住
const SHALLOW_CANDIDATE = `if git rev-parse -q --verify HEAD~1 >/dev/null 2>&1; then git rev-parse HEAD > .git/shallow; fi
`;

for (const [name, tamper] of [['replace ref', REPLACE_CANDIDATE], ['.git/shallow', SHALLOW_CANDIDATE]] as const) {
  test(`H1：required check 竄改自己的副本（${name}），交給 Reviewer 的副本仍是真正的 candidate`, { skip }, async () => {
    const c = await attempt({
      checks: [SCRIPT_CHECK], files: { 'check.sh': 'grep -q ok src/a.txt\n' },
      agent: agentWithCheck(`grep -q ok src/a.txt || exit 1\n${tamper}`),
    });
    assert.equal(c.outcome, 'SUCCESS');
    const head = commit(c.repo);
    docker.configure({ run: 'derive' });
    const result = await review(c, head, ['--json']);
    assert.equal(result.code, 5, result.stderr);
    assert.deepEqual(humanPaths(result.stdout), ['check.sh', 'src/a.txt', 'src/new.txt']);
  });
}

test('H2：work A 的 check 汙染共用的 verification HOME，work B 的 review 不受影響', { skip }, async () => {
  const state = join(ROOT, 'shared-state');
  const plant = `grep -q ok src/a.txt || exit 1
mkdir -p "$HOME/hooks"
printf '[core]\\n\\thooksPath = %s/hooks\\n' "$HOME" > "$HOME/.gitconfig"
cat > "$HOME/hooks/post-checkout" <<'HOOK'
#!/bin/sh
echo "$PWD" >> "$HOME/hook-ran"
${REPLACE_CANDIDATE}exit 0
HOOK
chmod +x "$HOME/hooks/post-checkout"
`;
  const a = await attempt({ state, checks: [SCRIPT_CHECK], files: { 'check.sh': 'grep -q ok src/a.txt\n' }, agent: agentWithCheck(plant) });
  assert.equal(a.outcome, 'SUCCESS');
  assert.ok(existsSync(join(a.policy.verificationHome, '.gitconfig')), 'work A 的 check 寫入了共用 HOME 的 .gitconfig');

  const b = await attempt({ state });
  assert.equal(b.outcome, 'SUCCESS');
  const head = commit(b.repo);
  docker.configure({ run: 'derive' });
  const result = await review(b, head, ['--json']);
  assert.equal(result.code, 5, result.stderr);
  assert.deepEqual(humanPaths(result.stdout), ['src/a.txt', 'src/new.txt']);
  assert.equal(existsSync(join(b.policy.verificationHome, 'hook-ran')), false, 'Harness 的 git 不得執行共用 HOME 裡的 hook');
});

test('M1：使用者 repo 的 refs/replace 不能讓非 Attempt 結果的 candidate 通過 CANDIDATE_TREE_MISMATCH', { skip }, async () => {
  const c = await attempt();
  const good = commit(c.repo);
  writeFileSync(join(c.repo, 'src/extra.txt'), 'not from the attempt\n');
  const evil = commit(c.repo);
  git(c.repo, 'replace', evil, good);
  docker.configure({ run: 'derive' });
  assertFailed(c, await review(c, evil), 2, 'CANDIDATE_TREE_MISMATCH');
});

test('M1：使用者 repo 的 grafts 讓非後代看起來從 baseRevision 長出來；副本裡重新檢查 → CANDIDATE_NOT_DESCENDANT', { skip }, async () => {
  // GIT_NO_REPLACE_OBJECTS 不會停用 .git/info/grafts；副本由 Harness 建立，沒有 grafts
  const c = await committedCase();
  const orphan = git(c.repo, 'commit-tree', `${c.head}^{tree}`, '-m', 'orphan');
  git(c.repo, 'branch', 'orphan', orphan);
  writeFileSync(join(c.repo, '.git/info/grafts'), `${orphan} ${c.base}\n`);
  try {
    docker.reset();
    docker.configure({ run: 'derive' });
    const result = await review(c, orphan);
    assertFailed(c, result, 2, 'CANDIDATE_NOT_DESCENDANT');
    assert.deepEqual(docker.calls().map((call) => call.argv[0]), [], '前提不成立時不得執行 Reviewer');
  } finally {
    rmSync(join(c.repo, '.git/info/grafts'));
    git(c.repo, 'branch', '-D', 'orphan');
  }
});

test('M3：報表列出的檔案必須正是 base..candidate 的變更；NO_CHANGES、少列、多列都是 REVIEW_REPORT_INVALID', { skip }, async () => {
  const c = await committedCase();
  const ids = { base: '__BASE__', head: '__HEAD__' };
  const file = (path: string) => ({ path, human: true, reasons: ['X'] });
  for (const specs of [
    [],                                                                  // 有變更卻說 NO_CHANGES
    [file('src/a.txt')],                                                 // 少列 src/new.txt
    [file('src/a.txt'), file('src/new.txt'), file('src/other.txt')],    // 多列
    [file('src/a.txt'), file('README.md')],                              // 數量對、內容錯
  ]) {
    docker.configure({ run: 'report', reportText: JSON.stringify(reviewerReportFor(specs, ids)) });
    const result = await review(c, c.head);
    assertFailed(c, result, 3, 'REVIEW_REPORT_INVALID');
    assert.match(result.stderr, /report files do not match base\.\.candidate/);
  }
});

test('M3：rename 用與 Reviewer 相同的語意（-M，取新路徑）', { skip }, async () => {
  const c = await attempt({ agent: (repo) => {
    writeFileSync(join(repo, 'src/a.txt'), 'ok\n');
    mkdirSync(join(repo, 'docs'));
    renameSync(join(repo, 'README.md'), join(repo, 'docs/README.md'));
  } });
  assert.equal(c.outcome, 'SUCCESS');
  const head = commit(c.repo);
  docker.configure({ run: 'derive' });
  const derived = await review(c, head, ['--json']);
  assert.equal(derived.code, 5, derived.stderr);
  assert.deepEqual(humanPaths(derived.stdout), ['docs/README.md', 'src/a.txt']);

  // 不偵測 rename 的清單（舊路徑也列入）不是 Reviewer 會產生的報表
  const noRenames = ['README.md', 'docs/README.md', 'src/a.txt'].map((path) => ({ path, human: true, reasons: ['X'] }));
  docker.configure({ run: 'report', reportText: JSON.stringify(reviewerReportFor(noRenames, { base: '__BASE__', head: '__HEAD__' })) });
  const result = await review(c, head);
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stderr, /^REVIEW_REPORT_INVALID: report files do not match base\.\.candidate/m);
});

// 只在 review 的乾淨副本（detached HEAD）留下刪不掉的目錄：500 刪不掉裡面的檔案，000 連列出內容都不行
const LOCK_CLONE = `grep -q ok src/a.txt || exit 1
if ! git symbolic-ref -q HEAD >/dev/null; then
  mkdir -p lock/d lock/e && touch lock/d/f && chmod 500 lock/d && chmod 000 lock/e
fi
`;

test('M5：check 在副本留下沒有寫入權限的目錄，清理不得蓋掉結果（成功與失敗兩條路徑）', { skip }, async () => {
  const c = await attempt({ checks: [SCRIPT_CHECK], files: { 'check.sh': 'grep -q ok src/a.txt\n' }, agent: agentWithCheck(LOCK_CLONE) });
  assert.equal(c.outcome, 'SUCCESS');
  const head = commit(c.repo);

  docker.configure({ run: 'derive' });
  const success = await review(c, head);
  assert.equal(success.code, 5, success.stderr);
  assert.doesNotMatch(success.stderr, /warning/);
  assert.deepEqual(reviewWork(c), [], '補上寫入權限後暫存目錄刪得掉');
  assert.equal(reviewEvents(c, 'review.completed').length, 1);

  docker.configure({ run: 'report', reportText: '{' });
  const failure = await review(c, head);
  assert.equal(failure.code, 3, failure.stderr);
  assert.match(failure.stderr, /^REVIEW_REPORT_INVALID: /m);
  assert.deepEqual(reviewWork(c), []);
  assert.equal(reviewEvents(c, 'review.failed').at(-1)?.code, 'REVIEW_REPORT_INVALID');
});

test('M5：暫存目錄真的刪不掉時只寫 stderr 警告，exit code 與 review.completed 不變', { skip }, async () => {
  const c = await attempt();
  const head = commit(c.repo);
  docker.configure({ run: 'report', reportText: reportText('human'), lockReviewWork: true });
  const dir = join(c.policy.stateDir, 'review-work');
  try {
    const result = await review(c, head);
    assert.equal(result.code, 5, result.stderr);
    assert.match(result.stderr, /^warning: review-work cleanup failed: /m);
    assert.deepEqual(reviewEvents(c, 'review.completed').map((event) => event.status), ['HUMAN_REVIEW_REQUIRED']);
    assert.deepEqual(reviewEvents(c, 'review.failed'), []);
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M5：非預期的例外 → exit 3 REVIEW_INTERNAL_ERROR，並記錄 review.failed', { skip }, async () => {
  const c = await committedCase();
  const dir = join(c.policy.stateDir, 'review-work');
  assert.deepEqual(reviewWork(c), []);
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(dir, 'not a directory');
  try {
    const result = await review(c, c.head);
    assert.equal(result.code, 3, result.stderr);
    assert.match(result.stderr, /^REVIEW_INTERNAL_ERROR: .*ENOTDIR/m);
    assert.equal(reviewEvents(c, 'review.failed').at(-1)?.code, 'REVIEW_INTERNAL_ERROR');
    assert.deepEqual(reviewEvents(c, 'review.completed'), []);
  } finally {
    rmSync(dir);
  }
});

test('L5：resultTree 算不出來（SHA-256 repo）時 Attempt 仍可 SUCCESS，之後的 review 回 ATTEMPT_RESULT_UNRECORDED', { skip }, async () => {
  const c = await attempt({ init: ['--object-format=sha256'] });
  assert.equal(c.outcome, 'SUCCESS', 'resultTree 只是 review 的前提，不是 Attempt 的 evidence');
  const [diff] = withStore(c, (store) => store.listEvidence(c.attemptId).filter((evidence) => evidence.type === 'git_diff'));
  assert.equal(diff?.status, 'PASS');
  assert.equal('resultTree' in (diff?.data as object), false);
  assert.deepEqual((diff?.data as { probeErrors: string[] }).probeErrors, ['git write-tree: unexpected output']);
  commit(c.repo);
  assertFailed(c, await review(c, 'a'.repeat(40)), 2, 'ATTEMPT_RESULT_UNRECORDED');
});

test('L2：人看的 review 輸出與 show 跳脫報表字串裡的控制字元（C0、DEL、C1，含 ESC 與換行）', { skip }, async () => {
  const odd = 'src/\x1b[31mred.txt';
  const c = await attempt({ agent: (repo) => {
    writeFileSync(join(repo, 'src/a.txt'), 'ok\n');
    writeFileSync(join(repo, odd), 'x\n');
  } });
  assert.equal(c.outcome, 'SUCCESS');
  const head = commit(c.repo);
  const report = reviewerReportFor([
    { path: 'src/a.txt', human: true, reasons: ['X\x1b[2K\r\n(none)\x7f\u009b'] },
    { path: odd, human: false, reasons: [] },
  ], { base: '__BASE__', head: '__HEAD__' });
  docker.configure({ run: 'report', reportText: JSON.stringify(report) });
  const result = await review(c, head);
  assert.equal(result.code, 5, result.stderr);
  const shown = await cli(c.policy, ['show', c.workId]);
  for (const output of [result.stdout, shown.stdout.slice(shown.stdout.indexOf('[review]'))]) {
    assert.match(output, /^- src\/a\.txt: X\\x1b\[2K\\x0d\\x0a\(none\)\\x7f\\x9b$/m);
    assert.match(output, /^- src\/\\x1b\[31mred\.txt$/m);
    assert.doesNotMatch(output, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/, '除了行尾的換行，不得有任何控制字元');
  }

  // 失敗時 stderr 的 detail（例如 container stderr 的結尾）也一樣
  docker.configure({ run: 'exit', exitCode: 2, stderr: 'boom\x1b[2K\x9b\n' });
  const failed = await review(c, head);
  assert.equal(failed.code, 3);
  assert.match(failed.stderr, /^REVIEW_RUNNER_FAILED: reviewer container exit 2: boom\\x1b\[2K\\x9b$/m);
});

test('L1：show 顯示最新一筆 review 事件：失敗時顯示代碼；contract 改版後的成功結果標 STALE', { skip }, async () => {
  const c = await attempt();
  const head = commit(c.repo);
  const block = async (): Promise<string> => {
    const shown = await cli(c.policy, ['show', c.workId]);
    return shown.stdout.slice(shown.stdout.indexOf('[review]'));
  };
  docker.configure({ run: 'report', reportText: reportText('human') });
  assert.equal((await review(c, head)).code, 5);
  assert.match(await block(), /^\[review\]\nstatus: HUMAN_REVIEW_REQUIRED$/m);

  docker.configure({ run: 'hang' });
  assert.equal((await review(c, head, [], { ...c.policy, reviewTimeoutMs: 300 })).code, 3);
  const failed = await block();
  assert.match(failed, /^\[review\]\nFAILED REVIEW_TIMEOUT \(exit 3\): reviewer exceeded 300 ms/m);
  assert.doesNotMatch(failed, /^status: /m, '較早的成功結果不得蓋過最新的失敗');

  docker.configure({ run: 'report', reportText: reportText('not-selected') });
  assert.equal((await review(c, head)).code, 0);
  assert.match(await block(), /^\[review\]\nstatus: NO_HUMAN_REVIEW$/m);

  assert.equal((await cli(c.policy, ['amend', c.workId, '改成另一個目標'])).code, 0);
  const stale = await block();
  assert.match(stale, /^\[review\]\nSTALE: work contract is now v2; this review is for v1\nstatus: NO_HUMAN_REVIEW$/m);
});

test('L3：Attempt 開始時 dirty 快照失敗（git status 錯誤）→ review 視同 PRE_EXISTING_DIRTY', { skip }, async () => {
  let index: Buffer | undefined;
  const c = await attempt({
    beforeAttempt: (repo) => {
      index = readFileSync(join(repo, '.git/index'));
      writeFileSync(join(repo, '.git/index'), 'not an index');   // 讓開始時的 git status 失敗
    },
    agent: (repo) => {
      writeFileSync(join(repo, '.git/index'), index!);
      writeFileSync(join(repo, 'src/a.txt'), 'ok\n');
      writeFileSync(join(repo, 'src/new.txt'), 'new\n');
    },
  });
  assert.equal(c.outcome, 'SUCCESS');
  docker.configure({ run: 'report', reportText: reportText('human') });
  const result = await review(c, commit(c.repo));
  assertFailed(c, result, 2, 'PRE_EXISTING_DIRTY');
  assert.match(result.stderr, /dirty snapshot at attempt start failed: git status: exit 128/);
});
