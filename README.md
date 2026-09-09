# Agent Work Harness (MVP)

`agent-work-harness-design.md` 的實作。Harness 是 **Work Governance Layer**：
保存使用者需求與決策、決定本次 Attempt 的 authority、以固定規則編譯 prompt、
讓 Codex 在隔離環境自行探索與修改，然後**不採信 agent 自述**，自己收集 evidence 決定成敗。

線上流程 0 額外 LLM：唯一的 reasoning LLM 是外部的 Codex Runtime。

## 目前狀態

```text
MVP                    ✅ 完成（Gate 1–6，見 docs/acceptance.md）
Cross-Repo Validation  ✅ task-tracker（36.6k 行 TS）✅ rag-stack（10k 行 Python）
Core abstraction       ✅ 跨兩種語言 / domain / runner，Core 0 修改
需要修改 Core 的證據      無
```

已觀察到但尚未造成實際損害的限制，記在 `DECISIONS.md` 的 watch list ——
連同「什麼情況才把它升級成實作項目」的判準。不為了把清單清空而實作。

## 需求

- Node 24+（直接執行 `.ts`，無 build step）
- `codex` CLI（已登入）
- `bwrap`（bubblewrap）—— verification 與 git evidence 的隔離執行

**使用手冊：`docs/usage.md`** —— 安裝、新專案設定、日常流程、出問題怎麼查、如何記錄使用中發現的問題。

## 快速開始

```bash
npm install                       # 只有 typescript / @types/node（開發用）
npm link                          # 選用：讓 `harness` 直接可用（bin 指向 src/cli.ts）
node src/cli.ts doctor            # 確認隔離真的生效
node src/cli.ts init /path/to/repo   # 產生候選 .harness/config.json（要人工確認）

node src/cli.ts new "修正 token 過期回傳負數的 bug，不要碰 payment，也不要部署" --dir /path/to/repo
node src/cli.ts run  <workId>     # --no-baseline 可跳過 pre-flight baseline（測試很慢時）
node src/cli.ts show <workId>     # contract / decisions / attempts / evidence
node src/cli.ts trace <workId>    # append-only 事件流
```

需要你決定時（`NEEDS_USER_DECISION`）：

```bash
node src/cli.ts answer <workId> "可以改 src/token，但 payment 不要動"
node src/cli.ts retry  <workId>
```

## 一次 Attempt 發生什麼

```
WorkContract + Decision Ledger + Repository Contract snapshot
  → Context Manifest（authority inline、資料 pointer-first）
  → 六區 deterministic prompt
  → codex exec（read-only / workspace-write、network deny、隔離 HOME）
  → RuntimeResult v1（schema 強制）
  → Harness 自己觀察：git diff、denied path、configured verification
  → Outcome（固定規則表）
  → 模板回應：agent claim 與 harness evidence 分開陳述
```

## 除錯入口

| 想知道 | 指令 |
|---|---|
| 這次到底送了什麼 prompt | `node src/cli.ts prompt <attemptId>` |
| 發生順序 | `node src/cli.ts trace <workId>` |
| Harness 觀察到什麼 | `node src/cli.ts show <workId>` |
| codex 原始輸出 | `~/.local/share/agent-work-harness/attempts/<attemptId>/runtime.log` |
| 隔離是否還有效 | `node src/cli.ts doctor <repo>` |
| 使用中發現判錯了 | `harness note <workId> <kind> "<說明>"`，見 `docs/usage.md` |

state 全部在 `~/.local/share/agent-work-harness/`（`HARNESS_STATE_DIR` 可覆蓋）：
`harness.db`（SQLite）、`artifacts/`（prompt、diff、stdout）、`attempts/`。

## Repository Contract

每個 repo 用 `.harness/config.json` 告訴 Harness「從哪裡開始找」與「怎麼驗證」。
Harness Core 不認識 Node / PHP / Go：

```json
{
  "schemaVersion": "1",
  "repositoryId": "repo-a",
  "context": { "entryPoints": ["src/", "test/"] },
  "filesystem": { "protectedPaths": [".git/**", ".harness/**", "payment/**"] },
  "verification": {
    "checks": [
      { "id": "test", "kind": "test", "argv": ["npm", "test"], "required": true }
    ]
  }
}
```

`argv` + `shell=false`，且在 bwrap 隔離中執行。Attempt 開始前這份 config 會被 hash 並凍結 ——
agent 改不了自己的驗收規則。

## 模組架構

