#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { loadPolicy } from './policy.ts';
import { Store, StoreOpenError } from './trace/store.ts';
import { Orchestrator } from './orchestrator.ts';
import { PlanService, type PlanProposal } from './work/plans.ts';
import { CheckpointService } from './trace/checkpoints.ts';
import { detectCandidate, loadSnapshot, CONTRACT_REL_PATH, ContractError } from './repo/contract.ts';
import { approveSkill, loadRegistry, admitSkills } from './security/skills.ts';
import { ensureRuntimeDirs } from './runtime/isolation.ts';
import {
  acquireExecutionOwnership, inspectExecutionOwnership, type ExecutionOwnership,
} from './runtime/ownership.ts';
import { localDispatchAuthority } from './runtime/dispatch-authority.ts';
import { runIsolated } from './evidence/exec.ts';
import {
  formatContextDropped, formatPreExistingDirty, formatRecoverySession, formatWorkListRow,
  formatBudget, formatCheckpoint, formatCompensation, formatMilestone, formatOperation, formatPlan,
} from './cli-format.ts';
import { formatPromptChars } from './response.ts';
import type { GlobalPolicy } from './types.ts';
import { BudgetLedger } from './budget/ledger.ts';
import { FakeProvider } from './tools/fake-provider.ts';
import { OperationGateway } from './tools/gateway.ts';
import { CompensationWorkflow } from './tools/compensation.ts';

const USAGE = `harness — Agent Work Harness (MVP)

  harness init [dir]                    產生候選 .harness/config.json（需人工確認後才生效）
  harness new "<需求>" [--dir .] [--title T] [--retry N]
  harness run <workId> [--milestone M] [--no-baseline]  執行下一個 attempt
  harness retry <workId> [--milestone M] [--no-baseline]  以 previous evidence 建立 retry attempt
  harness answer <workId> "<回覆>"       記錄使用者決策（不累積對話）
  harness amend <workId> "<新版目標>"     建立新版 goal contract（保留既有限制）
  harness plan propose <workId> <json-file>
  harness plan activate <planId>
  harness plan fork <checkpointId> <json-file>
  harness checkpoint create <workId> <json-file>
  harness checkpoint resume <checkpointId>
  harness recover <workId>              重新收集中斷 attempt 的 evidence
  harness list                          列出所有 work
  harness show <workId>                 contract / decisions / attempts / evidence
  harness trace <workId>                append-only 事件流
  harness prompt <attemptId>            印出該 attempt 實際送出的 prompt
  harness note <workId> <kind> "<說明>"  記錄使用中發現的問題（見下方 kind）
  harness notes [kind]                  列出所有記錄
  harness stats                         work / attempt / retry / outcome 彙總
  harness ownership                     顯示目前 execution ownership（唯讀）
  harness fake budget configure <workId> <kind> <limit> <pricing> [currency]
  harness fake budget show <workId>      顯示 Work 預算與 reservation（唯讀）
  harness fake operation prepare <workId> <json-file>
  harness fake operation dispatch|reconcile <operationId>
  harness fake operation show <workId>   顯示 operation／compensation（唯讀）
  harness fake compensation prepare <operationId> <json-file>
  harness fake compensation dispatch|reconcile <compensationId>
  harness skills list|approve <id> <dir>
  harness doctor [dir]                  檢查 runtime 與隔離是否真的生效

note 的 kind 對應 DECISIONS.md 的升級判準：
  false-accept   evidence 判 PASS，但實際上是壞的
  false-block    正當的工作被錯誤擋下
  retry-churn    因 context 或 evidence 不足而反覆重跑
  blocked-work   某類工作因為已知限制根本做不了
  friction       為了繞過某個限制必須反覆做額外的事
  other          其他值得記下來的觀察
`;

const NOTE_KINDS = ['false-accept', 'false-block', 'retry-churn', 'blocked-work', 'friction', 'other'];

const STORE_COMMANDS = new Set([
  'new', 'run', 'retry', 'recover', 'answer', 'amend', 'plan', 'checkpoint',
  'list', 'show', 'trace', 'prompt', 'note', 'notes', 'stats', 'fake',
]);
const READ_ONLY_COMMANDS = new Set(['list', 'show', 'trace', 'prompt', 'notes', 'stats']);
const MUTATING_COMMANDS = new Set([
  'init', 'new', 'run', 'retry', 'recover', 'answer', 'amend', 'plan', 'checkpoint', 'note', 'doctor', 'fake',
]);

