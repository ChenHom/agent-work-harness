import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { nowIso } from '../ids.ts';
import type { RepositoryContract, RepositoryContractSnapshot, VerificationCheck, GlobalPolicy } from '../types.ts';

export const CONTRACT_REL_PATH = '.harness/config.json';

export class ContractError extends Error {
  readonly code: 'REPOSITORY_NOT_INITIALIZED' | 'INVALID_CONTRACT';

  constructor(code: 'REPOSITORY_NOT_INITIALIZED' | 'INVALID_CONTRACT', message: string) {
    super(message);
    this.code = code;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new ContractError('INVALID_CONTRACT', msg);
}

/** §30.3 / §34.4：pointer 與 protected path 必須限制在 worktree 內的相對路徑。 */
function assertRelative(p: string, field: string): void {
  assert(typeof p === 'string' && p.length > 0, `${field}: 必須是非空字串`);
  assert(!isAbsolute(p), `${field}: 不允許絕對路徑（${p}）`);
  assert(!normalize(p).startsWith('..'), `${field}: 不允許跳出 worktree（${p}）`);
}

function validateCheck(c: unknown, i: number): VerificationCheck {
  const o = c as Partial<VerificationCheck>;
  assert(o && typeof o === 'object', `verification.checks[${i}]: 必須是物件`);
  assert(typeof o.id === 'string' && o.id.length > 0, `verification.checks[${i}].id 必填`);
  assert(['test', 'typecheck', 'lint', 'build', 'custom'].includes(String(o.kind)), `checks[${i}].kind 不合法`);
  assert(Array.isArray(o.argv) && o.argv.length > 0, `checks[${i}].argv 必須是非空陣列`);
  for (const a of o.argv) assert(typeof a === 'string', `checks[${i}].argv 只能是字串`);
  // §34.5 / §20.3：argv + shell=false。禁止絕對路徑執行檔，避免 repo 指向 worktree 外的東西。
  const exe = o.argv[0]!;
  assert(!isAbsolute(exe), `checks[${i}].argv[0] 不允許絕對路徑（${exe}）`);
  assert(!normalize(exe).startsWith('..'), `checks[${i}].argv[0] 不允許跳出 worktree`);
  assert(typeof o.required === 'boolean', `checks[${i}].required 必須是 boolean`);
  return {
    id: o.id, kind: o.kind as VerificationCheck['kind'], argv: o.argv,
    required: o.required, timeoutMs: typeof o.timeoutMs === 'number' ? o.timeoutMs : undefined,
  };
}

export function validateContract(raw: unknown): RepositoryContract {
  const o = raw as Partial<RepositoryContract>;
  assert(o && typeof o === 'object', 'contract 必須是 JSON 物件');
  assert(o.schemaVersion === '1', `schemaVersion 必須是 "1"`);
  assert(typeof o.repositoryId === 'string' && o.repositoryId.length > 0, 'repositoryId 必填');
  assert(o.context && Array.isArray(o.context.entryPoints), 'context.entryPoints 必填');
  o.context.entryPoints.forEach((p, i) => assertRelative(p, `context.entryPoints[${i}]`));
  assert(o.filesystem && Array.isArray(o.filesystem.protectedPaths), 'filesystem.protectedPaths 必填');
  o.filesystem.protectedPaths.forEach((p, i) => assertRelative(p, `filesystem.protectedPaths[${i}]`));
  assert(o.verification && Array.isArray(o.verification.checks), 'verification.checks 必填');
  const checks = o.verification.checks.map(validateCheck);
  const ids = new Set(checks.map((c) => c.id));
  assert(ids.size === checks.length, 'verification.checks id 重複');
  if (o.skills !== undefined) {
    assert(Array.isArray(o.skills), 'skills 必須是陣列');
    o.skills.forEach((s) => assert(typeof s === 'string', 'skills 只能是字串'));
  }
  return {
    schemaVersion: '1',
    repositoryId: o.repositoryId,
    context: { entryPoints: [...o.context.entryPoints] },
    filesystem: { protectedPaths: [...o.filesystem.protectedPaths] },
    verification: { checks },
    skills: o.skills ? [...o.skills] : undefined,
  };
}

/**
 * §34.1.1：Attempt 前 load → validate → hash → freeze。
 * §34.3：protectedPaths 與 global policy 取聯集，repo 只能加嚴不能放寬。
 */
export function loadSnapshot(workspace: string, policy: GlobalPolicy): RepositoryContractSnapshot {
  const path = join(workspace, CONTRACT_REL_PATH);
  if (!existsSync(path)) {
    throw new ContractError('REPOSITORY_NOT_INITIALIZED', `找不到 ${CONTRACT_REL_PATH}（執行 harness init 產生候選設定）`);
  }
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) {
    throw new ContractError('INVALID_CONTRACT', `${CONTRACT_REL_PATH} 不是合法 JSON: ${(e as Error).message}`);
  }
  const contract = validateContract(parsed);
  const merged: RepositoryContract = {
    ...contract,
    filesystem: {
      protectedPaths: [...new Set([...policy.defaultProtectedPaths, ...contract.filesystem.protectedPaths])],
    },
  };
  return {
    contract: merged,
    hash: createHash('sha256').update(text).digest('hex'),
    loadedAt: nowIso(),
    sourcePath: path,
  };
}

/** §34.7：auto-detect 只產生 candidate，必須由使用者確認後寫入。 */
export function detectCandidate(workspace: string, repositoryId: string): RepositoryContract {
  const has = (f: string) => existsSync(join(workspace, f));
  const checks: VerificationCheck[] = [];
  let entryPoints: string[] = [];

  if (has('package.json')) {
    entryPoints = ['src/', 'tests/', 'test/', 'README.md'].filter((p) => has(p) || p === 'README.md');
    const pkg = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    if (pkg.scripts?.test) checks.push({ id: 'test', kind: 'test', argv: ['npm', 'test'], required: true });
    if (pkg.scripts?.typecheck) checks.push({ id: 'typecheck', kind: 'typecheck', argv: ['npm', 'run', 'typecheck'], required: true });
    else if (has('tsconfig.json')) checks.push({ id: 'typecheck', kind: 'typecheck', argv: ['npx', 'tsc', '--noEmit'], required: true });
  } else if (has('composer.json')) {
    entryPoints = ['app/', 'routes/', 'tests/', 'composer.json', 'README.md'].filter((p) => has(p));
    checks.push({ id: 'test', kind: 'test', argv: ['php', 'artisan', 'test'], required: true });
  } else if (has('go.mod')) {
    entryPoints = ['cmd/', 'internal/', 'pkg/', 'README.md'].filter((p) => has(p));
    checks.push({ id: 'test', kind: 'test', argv: ['go', 'test', './...'], required: true });
    checks.push({ id: 'build', kind: 'build', argv: ['go', 'build', './...'], required: true });
  } else if (has('pyproject.toml') || has('requirements.txt')) {
    entryPoints = ['src/', 'tests/', 'README.md'].filter((p) => has(p));
    checks.push({ id: 'test', kind: 'test', argv: ['python3', '-m', 'pytest', '-q'], required: true });
  }

  checks.push({ id: 'diff-check', kind: 'custom', argv: ['git', 'diff', '--check'], required: true });
  return {
    schemaVersion: '1',
    repositoryId,
    context: { entryPoints: entryPoints.length ? entryPoints : ['README.md'] },
    filesystem: { protectedPaths: ['.git/**', '.harness/**'] },
    verification: { checks },
  };
}
