#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { loadPolicy } from './policy.ts';
import { Store } from './trace/store.ts';
import { Orchestrator } from './orchestrator.ts';
import { detectCandidate, loadSnapshot, CONTRACT_REL_PATH, ContractError } from './repo/contract.ts';
import { approveSkill, loadRegistry, admitSkills } from './security/skills.ts';
import { ensureRuntimeDirs } from './runtime/isolation.ts';
import { runIsolated } from './evidence/exec.ts';

const USAGE = `harness — Agent Work Harness (MVP)

  harness init [dir]                    產生候選 .harness/config.json（需人工確認後才生效）
  harness new "<需求>" [--dir .] [--title T] [--retry N]
  harness run <workId>                  執行下一個 attempt
  harness retry <workId>                以 previous evidence 建立 retry attempt
  harness answer <workId> "<回覆>"       記錄使用者決策（不累積對話）
  harness recover <workId>              重新收集中斷 attempt 的 evidence
  harness list                          列出所有 work
  harness show <workId>                 contract / decisions / attempts / evidence
  harness trace <workId>                append-only 事件流
  harness prompt <attemptId>            印出該 attempt 實際送出的 prompt
  harness skills list|approve <id> <dir>
  harness doctor [dir]                  檢查 runtime 與隔離是否真的生效
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const policy = loadPolicy();
  ensureRuntimeDirs(policy);
  const store = new Store(policy.stateDir);
  const log = (m: string): void => { process.stderr.write(`  · ${m}\n`); };
  const orch = new Orchestrator(policy, store, log);

  // §D5：每次啟動先處理殘留 RUNNING attempt
  const crashed = orch.markCrashedAttempts();
  for (const a of crashed) console.error(`! attempt ${a.id}（work ${a.workId}）在執行中中斷 → RECOVERY_REQUIRED，請執行 harness recover ${a.workId}`);

  switch (cmd) {
    case 'init': {
      const dir = resolve(rest[0] ?? '.');
      const target = join(dir, CONTRACT_REL_PATH);
      if (existsSync(target)) { console.error(`已存在：${target}`); return 1; }
      const candidate = detectCandidate(dir, dir.split('/').pop() ?? 'repo');
      mkdirSync(join(dir, '.harness'), { recursive: true });
      writeFileSync(target, `${JSON.stringify(candidate, null, 2)}\n`);
      console.log(`已寫入候選設定：${target}`);
      console.log('這是自動偵測的 candidate，請人工確認 entryPoints / protectedPaths / verification 後再使用。');
      console.log(readFileSync(target, 'utf8'));
      return 0;
    }

    case 'new': {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true,
        options: { dir: { type: 'string' }, title: { type: 'string' }, retry: { type: 'string' } },
      });
      const request = positionals[0];
      if (!request) { console.error('需要需求文字'); return 1; }
      const workspace = resolve(values.dir ?? '.');
      try {
        const work = orch.createWork({ request, workspace, title: values.title });
        if (values.retry) store.db.prepare('update works set retry_budget = ? where id = ?').run(Number(values.retry), work.id);
        const contract = store.getContract(work.id, 1)!;
        console.log(`work: ${work.id}  repo: ${work.repositoryId}  mode: ${contract.mode}`);
        console.log(`denied: ${contract.deniedPaths.join(', ') || '(僅 repo protectedPaths)'}`);
        console.log(`allowed: ${contract.allowedPaths?.join(', ') ?? '整個 worktree'}`);
        console.log(`constraints: ${contract.constraints.join(' / ') || '(無機械可解析者，原文保留在 request)'}`);
        console.log(`\n下一步：harness run ${work.id}`);
        return 0;
      } catch (e) {
        if (e instanceof ContractError) { console.error(`BLOCKED ${e.code}: ${e.message}`); return 2; }
        throw e;
      }
    }

    case 'run': case 'retry': case 'recover': {
      const workId = rest[0];
      if (!workId) { console.error('需要 workId'); return 1; }
      const report = cmd === 'run' ? await orch.runAttempt(workId)
        : cmd === 'retry' ? await orch.retry(workId)
        : await orch.recover(workId);
      console.log(`\n${report.response}\n`);
      return report.decision.outcome === 'SUCCESS' ? 0 : 3;
    }

    case 'answer': {
      const [workId, text] = rest;
      if (!workId || !text) { console.error('用法：harness answer <workId> "<回覆>"'); return 1; }
      const added = orch.answer(workId, text);
      console.log(added.length ? `已記錄 ${added.length} 筆決策：` : '沒有可機械解析的新決策（原文已保留）');
      for (const d of added) console.log(`- ${d.kind}: ${d.value}`);
      console.log(`\n下一步：harness retry ${workId}`);
      return 0;
    }

    case 'list': {
      for (const w of store.listWorks()) {
        console.log(`${w.id}  ${w.state.padEnd(12)} ${w.repositoryId.padEnd(16)} ${w.title}`);
      }
      return 0;
    }

    case 'show': {
      const workId = rest[0];
      const work = workId ? store.getWork(workId) : null;
      if (!work) { console.error('找不到 work'); return 1; }
      const contract = store.getContract(work.id, work.currentContractVersion)!;
      console.log(`work ${work.id}  state=${work.state}  repo=${work.repositoryId}`);
      console.log(`workspace: ${work.workspace}`);
      console.log(`\n[contract v${contract.version}] mode=${contract.mode}`);
      console.log(`request: ${contract.request}`);
      console.log(`denied: ${contract.deniedPaths.join(', ') || '-'}`);
      console.log(`allowed: ${contract.allowedPaths?.join(', ') ?? '整個 worktree'}`);
      console.log(`constraints: ${contract.constraints.join(' / ') || '-'}`);
      console.log(`success criteria (semantic): ${contract.successCriteria.join(' / ')}`);
      console.log('\n[decisions]');
      for (const d of store.listDecisions(work.id)) console.log(`- ${d.kind}: ${d.value}  (${d.sourceMessageId})`);
      console.log('\n[attempts]');
      for (const a of store.listAttempts(work.id)) {
        console.log(`- #${a.number} ${a.id} ${a.mode} ${a.status} base=${a.baseRevision.slice(0, 8)} contract=v${a.contractVersion} snapshot=${a.contractSnapshotHash.slice(0, 8)}${a.retryOf ? ` retryOf=${a.retryOf}` : ''}`);
        for (const e of store.listEvidence(a.id)) console.log(`    · ${e.type} ${e.label}: ${e.status}`);
      }
      const last = store.lastOutcome(work.id);
      if (last) console.log(`\n[outcome] ${last.outcome}: ${last.reasons.join(' / ')}`);
      return 0;
    }

    case 'trace': {
      const workId = rest[0];
      if (!workId) { console.error('需要 workId'); return 1; }
      for (const e of store.events(workId)) {
        console.log(`${String(e.seq).padStart(4)} ${e.created_at} ${e.type.padEnd(26)} ${e.attempt_id ?? '-'} ${e.data}`);
      }
      return 0;
    }

    case 'prompt': {
      const attemptId = rest[0];
      const attempt = attemptId ? store.getAttempt(attemptId) : null;
      if (!attempt) { console.error('找不到 attempt'); return 1; }
      console.log(store.readArtifact(attempt.promptArtifactId) ?? '(prompt artifact 不存在)');
      return 0;
    }

    case 'skills': {
      const [sub, id, dir] = rest;
      if (sub === 'list') {
        const reg = loadRegistry(policy);
        if (!reg.length) console.log('(registry 為空)');
        const admissions = admitSkills(policy, reg.map((s) => s.id));
        for (const s of reg) {
          const a = admissions.find((x) => x.skillId === s.id)!;
          console.log(`${s.id.padEnd(20)} ${a.allowed ? 'OK  ' : 'DENY'} ${s.approvedHash.slice(0, 12)} ${s.path}${a.allowed ? '' : `  (${a.reason})`}`);
        }
        return 0;
      }
      if (sub === 'approve' && id && dir) {
        const s = approveSkill(policy, id, resolve(dir));
        console.log(`已核准 ${s.id} @ ${s.approvedHash.slice(0, 16)}（scripts=${s.scriptsAllowed} externalRefs=${s.externalRefsAllowed}）`);
        return 0;
      }
      console.error('用法：harness skills list | harness skills approve <id> <dir>');
      return 1;
    }

    case 'doctor': {
      const dir = resolve(rest[0] ?? '.');
      console.log(`state dir       : ${policy.stateDir}`);
      console.log(`agent HOME      : ${policy.agentHome}`);
      console.log(`codex HOME      : ${policy.codexHome}`);
      const probe = await runIsolated(policy, ['sh', '-c',
        'printf "HOME=%s\\n" "$HOME"; ls -a "$HOME" | tr "\\n" " "; echo; ' +
        'cat /home/*/.secrets 2>&1 | head -c 30; echo; ' +
        'curl -sS -m 3 -o /dev/null -w "net=%{http_code}" https://example.com 2>&1 | head -1'],
        { workspace: dir, writable: false, timeoutMs: 30_000 });
      console.log('--- verification sandbox probe ---');
      console.log(probe.stdout.trim() || '(no stdout)');
      if (probe.stderr.trim()) console.log(`stderr: ${probe.stderr.trim()}`);
      const leaked = /sk-|BEGIN .*PRIVATE KEY|net=[123]\d\d/.test(probe.stdout);
      console.log(leaked ? '結果：隔離異常，請勿使用' : '結果：HOME 隔離與 network deny 生效');
      try {
        const snap = loadSnapshot(dir, policy);
        console.log(`\nrepository contract: ${snap.contract.repositoryId} (hash ${snap.hash.slice(0, 12)})`);
        console.log(`checks: ${snap.contract.verification.checks.map((c) => `${c.id}${c.required ? '*' : ''}`).join(', ') || '(無)'}`);
        console.log(`protected: ${snap.contract.filesystem.protectedPaths.join(', ')}`);
      } catch (e) {
        console.log(`\nrepository contract: ${(e as Error).message}`);
      }
      return leaked ? 4 : 0;
    }

    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e: unknown) => { console.error(`error: ${(e as Error).message}\n${(e as Error).stack ?? ''}`); process.exit(1); });
