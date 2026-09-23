# 使用手冊

## 安裝

```bash
cd /path/to/agent-work-harness
npm install
npm link          # 讓 `harness` 全域可用
harness doctor    # 確認隔離真的生效（不是只在 prompt 裡寫）
```

需要 Node 24+、`codex` CLI（已登入）、`bwrap`。

`doctor` 印出「HOME 隔離與 network deny 生效」才算可用。它會實際在 sandbox 裡試著讀
`~/.secrets`、連外網 —— 有洩漏跡象就以 exit 4 失敗。**每次換機器或升級 codex 都值得重跑一次。**

state 全部在 `~/.local/share/agent-work-harness/`（`HARNESS_STATE_DIR` 可覆蓋），
跨專案共用，所以 `harness list` 會列出所有 repo 的 work。

---

## 在新專案第一次使用

```bash
cd <你的專案>
harness init .
```

它會偵測技術棧產生 `.harness/config.json` 的**候選**。這份檔案決定了兩件關鍵的事，
**一定要人工看過**：

| 欄位 | 決定什麼 | 看什麼 |
|---|---|---|
| `verification.checks` | 什麼叫「通過」 | 自動偵測常常漏或重複。required 的 check 沒跑到位，SUCCESS 就沒有意義 |
| `filesystem.protectedPaths` | 什麼碰不得 | 資料目錄、部署設定、憑證。`.git/**` 與 `.harness/**` 已預設 |

實際調整過的兩個例子：

```jsonc
// task-tracker：npm test 本身已包含 typecheck，init 產生的第二個 check 是重複的
"checks": [{ "id": "test", "kind": "test", "argv": ["npm", "test"], "required": true }]

// rag-stack：測試需要 PYTHONPATH，用 env(1) 表達，不需要新欄位
"argv": ["env", "PYTHONPATH=app", ".venv/bin/python", "-m", "unittest", "discover", "-s", "tests"]
```

確認後再跑一次 `harness doctor .`，它會印出 contract hash 與實際生效的 checks。

**依賴要先在 host 裝好**（`npm i`、`pip install`）。verification 跑在 network deny 的
sandbox 裡，在那裡面裝不了東西。

---

## 日常流程

```bash
harness new "修正 token 過期時回傳負數的 bug，不要碰 payment，也不要部署" --dir .
# → work: W-xxx   mode: write   denied: payment/**   constraints: 不要部署

harness run W-xxx
harness show W-xxx        # claim / evidence / outcome 分開看
```

`new` 會印出它從你的話裡解析出什麼。**看一眼再往下跑** —— 如果 mode 或 denied 不對，
現在改比事後便宜。幾個會被機械解析的說法：

```text
只看不要改 / 只分析          → mode = read
不要碰 payment              → deniedPaths += payment/**
只改 src/auth               → allowedPaths = ["src/auth/**"]（限縮範圍）
可以改 src/token            → 授權，但不限縮範圍
不要部署 / 不要提交          → constraints
```

注意「只改 X」和「可以改 X」不同：前者限縮 write scope，後者只是授權。
其他說法會原樣保留在 request 裡交給 agent 理解，不會被硬拆。

### 需要你決定時

```bash
harness answer W-xxx "可以改 src/token，但 payment 還是不要動"
harness retry W-xxx
```

`answer` 只累積**決策**，不累積對話。既有的 deny 不會因為新的授權而消失。

### 受控 Plan 與 Logical Checkpoint（P2）

使用者要改原始目標時，用 `amend` 建立新版 immutable WorkContract。舊版本保留，既有
constraints 與 denied paths 會累積到新版，不會因改寫 goal 而消失：

```bash
harness amend W-xxx "完成新版恢復流程，不要碰 production"
```

Plan 從 JSON 檔提出並經 deterministic validation；milestone 必須覆蓋目前 contract 的
acceptance criteria，dependency 不可缺失、自依賴或成環：

```json
{
  "contractVersion": 2,
  "branchId": "B-main",
  "reason": "initial plan",
  "milestones": [
    { "id": "M-1", "objective": "implement", "acceptanceCriterionIds": ["AC-..."] },
    { "id": "M-2", "objective": "verify", "acceptanceCriterionIds": ["AC-..."], "dependsOn": ["M-1"] }
  ]
}
```