依賴單向往下，無循環。`types.ts`（純型別，零 import）與 `ids.ts` 被幾乎所有模組引用，圖上省略連線。

```
                              cli.ts
                 指令解析 / 組裝 Orchestrator / 輸出文字
                                 │
   ┌─────────┬─────────┬─────────┼─────────┬──────────┬───────────┐
   ▼         ▼         ▼         ▼         ▼          ▼           ▼
 policy   trace/    repo/    security/  runtime/   evidence/   cli-format
          store    contract   skills   isolation     exec      response
         事件流   config 契約  skill 准入  沙箱/env   跑指令     人看的輸出

                           orchestrator.ts
                     Work / Attempt 生命週期的唯一主體
     ┌─────────────────┬──────────────────┬─────────────────────┐
     │ prepareAttempt  │  executeRuntime  │   collectAndDecide  │
     ▼                 ▼                  ▼
 work/parser      runtime/codex-driver   evidence/git
 context/manifest runtime/result         evidence/verification
 context/budget   （← runtime/isolation） repo/paths
 prompt/compiler                         evidence/outcome
 repo/contract                           → response
 security/skills
```

| 層 | 模組 | 職責 |
|---|---|---|
| 入口 | `cli.ts` | 子指令 → Orchestrator / Store，不含業務邏輯 |
| 流程 | `orchestrator.ts` | attempt 生命週期、retry、recovery；`RuntimeDriver` 與 `EvidenceCollector` 兩個介面注入，測試可替換 |
| 輸入 | `work/parser`、`context/manifest`、`context/budget`、`prompt/compiler` | 需求 → pointers → 預算裁切 → 六區 prompt |
| 執行 | `runtime/codex-driver`、`runtime/isolation`、`runtime/result` | prepare/run、bwrap 沙箱與 env、RuntimeResult 解析 |
| 證據 | `evidence/{git,verification,exec,outcome}`、`repo/paths` | diff 觀察、隔離跑驗證指令、path policy → `OutcomeDecision` |
| 邊界 | `repo/contract`、`security/skills`、`policy` | `.harness/config.json` 凍結、skill hash 准入、authority 上限 |
| 儲存 | `trace/store` | append-only 事件流 + work / attempt / evidence 查詢 |
| 輸出 | `response`、`cli-format` | 給人看的字串，不參與決策 |

一次 attempt 的資料流：

```
new  →  parseRequest ──→ Work + WorkContract ──→ Store
run  ┌ prepare  contract 快照 → admitSkills → manifest → budget → compilePrompt
     │          └ 缺 contract / skill 被擋 → blockedReport（不進 runtime）
     ├ execute  CodexDriver.prepare → bwrap 沙箱 run → parseRuntimeResult
     └ collect  baseRevision / snapshotDirty → observeGit → checkPaths
                → collectBaseline → runVerification → decideOutcome
                → applyWorkState → buildResponse
```

## 文件

- [下一版長任務架構 v2（設計提案，未實作）](docs/superpowers/specs/2026-09-09-long-running-harness-v2-design.md)
- [v2 分階段實作計畫（P1 本機恢復優先）](docs/superpowers/plans/2026-09-09-long-running-harness-v2.md)

- 決策記錄：`DECISIONS.md`
- 隔離實測：`docs/spikes/2026-08-21-isolation-spike.md`
- E2E 場景：`docs/e2e-scenarios.md`
- §38 驗收條件對照：`docs/acceptance.md`
- Gate 1 dogfood：`docs/dogfood.md`
- Cross-Repo Validation（Post-MVP）：`docs/cross-repo-validation.md`
- Evidence 四層模型（設計，未實作）：`docs/evidence-model.md`

## 測試

```bash
npm run check     # lint + typecheck + test + deadcode，提交前跑這個

npm test          # 155 個測試，不需要 codex
npm run typecheck # tsc --noEmit
npm run lint      # eslint：no-floating-promises + 兩條架構界線（D-29 / D-31）
npm run deadcode  # knip：沒人用的 export / file / dependency
npm run coverage  # node 內建 coverage，不需要額外工具
npm run mutation  # stryker：測試到底抓不抓得到 bug。十幾分鐘，定期跑（D-30）

bash scripts/e2e.sh          # §37 九個 E2E scenario（會實際呼叫 codex）
bash scripts/e2e.sh G I      # 只跑不需要 codex 的
```

`docs/acceptance.md` 列出 §38 的 30 條 invariant 各自由哪個測試或 scenario 覆蓋。
