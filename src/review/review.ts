import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { nowIso } from '../ids.ts';
import { tail, type IsolatedRun } from '../evidence/exec.ts';
import { attemptPathPolicy, runGit } from '../evidence/git.ts';
import { runVerification } from '../evidence/verification.ts';
import { checkPaths } from '../repo/paths.ts';
import type { ExecutionOwnership } from '../runtime/ownership.ts';
import type { Store } from '../trace/store.ts';
import type {
  Attempt, AttemptInputSnapshot, GlobalPolicy, RepositoryContractSnapshot, VerificationEvidenceData, Work,
} from '../types.ts';
import { prepareReviewer, runReviewer } from './docker-runner.ts';
import {
  buildReviewEnvelope, reviewExitCode, validateReviewerReport,
  type ReviewEnvelope, type ReviewStatus, type ReviewVerificationSummary, type ValidatedReport,
} from './report.ts';

// HR-01 定案 A2／A3（M1）：人 commit 的 candidate 必須正是某個 SUCCESS Attempt 的結果（tree 相同、
// 從 baseRevision 長出來），在乾淨副本以凍結的 Repository Contract 重跑 required checks 與 path policy，
// 再以離線 Docker 執行 Reviewer。Harness 不碰使用者的 index、refs、工作樹或 object DB；
// 任何一步失敗都不得保存成功結果，exit 0 也不單獨當成功證據（以驗證過的報表為準）。

const SHA = /^[0-9a-f]{40}$/;
const REPORT_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export type ReviewResult =
  | { exitCode: 0 | 5; envelope: ReviewEnvelope; envelopeText: string; envelopeSha256: string; reportSha256: string }
  | { exitCode: 1 | 2 | 3; code: string; detail: string };

/** 1：用法／找不到；2：BLOCKED，前提不成立、沒有執行審查；3：執行了但結果不可用。 */
class ReviewStop extends Error {
  readonly exitCode: 1 | 2 | 3;
  readonly code: string;
  readonly detail: string;

  constructor(exitCode: 1 | 2 | 3, code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.exitCode = exitCode;
    this.code = code;
    this.detail = detail;
  }
}

const blocked = (code: string, detail: string): ReviewStop => new ReviewStop(2, code, detail);
const failed = (code: string, detail: string): ReviewStop => new ReviewStop(3, code, detail);

function runDetail(run: IsolatedRun): string {
  if (run.timedOut) return 'timeout';
  if (run.outputTruncated) return 'output truncated';
  const stderr = tail(run.stderr, 3);
  return `exit ${run.exitCode ?? run.signal ?? 'null'}${stderr ? ` (${stderr})` : ''}`;
}

const ok = (run: IsolatedRun): boolean => run.exitCode === 0 && !run.timedOut && !run.outputTruncated;

/** 一律以強化後的 git 環境（不讀共用 HOME 的設定、不採用 replace refs、不跑 hook／fsmonitor）在沙箱內執行。 */
function git(policy: GlobalPolicy, workspace: string, args: string[], writable = false): Promise<IsolatedRun> {
  return runGit(policy, args, { workspace, writable, timeoutMs: 60_000 });
}

/** Attempt 結束時記錄的 resultTree；必須恰好一筆 git_diff evidence 帶著合法的值。 */
function recordedResultTree(store: Store, attemptId: string): string | undefined {
  const trees = store.listEvidence(attemptId)
    .filter((evidence) => evidence.type === 'git_diff')
    .map((evidence) => (evidence.data as { resultTree?: unknown }).resultTree);
  const [tree] = trees;
  return trees.length === 1 && typeof tree === 'string' && SHA.test(tree) ? tree : undefined;
}

