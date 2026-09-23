# AGENTS.md

給在這個 repo 工作的 coding agent（Codex、Claude Code 等）。人類讀者請先看 `README.md` 與 `docs/usage.md`。

## 這是什麼

Agent Work Harness：把一段需求變成可驗證、可恢復的 attempt，由 harness（而非模型）觀察 evidence、決定結果、保存軌跡。
長任務架構 v2（P1–P5）已實作：recovery correctness、受控 plan/checkpoint、operation gateway 與預算、Temporal durable runtime、
criterion 完成判定／校準／保留／備份還原。設計見 `agent-work-harness-design.md` 與 `docs/superpowers/`。

## 環境與指令

- Node 24+，直接執行 `.ts`（type stripping），沒有 build step，沒有 runtime 依賴（DECISIONS D-01）。
- `npm run check`：lint + typecheck + test + knip。提交前必跑，結束碼必須是 0。
- 單一檔案：`node --test test/<name>.test.ts`；只跑某些測試：加 `--test-name-pattern=<regex>`。
- `npm test` 不需要 codex 或網路；Temporal 測試會自行啟動本機 dev server。
- `bash scripts/e2e.sh` 會真的呼叫 `codex`；需要 `codex` 已登入與 `bwrap`。
- `npm run mutation`（Stryker）要十幾分鐘，只在需要時跑。

## 程式碼地圖

分層與職責表在 `README.md` 的「模組架構」。常用入口：

| 目的 | 位置 |
|---|---|
| CLI 子指令 | `src/cli.ts`（只轉呼叫，不放業務邏輯） |
| Attempt 流程 | `src/orchestrator.ts` |
| 儲存、schema、migration | `src/trace/store.ts`、`src/trace/migrations.ts` |
| Operation／補償／預算 | `src/tools/gateway.ts`、`src/tools/compensation.ts`、`src/budget/ledger.ts` |
| Durable runtime（Temporal） | `src/durable/` |
| 完成判定與校準 | `src/evaluation/`（`criteria.ts` 是完成規則） |
| 保留、GC、備份、redaction、trace links | `src/trace/{retention,backup,redaction,links}.ts` |
| Recovery benchmark | `src/benchmark/recovery.ts`、`scripts/benchmark-recovery.ts` |

## 不可違反的規則

1. **Fail closed。** 缺少、損壞、過期、替換或無法解析的 evidence 一律變成 `unknown`／阻擋，永遠不能讀成通過。
   完成規則固定在 `decideGlobalVerdict`：必要或硬限制的 `fail` 優先，其次任何必要 `unknown` 擋住 `DONE`；
   confidence、optional criterion、平均分數不參與判定。
2. **Authority 不來自內容。** Artifact 內容、模型輸出不能改 criterion、required／kind、validator identity 或 contract。
   校準的標註只接受獨立來源（`human-review`、`fixture-author`），模型產生的標註不能當 oracle。
3. **Operation `UNKNOWN` 只能 reconcile，不能重送。** 過了 idempotency 窗口就交給人（`WAITING_USER`）。
4. **只用可抹除的 TypeScript 語法**：不能用 `enum`、constructor parameter properties（`tsconfig` 的 `erasableSyntaxOnly` 會擋）。
5. **架構界線（ESLint 會擋）**：`node:child_process` 只能出現在 `src/evidence/exec.ts` 與 `src/runtime/codex-driver.ts`；
   下層模組（context、evidence、prompt、repo、runtime、security、trace、work）不得 import `orchestrator.ts`。
6. **Store 交易**：`withTransaction` 的 callback 必須同步、只做 DB 操作。唯一例外是 GC 與 redaction 在交易內 unlink，
   用寫鎖擋住不持有 execution lock 的 durable worker（見 `src/trace/retention.ts` 註解）；不要把這個例外擴大。
7. **Artifact 是 content-addressed 檔案**：新檔名 `<sha256>.<ext>`，v7 以前的檔名是 `<sha256 前 16 hex>.<ext>`，兩者都要支援。
   不刪 DB row；payload 只能經 GC 或 redaction 刪除，而且必須留下 tombstone（hash、kind、時間、authority、replay 限制）。
8. **Schema 變更**：提高 `CURRENT_SCHEMA_VERSION`，在 `SCHEMA` 用 `create table if not exists`，補 `REQUIRED_TABLES`／unique 檢查，
   並在 `test/migrations.test.ts` 加「從上一版 migration」的測試。唯讀開啟永遠不 migrate 原檔（舊 schema 讀私有快照）。
9. **會改狀態的 CLI 指令取得 execution ownership**；唯讀指令以 `readOnly` 開 Store、不取鎖。新增指令時照 `src/cli.ts` 的集合分類。
10. **新增的錯誤訊息用** `UPPER_SNAKE_CODE: detail`（多數既有錯誤如此，少數舊訊息不是）。測試靠 code 比對，不要改既有 code 的名字。

## 測試慣例

- 只用 `node:test` 與 `node:assert/strict`，不引入測試框架（D-03）。檔名 `test/<name>.test.ts`，共用 fixture 放 `test/helpers/`、
  固定資料放 `test/fixtures/`。
- 修 bug 先寫會在舊程式碼上失敗的測試。改完關鍵規則時，暫時撤回修正確認測試會失敗（手動 mutation），再還原。
- 測試斷言具體值（計數、分母、reason code），不要只斷言「不為空」。
- 量測（延遲、規模）寫在 scratch script，不進 repo；結果記在 commit message 或 `docs/acceptance.md`。

## 完成的定義

- `npm run check` 結束碼 0，並記下 pass/fail/skip 數；沒有這個證據就不要說完成。
- 改文件時確認 Markdown 相對連結存在、`git diff --check` 乾淨。
- 一個 task 一個 commit。訊息格式 `<type>: <摘要>`（feat／fix／docs／refactor／test／chore），本文寫為什麼、取捨與驗證證據。
- 計畫的勾選框（`docs/superpowers/plans/`）只在該項有可執行證據後才打勾。

## 文件

- `README.md`、`docs/usage.md`、`docs/acceptance.md`：正體中文。`docs/runbooks/`：英文。
- 設計或實作取捨記在 `DECISIONS.md`（`D-xx`）；新的 gate 證據寫進 `docs/acceptance.md`。
- 操作程序（事故、GC、備份還原、Temporal）在 `docs/runbooks/`，行為改了要一起更新。
