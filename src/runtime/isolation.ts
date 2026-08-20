import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { GlobalPolicy } from '../types.ts';

// §20.2/§20.3：Harness 宣告的 authority 必須對應 runtime 真正 enforce 的限制。
// 本檔的設定全部來自 docs/spikes/2026-08-21-isolation-spike.md 的實測結果。

const CODEX_CONFIG = (model: string | undefined, skillMainFiles: readonly string[]): string => [
  model ? `model = "${model}"` : '',
  'approval_policy = "never"',
  '',
  '[sandbox_workspace_write]',
  '# spike 實測：未顯式關閉時 curl 仍可連外，因此必須寫死 false',
  'network_access = false',
  'exclude_tmpdir_env_var = true',
  'exclude_slash_tmp = true',
  '',
  '[shell_environment_policy]',
  'inherit = "core"',
  '',
  // 只有 admission 通過的 skill 會出現在這裡；操作者的個人 skills 因 HOME 隔離而看不到。
  ...skillMainFiles.flatMap((f) => ['[[skills.config]]', `path = "${f}"`, 'enabled = true', '']),
].filter(Boolean).join('\n');

/** 建立 production 專用 HOME / CODEX_HOME（§21）。CODEX_HOME 不可放在 /tmp：codex 會拒絕建立 helper binaries。 */
export function ensureRuntimeDirs(policy: GlobalPolicy, skillMainFiles: readonly string[] = []): void {
  for (const d of [policy.stateDir, policy.agentHome, policy.codexHome, policy.verificationHome, policy.skillsDir]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(policy.codexHome, 'config.toml'), CODEX_CONFIG(policy.codexModel, skillMainFiles));
  const operatorAuth = join(homedir(), '.codex', 'auth.json');
  const runtimeAuth = join(policy.codexHome, 'auth.json');
  // 已知取捨（DECISIONS D-08）：codex 需要自己的憑證，因此 agent 仍可讀到這一份，
  // 但操作者的其他 credentials（~/.ssh、~/.secrets…）已被隔離的 HOME 擋掉。
  if (!existsSync(runtimeAuth) && existsSync(operatorAuth)) copyFileSync(operatorAuth, runtimeAuth);
}

/** 給 codex 子行程的環境：最小 env，隔離 HOME，指向 production CODEX_HOME。 */
export function agentEnv(policy: GlobalPolicy): NodeJS.ProcessEnv {
  const nodeBin = dirname(process.execPath);
  return {
    PATH: `${nodeBin}:/usr/local/bin:/usr/bin:/bin`,
    HOME: policy.agentHome,
    CODEX_HOME: policy.codexHome,
    TERM: 'dumb',
    LANG: process.env.LANG ?? 'C.UTF-8',
  };
}

export interface SandboxSpec {
  workspace: string;
  home: string;
  readOnlyBinds: readonly string[];
  writable?: boolean;
}

/**
 * §20.3：Verification Runner 必須與 Agent 同等或更嚴格的隔離。
 * spike 實測：`--ro-bind / /` 會讓 ~/.secrets 可讀，因此改用白名單 bind + `--tmpfs /home`。
 */
export function bwrapArgv(spec: SandboxSpec): string[] {
  const argv = [
    '--unshare-all',            // 含 --unshare-net：network deny
    '--die-with-parent',
    '--new-session',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/sbin', '/sbin',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind', '/etc', '/etc',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/run',
    '--tmpfs', '/home',         // 遮蔽操作者 HOME，之後只 bind 需要的路徑
  ];
  for (const b of spec.readOnlyBinds) argv.push('--ro-bind-try', b, b);
  argv.push('--bind', spec.home, spec.home);
  argv.push(spec.writable === false ? '--ro-bind' : '--bind', spec.workspace, spec.workspace);
  argv.push('--setenv', 'HOME', spec.home);
  argv.push('--setenv', 'TMPDIR', '/tmp');
  argv.push('--chdir', spec.workspace);
  return argv;
}

export function verificationEnv(policy: GlobalPolicy): NodeJS.ProcessEnv {
  const nodeBin = dirname(process.execPath);
  return {
    PATH: `${nodeBin}:/usr/local/bin:/usr/bin:/bin`,
    HOME: policy.verificationHome,
    TERM: 'dumb',
    CI: '1',
    LANG: process.env.LANG ?? 'C.UTF-8',
  };
}
