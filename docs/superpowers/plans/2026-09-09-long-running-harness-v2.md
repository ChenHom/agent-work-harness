# Long-Running Harness v2 Implementation Plan

> **For agentic workers:** 使用 `executing-plans` 逐項執行；若使用者明確選擇代理分工，
> 可使用 `subagent-driven-development`。下列 checkbox 記錄各階段的實際完成狀態。

**Goal:** 先讓既有本機 harness 的中斷恢復使用原始證據與明確執行所有權，再分階段接入長任務控制。

**Architecture:** 延續 Work／Attempt、SQLite、deterministic prompt 與 evidence-first outcome。
P1–P2 不增加線上 LLM 或 workflow engine；P3–P5 是有前置條件的演進路線，各自通過 gate 才擴張保證。

**Tech Stack:** TypeScript、Node 24、node:sqlite、node:test、Codex CLI、既有 bwrap runner。

**設計依據:** [v2 架構規格](../specs/2026-09-09-long-running-harness-v2-design.md)。

**基線:** `9f04360`；2026-09-09 主機 `npm run check`：173 pass／0 fail／0 skip。

**本文件狀態:** **P1/G1、P2/G2、P3/G3 與 P4/G4 已完成；P5 尚未開始。**

## 1. 可交付範圍

| 階段 | 可以對使用者承諾的新增行為 | 依賴／完成 gate |
|---|---|---|
| P1 本機恢復正確性 | 查詢不誤標執行中任務；新 attempt 原始輸入可取回；缺證據就明示不可恢復；terminal state 原子落地 | G1：下方 10 條必要條件與故障測試通過 |
| P2 Milestone／Plan／Checkpoint | 目標版本固定、計畫可受控修訂；從工作快照開新分支，帳本不回滾 | G2：依賴失效、版本競爭、fork 保留事實測試 |
| P3 Operation Gateway／Budget | 僅對已接入 adapter 的工具提供 intent／receipt／UNKNOWN／對帳與費用預留 | G3：外部成功 response 遺失仍不重複效果 |
| P4 Durable orchestration | 持久 timer、callbacks、跨 worker 接手及取消；由單一 runtime 管 retry | G4：重啟、舊 worker、亂序訊息與版本切換測試 |
| P5 Evaluation／Retention | criterion-level verdict、已校準語意評估、可恢復期限與封存／GC | G5：獨立標註集、artifact 刪除安全、備份還原 |

Telemetry、故障案例與 evidence binding 從 P1 就做；P5 才增加語意判斷與自動保留政策。
P1 不完成外部工具補償、精確 token／美元上限、任意 Git rollback 或多主機高可用。
這些限制必須出現在對外文件，不能等平台整合後才補。

## 2. P1：來源對照與規格變化

| 基線入口 | 實際問題／限制 | 變化 |
|---|---|---|
| `src/cli.ts main()` | 每個命令都 ensureRuntimeDirs，然後 markCrashedAttempts | 只讀命令不用建立 runtime directories、不做 lifecycle mutation |
| `Orchestrator.markCrashedAttempts()` | 只憑 RUNNING 判定 crash | 移除啟動時全域掃描；恢復前先處理 ownership，狀態不是存活證據 |
| `Orchestrator.prepareAttempt()` | snapshot 在記憶體，baseline 之前還沒有 durable attempt | 先保存完整 inputs 與 phase=preparing 的 attempt，再執行可失敗工作 |
| `Orchestrator.executeRuntime()` | stdout/stderr artifact 的返回 ID 未綁 attempt | 立即保存 output refs，與 runtime 結束事實一起落地 |
| `Orchestrator.collectAndDecide()` | attempt／outcome／work／event 分次更新 | terminal writes 同 transaction |
| `Orchestrator.recover()` | 使用 currentContract(work)／loadSnapshot；未檢查適用狀態 | 原始 contract／snapshot，獨立 recovery session，檢查當前政策 |
| `Store.readArtifact()` | 只讀 path，不驗 bytes/hash | 增加 typed verified read，缺失／損壞與空內容分開 |
| `Store` schema | create-if-not-exists、無版本化 migration | schema version + transaction migration + 舊資料相容規則 |

