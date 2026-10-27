import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// HR-03 子集：受信任的 Reviewer runner（M1 B5 定案）。
// 第三個可以 import node:child_process 的檔案（見 eslint.config.js、DECISIONS D-42）：
// 只執行 `docker`，argv 全部由本檔固定組裝，shell: false。機械審查一律離線（--network none）、
// 唯讀掛載候選副本、以 inspect 過的 image ID 執行，不傳任何 ANTHROPIC_* 也不加 --ai。

const REVISION_LABEL = 'org.opencontainers.image.revision';
const INSPECT_FORMAT = `{{.Id}}|{{index .Config.Labels "${REVISION_LABEL}"}}`;
const INSPECT_TIMEOUT_MS = 60_000;
const KILL_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL_CHARS = 64 * 1024;

// docker CLI 需要找到 daemon 與 context；其餘環境變數（含 API key）一律不給。
const DOCKER_ENV_KEYS = [
  'PATH', 'HOME', 'LANG', 'XDG_RUNTIME_DIR',
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY',
];

type RunnerFailure = { ok: false; code: 'REVIEW_RUNNER_FAILED' | 'REVIEW_TIMEOUT'; detail: string };
type RunnerResult<T> = { ok: true; value: T } | RunnerFailure;

export interface PreparedReviewer {
  /** `sha256:<64 hex>`；之後一律以它執行，確保跑的就是剛才檢查過的那一個。 */
  imageId: string;
  /** image 的 revision label（Reviewer commit）。 */
  revision: string;
  user: { uid: number; gid: number };
}

interface DockerRun {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

const failed = (detail: string): RunnerFailure => ({ ok: false, code: 'REVIEW_RUNNER_FAILED', detail });
const tailOf = (text: string, lines = 5): string => text.trim().split('\n').slice(-lines).join('\n');

function dockerEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(DOCKER_ENV_KEYS.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

/** 執行一次 docker；輸出只保留結尾，不因輸出過多而殺掉 CLI（那會讓 container 留在背景）。 */
function docker(args: readonly string[], timeoutMs: number, onTimeout?: () => Promise<void>): Promise<DockerRun> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const finish = (run: Pick<DockerRun, 'exitCode' | 'signal' | 'spawnError'>): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...run, stdout, stderr, timedOut });
    };
    const child = spawn('docker', args, { shell: false, env: dockerEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-OUTPUT_TAIL_CHARS); });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-OUTPUT_TAIL_CHARS); });
    const timer = setTimeout(() => {
      timedOut = true;
      // 先停 container，再收掉 CLI；只殺 CLI 的話 --rm 的 container 會繼續跑。
      void (onTimeout?.() ?? Promise.resolve()).finally(() => { child.kill('SIGKILL'); });
    }, timeoutMs);
    child.on('error', (error) => { finish({ exitCode: null, signal: null, spawnError: error.message }); });
    child.on('close', (exitCode, signal) => { finish({ exitCode, signal }); });
  });
}

/** image 由 Global Policy 指定；先 inspect，取得 image ID 與 revision label。 */
export async function prepareReviewer(
  image: string | undefined, user: { uid: number; gid: number } | undefined,
): Promise<RunnerResult<PreparedReviewer>> {
  if (!image) return failed('reviewerImage is not configured (HARNESS_REVIEWER_IMAGE or policy.json)');
  if (!user) return failed('cannot determine the harness uid/gid');
  if (user.uid === 0) return failed('refusing to run the reviewer as uid 0');
  const run = await docker(['image', 'inspect', '--format', INSPECT_FORMAT, image], INSPECT_TIMEOUT_MS);
  if (run.spawnError) return failed(`docker image inspect: ${run.spawnError}`);
  if (run.timedOut) return failed('docker image inspect: timeout');
  if (run.exitCode !== 0) return failed(`docker image inspect ${image}: exit ${run.exitCode ?? run.signal} (${tailOf(run.stderr)})`);
  const [imageId, revision, ...rest] = run.stdout.trim().split('|');
  if (rest.length || !imageId || !/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    return failed(`docker image inspect ${image}: unexpected image id`);
  }
  if (!revision || !/^[0-9a-f]{40}$/.test(revision)) {
    return failed(`image ${image} has no ${REVISION_LABEL} label with a 40-hex commit`);
  }
  return { ok: true, value: { imageId, revision, user } };
}

/** 以離線、唯讀的 container 執行機械審查；報表寫到 `<outputDir>/report.json`，由呼叫端驗證。 */
export async function runReviewer(reviewer: PreparedReviewer, input: {
  repoDir: string; outputDir: string; baseRevision: string; candidate: string; timeoutMs: number;
}): Promise<RunnerResult<void>> {
  // `-v src:dst:mode` 以 : 分隔；路徑含 : 或換行時無法安全表達。
  if ([input.repoDir, input.outputDir].some((path) => /[:\n]/.test(path))) {
    return failed('mount path contains ":" or a newline');
  }
  const name = `harness-review-${randomBytes(8).toString('hex')}`;
  const argv = [
    'run', '--rm', '--name', name, '--network', 'none', '--read-only', '--pull', 'never',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${reviewer.user.uid}:${reviewer.user.gid}`,
    '--tmpfs', '/tmp:rw,nosuid,size=256m',
    '-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory', '-e', 'GIT_CONFIG_VALUE_0=/target',
    '-v', `${input.repoDir}:/target:ro`, '-v', `${input.outputDir}:/output:rw`,
    reviewer.imageId, 'node', 'bin/review.js', '--repo', '/target',
    '--base', input.baseRevision, '--head', input.candidate, '--out', '/output/report.json',
  ];
  const run = await docker(argv, input.timeoutMs, async () => { await docker(['kill', name], KILL_TIMEOUT_MS); });
  if (run.timedOut) return { ok: false, code: 'REVIEW_TIMEOUT', detail: `reviewer exceeded ${input.timeoutMs} ms; killed ${name}` };
  if (run.spawnError) return failed(`docker run: ${run.spawnError}`);
  if (run.exitCode !== 0) return failed(`reviewer container exit ${run.exitCode ?? run.signal}: ${tailOf(run.stderr)}`);
  return { ok: true, value: undefined };
}
