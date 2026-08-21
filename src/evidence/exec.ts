import { execFile } from 'node:child_process';
import type { GlobalPolicy } from '../types.ts';
import { bwrapArgv, verificationEnv } from '../runtime/isolation.ts';

// §20.3：Harness 自己啟動的任何 repository-touching 行程（含 git evidence 與 verification）
// 都必須落在與 Agent 同等或更嚴格的 isolation contract 中。

export interface IsolatedRun {
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /**
   * 輸出超過 maxBuffer。實測：execFile 此時會殺掉行程（不是截斷輸出），
   * err.code 是字串常數，保留下來的是輸出「開頭」而非結尾。
   * 所以這代表執行沒跑完，語意接近 timeout。
   */
  outputTruncated: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunOptions {
  workspace: string;
  writable?: boolean;
  timeoutMs?: number;
}

export function runIsolated(policy: GlobalPolicy, argv: readonly string[], opts: RunOptions): Promise<IsolatedRun> {
  const wrapped = [
    ...bwrapArgv({
      workspace: opts.workspace,
      home: policy.verificationHome,
      readOnlyBinds: policy.readOnlyBinds,
      writable: opts.writable ?? false,
    }),
    '--',
    ...argv,
  ];
  const started = Date.now();
  const timeout = opts.timeoutMs ?? policy.verificationTimeoutMs;

  return new Promise((resolve) => {
    let timedOut = false;
    const child = execFile('bwrap', wrapped, {
      env: verificationEnv(policy),
      shell: false,
      maxBuffer: policy.maxOutputBytes,
      killSignal: 'SIGKILL',
    }, (err, stdout, stderr) => {
      clearTimeout(timer);
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
      resolve({
        argv: [...argv],
        exitCode: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        signal: e?.signal ?? null,
        timedOut,
        outputTruncated: e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        stdout: String(stdout), stderr: String(stderr),
        durationMs: Date.now() - started,
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
  });
}

export function tail(text: string, lines = 40): string {
  return text.split('\n').slice(-lines).join('\n').trim();
}