P1 改變既有 D-19 的「每次 CLI 啟動標記 RUNNING」與準備階段的落地順序。
保留 D-19 的核心：**不 auto-rerun 中斷的 agent**。
既有 D-02 SQLite／非完整 event sourcing 與 D-20 fresh retry session 不變。

## 3. P1 檔案分工

以下新檔是預定路徑，尚不存在；不要在 docs 階段建立空模組。

| 路徑 | 職責 |
|---|---|
| 修改 `src/types.ts` | 可選的 v2 attempt input/output refs、phase、runtime dispatch 記錄與 recovery types |
| 修改 `src/trace/store.ts` | transaction helper、verified artifact read、原子 attempt finalization、read-only open |
| 新增 `src/trace/migrations.ts` | schema version 與 recovery_sessions migration；不執行網路／程序 |
| 新增 `src/runtime/ownership.ts` | 同 state directory 的互斥執行、owner metadata、保守釋放規則 |
| 修改 `src/orchestrator.ts` | 保存輸入／輸出、適用狀態檢查、snapshot recovery、使用 store 交易 |
| 修改 `src/cli.ts` | 只讀／mutating 命令組裝、ownership 訊息、移除啟動時誤標記 |
| 修改 `src/response.ts`、`src/cli-format.ts` | recovery evidence／缺快照／owner 不明的可操作輸出 |
| 修改 `src/runtime/codex-driver.ts` | 記錄啟動／停止證據，防雙重 finish，無法證明 quiescence 時不放行接手 |
| 新增 `test/store-transaction.test.ts`、`test/artifact-integrity.test.ts` | SQL／artifact 故障邊界 |
| 新增 `test/migrations.test.ts`、`test/ownership.test.ts` | 舊資料重開、雙執行者與 lock 保留 |
| 修改 `test/attempt-flow.test.ts`、`test/recovery.test.ts`、`test/cli.test.ts`、`test/driver.test.ts` | 基線 fake seams 與新恢復／CLI 行為 |
| 更新 `docs/usage.md`、`docs/acceptance.md`、`DECISIONS.md`、`README.md` | 只有實作通過後才改寫目前能力與驗收 |

不另造第二個 Orchestrator，也不為每個階段先抽通用 plugin framework。
既有 child_process import 限制仍適用：Git／verification 用既有 runner；
實際程序啟停擴充在 codex-driver，不由 store 或 ownership 任意執行 shell。

## 4. P1 介面與不可變資料

下面是**實作目標的介面契約**，不是基線已存在的 API。
新型別只在實際使用時 export，維持 Knip 檢查。

```ts
interface AttemptInputSnapshot {
  schemaVersion: '2';
  workId: string;
  attemptId: string;
  contract: WorkContract;
  repository: RepositoryContractSnapshot;
  authority: AttemptAuthority;
  manifest: ContextManifest;
  compilerVersion: string;
  promptArtifactId: string;
  admittedSkills: Array<{ skillId: string; actualHash: string }>;
  executionConfig: {
    runtime: 'codex';
    model?: string;
    attemptTimeoutMs: number;
    verificationTimeoutMs: number;
    maxOutputBytes: number;
    promptBudgetChars: number;
  };
}

type VerifiedArtifact =
  | { status: 'verified'; id: string; hash: string; content: Buffer }
  | { status: 'missing' | 'corrupt'; id: string };

type AttemptPhase = 'preparing' | 'dispatch_intent' | 'executing' | 'collecting' | 'terminal';

interface AttemptOutputRefs {
  stdoutArtifactId: string;
  stderrArtifactId?: string;
  rawResultArtifactId: string;
  parsedResultArtifactId?: string;
}
```