/** 前提 1～7：只讀 Harness 自己的紀錄。 */
function checkAttempt(store: Store, input: { workId: string; attemptId: string; candidate: string }): {
  work: Work; attempt: Attempt; resultTree: string;
} {
  if (!SHA.test(input.candidate)) {
    throw blocked('CANDIDATE_NOT_SHA', `--head must be a full lowercase 40-hex commit SHA, got ${JSON.stringify(input.candidate)}`);
  }
  const work = store.getWork(input.workId);
  if (!work) throw new ReviewStop(1, 'WORK_NOT_FOUND', `work ${input.workId} does not exist`);
  const attempt = store.getAttempt(input.attemptId);
  if (!attempt) throw new ReviewStop(1, 'ATTEMPT_NOT_FOUND', `attempt ${input.attemptId} does not exist`);
  if (attempt.workId !== work.id) {
    throw blocked('ATTEMPT_WORK_MISMATCH', `attempt ${attempt.id} belongs to work ${attempt.workId}, not ${work.id}`);
  }
  const outcomes = store.attemptOutcomes(attempt.id);
  if (!outcomes.length || outcomes.some((outcome) => outcome !== 'SUCCESS')) {
    throw blocked('ATTEMPT_NOT_SUCCESS', `attempt ${attempt.id} outcome is ${outcomes.join('/') || 'not decided'}`);
  }
  if (attempt.preExistingDirty?.length) {
    throw blocked('PRE_EXISTING_DIRTY', `attempt started with uncommitted changes: ${attempt.preExistingDirty.map((d) => d.path).join(', ')}`);
  }
  const resultTree = recordedResultTree(store, attempt.id);
  if (!resultTree) throw blocked('ATTEMPT_RESULT_UNRECORDED', `attempt ${attempt.id} has no recorded resultTree`);
  if (work.currentContractVersion !== attempt.contractVersion) {
    throw blocked('CONTRACT_STALE', `work contract is v${work.currentContractVersion}, attempt ran under v${attempt.contractVersion}`);
  }
  return { work, attempt, resultTree };
}

/** 前提 8～11：candidate 必須是該 Attempt 的結果，而且從 baseRevision 長出來。git 一律在唯讀沙箱內執行。 */
async function checkCandidate(policy: GlobalPolicy, workspace: string, candidate: string, base: string, resultTree: string): Promise<void> {
  const toplevel = await git(policy, workspace, ['rev-parse', '--show-toplevel']);
  const real = (path: string): string | null => { try { return realpathSync(path); } catch { return null; } };
  const top = ok(toplevel) ? real(toplevel.stdout.trim()) : null;
  if (top === null || top !== real(workspace)) {
    throw blocked('WORKSPACE_NOT_GIT_ROOT', ok(toplevel)
      ? `git toplevel is ${toplevel.stdout.trim()}, workspace is ${workspace}`
      : `git rev-parse --show-toplevel: ${runDetail(toplevel)}`);
  }
  const exists = await git(policy, workspace, ['cat-file', '-e', `${candidate}^{commit}`]);
  if (!ok(exists)) throw blocked('CANDIDATE_NOT_FOUND', `commit ${candidate} is not in the repository (${runDetail(exists)})`);
  await checkLineage(policy, workspace, { candidate, base, resultTree });
}

/**
 * 前提 10～11：candidate 的 tree 等於 resultTree，且從 baseRevision 長出來。在使用者 workspace 與兩份副本上各檢查一次：
 * 使用者 repo 的 .git/info/grafts 不受 GIT_NO_REPLACE_OBJECTS 影響，副本的 refs 與 grafts 則由 Harness 控制。
 */
async function checkLineage(policy: GlobalPolicy, dir: string, ids: { candidate: string; base: string; resultTree: string }): Promise<void> {
  const { candidate, base, resultTree } = ids;
  const tree = await git(policy, dir, ['rev-parse', '--verify', '--quiet', `${candidate}^{tree}`]);
  if (!ok(tree) || tree.stdout.trim() !== resultTree) {
    throw blocked('CANDIDATE_TREE_MISMATCH', `candidate tree ${tree.stdout.trim() || runDetail(tree)} != attempt resultTree ${resultTree}`);
  }
  if (!SHA.test(base)) throw blocked('CANDIDATE_NOT_DESCENDANT', `attempt baseRevision ${JSON.stringify(base)} is not a commit SHA`);
  const mergeBase = await git(policy, dir, ['merge-base', base, candidate]);
  if (!ok(mergeBase) || mergeBase.stdout.trim() !== base) {
    throw blocked('CANDIDATE_NOT_DESCENDANT', `merge-base(${base}, ${candidate}) is ${mergeBase.stdout.trim() || 'none'}`);
  }
}

