import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitSkills, approveSkill, hashSkillDir } from '../src/security/skills.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import type { GlobalPolicy } from '../src/types.ts';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'harness-skill-'));
  const skillDir = join(base, 'debugging');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# debugging\n先讀 log 再猜。\n');
  const policy: GlobalPolicy = { ...DEFAULT_POLICY, skillsDir: join(base, 'registry') };
  return { base, skillDir, policy };
}

test('核准後 admission 通過；內容改動後 fail-closed', () => {
  const { base, skillDir, policy } = fixture();
  approveSkill(policy, 'debugging', skillDir);
  assert.equal(admitSkills(policy, ['debugging'])[0]!.allowed, true);

  writeFileSync(join(skillDir, 'SKILL.md'), '# debugging\n被竄改\n');
  const denied = admitSkills(policy, ['debugging'])[0]!;
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /hash 不符/);
  rmSync(base, { recursive: true, force: true });
});

test('hash 涵蓋整個目錄，不只 SKILL.md', () => {
  const { base, skillDir, policy } = fixture();
  const before = hashSkillDir(skillDir);
  writeFileSync(join(skillDir, 'notes.md'), 'extra');
  assert.notEqual(hashSkillDir(skillDir), before);
  assert.equal(admitSkills(policy, ['unknown'])[0]!.allowed, false);
  rmSync(base, { recursive: true, force: true });
});

test('預設拒絕腳本與外部參照', () => {
  const { base, skillDir, policy } = fixture();
  writeFileSync(join(skillDir, 'run.sh'), 'echo hi');
  approveSkill(policy, 'debugging', skillDir);
  const a = admitSkills(policy, ['debugging'])[0]!;
  assert.equal(a.allowed, false);
  assert.match(a.reason, /腳本/);
  rmSync(base, { recursive: true, force: true });
});

test('admission 回傳 registry 中的實際路徑，供 driver 複製', () => {
  const { base, skillDir, policy } = fixture();
  approveSkill(policy, 'debugging', skillDir);
  const a = admitSkills(policy, ['debugging'])[0]!;
  assert.equal(a.path, skillDir);
  rmSync(base, { recursive: true, force: true });
});
