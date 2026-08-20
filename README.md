# Agent Work Harness (MVP)

`agent-work-harness-design.md` 的實作。Harness 是 **Work Governance Layer**：
保存使用者需求與決策、決定本次 Attempt 的 authority、以固定規則編譯 prompt、
讓 Codex 在隔離環境自行探索與修改，然後**不採信 agent 自述**，自己收集 evidence 決定成敗。

線上流程 0 額外 LLM：唯一的 reasoning LLM 是外部的 Codex Runtime。

## 需求

- Node 24+（直接執行 `.ts`，無 build step）
- `codex` CLI（已登入）
- `bwrap`（bubblewrap）—— verification 與 git evidence 的隔離執行

## 快速開始

```bash
npm install                       # 只有 typescript / @types/node（開發用）
node src/cli.ts doctor            # 確認隔離真的生效
node src/cli.ts init /path/to/repo   # 產生候選 .harness/config.json（要人工確認）

node src/cli.ts new "修正 token 過期回傳負數的 bug，不要碰 payment，也不要部署" --dir /path/to/repo
node src/cli.ts run  <workId>
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

## 專案結構

```
src/
├── types.ts           所有契約型別
├── policy.ts          Harness Global Policy（authority 上限）
├── work/parser.ts     §18 deterministic 需求解析
├── repo/              Repository Contract 載入/凍結、glob path policy
├── context/           Context Manifest、budget
├── prompt/compiler.ts 六區 deterministic prompt
├── security/skills.ts Skill registry + hash + fail-closed admission
├── runtime/           隔離設定、Codex driver、RuntimeResult 解析
├── evidence/          隔離執行、git 觀察、verification、outcome 規則
├── orchestrator.ts    Work / Attempt 生命週期、retry、recovery
└── cli.ts
```

- 決策記錄：`DECISIONS.md`
- 隔離實測：`docs/spikes/2026-08-21-isolation-spike.md`
- E2E 場景：`docs/e2e-scenarios.md`
- §38 驗收條件對照：`docs/acceptance.md`

## 測試

```bash
npm test          # 63 個測試，不需要 codex
npm run typecheck

bash scripts/e2e.sh          # §37 九個 E2E scenario（會實際呼叫 codex）
bash scripts/e2e.sh G I      # 只跑不需要 codex 的
```

`docs/acceptance.md` 列出 §38 的 30 條 invariant 各自由哪個測試或 scenario 覆蓋。