/** Attempt 開始時凍結的輸入（不是重新從 workspace 載入的 contract）。 */
function frozenInput(store: Store, work: Work, attempt: Attempt): AttemptInputSnapshot {
  const unavailable = (why: string): ReviewStop => failed('VERIFICATION_FAILED', `frozen repository contract unavailable: ${why}`);
  if (!attempt.inputSnapshotArtifactId) throw unavailable('attempt has no input snapshot');
  const artifact = store.readVerifiedArtifact(attempt.inputSnapshotArtifactId);
  if (artifact.status !== 'verified') throw unavailable(`input snapshot ${artifact.status} (${artifact.reason ?? '-'})`);
  let input: AttemptInputSnapshot;
  try { input = JSON.parse(artifact.content.toString('utf8')) as AttemptInputSnapshot; } catch { throw unavailable('input snapshot is not JSON'); }
  const repositoryHash = input?.repository?.contract
    ? createHash('sha256').update(JSON.stringify(input.repository.contract)).digest('hex') : null;
  if (input?.schemaVersion !== '2' || input.workId !== work.id || input.attemptId !== attempt.id
    || input.contract?.version !== attempt.contractVersion
    || input.repository.hash !== attempt.contractSnapshotHash || repositoryHash !== attempt.contractSnapshotHash) {
    throw unavailable('input snapshot does not match the attempt');
  }
  return input;
}

/**
 * 乾淨副本：--no-local 只帶 ref 可達的 objects；不用 --shared（container 讀不到 Host 的 alternates）、不用 worktree add。
 * 沙箱只看得到這份副本自己的目錄與唯讀的來源 workspace。
 */
async function cloneCandidate(
  policy: GlobalPolicy, workspace: string, repo: string, ids: { candidate: string; base: string; resultTree: string },
): Promise<string> {
  const { candidate } = ids;
  mkdirSync(repo);
  const clone = await runGit(policy, ['clone', '--no-local', '--no-checkout', '--quiet', workspace, repo], {
    workspace: repo, writable: true, readOnlyBinds: [workspace], timeoutMs: policy.verificationTimeoutMs,
  });
  if (!ok(clone)) throw failed('VERIFICATION_FAILED', `git clone: ${runDetail(clone)}`);
  const present = await git(policy, repo, ['cat-file', '-e', `${candidate}^{commit}`]);
  if (!ok(present)) throw blocked('CANDIDATE_NOT_FOUND', `commit ${candidate} is not reachable from any ref`);
  await checkLineage(policy, repo, ids);
  const checkout = await git(policy, repo, ['checkout', '--quiet', '--detach', candidate], true);
  if (!ok(checkout)) throw failed('VERIFICATION_FAILED', `git checkout: ${runDetail(checkout)}`);
  return repo;
}