直接重用 `src/types.ts` 的 WorkContract、RepositoryContractSnapshot、AttemptAuthority、
ContextManifest，compilerVersion 取既有 compilePrompt 結果。
snapshot 不保存 credentials／環境秘密；policy binding 另保存控制權限相關的有效設定摘要，
實際執行檢查使用目前 policy。不要把當時 policy snapshot 當今天的放行權。

Attempt 新增可選 `inputSnapshotArtifactId`、`outputRefs`、`phase`。
準備時沿用 `status=CREATED` 並設定 `phase=preparing`；不另加意義重複的 PREPARING status。
缺欄位表示 legacy，不能自動從最新資料填補。
JSONL trace 之外的 SQL events 保留原有 event sequence。
Recovery session 另存 id/work_id/attempt_id/observed_at/evidence_ids/reason/status；
新 evidence 仍可引用原 attempt，但 session 明示這是新觀察，不能改寫舊 outcome 的解讀。

## 5. Task 1：Store transaction 與 schema migration

**Files:** `src/trace/store.ts`、`src/trace/migrations.ts`、
`test/store-transaction.test.ts`、`test/migrations.test.ts`。

- [x] 寫 transaction rollback 測試：插入 event 後注入例外，重新開 DB 必須完全看不到該 event。
- [x] 寫原子 terminal 測試：在 outcome 與 work update 之間丟錯，attempt/work/outcome/event 全部維持前值。
- [x] 執行 `node --test test/store-transaction.test.ts test/migrations.test.ts`，確認新增行為尚未存在而失敗。
- [x] 新增同步 `Store.withTransaction<T>(fn: () => T): T`，BEGIN IMMEDIATE／COMMIT／ROLLBACK；
  明確拒絕巢狀與 Promise callback，不在 transaction 內做外部 I/O。
- [x] 將 terminal transition 包成 `finalizeAttempt`，一次更新 attempt、outcome、work state 與 events。
  最終 verdict 綁定該次 evidence；相同 attempt 的相同 finalization 可安全重入，不追加第二次完成事件；
  衝突 finalization 回 STATE_CONFLICT。
- [x] 用 `PRAGMA user_version` 管 migration；辨識 v0 既有 schema，保留原 rows，
  transaction 建立 recovery_sessions 及需要的索引。未來版本拒絕寫入。
- [x] 加入 `Store(stateDir, { readOnly: true })`：不 mkdir、不執行 DDL/WAL pragma；
  DB 不存在時回報尚無 state，不建立空 state。
- [x] 重跑兩個測試檔及 typecheck；通過後提交 `feat: add transactional attempt persistence`。

代表性測試（新 API 的驗收範例，可直接放入 store-transaction.test.ts）：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/trace/store.ts';