```bash
harness plan propose W-xxx plan.json
harness plan activate P-xxx
harness run W-xxx --milestone M-1
```

有 active plan 時，每個 run/retry 都必須綁定 milestone。單一 milestone 的 SUCCESS 只完成該
milestone；active plan 的 required milestones 全部通過後，Work 才會 DONE。過期 plan 的
成功結果不會推進目前 active plan。

Checkpoint JSON 指定 `planId`、選用的 `parentCheckpointId`/`milestoneId`、`artifacts`、
`validationStatus` 與 `validationEvidenceIds`。Runtime 會驗證 artifact 存在且 hash 正確後才保存：

```bash
harness checkpoint create W-xxx checkpoint.json
harness checkpoint resume CP-xxx
harness plan fork CP-xxx fork.json
```

四種操作的語意不同：

| 操作 | 行為 |
|---|---|
| resume | 驗證 checkpoint schema、refs 與 artifact hash，回傳同 branch 的可用狀態；不執行模型、不改檔、不把 pending 提升為 validated |
| fork | 從 checkpoint 提出新 branch/child plan；保留 attempts、retry 計數、artifact 與 workspace 現況 |
| audit replay | 讀取既有 trace、artifact 與 checkpoint 做稽核；不重新執行模型或工具 |
| re-execution | 用 active plan/milestone 建立全新 attempt，重新計入執行與 retry 帳本 |

Checkpoint 是 append-only 的 logical state reference。它不代表 Git commit、worktree snapshot 或
filesystem rollback；resume/fork 都不會執行 `git reset`／`git clean`，也不能撤銷已發生的外部副作用。
同一 producer milestone 與 logical artifact name 的 hash 被替換時，已完成的下游 milestone 會
轉為 STALE，trace 會保存來源 artifact 與 dependency path。

### Fake Operation Gateway（P3）

P3 只接本機 fake provider，用來驗證 side-effect protocol。它不會呼叫真實外部 API；provider
狀態存放在 state directory 的 `fake-provider/ledger.json`，與 `harness.db` 分開，CLI 重啟後仍會
沿用相同 business identity 與 idempotency key。Codex runtime 與 repository verification shell
仍在 network-denied sandbox，不能直接走這條 provider path。

先為 Work 設整數 hard cap，再從 JSON 建立 operation：

```bash
harness fake budget configure W-xxx fake_write 30 fake-v1 unit
harness fake operation prepare W-xxx operation.json
harness fake operation dispatch OP-xxx
```

`operation.json` 範例：

```json
{
  "intentKey": "create:customer-7",
  "kind": "fake.create",
  "targetScope": "customer-7",
  "payload": { "businessId": "customer-7", "value": "enabled", "behavior": "success" },
  "precondition": "customer absent",
  "reconciliationStrategy": "lookup by idempotency key",
  "compensationPolicy": "remove exact owned version",
  "authorizationRef": "contract:C-1"
}
```

Gateway 會先持久化 intent、authorization reference、adapter capability snapshot 與 reservation，
再呼叫 provider。只有 receipt 與 postcondition 都通過才會進入 `SUCCEEDED` 並以 receipt 的實際整數
用量結算。Response 遺失或結果不明會進入 `UNKNOWN`，額度維持 reserved：

```bash
harness fake operation reconcile OP-xxx
harness fake operation show W-xxx
harness fake budget show W-xxx
```

UNKNOWN operation 不接受再次 dispatch。Lookup 的 not-found 在 completion window 內仍是 UNKNOWN；
confirmed no-effect 才會 `FAILED` 並釋放額度。Partial、unsupported 或 idempotency key 過期會轉
`WAITING_USER`。這套 hard cap 只適用 adapter 能提供可信 upper bound 與 receipt 的資源；Codex
token／費用目前維持 unknown 或 estimated，不能用 prompt 字元數冒充 token 或金額。

補償是另一個持久 workflow，有自己的 key、attempt、receipt 與 reservation：

```bash
harness fake compensation prepare OP-xxx compensation.json
harness fake compensation dispatch COMP-xxx
harness fake compensation reconcile COMP-xxx
```

`compensation.json` 必須指定 `authorizationRef`、原 receipt 的 `resourceIdentity`、`ownershipRef` 與
`targetVersion`。Identity、ownership、version 或 reversibility 不符時不會 dispatch。補償 UNKNOWN
也只能 lookup；原 operation 不會因補償意圖或不明結果就被視為已撤銷。