/** 在乾淨副本上以凍結的 contract 重新評估 path policy 並重跑 checks；不沿用 dirty worktree 的舊 evidence。 */
async function verifyCandidate(
  policy: GlobalPolicy, input: AttemptInputSnapshot, repo: string,
  ids: { workId: string; attemptId: string; baseRevision: string; candidate: string },
  baseline: Attempt['baseline'], log: (m: string) => void,
): Promise<ReviewVerificationSummary> {
  const diff = await git(policy, repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z',
    ids.baseRevision, ids.candidate]);
  if (!ok(diff)) throw failed('VERIFICATION_FAILED', `git diff --name-only: ${runDetail(diff)}`);
  const changed = diff.stdout.split('\0').filter(Boolean);
  const violations = checkPaths(changed, attemptPathPolicy(input.contract, input.repository));
  if (violations.length) {
    throw failed('VERIFICATION_FAILED', `path policy: ${violations.map((v) => `${v.path} ${v.rule}${v.pattern ? ` ${v.pattern}` : ''}`).join(', ')}`);
  }
  const snapshot: RepositoryContractSnapshot = input.repository;
  const outcome = await runVerification(policy, snapshot, repo,
    { workId: ids.workId, attemptId: ids.attemptId, baseRevision: ids.baseRevision, headRevision: ids.candidate },
    baseline, log);
  const checks = outcome.evidence.map((evidence) => {
    const data = evidence.data as VerificationEvidenceData;
    return {
      checkId: data.checkId, required: data.required, status: evidence.status, exitCode: data.exitCode,
      executed: data.executed, skipped: data.skipped, reason: data.reason,
    };
  });
  if (!outcome.allRequiredPassed) {
    throw failed('VERIFICATION_FAILED', `required checks on clean copy: ${checks.filter((c) => c.required && c.status !== 'PASS')
      .map((c) => `${c.checkId}=${c.status} (exit ${c.exitCode ?? 'null'}${c.reason ? `, ${c.reason}` : ''})`).join(', ')}`);
  }
  return { revision: ids.candidate, contractHash: snapshot.hash, changedPaths: changed.length, checks };
}

/**
 * Harness 自己算出 Reviewer 應該列出的檔案：與 Reviewer 的 diffEntries 同一組 git 旗標
 * （`diff --raw -z --no-abbrev -M --no-ext-diff <mergeBase> <head>`，mergeBase 已確認等於 baseRevision），
 * 路徑取 `newPath ?? oldPath`（rename 是新路徑、刪除是舊路徑）。
 */
async function reviewedPaths(policy: GlobalPolicy, repo: string, base: string, candidate: string): Promise<string[]> {
  const diff = await git(policy, repo, ['diff', '--raw', '-z', '--no-abbrev', '-M', '--no-ext-diff', base, candidate]);
  if (!ok(diff)) throw failed('VERIFICATION_FAILED', `git diff --raw: ${runDetail(diff)}`);
  const fields = diff.stdout.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index]!;
    if (header === '') { index++; continue; }
    const match = /^:\d{6} \d{6} [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(header);
    const twoPaths = match?.[1] === 'R' || match?.[1] === 'C';
    const path = fields[index + (twoPaths ? 2 : 1)];
    if (!match || !path) throw failed('VERIFICATION_FAILED', `git diff --raw: unparsable entry ${JSON.stringify(header)}`);
    paths.push(path);
    index += twoPaths ? 3 : 2;
  }
  return paths;
}

/** 報表列出的檔案集合必須正是 base..candidate 的變更（也就保證 files 為空若且唯若沒有任何變更）。 */
function checkReportedPaths(report: ValidatedReport, changed: readonly string[]): void {
  const listed = [...report.humanReview, ...report.notSelected].map((file) => file.path);
  const expected = new Set(changed);
  const missing = [...expected].filter((path) => !listed.includes(path));
  const unexpected = listed.filter((path) => !expected.has(path));
  if (missing.length || unexpected.length) {
    throw failed('REVIEW_REPORT_INVALID', `report files do not match base..candidate: `
      + `missing ${JSON.stringify(missing)}, unexpected ${JSON.stringify(unexpected)}`);
  }
}

