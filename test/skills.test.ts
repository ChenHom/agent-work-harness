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

test('預設拒絕腳本', () => {
  const { base, skillDir, policy } = fixture();
  writeFileSync(join(skillDir, 'run.sh'), 'echo hi');
  approveSkill(policy, 'debugging', skillDir);
  const a = admitSkills(policy, ['debugging'])[0]!;
  assert.equal(a.allowed, false);
  assert.match(a.reason, /腳本/);
  rmSync(base, { recursive: true, force: true });
});

// ------------------------------------------------ §19.2 外部參照檢查
// mutation 測試（D-32）發現這條 gate 完全沒被驗證：把 skills.ts:70 的 `!` 拿掉、
// 把副檔名清單改空、把整段刪掉，155 條測試沒有一條會紅。原本唯一相關的測試
// 叫「預設拒絕腳本與外部參照」，但它只寫了 run.sh —— 只測到腳本那一半。
// 外部參照是 prompt injection 的入口，這裡把三種形態與三種放行條件都釘住。

/** 內容必須在 approveSkill 之前寫入，否則 hash 不符會先擋下來，測不到內容檢查。 */
function withFile(name: string, body: string, opts?: { externalRefsAllowed?: boolean; scriptsAllowed?: boolean }) {
  const f = fixture();
  writeFileSync(join(f.skillDir, name), body);
  approveSkill(f.policy, 'debugging', f.skillDir, opts);
  return { ...f, admission: admitSkills(f.policy, ['debugging'])[0]! };
}

test('外部參照 反向：.md 裡的 https:// 會被擋下', () => {
  const { base, admission } = withFile('notes.md', '參考 https://evil.example/payload');
  assert.equal(admission.allowed, false);
  assert.match(admission.reason, /外部參照/);
  rmSync(base, { recursive: true, force: true });
});

test('外部參照 反向：.txt 裡的 git@ 會被擋下', () => {
  const { base, admission } = withFile('refs.txt', 'clone git@github.com:evil/repo.git');
  assert.equal(admission.allowed, false);
  assert.match(admission.reason, /外部參照/);
  rmSync(base, { recursive: true, force: true });
});

test('外部參照 反向：.json 裡的 ssh:// 會被擋下', () => {
  const { base, admission } = withFile('cfg.json', '{"remote":"ssh://evil.example/x"}');
  assert.equal(admission.allowed, false);
  assert.match(admission.reason, /外部參照/);
  rmSync(base, { recursive: true, force: true });
});

test('外部參照 正向：沒有外部參照的 .md 照常放行', () => {
  const { base, admission } = withFile('notes.md', '先讀 log 再猜，不要臆測。');
  assert.equal(admission.allowed, true);
  rmSync(base, { recursive: true, force: true });
});

test('外部參照 正向：明確核准 externalRefsAllowed 時放行', () => {
  const { base, admission } = withFile('notes.md', '見 https://internal.example/runbook', { externalRefsAllowed: true });
  assert.equal(admission.allowed, true, '這是核准過的例外，不是漏擋');
  rmSync(base, { recursive: true, force: true });
});

test('外部參照 正向：不在檢查清單的副檔名不掃內容', () => {
  const { base, admission } = withFile('data.yaml', 'url: https://example.com');
  assert.equal(admission.allowed, true, '檢查範圍就是 .md/.txt/.json，不是所有檔案');
  rmSync(base, { recursive: true, force: true });
});

test('外部參照 邊界：沒有 :// 的 http 字樣不算外部參照', () => {
  const { base, admission } = withFile('notes.md', '用 http 而不是 https 傳輸是不安全的');
  assert.equal(admission.allowed, true, 'EXTERNAL_REF 認的是 scheme，不是關鍵字');
  rmSync(base, { recursive: true, force: true });
});

test('外部參照 邊界：腳本與外部參照同時存在時，兩個理由都要列出', () => {
  const { base, skillDir, policy } = fixture();
  writeFileSync(join(skillDir, 'run.sh'), 'echo hi');
  writeFileSync(join(skillDir, 'notes.md'), '見 https://evil.example');
  approveSkill(policy, 'debugging', skillDir);
  const a = admitSkills(policy, ['debugging'])[0]!;
  assert.equal(a.allowed, false);
  assert.match(a.reason, /腳本/);
  assert.match(a.reason, /外部參照/, '只回報第一個違規會讓使用者修完一輪又被擋一次');
  rmSync(base, { recursive: true, force: true });
});

test('外部參照 邊界：檔名本身就是 .md 的檔案一樣要掃（不能靠檔名繞過）', () => {
  // lastIndexOf('.') === 0 —— 副檔名解析若寫成 dot > 0，這種檔就會整個跳過掃描
  const { base, admission } = withFile('.md', '見 https://evil.example');
  assert.equal(admission.allowed, false);
  assert.match(admission.reason, /外部參照/);
  rmSync(base, { recursive: true, force: true });
});

test('外部參照 邊界：完全沒有副檔名的檔案不掃內容', () => {
  const { base, admission } = withFile('Makefile', 'fetch: curl https://example.com');
  assert.equal(admission.allowed, true, '沒有點就沒有副檔名，不該把整個檔名當副檔名');
  rmSync(base, { recursive: true, force: true });
});

test('外部參照 邊界：scriptsAllowed 與 externalRefsAllowed 各管各的', () => {
  const { base, admission } = withFile('run.sh', 'curl https://example.com', { scriptsAllowed: true });
  assert.equal(admission.allowed, true, '.sh 不在內容掃描清單，核准腳本就該放行');
  rmSync(base, { recursive: true, force: true });
});

test('admission 回傳 registry 中的實際路徑，供 driver 複製', () => {
  const { base, skillDir, policy } = fixture();
  approveSkill(policy, 'debugging', skillDir);
  const a = admitSkills(policy, ['debugging'])[0]!;
  assert.equal(a.path, skillDir);
  rmSync(base, { recursive: true, force: true });
});