目前「外部副作用治理未接入」任何真實 provider。若未來加入 real adapter，必須另外證明 model／
shell 沒有繞過 Gateway 的寫入路徑，並保留現在的 network deny，才能擴大承諾。

### Temporal Durable Runtime（P4）

P4 是獨立的 Temporal 執行路徑；`harness run/retry` 與 `harness fake ...` 仍是 P1–P3 本機流程，
不會暗中改走 Temporal。先設定連線與 task queue：

```bash
export TEMPORAL_ADDRESS=localhost:7233
export TEMPORAL_NAMESPACE=default
export TEMPORAL_TLS=false
export HARNESS_TEMPORAL_TASK_QUEUE=harness-p4

# production worker 需成對設定
export HARNESS_TEMPORAL_DEPLOYMENT=harness-p4
export HARNESS_TEMPORAL_BUILD_ID=2026.09.23.1
```

啟動 worker：

```bash
harness durable worker
```

`workflow.json`：

```json
{
  "workId": "W-durable-1",
  "epoch": 1,
  "businessId": "customer-7",
  "value": "enabled",
  "generatedText": "saved durable output",
  "callbackTimeoutMs": 30000,
  "requiredWorkflowVersion": 1
}
```

啟動、查詢及送 callback：

```bash
harness durable start WF-durable-1 workflow.json
harness durable inspect WF-durable-1
harness durable callback WF-durable-1 callback.json
harness durable rollover WF-durable-1
harness durable cancel WF-durable-1
```

`callback.json` 必須含穩定 event ID、來源版本／序號、operation ID 與 receipt reference：

```json
{
  "eventId": "provider-event-42",
  "sourceVersion": 1,
  "sequence": 42,
  "operationId": "OP-...",
  "receiptRef": "provider:receipt-42"
}
```

取消指令送的是 durable signal；它會先停止新工作並進入 quiescence。UNKNOWN effect 未對帳完成時
不會假裝成 `CANCELLED`。`rollover` 只要求在安全等待點 Continue-As-New，Work、budget、operation、
callback dedupe、deadline 與 artifact refs 會帶到新 run，epoch 會增加。

本機 fake provider ledger 可用 `HARNESS_DURABLE_PROVIDER_LEDGER` 指定。這只適合測試；跨 host
部署必須改用每個 worker 都能存取且具備一致性／冪等保證的 provider 與 ledger。完整值班流程見
[Temporal operations runbook](runbooks/temporal-operations.md)，版本升級見
[Temporal upgrade runbook](runbooks/temporal-upgrade.md)。

### 讀懂結果

回應分成三塊，來源不同，不要混著看：

```text
Agent 判斷（未經 Harness 獨立驗證）   ← agent 說的，可能錯
實際修改（Harness 觀察）              ← git 觀察到的事實
驗證（Harness 執行）                  ← Harness 自己在隔離環境跑出來的
```

`SUCCESS` 的意思是「宣稱的驗證真的跑過且通過、變更沒有越界」，
**不是「agent 解對了問題」**。diff 還是要看。

---

## 出問題時怎麼查

| 想知道 | 指令 |
|---|---|
| 這次到底送了什麼 prompt | `harness prompt <attemptId>` |
| 發生順序、每一步的時間 | `harness trace <workId>` |
| Harness 觀察到什麼、evidence 明細 | `harness show <workId>` |
| codex 原始輸出 | `~/.local/share/agent-work-harness/attempts/<attemptId>/runtime.log` |
| 完整 diff / 測試輸出原文 | `~/.local/share/agent-work-harness/artifacts/` |
| 隔離是不是還有效 | `harness doctor <repo>` |

`attemptId` 從 `harness show` 的 attempts 段落取得。

### 常見狀況

**verification 顯示「執行規模未知」**
runner 的輸出格式不被支援（目前只認得 `node:test` 與 pytest 的摘要）。
判定會退回 exit code，不會誤判成失敗，但 pre-flight baseline 的保護在這個 repo 上不起作用。

**agent 說「測試沒跑完」，但 Harness 判 PASS**
信 evidence。agent 的執行環境比 verification 更受限（沒有可寫的 `/tmp`），
它跑不完不代表測試有問題。實測確認過至少三次都是環境假象。詳見 `DECISIONS.md` D-27。

