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
    execFile('bwrap', wrapped, {
      env: verificationEnv(policy),
      shell: false,
      timeout,
      maxBuffer: policy.maxOutputBytes,
      killSignal: 'SIGKILL',
    }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
      resolve({
        argv: [...argv],
        exitCode: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        signal: e?.signal ?? null,
        timedOut: Boolean(e?.killed && e.signal === 'SIGKILL'),
        stdout: String(stdout), stderr: String(stderr),
        durationMs: Date.now() - started,
      });
    });
  });
}

export function tail(text: string, lines = 40): string {
  return text.split('\n').slice(-lines).join('\n').trim();
}