/** container 可以在 rw 的 /output 裡放 symlink 指向 Host 檔案：不跟隨 symlink，只讀一般檔案，且有大小上限。 */
function readReport(outputDir: string, maxBytes: number): Buffer {
  const invalid = (why: string): ReviewStop => failed('REVIEW_REPORT_INVALID', why);
  let descriptor: number;
  try {
    descriptor = openSync(join(outputDir, 'report.json'), REPORT_READ_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw invalid(code === 'ENOENT' ? 'report.json is missing' : `report.json cannot be opened (${code ?? 'unknown'})`);
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw invalid('report.json is not a regular file');
    if (stat.size > maxBytes) throw invalid(`report.json is ${stat.size} bytes, over maxReviewReportBytes ${maxBytes}`);
    const content = readFileSync(descriptor);
    if (content.length > maxBytes) throw invalid(`report.json grew over maxReviewReportBytes ${maxBytes}`);
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function currentUser(): { uid: number; gid: number } | undefined {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || gid === undefined ? undefined : { uid, gid };
}

/** `harness review` 的完整流程。呼叫端（CLI）只負責輸出與 exit code。 */
export async function reviewAttempt(
  policy: GlobalPolicy, store: Store,
  input: { workId: string; attemptId: string; candidate: string },
  opts: { ownership?: ExecutionOwnership; log?: (m: string) => void } = {},
): Promise<ReviewResult> {
  const log = opts.log ?? (() => {});
  try {
    const { work, attempt, resultTree } = checkAttempt(store, input);
    const frozenAttempt = JSON.stringify(attempt);
    mkdirSync(policy.verificationHome, { recursive: true });
    await checkCandidate(policy, work.workspace, input.candidate, attempt.baseRevision, resultTree);

    const root = join(policy.stateDir, 'review-work', randomUUID());
    mkdirSync(join(root, 'output'), { recursive: true });
    try {
      log(`review: clone ${input.candidate} → ${root}`);
      const lineage = { candidate: input.candidate, base: attempt.baseRevision, resultTree };
      const verifyRepo = await cloneCandidate(policy, work.workspace, join(root, 'verify'), lineage);
      // 所有 BLOCKED 前提都已確認；在花時間重跑 checks 之前先確認凍結的輸入與 runner 可用。
      const frozen = frozenInput(store, work, attempt);
      const prepared = await prepareReviewer(policy.reviewerImage, currentUser());
      if (!prepared.ok) throw failed(prepared.code, prepared.detail);
      const ids = { workId: work.id, attemptId: attempt.id, baseRevision: attempt.baseRevision, candidate: input.candidate };
      const verification = await verifyCandidate(policy, frozen, verifyRepo, ids, attempt.baseline, log);
      // checks 可以改寫自己的副本（例如 git replace）；交給 Reviewer 的副本在 checks 跑完之後才重新 clone，從未暴露給 checks。
      const repo = await cloneCandidate(policy, work.workspace, join(root, 'repo'), lineage);
      const changed = await reviewedPaths(policy, repo, attempt.baseRevision, input.candidate);

      log(`review: reviewer ${prepared.value.imageId} (revision ${prepared.value.revision})`);
      const run = await runReviewer(prepared.value, {
        repoDir: repo, outputDir: join(root, 'output'),
        baseRevision: attempt.baseRevision, candidate: input.candidate, timeoutMs: policy.reviewTimeoutMs,
      });
      if (!run.ok) throw failed(run.code, run.detail);
      const reportBytes = readReport(join(root, 'output'), policy.maxReviewReportBytes);
      const validation = validateReviewerReport(reportBytes.toString('utf8'), {
        baseRevision: attempt.baseRevision, candidate: input.candidate,
      });
      if (!validation.ok) throw failed('REVIEW_REPORT_INVALID', validation.reason);
      checkReportedPaths(validation.report, changed);

      // 審查期間 attempt、outcome、resultTree 或 Work Contract 版本有任何變化，結果就不再對應原來的前提。
      const now = store.getAttempt(attempt.id);
      if (JSON.stringify(now) !== frozenAttempt || store.getWork(work.id)?.currentContractVersion !== attempt.contractVersion
        || store.attemptOutcomes(attempt.id).some((outcome) => outcome !== 'SUCCESS')
        || recordedResultTree(store, attempt.id) !== resultTree) {
        throw failed('REVIEW_STALE', `attempt ${attempt.id} or work contract changed during the review`);
      }
      if (opts.ownership && !opts.ownership.validate()) {
        throw failed('REVIEW_STALE', 'execution ownership was lost during the review');
      }

      const raw = store.putArtifact('review_report', reportBytes, 'json');
      const envelope = buildReviewEnvelope({
        workId: work.id, attemptId: attempt.id, contractVersion: attempt.contractVersion,
        contractSnapshotHash: attempt.contractSnapshotHash, workspace: work.workspace,
        baseRevision: attempt.baseRevision, candidate: input.candidate, resultTree,
        reviewer: { imageId: prepared.value.imageId, revision: prepared.value.revision },
        rawReport: { sha256: raw.hash, artifactId: raw.id }, verification,
      }, validation.report, nowIso());
      const envelopeText = JSON.stringify(envelope, null, 2);
      const stored = store.putArtifact('review_envelope', envelopeText, 'json');
      store.event('review.completed', {
        attemptId: attempt.id, candidate: input.candidate, status: envelope.status,
        envelopeArtifactId: stored.id, envelopeSha256: stored.hash,
        reportArtifactId: raw.id, reportSha256: raw.hash,
      }, work.id, attempt.id);
      return {
        exitCode: reviewExitCode(envelope.status), envelope, envelopeText,
        envelopeSha256: stored.hash, reportSha256: raw.hash,
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } catch (error) {
    if (!(error instanceof ReviewStop)) throw error;
    if (store.getWork(input.workId)) {
      store.event('review.failed', {
        attemptId: input.attemptId, candidate: input.candidate, code: error.code, detail: error.detail, exitCode: error.exitCode,
      }, input.workId);
    }
    return { exitCode: error.exitCode, code: error.code, detail: error.detail };
  }
}

export type LatestReview =
  | { status: 'none' }
  | { status: 'invalid'; reason: string }
  | { status: 'valid'; envelope: ReviewEnvelope; envelopeSha256: string; reportSha256: string };

/**
 * `show` 用：最新一筆 review.completed。envelope 與原始報表都必須存在、hash 與 event 記錄的一致，
 * 且 envelope 綁定的正是那份報表；任何一項不符都是 REVIEW_ARTIFACT_INVALID，不得顯示成成功。
 */
export function latestReview(store: Store, workId: string): LatestReview {
  const event = store.events(workId).filter((e) => e.type === 'review.completed').at(-1);
  if (!event) return { status: 'none' };
  const invalid = (reason: string): LatestReview => ({ status: 'invalid', reason });
  let data: Record<string, unknown>;
  try { data = JSON.parse(event.data) as Record<string, unknown>; } catch { return invalid('review.completed event is not JSON'); }
  const field = (key: string): string | null => typeof data[key] === 'string' ? data[key] : null;

  const verify = (label: string, idKey: string, hashKey: string): Buffer | string => {
    const id = field(idKey);
    const hash = field(hashKey);
    if (!id || !hash) return `${label} artifact is not recorded`;
    const artifact = store.readVerifiedArtifact(id);
    if (artifact.status !== 'verified') return `${label} artifact ${artifact.status} (${artifact.reason ?? '-'})`;
    if (artifact.hash !== hash) return `${label} artifact sha256 ${artifact.hash} != recorded ${hash}`;
    return artifact.content;
  };
  const envelopeBytes = verify('envelope', 'envelopeArtifactId', 'envelopeSha256');
  if (typeof envelopeBytes === 'string') return invalid(envelopeBytes);
  const reportBytes = verify('report', 'reportArtifactId', 'reportSha256');
  if (typeof reportBytes === 'string') return invalid(reportBytes);

  let envelope: ReviewEnvelope;
  try { envelope = JSON.parse(envelopeBytes.toString('utf8')) as ReviewEnvelope; } catch { return invalid('envelope is not JSON'); }
  const statuses: unknown[] = ['NO_CHANGES', 'NO_HUMAN_REVIEW', 'HUMAN_REVIEW_REQUIRED'] satisfies ReviewStatus[];
  if (envelope?.schemaVersion !== 1 || !statuses.includes(envelope.status) || envelope.status !== field('status')
    || envelope.candidate !== field('candidate') || envelope.attemptId !== field('attemptId')
    || envelope.rawReport?.artifactId !== field('reportArtifactId') || envelope.rawReport?.sha256 !== field('reportSha256')
    || !Array.isArray(envelope.humanReview) || !Array.isArray(envelope.notSelected)) {
    return invalid('envelope does not match the review.completed event');
  }
  return { status: 'valid', envelope, envelopeSha256: field('envelopeSha256')!, reportSha256: field('reportSha256')! };
}
