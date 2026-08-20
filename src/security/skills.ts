import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { ApprovedSkill, SkillAdmission, GlobalPolicy } from '../types.ts';

// §19：fail-closed。只允許 registry 中且 hash 相符的 skill artifact。

const SCRIPT_EXT = new Set(['.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.php', '.exe', '.bin']);
const EXTERNAL_REF = /\b(?:https?:\/\/|git@|ssh:\/\/)/i;

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else if (st.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/** §19.2：hash 涵蓋完整目錄，而不是只有 SKILL.md。 */
export function hashSkillDir(dir: string): string {
  const h = createHash('sha256');
  for (const rel of walk(dir).sort()) {
    h.update(rel);
    h.update('\0');
    h.update(readFileSync(join(dir, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

export function registryPath(policy: GlobalPolicy): string {
  return join(policy.skillsDir, 'registry.json');
}

export function loadRegistry(policy: GlobalPolicy): ApprovedSkill[] {
  const p = registryPath(policy);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')) as ApprovedSkill[];
}

export function saveRegistry(policy: GlobalPolicy, skills: ApprovedSkill[]): void {
  mkdirSync(policy.skillsDir, { recursive: true });
  writeFileSync(registryPath(policy), `${JSON.stringify(skills, null, 2)}\n`);
}

/** §19.3：核准只能由使用者顯式操作，Harness 絕不自動把新 hash 寫回 registry。 */
export function approveSkill(policy: GlobalPolicy, id: string, dir: string, opts?: { scriptsAllowed?: boolean; externalRefsAllowed?: boolean }): ApprovedSkill {
  const skill: ApprovedSkill = {
    id,
    path: dir,
    approvedHash: hashSkillDir(dir),
    scriptsAllowed: opts?.scriptsAllowed ?? false,
    externalRefsAllowed: opts?.externalRefsAllowed ?? false,
  };
  const all = loadRegistry(policy).filter((s) => s.id !== id);
  all.push(skill);
  saveRegistry(policy, all);
  return skill;
}

function contentViolations(skill: ApprovedSkill): string[] {
  const bad: string[] = [];
  for (const rel of walk(skill.path)) {
    const dot = rel.lastIndexOf('.');
    const ext = dot >= 0 ? rel.slice(dot).toLowerCase() : '';
    if (!skill.scriptsAllowed && SCRIPT_EXT.has(ext)) bad.push(`含腳本檔案：${rel}`);
    if (!skill.externalRefsAllowed && (ext === '.md' || ext === '.txt' || ext === '.json')) {
      const text = readFileSync(join(skill.path, rel), 'utf8');
      if (EXTERNAL_REF.test(text)) bad.push(`含外部參照：${rel}`);
    }
  }
  return bad;
}

/** §19.2 admission：registry 存在 → 重算 hash → 相符 → 無禁止內容 → ALLOW。 */
export function admitSkills(policy: GlobalPolicy, requestedIds: readonly string[]): SkillAdmission[] {
  const registry = loadRegistry(policy);
  return requestedIds.map((id) => {
    const skill = registry.find((s) => s.id === id);
    if (!skill) return { skillId: id, allowed: false, reason: '不在 approved skill registry 中' };
    if (!existsSync(skill.path)) return { skillId: id, allowed: false, path: skill.path, reason: `skill 路徑不存在：${skill.path}` };
    const actual = hashSkillDir(skill.path);
    if (actual !== skill.approvedHash) {
      return { skillId: id, allowed: false, path: skill.path, actualHash: actual, reason: `hash 不符（approved=${skill.approvedHash.slice(0, 12)} actual=${actual.slice(0, 12)}）：這是未核准的新版本` };
    }
    const bad = contentViolations(skill);
    if (bad.length) return { skillId: id, allowed: false, path: skill.path, actualHash: actual, reason: bad.join('；') };
    return { skillId: id, allowed: true, path: skill.path, actualHash: actual, reason: 'ok' };
  });
}