function isReadOnlyCommand(cmd: string | undefined, rest: string[]): boolean {
  return Boolean(cmd && (READ_ONLY_COMMANDS.has(cmd)
    || (cmd === 'fake' && rest[1] === 'show')));
}

export async function main(argv: string[], policy: GlobalPolicy = loadPolicy()): Promise<number> {
  const [cmd, ...rest] = argv;
  let store: Store | undefined;
  let ownership: ExecutionOwnership | undefined;
  try {
    const readOnlyCommand = isReadOnlyCommand(cmd, rest);
    if ((cmd && MUTATING_COMMANDS.has(cmd) && !readOnlyCommand) || (cmd === 'skills' && rest[0] === 'approve')) {
      ownership = acquireExecutionOwnership(policy.stateDir);
    }
    if (cmd && STORE_COMMANDS.has(cmd)) {
      store = new Store(policy.stateDir, { readOnly: readOnlyCommand });
    }
    const log = (m: string): void => { process.stderr.write(`  · ${m}\n`); };
    const orch = store && !readOnlyCommand ? new Orchestrator(policy, store, log) : undefined;

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
        const work = orch!.createWork({ request, workspace, title: values.title }, ownership);
        if (values.retry) store!.db.prepare('update works set retry_budget = ? where id = ?').run(Number(values.retry), work.id);
        const contract = store!.getContract(work.id, 1)!;
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
      // pre-flight baseline 讓 verification 時間翻倍；測試很慢的 repo 可以關掉，
      // 代價是失去「有沒有比動手前少跑」這個判斷。
      const noBaseline = rest.includes('--no-baseline');
      const milestoneOption = rest.indexOf('--milestone');
      const milestoneId = milestoneOption >= 0 ? rest[milestoneOption + 1] : undefined;
      const report = cmd === 'run' ? await orch!.runAttempt(workId, { noBaseline, milestoneId, ownership })
        : cmd === 'retry' ? await orch!.retry(workId, { noBaseline, milestoneId, ownership })
        : await orch!.recover(workId, ownership);
      console.log(`\n${report.response}\n`);
      return report.decision.outcome === 'SUCCESS' ? 0 : 3;
    }

    case 'answer': {
      const [workId, text] = rest;
      if (!workId || !text) { console.error('用法：harness answer <workId> "<回覆>"'); return 1; }
      const added = orch!.answer(workId, text, ownership);
      console.log(added.length ? `已記錄 ${added.length} 筆決策：` : '沒有可機械解析的新決策（原文已保留）');
      for (const d of added) console.log(`- ${d.kind}: ${d.value}`);
      console.log(`\n下一步：harness retry ${workId}`);
      return 0;
    }

    case 'amend': {
      const [workId, request] = rest;
      if (!workId || !request) { console.error('用法：harness amend <workId> "<新版目標>"'); return 1; }
      const contract = orch!.amend(workId, request, ownership);
      console.log(`contract: ${contract.id} v${contract.version}`);
      console.log(`request: ${contract.request}`);
      console.log(`denied: ${contract.deniedPaths.join(', ') || '-'}`);
      console.log(`constraints: ${contract.constraints.join(' / ') || '-'}`);
      return 0;
    }

    case 'plan': {
      const [sub, id, jsonPath] = rest;
      const plans = new PlanService(store!);
      if (sub === 'propose' && id && jsonPath) {
        const work = store!.getWork(id);
        if (!work) { console.error(`找不到 work ${id}`); return 1; }
        const input = readJson(jsonPath) as Omit<PlanProposal, 'workId'>;
        const proposed = plans.propose({ ...input, workId: id });
        console.log(`plan: ${proposed.plan.id} status=${proposed.plan.status} branch=${proposed.plan.branchId}`);
        for (const milestone of proposed.milestones) console.log(formatMilestone(milestone));
        return 0;
      }
      if (sub === 'activate' && id) {
        const activated = plans.activate(id);
        console.log(`plan: ${activated.id} status=${activated.status} branch=${activated.branchId}`);
        return 0;
      }
      if (sub === 'fork' && id && jsonPath) {
        const input = readJson(jsonPath) as { reason: string; milestones: PlanProposal['milestones'] };
        const forked = new CheckpointService(store!).fork({
          checkpointId: id, reason: input.reason, milestones: input.milestones,
        });
        console.log(`plan: ${forked.plan.id} status=${forked.plan.status} branch=${forked.plan.branchId}`
          + ` sourceCheckpoint=${forked.plan.sourceCheckpointId}`);
        return 0;
      }
      console.error('用法：harness plan propose <workId> <json-file> | activate <planId> | fork <checkpointId> <json-file>');
      return 1;
    }

    case 'checkpoint': {
      const [sub, id, jsonPath] = rest;
      const checkpoints = new CheckpointService(store!);
      if (sub === 'create' && id && jsonPath) {
        const input = readJson(jsonPath) as Parameters<CheckpointService['create']>[0];
        const checkpoint = checkpoints.create({ ...input, workId: id });
        console.log(`checkpoint: ${checkpoint.id} branch=${checkpoint.branchId} plan=${checkpoint.planId}`);
        return 0;
      }
      if (sub === 'resume' && id) {
        const resumed = checkpoints.resume(id);
        console.log(`checkpoint: ${resumed.checkpoint.id} branch=${resumed.checkpoint.branchId}`
          + ` plan=${resumed.activePlan.id} validation=${resumed.checkpoint.validationStatus}`);
        return 0;
      }
      console.error('用法：harness checkpoint create <workId> <json-file> | resume <checkpointId>');
      return 1;
    }

    case 'list': {
      const works = store!.listWorks();
      if (!works.length) console.log('(沒有 work)');
      for (const w of works) {
        console.log(formatWorkListRow(w, store!.lastOutcome(w.id)?.outcome ?? null));
      }
      return 0;
    }

    case 'show': {
      const workId = rest[0];
      const work = workId ? store!.getWork(workId) : null;
      if (!work) { console.error('找不到 work'); return 1; }
      const contract = store!.getContract(work.id, work.currentContractVersion)!;
      console.log(`work ${work.id}  state=${work.state}  repo=${work.repositoryId}`);
      console.log(`workspace: ${work.workspace}`);
      console.log(`\n[contract v${contract.version}] mode=${contract.mode}`);
      console.log(`request: ${contract.request}`);
      console.log(`denied: ${contract.deniedPaths.join(', ') || '-'}`);
      console.log(`allowed: ${contract.allowedPaths?.join(', ') ?? '整個 worktree'}`);
      console.log(`constraints: ${contract.constraints.join(' / ') || '-'}`);
      console.log(`success criteria (semantic): ${contract.successCriteria.join(' / ')}`);
      console.log('\n[decisions]');
      for (const d of store!.listDecisions(work.id)) console.log(`- ${d.kind}: ${d.value}  (${d.sourceMessageId})`);
      console.log('\n[active plan]');
      const activePlan = store!.getActivePlan(work.id);
      if (!activePlan) console.log('(none)');
      else {
        console.log(formatPlan(activePlan));
        for (const milestone of store!.listMilestones(activePlan.id)) console.log(formatMilestone(milestone));
      }
      console.log('\n[checkpoints]');
      const checkpoints = store!.listCheckpoints(work.id);
      if (!checkpoints.length) console.log('(none)');
      for (const checkpoint of checkpoints) console.log(formatCheckpoint(checkpoint));
      console.log('\n[attempts]');
      for (const a of store!.listAttempts(work.id)) {
        console.log(`- #${a.number} ${a.id} ${a.mode} ${a.status} base=${a.baseRevision.slice(0, 8)} contract=v${a.contractVersion} snapshot=${a.contractSnapshotHash.slice(0, 8)}${a.retryOf ? ` retryOf=${a.retryOf}` : ''}`);
        console.log(formatPromptChars(store!.readArtifact(a.promptArtifactId)));
        console.log(formatPreExistingDirty(a));
        console.log(formatContextDropped(a));
        for (const e of store!.listEvidence(a.id)) console.log(`    · ${e.type} ${e.label}: ${e.status}`);
      }
      const last = store!.lastOutcome(work.id);
      if (last) console.log(`\n[outcome] ${last.outcome}: ${last.reasons.join(' / ')}`);
      const recoverySessions = store!.listRecoverySessions(work.id);
      if (recoverySessions.length) {
        console.log('\n[recovery sessions]');
        for (const session of recoverySessions) console.log(formatRecoverySession(session));
      }
      return 0;
    }

    case 'trace': {
      const workId = rest[0];
      if (!workId) { console.error('需要 workId'); return 1; }
      for (const e of store!.events(workId)) {
        console.log(`${String(e.seq).padStart(4)} ${e.created_at} ${e.type.padEnd(26)} ${e.attempt_id ?? '-'} ${e.data}`);
      }
      return 0;
    }

    case 'prompt': {
      const attemptId = rest[0];
      const attempt = attemptId ? store!.getAttempt(attemptId) : null;
      if (!attempt) { console.error('找不到 attempt'); return 1; }
      console.log(store!.readArtifact(attempt.promptArtifactId) ?? '(prompt artifact 不存在)');
      return 0;
    }

    case 'note': {
      const [workId, kind, text] = rest;
      if (!workId || !kind || !text) { console.error('用法：harness note <workId> <kind> "<說明>"'); return 1; }
      if (!NOTE_KINDS.includes(kind)) { console.error(`kind 必須是：${NOTE_KINDS.join(' / ')}`); return 1; }
      if (!store!.getWork(workId)) { console.error(`找不到 work ${workId}`); return 1; }
      store!.event('usage.note', { kind, text }, workId);
      console.log(`已記錄 [${kind}] ${workId}`);
      // false-accept / false-block 是 watch list 的前兩條升級判準，出現就該被看見
      if (kind === 'false-accept' || kind === 'false-block') {
        console.log('這一類直接對應 DECISIONS.md 的升級判準 —— 累積出模式時，該把對應的 observed limitation 移出 watch list。');
      }
      return 0;
    }

    case 'notes': {
      const kind = rest[0];
      const notes = store!.notes(kind);
      if (!notes.length) { console.log(kind ? `(沒有 ${kind} 的記錄)` : '(還沒有任何記錄)'); return 0; }
      for (const n of notes) {
        console.log(`${n.createdAt.slice(0, 16).replace('T', ' ')}  ${n.kind.padEnd(13)} ${n.workId ?? '-'}`);
        console.log(`    ${n.text}`);
        if (n.title) console.log(`    work: ${n.title.slice(0, 70)}`);
      }
      return 0;
    }

    case 'stats': {
      const st = store!.stats();
      console.log(`works: ${st.works}   attempts: ${st.attempts}   retries: ${st.retries}` +
        (st.attempts ? `   (retry 率 ${Math.round((st.retries / st.attempts) * 100)}%)` : ''));
      console.log('\noutcome 分佈');
      if (!st.outcomes.length) console.log('  (無)');
      for (const o of st.outcomes) console.log(`  ${o.outcome.padEnd(22)} ${o.count}`);
      if (st.notes.length) {
        console.log('\n使用中記錄的問題');
        for (const n of st.notes) console.log(`  ${String(n.kind).padEnd(22)} ${n.count}`);
      }
      return 0;
    }

    case 'ownership': {
      const inspection = inspectExecutionOwnership(policy.stateDir);
      if (!inspection.occupied) { console.log('(沒有 active execution ownership)'); return 0; }
      const metadata = inspection.metadata;
      console.log(`token: ${metadata?.token ?? 'unknown'}`);
      console.log(`owner: ${metadata ? `${metadata.host} pid=${metadata.pid} start=${metadata.processStart}` : 'unknown'}`);
      console.log(`phase: ${metadata?.phase ?? 'unknown'}`);
      console.log(`known child: ${metadata?.child ? `pid=${metadata.child.pid} start=${metadata.child.processStart}` : 'unknown'}`);
      console.log(`blocked reason: ${inspection.blockedReason ?? 'occupied'}`);
      return 0;
    }

    case 'fake': {
      const [area, action, id, extra, extra2, extra3, extra4] = rest;
      if (area === 'budget' && action === 'configure' && id && extra && extra2 && extra3) {
        const limit = new BudgetLedger(store!).configureLimit({
          workId: id, resourceKind: extra, limitUnits: Number(extra2),
          pricingVersion: extra3, currency: extra4,
        });
        console.log(`budget: ${limit.id} ${limit.resourceKind}/${limit.currency ?? '-'} limit=${limit.limitUnits}`);
        return 0;
      }
      if (area === 'budget' && action === 'show' && id) {
        const ledger = new BudgetLedger(store!);
        const limits = store!.listBudgetLimits(id);
        if (!limits.length) console.log('(沒有 budget limit)');
        for (const limit of limits) {
          const summary = ledger.summary(limit.id);
          console.log(formatBudget(
            limit, store!.listBudgetReservations(limit.id), summary.spentUnits, summary.reservedUnits,
          ));
        }
        return 0;
      }
      if (area === 'operation' && action === 'show' && id) {
        const operations = store!.listOperations(id);
        if (!operations.length) console.log('(沒有 operation)');
        for (const operation of operations) {
          console.log(formatOperation(operation));
          const compensation = store!.getCompensationForOperation(operation.id);
          if (compensation) console.log(`  compensation ${formatCompensation(compensation).slice(2)}`);
        }
        return 0;
      }
      const providerDir = join(policy.stateDir, 'fake-provider');
      mkdirSync(providerDir, { recursive: true });
      const budget = new BudgetLedger(store!);
      const provider = new FakeProvider(join(providerDir, 'ledger.json'));
      const gateway = new OperationGateway(store!, budget, provider);
      const compensations = new CompensationWorkflow(store!, budget, provider);
      const dispatchAuthority = localDispatchAuthority(ownership!);
      if (area === 'operation' && action === 'prepare' && id && extra) {
        const input = readJson(extra) as Omit<Parameters<OperationGateway['prepare']>[0], 'workId'>;
        const operation = gateway.prepare({ ...input, workId: id });
        console.log(formatOperation(operation));
        return 0;
      }
      if (area === 'operation' && (action === 'dispatch' || action === 'reconcile') && id) {
        const operation = action === 'dispatch'
          ? await gateway.dispatch(id, dispatchAuthority) : await gateway.reconcile(id, dispatchAuthority);
        console.log(formatOperation(operation));
        return 0;
      }
      if (area === 'compensation' && action === 'prepare' && id && extra) {
        const input = readJson(extra) as Omit<Parameters<CompensationWorkflow['prepare']>[0], 'operationId'>;
        const compensation = compensations.prepare({ ...input, operationId: id });
        console.log(formatCompensation(compensation));
        return 0;
      }
      if (area === 'compensation' && (action === 'dispatch' || action === 'reconcile') && id) {
        const compensation = action === 'dispatch'
          ? await compensations.dispatch(id, dispatchAuthority) : await compensations.reconcile(id, dispatchAuthority);
        console.log(formatCompensation(compensation));
        return 0;
      }
      console.error('用法：harness fake budget configure|show | operation prepare|dispatch|reconcile|show | compensation prepare|dispatch|reconcile');
      return 1;
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
      ensureRuntimeDirs(policy);
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
  } catch (error) {
    if (error instanceof StoreOpenError && error.code === 'NO_STATE' && cmd && isReadOnlyCommand(cmd, rest)) {
      if (cmd === 'list') console.log('(沒有 work)');
      else if (cmd === 'notes') console.log('(還沒有任何記錄)');
      else if (cmd === 'stats') console.log('works: 0   attempts: 0   retries: 0\n\noutcome 分佈\n  (無)');
      else if (cmd === 'fake') console.log('(沒有 operation/budget state)');
      else console.error(cmd === 'prompt' ? '找不到 attempt' : '找不到 work');
      return ['list', 'notes', 'stats', 'fake'].includes(cmd) ? 0 : 1;
    }
    throw error;
  } finally {
    store?.close();
    ownership?.release();
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e: unknown) => { console.error(`error: ${(e as Error).message}\n${(e as Error).stack ?? ''}`); process.exit(1); });
}
