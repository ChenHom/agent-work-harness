// 最小 glob → RegExp。安全關鍵路徑（denied/protected 判定），行為必須保守：
// 看不懂的 pattern 一律不匹配，不做寬鬆猜測。
// 支援 **（跨層）、*（單層）、?（單字元）。

function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/^\.\//, '').replace(/^\/+/, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const afterSlash = g[i + 2] === '/';
        re += afterSlash ? '(?:.*/)?' : '.*';
        i += afterSlash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesGlob(path: string, glob: string): boolean {
  const p = path.replace(/^\.\//, '').replace(/^\/+/, '');
  if (globToRegExp(glob).test(p)) return true;
  // 目錄 pattern `a/**` 也應涵蓋 `a` 本身的變更（例如目錄被刪除）
  if (glob.endsWith('/**')) {
    const dir = glob.slice(0, -3);
    return p === dir || p.startsWith(`${dir}/`);
  }
  return false;
}

function matchesAny(path: string, globs: readonly string[]): string | null {
  for (const g of globs) if (matchesGlob(path, g)) return g;
  return null;
}

export interface PathPolicy {
  deniedPaths: string[];       // WorkContract deniedPaths + Repository protectedPaths
  allowedPaths?: string[];     // 只有明確限制時存在（§20.1）
}

export interface PathViolation {
  path: string;
  rule: 'denied' | 'outside_allowed';
  pattern?: string;
}

/** §23.1：對實際觀察到的 changed paths 做政策判定。deny 永遠優先。 */
export function checkPaths(changed: readonly string[], policy: PathPolicy): PathViolation[] {
  const out: PathViolation[] = [];
  for (const p of changed) {
    const denied = matchesAny(p, policy.deniedPaths);
    if (denied) { out.push({ path: p, rule: 'denied', pattern: denied }); continue; }
    if (policy.allowedPaths && policy.allowedPaths.length > 0 && !matchesAny(p, policy.allowedPaths)) {
      out.push({ path: p, rule: 'outside_allowed' });
    }
  }
  return out;
}
