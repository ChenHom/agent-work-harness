import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import type { GlobalPolicy } from './types.ts';

// Harness Global Policy：authority 來源之一（§36.2 C1）。
// 只從 Harness 自己的 config 讀取，永遠不從 repository 讀。
const HOME = homedir();
const BASE = process.env.HARNESS_STATE_DIR ?? join(HOME, '.local/share/agent-work-harness');

export const DEFAULT_POLICY: GlobalPolicy = {
  stateDir: BASE,
  agentHome: join(BASE, 'agent-home'),
  codexHome: join(BASE, 'codex-home'),
  verificationHome: join(BASE, 'verification-home'),
  // spike 2026-08-21：verification sandbox 需要 toolchain 可讀，預設放 node 安裝路徑。
  readOnlyBinds: [dirname(dirname(process.execPath))],
  skillsDir: join(BASE, 'skills'),
  defaultRetryBudget: 1,
  defaultProtectedPaths: ['.git/**', '.harness/**'],
  codexBin: process.env.HARNESS_CODEX_BIN ?? 'codex',
  codexModel: process.env.HARNESS_CODEX_MODEL,
  attemptTimeoutMs: 30 * 60_000,
  verificationTimeoutMs: 10 * 60_000,
  maxOutputBytes: 2_000_000,
  promptBudgetChars: 24_000,
};

export function loadPolicy(): GlobalPolicy {
  const path = join(BASE, 'policy.json');
  if (!existsSync(path)) return DEFAULT_POLICY;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<GlobalPolicy>;
  return { ...DEFAULT_POLICY, ...raw };
}
