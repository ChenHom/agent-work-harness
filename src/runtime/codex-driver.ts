import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { GlobalPolicy, Mode } from '../types.ts';
import { agentEnv, ensureRuntimeDirs } from './isolation.ts';

// §21：Driver 只負責啟動 Codex 與捕捉結果。不理解 intent、不判定成功、不追加 authority。

export interface PreparedCodexRun {
  attemptDir: string;
  promptPath: string;
  lastMessagePath: string;
  logPath: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface CodexRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  lastMessage: string;
  durationMs: number;
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'string' },
    workId: { type: 'string' },
    attemptId: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'needs_user_decision', 'blocked', 'failed'] },
    summary: { type: 'string' },
    claims: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['finding', 'diagnosis', 'change', 'verification', 'limitation'] },
          text: { type: 'string' },
          // OpenAI structured outputs 要求 required 涵蓋所有 properties，optional 以 nullable 表示
          relatedPaths: { type: ['array', 'null'], items: { type: 'string' } },
        },
        required: ['type', 'text', 'relatedPaths'],
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string' }, text: { type: 'string' }, requestedAuthority: { type: ['string', 'null'] } },
        required: ['id', 'text', 'requestedAuthority'],
      },
    },
    declaredChangedPaths: { type: 'array', items: { type: 'string' } },
  },
  required: ['schemaVersion', 'workId', 'attemptId', 'status', 'summary', 'claims', 'questions', 'declaredChangedPaths'],
};

export class CodexDriver {
  private readonly policy: GlobalPolicy;

  constructor(policy: GlobalPolicy) {
    this.policy = policy;
  }

  /** approved skill 複製進 production CODEX_HOME；未核准的一律不出現在該目錄（§19 fail-closed）。 */
  private syncSkills(approvedSkillPaths: readonly string[]): void {
    const dst = join(this.policy.codexHome, 'skills');
    rmSync(dst, { recursive: true, force: true });
    if (!approvedSkillPaths.length) return;
    mkdirSync(dst, { recursive: true });
    for (const src of approvedSkillPaths) {
      if (existsSync(src)) cpSync(src, join(dst, src.split('/').filter(Boolean).pop()!), { recursive: true });
    }
  }

  prepare(input: {
    attemptId: string;
    workspace: string;
    mode: Mode;
    promptText: string;
    approvedSkillPaths: readonly string[];
  }): PreparedCodexRun {
    ensureRuntimeDirs(this.policy);
    this.syncSkills(input.approvedSkillPaths);

    const attemptDir = join(this.policy.stateDir, 'attempts', input.attemptId);
    mkdirSync(attemptDir, { recursive: true });
    const promptPath = join(attemptDir, 'prompt.txt');
    const schemaPath = join(attemptDir, 'output-schema.json');
    const lastMessagePath = join(attemptDir, 'last-message.json');
    writeFileSync(promptPath, input.promptText);
    writeFileSync(schemaPath, JSON.stringify(OUTPUT_SCHEMA, null, 2));

    const argv = [
      'exec',
      '-s', input.mode === 'read' ? 'read-only' : 'workspace-write',
      '-C', input.workspace,
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-rules',                 // repo 提供的 execpolicy .rules 不得影響 authority
      '-c', 'project_doc_max_bytes=0',  // repo AGENTS.md 是 data，不作為 instruction
      '--output-schema', schemaPath,
      '-o', lastMessagePath,
      '--color', 'never',
    ];
    if (this.policy.codexModel) argv.push('-m', this.policy.codexModel);

    return {
      attemptDir, promptPath, lastMessagePath,
      logPath: join(attemptDir, 'runtime.log'),
      argv, env: agentEnv(this.policy), cwd: input.workspace,
    };
  }

  run(run: PreparedCodexRun): Promise<CodexRunResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(this.policy.codexBin, run.argv, {
        cwd: run.cwd, env: run.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '', stderr = '', timedOut = false;
      const cap = this.policy.maxOutputBytes;
      const append = (buf: Buffer, cur: string): string =>
        (cur.length >= cap ? cur : (cur + buf.toString('utf8')).slice(0, cap));

      child.stdout.on('data', (b: Buffer) => { stdout = append(b, stdout); });
      child.stderr.on('data', (b: Buffer) => { stderr = append(b, stderr); });
      child.stdin.write(readFileSync(run.promptPath));
      child.stdin.end();

      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, this.policy.attemptTimeoutMs);

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        clearTimeout(timer);
        const lastMessage = existsSync(run.lastMessagePath) ? readFileSync(run.lastMessagePath, 'utf8') : '';
        writeFileSync(run.logPath, `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
        resolve({ exitCode, signal, timedOut, stdout, stderr, lastMessage, durationMs: Date.now() - started });
      };

      child.on('error', (e) => { stderr += `\nspawn error: ${e.message}`; finish(null, null); });
      child.on('close', finish);
    });
  }
}