**POLICY_VIOLATION，但我沒改那些檔案**
先看 `harness show` 的 `preExistingDirty` —— attempt 開始前就未提交的檔案不該算在 agent 頭上，
Harness 會扣除。如果那個檔案確實是這次動的，就是真的越界。

**連不到 DB / Redis / 本機服務**
verification 跑在獨立的 network namespace，只有自己的 loopback。
測試自己起 server 再連自己可以，連主機上已在跑的服務不行。詳見 `DECISIONS.md` D-26。

**測試需要環境變數**
用 `env(1)` 當 argv[0]，不需要改 contract schema：
`["env", "FOO=bar", "npm", "test"]`

**required check 跑太久**
`harness run <workId> --no-baseline` 跳過 pre-flight baseline，verification 只跑一次。
代價是失去「有沒有比 agent 動手前少跑」這個判斷。

**上次跑到一半被中斷**
Harness **不會在 CLI 啟動時掃描、接手或重跑**中斷的 attempt。先執行：

```bash
harness ownership
```

如果 ownership 可正常取得，`harness recover <workId>` 會讀取該 attempt 原本凍結的 input snapshot，
並建立獨立 recovery session。這個動作只讀取目前 workspace，不執行模型、不執行 verification、
不做 `git reset`／`git clean`，也不會把 recovery 判成 `SUCCESS`。輸出分為「已知／未知／可採取動作」；
要重新驗證或繼續工作，應以目前有效的 contract 建立新 attempt。

若顯示 `SNAPSHOT_UNAVAILABLE` 或 `ARTIFACT_CORRUPT`，保留舊 attempt、artifact 與 evidence。
不要用目前的 contract 或 repository config 回填歷史輸入。現況只能由新 attempt 重新凍結並驗證。

**OWNER_UNKNOWN 的人工處置**

1. 保存 `harness ownership` 的完整輸出，並備份整個 state directory（預設
   `~/.local/share/agent-work-harness/`）。
2. 確認舊 harness process、metadata 記錄的 Codex child，以及相關受管執行環境都已停止。
   PID 不存在本身不足以證明 child 沒有留下副作用。
3. 只要任何一項無法確認，就維持 blocked；不要刪除或改寫 `execution.lock`。
4. 全部確認且 state 已備份後，操作者可把 `execution.lock` 移到備份位置，再執行
   `harness recover <workId>` 做只讀觀察。P1 沒有 force-unlock 或自動 orphan 接手機制。

---

## 記錄使用中發現的問題

Harness 會記下所有機械事實，但有一件事只有你知道：**它判錯了**。

```bash
harness note <workId> <kind> "<說明>"
harness notes [kind]
harness stats
```

`kind` 直接對應 `DECISIONS.md` 裡的升級判準：

| kind | 什麼時候用 |
|---|---|
| `false-accept` | evidence 判 PASS，但實際上是壞的 |
| `false-block` | 正當的工作被錯誤擋下 |
| `retry-churn` | 因 context 或 evidence 不足而反覆重跑 |
| `blocked-work` | 某類工作因為已知限制根本做不了 |
| `friction` | 為了繞過某個限制必須反覆做額外的事 |
| `other` | 其他值得記下來的觀察 |

這不是抱怨箱。`DECISIONS.md` 有一份 **observed limitations（watch list）**，
上面每一項都已知、但都還沒造成實際損害。它們留在那裡是為了被認出來，不是為了被做完。

`harness notes` 累積出模式時，才把對應的項目移出 watch list 變成要做的事。
沒有這些記錄，「該不該修」就只能憑印象。

`harness stats` 回答趨勢問題（retry 率、outcome 分佈、各類 note 的數量）——
「大量 retry」這條判準需要看的就是它。

---

## 其他

```bash
harness list                          # 所有 work
harness skills approve <id> <dir>     # 核准 skill（hash 改變即失效，不會自動更新）
harness skills list                   # 含當下的 admission 結果
```

- 設計文件：`agent-work-harness-design.md`
- 實作決策與已知限制：`DECISIONS.md`
- 驗收對照：`docs/acceptance.md`
- 跨 repo 驗證記錄：`docs/cross-repo-validation.md`