test('transaction failure does not leave an event after reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-v2-tx-'));
  let store = new Store(dir);
  try {
    assert.throws(() => store.withTransaction(() => {
      store.event('usage.note', { kind: 'other', text: 'uncommitted' }, 'W-test');
      throw new Error('injected-crash');
    }), /injected-crash/);
    store.close();
    store = new Store(dir);
    assert.deepEqual(store.events('W-test'), []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

這個單元測試只證明 transaction 邊界；Task 6 另外測 process kill，不能用丟例外替代所有 crash 測試。

## 6. Task 2：Artifact integrity 與 durable refs

**Files:** `src/trace/store.ts`、`test/artifact-integrity.test.ts`。

- [x] 寫空檔、missing、hash mismatch、相同內容 dedupe 測試；測試原有短 hash path 仍可讀。
- [x] 執行 `node --test test/artifact-integrity.test.ts`，確認損壞檔目前不會被拒絕。
- [x] putArtifact 改用完整 hash 檔名、同目錄 temporary file、完成寫入後原子 rename；
  durability 契約需包含 file 與必要 directory sync，最後才 commit DB 引用。
  已存在內容必須驗證 hash，不能因 exists 就信任。
- [x] 新增 `Store.readVerifiedArtifact(id): VerifiedArtifact`；
  比對檔案長度與完整 SHA-256，I/O 錯誤留下可辨識原因，不把空 Buffer 判 missing。
- [x] 保留舊 `readArtifact` 呼叫端相容性；recovery／驗收逐一切到 verified API，
  stdout／prompt 展示遇損壞也必須明示，不能顯示不可信內容而不標註。
- [x] 外部 payload 發布成功但 DB insert 失敗，可留下 orphan；P1 不自動 GC。
- [x] 重跑 artifact 測試及現有 driver/compiler/store tests；提交 `feat: verify persisted artifact integrity`。

代表性測試：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/trace/store.ts';

test('corrupt artifact is distinct from an empty valid artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-v2-artifact-'));
  const store = new Store(dir);
  try {
    const empty = store.putArtifact('prompt', '');
    const verified = store.readVerifiedArtifact(empty.id);
    assert.equal(verified.status, 'verified');
    if (verified.status === 'verified') assert.equal(verified.content.length, 0);
    const result = store.putArtifact('runtime_result', '{"ok":true}', 'json');
    writeFileSync(result.path, '{"ok":false}');
    assert.equal(store.readVerifiedArtifact(result.id).status, 'corrupt');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

## 7. Task 3：單主機 ownership 與只讀 CLI

**Files:** `src/runtime/ownership.ts`、`src/runtime/codex-driver.ts`、
`src/orchestrator.ts`、`src/cli.ts`、`test/ownership.test.ts`、
`test/cli.test.ts`、`test/driver.test.ts`。

- [x] 加入雙執行者 fixture：第一個 fake driver 暫停時，第二個 run 不得 prepare／修改 shared CODEX_HOME。
- [x] 加入查詢 fixture：執行中呼叫 list/show/trace/prompt/stats/notes/skills list，
  attempt 與 work state、events sequence 不得改變。
- [x] 執行 `node --test test/ownership.test.ts test/cli.test.ts test/driver.test.ts`，確認新 ownership 規則尚未滿足。
- [x] 以 state directory 下的 exclusive lock（原子 mkdir）取得單一 execution token；
  保存 token、host、owner PID、程序啟動識別、phase、已知 child identity。
  owner metadata 尚未寫完也視為已被占用，不可因空檔清掉。
- [x] 覆蓋會影響執行的 mutation：new/run/retry/recover/answer、skills approve、共享 runtime config 準備；
  init／doctor 等會寫設定或啟動工具的路徑也不能繞過同一 execution boundary。
  從 Orchestrator 直接呼叫也要經 ownership wrapper；不要只在 CLI 外殼上鎖。
  token 由最外層取得並明確往內傳，不重複奪鎖。
- [x] 正常釋放要求 token 相符且 driver 已證明受管執行停止；
  launch 途中 crash／timeout 無法確認子程序時保留鎖，回 OWNER_UNKNOWN。
  P1 **不實作自動過期奪鎖**，PID 不存在也不足以證明子程序停止。
- [x] 移除 main 啟動時 markCrashedAttempts；
  只讀命令用 readonly Store，無 DB 時只顯示空狀態。
- [x] 實作 ownership inspection 輸出：token、owner、phase、已知 child、blocked reason；
  不提供未經驗證的 force-unlock。異常 lock 的處置見 Task 7 runbook。
- [x] 驗證正常結束／throw／重複 close/error event 不會釋放別人的 token；
  通過後提交 `fix: preserve active execution ownership across cli calls`。

P1 的保證是「不自動派出第二個執行者」，不是任意 untrusted process tree 的強制終止保證。
若要安全自動回收 orphan ownership，需 P4 的可驗證 supervisor／container/cgroup 邊界。

## 8. Task 4：持久化 attempt 原始輸入與輸出

**Files:** `src/types.ts`、`src/orchestrator.ts`、`src/trace/store.ts`、
`test/attempt-flow.test.ts`。

- [x] 用既有 fake driver／EvidenceCollector 測試：baseline throw 後重開 DB，
  attempt 必須存在、inputs 可驗 hash，且 driver.calls === 0。
- [x] 測試：model 已返回、verification throw，stdout/raw result refs 仍可讀；
  work 不得 DONE，recovery 能分辨 collecting 與 dispatch_intent。
- [x] 執行 `node --test test/attempt-flow.test.ts`，確認新 assertions 失敗。
- [x] 依 §4 建立完整 input snapshot，與 prompt 分開保存。
  先 publish artifacts，再 transaction 插入 status=CREATED／phase=preparing 的 attempt、
  input refs 與事件，之後才跑 baseline。
- [x] 在呼叫 driver.prepare/run 前，持久化 dispatch_intent；
  將 launch identity 接上 ownership token，啟動後保存已知 child receipt。
- [x] Model 返回後立即保存 raw output／stdout／stderr 及 parse result；
  保存 refs 與 phase=collecting 後才開始 verification。
- [x] 例外依 phase 留下原因；prepare 失敗不可假造 runtime completion；
  執行結果不明保持 recovery required。
- [x] Retry 計數以 durable dispatch intent 保守計費：未派發的 prepare 失敗不扣模型 retry；
  dispatch intent 已存在但 crash，視為可能派發並占用一次；重開 DB／換 plan 不會清零。
  用新 phase 規則兼容 legacy retryOf 計數，不改歷史資料的含義。
- [x] collectAndDecide 改用 Task 1 finalization；通過現有 outcome／retry 回歸與新增案例後，
  提交 `feat: persist attempt inputs and outputs before recovery boundaries`。

驗證不變量：

```text
driver.calls > 0  ⇒ inputs 可讀且驗 hash 通過，dispatch intent 已 commit
phase=collecting  ⇒ raw result／stdout refs 可讀
work=DONE        ⇒ terminal attempt／outcome／對應 events 同筆 transaction 完成
```

## 9. Task 5：Recovery session 與原始 snapshot

**Files:** `src/orchestrator.ts`、`src/trace/store.ts`、
`src/response.ts`、`src/cli-format.ts`、`test/recovery.test.ts`。

- [x] 建立 attempt v1 fixture，中斷後把 repository checks 改成 v2；
  recover 不得把 v2 檢查當 v1 evidence，也不得重新呼叫模型。
- [x] 建立 contract mode／deniedPaths 改變 fixture；
  recover 必須引用 attempt.contractVersion，並拒絕違反目前強制 policy 的執行。
- [x] 覆蓋 legacy 無 snapshot、損壞 snapshot、不適用狀態、重複 recover 與目前仍有 owner。
- [x] 執行 `node --test test/recovery.test.ts`，確認目前 recover 使用最新 snapshot 的測試失敗。
- [x] 先做 ownership／status 檢查；缺原始 inputs 時回 SNAPSHOT_UNAVAILABLE，
  可顯示有標註的新 readback，但不得替舊 attempt 補造成功證據。
- [x] 建立獨立 recovery session，保存輸入 artifact ref、當前 repo readback、
  最新 policy 評估及 evidence IDs。原 attempt 的原始 snapshot／terminal outcome 不變。
- [x] Recovery 預設做只讀 observation，不自動跑可能寫入的 verification。
  需要再驗證時由新 attempt 執行凍結 checks；明確標示使用原始或新 contract，
  並檢查當前 policy、workspace 及 verification scripts 的變更。
- [x] 輸出「已知／未知／可採取動作」；
  recovery 不直接 SUCCESS，保留由有效授權建立新 attempt 的既有模式。
- [x] 原始 snapshot 為證據，不是 Git 備份，不 reset／clean／覆蓋既有 worktree。
- [x] 通過 recovery 與 attempt-flow 回歸；提交 `fix: bind recovery evidence to original attempt inputs`。

## 10. Task 6：遷移與恢復測試矩陣

**Files:** `test/migrations.test.ts`、`test/recovery.test.ts`、
`test/store-transaction.test.ts`、`test/ownership.test.ts`。

- [x] 用基線 SCHEMA 與固定 fixture rows 建立 v0 DB，再由 v2 重開；
  work/attempt/contract/evidence 的 identity、內容、events 順序不變。
- [x] 在 migration 中途注入例外，重開應仍是完整 v0；重新 migration 可成功。
- [x] 未知較新 schema 拒絕 mutation，不能把 user_version 改回較舊數字。
- [x] 在 artifact 完成／DB commit 前，及 outcome／work update 間強制終止測試程序；
  重新啟動確認無部分 terminal state、無 DB 指向不完整 artifact。
- [x] 在 dispatch intent 後、child receipt 前中斷，重啟不得 auto-rerun；
  owner 模糊時保持 OWNER_UNKNOWN，不推測安全。
- [x] 測試受限環境遇 process／Git EPERM 時記錄環境限制，
  不將整個檔案 skip 或使用失敗的 composite check 宣告通過。
- [x] 目標測試通過後跑完整 `npm run check`；
  根據需要在支援 bwrap／Git fixture 的主機跑，保存 pass/fail/skip 與 exit code。
- [x] 提交 `test: cover persistence and ownership crash boundaries`。

## 11. Task 7：文件、操作手冊與 G1 驗收

**Files:** `docs/usage.md`、`docs/acceptance.md`、`DECISIONS.md`、
`README.md`、本計畫。

- [x] 記錄 OWNER_UNKNOWN 處置：先保存 owner metadata／state backup，確認舊 harness、
  已知 Codex 子程序與受管執行環境停止；無法確認則維持 blocked，不刪 lock。
  只有可證明環境已隔離／停止時，才由操作者清理該 token 的 lock，再執行只讀 recovery。
- [x] 記錄 legacy snapshot unavailable 的行為：保留舊證據；以新 attempt 驗證現況；
  不把最新設定回填成歷史輸入。
- [x] 在 DECISIONS 新增取代 D-19 啟動掃描的決策，保留舊條目並連結；
  說明 P1 是保守本機互斥，不是自動 orphan 接手。
- [x] README 僅將 G1 已驗證行為改成已完成；P2–P5 保持設計狀態。
- [x] 完整檢查通過後，只在無新增 code 時做 docs link／diff check；
  提交 `docs: describe verified recovery guarantees and limits`。

G1 必須全部通過：

1. 只讀 CLI 不標記別的活躍 attempt 為 crash，也不改 lifecycle events。
2. 同 state directory 不會同時進入兩個 driver.prepare/run。
3. 無法確認 owner／child 狀態時不自動接手。
4. 派發前已保存且可驗證原始 WorkContract、repository snapshot、authority、manifest 與 prompt refs。
5. Model 返回後、verification 前，原始輸出已持久化且可從 attempt 直接找到。
6. terminal attempt／outcome／work state／events 無部分更新。
7. recover 不偷換最新 contract，不重新執行模型。
8. legacy／missing／corrupt inputs 回明確限制，不能 SUCCESS。
9. Retry 與恢復不重設已派發計數，不破壞原有 path／skill／Git evidence 護欄。
10. 基線測試與新增 crash／ownership／migration 測試通過，記錄環境與 skip。

## 12. P2：受控計畫與工作快照

**進入條件：** G1 完成；選定一個至少兩個 milestone 的真實 repository Work 作驗收案例。

**預定模組：** `src/work/plans.ts`、`src/trace/checkpoints.ts`、
現有 types/store/orchestrator/context/cli；測試 `test/plans.test.ts`、`test/checkpoints.test.ts`。

- [x] 加入固定 contractVersion 的 plan proposal／validation／activation；初期允許使用者輸入 milestones，
  不為拆計畫強制新增 Planner LLM。
- [x] milestone 指向 acceptance criterion IDs；依賴 cycle、缺失 step、過期 parent version 都拒絕。
- [x] checkpoint 保存工作引用與 validation status；允許 pending_validation，不等於驗收通過。
- [x] fork 建立新 branch／plan，保留最新 attempt／dispatch 計數與舊 branch history。
  P3 尚未接入時不虛構費用／operation 帳本；接入後這些帳本也不受 fork 回退。
- [x] 將 Attempt 綁定 milestone；調整 applyWorkState，milestone SUCCESS 不直接 Work DONE。
  目前 plan 的必要 milestones 與全域 mechanical checks 全部通過，才標 Work 完成；
  過期分支的成功不能滿足新 plan 的驗收。
- [x] dependency artifact 被替換時，標記下游成果 stale，不能自動沿用。
- [x] 明確限定 logical checkpoint；若需要檔案還原，另驗證隔離 worktree／artifact manifest 的完整性。

**G2：** 使用者 amend goal 建新版本；LLM 不可改 constraints；
兩個競爭 plan 只一個 activation 成功；resume 與 fork 身份不同；
fork 不重設計數，不覆蓋使用者 dirty files；舊 artifact 失效可追溯到下游 criterion。

## 13. P3：Operation Gateway 與預算

**進入條件：** G1 完成；先在 fake provider 實作單一有查詢 identity 的寫入 adapter。
P2 plan UI 不阻擋此子專案，但所有 operation identity 必須能跨未來 replan 延用。

**預定模組：** `src/tools/operations.ts`、`src/tools/gateway.ts`、
`src/tools/compensation.ts`、`src/budget/ledger.ts`；測試
`test/operation-recovery.test.ts`、`test/budget-ledger.test.ts`。

- [x] Operation／attempt 分開；同 intent 沿用 key，同 key 不同 payload 拒絕。
- [x] transaction 保存授權、intent、reservation，再派發；receipt 回來先保存再判定。
- [x] Adapter 定義 lookup／postcondition／key TTL／部分完成／unsafe retry 行為。
- [x] UNKNOWN 先對帳；查不到且可能晚到，不標成 FAILED。
- [x] Compensation 有獨立持久進度與 budget；失敗轉人工，不自動假設已撤銷。
- [x] 上限可驗的工具才提供 hard cap；CodexDriver 目前沒有精確費用 receipt，
  維持 unknown／estimated，不用字元數冒充 token usage。
- [x] 證明 model／shell 無繞過 Gateway 的寫入路徑，才開放實際外部操作；
  原有 network deny 不因新增 adapter 自動放寬。

**G3：** fake provider 已完成但 response 遺失、重複派送、TTL 到期、
eventual consistency、補償再次 crash、並行預算競爭都有測試；
獨立 provider ledger 中每個業務 identity 的效果次數符合授權。
沒有真實支援的 adapter，產品仍明示「外部副作用治理未接入」。

## 14. P4：Durable runtime 選型與整合

**進入條件：** G1、G3 完成，確定需要 persistent timer／跨 worker 執行，
選定與現有 runtime 相容的 identity 與帳本邊界。

**比較方式：** 同一個 fake workflow：模型產出 → 工具寫入 → 等待 callback →
中途 crash → 對帳 → 驗收。固定 failure seed 與 budget，比較：

| 方案 | 必須實證 | 拒絕條件 |
|---|---|---|
| 維持本機 orchestrator | 持久 timer／queue／owner supervisor 的實際維護成本 | 仍需自行重造分散式 lease／retry 且無證據能可靠運作 |
| Temporal lifecycle owner | Activity 重新執行安全、workflow code versioning、history 分段 | 既有程式與平台各自派發／雙重 retry；無可用維運方式 |
| LangGraph + 明確執行服務 | persistent checkpointer、worker ownership、time-travel 副作用政策 | 只因有 checkpoint 就宣稱有完整 scheduler／對帳／補償 |

- [x] 寫 ADR 記錄實測，而不是只列功能表；指定唯一 schedule/retry/cancel owner。
- [x] 模型與外部操作結果走已保存 receipt；audit replay 不執行 external writes。
- [x] 加入 epoch/fencing、durable inbox、callback 去重、timer 與版本相容策略。
- [x] 以受管程序環境與發布 gate 解決本地檔案寫入的 stale worker 問題，
  不只在 SQLite 加一欄 epoch。
- [x] 取消停止新派發、追蹤 in-flight；未知結果／未完成清理不直接 CANCELLED。

**G4：** 舊 worker 復活不發布結果；跨 host 接手不重複效果；
callback 重複亂序只處理一次有效狀態轉移；deadline 經重啟仍有效；
舊 code 的 Work 能兼容完成或明確暫停；平台故障有 runbook。

## 15. P5：Global validation、benchmark 與保留

**進入條件：** 有真實 criterion 與獨立標註／oracle；未具備時保持 deterministic evidence，
不要先加 goal_alignment 小數分數當驗收。

**預定模組：** `src/evaluation/criteria.ts`、`src/trace/retention.ts`、
`scripts/benchmark-recovery.ts` 與對應 node:test 測試。

- [x] Verdict 為 pass/fail/unknown，固定 criterion／artifact hash／validator version；
  必要 unknown 阻擋 DONE，硬限制不平均。
- [x] Semantic critic event-driven + periodic fallback，去重、cooldown、預算上限；
  planner／executor／critic 各模型設定與成本入帳。
- [x] 以獨立標註集測 false accept/reject／abstention；模型互投不能替代 oracle。
- [x] Benchmark 納入失敗 runs 成本，報 p50/p95/p99、unknown age、
  重複效果、人工介入與恢復 SLA；保持 fixture／seed／模型版本。
- [x] 定義 active／resumable／archived 的 retention window，
  依引用可達性做 GC dry-run；未決 operation 與 key 紀錄不可過早刪除。
- [x] DB + artifact 備份還原與 schema migration drill；過期／無法重播要明示，
  不自動重問模型補失去的歷史。
- [x] Trace 支持 span links，權威帳本不採樣；
  raw logs 脫敏與權限控管，敏感 payload 刪除不破壞必要的因果 metadata。

**G5：** 驗證 A 交付 B 被拒絕、malicious artifact 不能改 authority、
必要 unknown 不會 DONE、GC 不刪可恢復引用、backup 能實際恢復、
報告不以平均值或單一 goal score 隱藏故障。

## 16. 執行順序與交接

先執行 P1 Task 1–7，每個提交都能獨立驗證。
P1／P2／P3／P4／P5 已各自完成實作與 gate。P5 的細部計畫與證據見
[P5 evaluation/retention plan](2026-09-23-p5-evaluation-retention.md)、`test/g5-acceptance.test.ts` 與
[evaluation/retention runbook](../../runbooks/evaluation-retention.md)。P5 的校準標註集
`2026-09-23.1` 由 fixture 作者手寫、尚未經人工審閱；對 Claude 系 critic 的校準結果在人工審閱前
只能視為較弱的證據。
P1–P5 合併後的下一步（code review 剩餘項目、待決定事項與環境步驟）見
[review 後續處理計畫](2026-09-23-review-followups.md)。

本輪文件驗證只包含來源對照、章節與 review 覆蓋、相對連結與 diff 檢查。
P4 的實作與 G4 證據見獨立 P4 plan、`test/g4-acceptance.test.ts` 與 operations runbook。
