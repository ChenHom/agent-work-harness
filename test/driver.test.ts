import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { CodexDriver } from '../src/runtime/codex-driver.ts';
import { bwrapArgv } from '../src/runtime/isolation.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import type { GlobalPolicy } from '../src/types.ts';

function policyIn(base: string): GlobalPolicy {
  return {
    ...DEFAULT_POLICY,
    stateDir: join(base, 'state'),
    agentHome: join(base, 'state/agent-home'),
    codexHome: join(base, 'state/codex-home'),
    verificationHome: join(base, 'state/verification-home'),
    skillsDir: join(base, 'state/skills'),
  };
}

test('prepare：argv 反映 mode，read 用 read-only', () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-drv-'));
  const policy = policyIn(base);
  const d = new CodexDriver(policy);
  const r = d.prepare({ attemptId: 'A-1', workspace: base, mode: 'read', promptText: 'hi', approvedSkillPaths: [] });
  assert.ok(r.argv.includes('read-only'));
  assert.ok(!r.argv.includes('workspace-write'));
  assert.ok(r.argv.includes('--ignore-rules'));
  assert.ok(r.argv.includes('-c') && r.argv.includes('project_doc_max_bytes=0'));
  assert.equal(readFileSync(r.promptPath, 'utf8'), 'hi');

  const w = d.prepare({ attemptId: 'A-2', workspace: base, mode: 'write', promptText: 'hi', approvedSkillPaths: [] });
  assert.ok(w.argv.includes('workspace-write'));
  rmSync(base, { recursive: true, force: true });
});

test('prepare：隔離環境變數不洩漏操作者 HOME', () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-drv-'));
  const policy = policyIn(base);
  const r = new CodexDriver(policy).prepare({ attemptId: 'A-1', workspace: base, mode: 'read', promptText: 'x', approvedSkillPaths: [] });
  assert.equal(r.env.HOME, policy.agentHome);
  assert.equal(r.env.CODEX_HOME, policy.codexHome);
  assert.notEqual(r.env.HOME, homedir());
  const config = readFileSync(join(policy.codexHome, 'config.toml'), 'utf8');
  assert.match(config, /network_access = false/);
  rmSync(base, { recursive: true, force: true });
});

test('prepare：approved skill 被複製並寫入 codex config，未核准的不會出現', () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-drv-'));
  const policy = policyIn(base);
  const skill = join(base, 'my-skill');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# my-skill\n');

  const d = new CodexDriver(policy);
  d.prepare({ attemptId: 'A-1', workspace: base, mode: 'read', promptText: 'x', approvedSkillPaths: [skill] });
  const copied = join(policy.codexHome, 'skills/my-skill/SKILL.md');
  assert.ok(existsSync(copied), 'skill 應被複製進 CODEX_HOME');
  const config = readFileSync(join(policy.codexHome, 'config.toml'), 'utf8');
  assert.match(config, /\[\[skills\.config\]\]/);
  assert.match(config, /my-skill\/SKILL\.md/);

  // 下一次 attempt 不帶 skill → 舊的必須消失（fail-closed）
  d.prepare({ attemptId: 'A-2', workspace: base, mode: 'read', promptText: 'x', approvedSkillPaths: [] });
  assert.ok(!existsSync(copied), '未核准時舊 skill 必須被移除');
  assert.doesNotMatch(readFileSync(join(policy.codexHome, 'config.toml'), 'utf8'), /\[\[skills\.config\]\]/);
  rmSync(base, { recursive: true, force: true });
});

test('bwrap argv：遮蔽 /home，只 bind 需要的路徑，且不共享網路', () => {
  const argv = bwrapArgv({ workspace: '/w', home: '/vh', readOnlyBinds: ['/tool'], writable: false });
  const s = argv.join(' ');
  assert.match(s, /--unshare-all/);
  assert.match(s, /--tmpfs \/home/);
  assert.match(s, /--ro-bind-try \/tool \/tool/);
  assert.match(s, /--bind \/vh \/vh/);
  assert.match(s, /--ro-bind \/w \/w/);       // writable: false
  assert.ok(!s.includes('--ro-bind / /'));    // 絕不整個根目錄 bind
  const rw = bwrapArgv({ workspace: '/w', home: '/vh', readOnlyBinds: [], writable: true }).join(' ');
  assert.match(rw, /--bind \/w \/w/);
});

test('run reports the managed child identity and a stopped receipt', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-drv-'));
  const policy = { ...policyIn(base), codexBin: process.execPath };
  const promptPath = join(base, 'prompt.txt');
  const lastMessagePath = join(base, 'last.json');
  const logPath = join(base, 'runtime.log');
  writeFileSync(promptPath, '');
  const states: Array<{ phase: string; child: { pid: number; processStart: string } | null; quiesced: boolean }> = [];
  const result = await new CodexDriver(policy).run({
    attemptDir: base, promptPath, lastMessagePath, logPath,
    argv: ['-e', 'process.stdout.write("ok")'], env: process.env, cwd: base,
  }, (state) => states.push(state));

  assert.equal(result.exitCode, 0);
  const running = states.find((state) => state.phase === 'running');
  assert.ok(running?.child?.pid);
  assert.ok(running?.child?.processStart);
  assert.deepEqual(states.at(-1), { phase: 'stopped', child: running.child, quiesced: true });
  rmSync(base, { recursive: true, force: true });
});

test('spawn error and close produce only one stopped receipt', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-drv-'));
  const policy = { ...policyIn(base), codexBin: join(base, 'missing-codex') };
  const promptPath = join(base, 'prompt.txt');
  writeFileSync(promptPath, '');
  const phases: string[] = [];
  const result = await new CodexDriver(policy).run({
    attemptDir: base,
    promptPath,
    lastMessagePath: join(base, 'last.json'),
    logPath: join(base, 'runtime.log'),
    argv: [], env: process.env, cwd: base,
  }, (state) => phases.push(state.phase));

  assert.equal(result.exitCode, null);
  assert.equal(phases.filter((phase) => phase === 'stopped').length, 1);
  assert.equal(phases.at(-1), 'stopped');
  rmSync(base, { recursive: true, force: true });
});

test('a rejected launching receipt prevents spawning the child', async () => {
  const base = mkdtempSync(join(tmpdir(), 'harness-drv-'));
  const marker = join(base, 'spawned');
  const promptPath = join(base, 'prompt.txt');
  writeFileSync(promptPath, '');
  const phases: string[] = [];

  await assert.rejects(new CodexDriver({ ...policyIn(base), codexBin: process.execPath }).run({
    attemptDir: base,
    promptPath,
    lastMessagePath: join(base, 'last.json'),
    logPath: join(base, 'runtime.log'),
    argv: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
    env: process.env,
    cwd: base,
  }, (state) => {
    phases.push(state.phase);
    throw new Error('ownership update rejected');
  }), /ownership update rejected/);

  assert.equal(existsSync(marker), false);
  assert.deepEqual(phases, ['launching']);
  rmSync(base, { recursive: true, force: true });
});
