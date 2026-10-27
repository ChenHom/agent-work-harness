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

### 審查交接（`harness review`）

Attempt `SUCCESS` 之後，Harness 不會替你 commit。看過 diff、自己 commit 之後，用 `harness review`
證明這個 commit 正是那個 Attempt 的結果，並交給 Reviewer 做離線的機械審查：

```bash
git add -A && git commit -m "..."        # 人 commit；commit 前不要再改任何東西
harness review W-xxx --attempt A-xxx --head "$(git rev-parse HEAD)"
harness review W-xxx --attempt A-xxx --head <40 位 SHA> --json   # stdout 是 envelope JSON
harness show W-xxx                        # [review] 段落：最新一次審查
```

`--attempt` 必須明確給，不會自動挑「最新成功」的 Attempt；`--head` 只接受完整的 40 位小寫 SHA。
`review` 會寫入狀態，執行時取得 `execution.lock`。

依序檢查，任一步不符就停：

1. 前提（只讀 Harness 的紀錄）：Attempt 屬於這個 work、outcome 是 `SUCCESS`、開始前沒有既有修改
   （開始時的 dirty 快照失敗也視同有，`PRE_EXISTING_DIRTY`）、
   記錄了 `resultTree`、Work Contract 版本沒變。
2. candidate（git 在唯讀沙箱內執行）：workspace 是 repository 根目錄、commit 存在、
   `<sha>^{tree}` 等於 `resultTree`、`merge-base(baseRevision, sha)` 等於 `baseRevision`。
3. 乾淨副本：`git clone --no-local --no-checkout` 到 `<state dir>/review-work/<id>/verify/`，checkout 該 SHA。
   以 Attempt 開始時凍結的 Repository Contract，對 `baseRevision..sha` 的變更路徑重新評估 path policy，
   並重跑 checks。checks 跑完之後，才從 workspace 重新 clone 一份 `repo/` 交給 Reviewer；這份副本從未暴露給 checks。
   兩份副本裡都再檢查一次第 2 步的 tree 與 merge-base（副本的 refs 由 Harness 建立，沒有 replace refs 或 grafts）。
   暫存目錄結束時一律刪除（checks 留下沒有寫入權限的目錄時先補上擁有者權限；真的刪不掉只在 stderr 印
   `warning: review-work cleanup failed: …`，不改變 exit code）。
   Harness 自己的 git 呼叫（含 Attempt 的 git evidence 與 `resultTree`）一律不讀全域與 system 設定、不採用
   replace refs、不執行 hook 與 fsmonitor：verification HOME 是共用且可寫的，checks 可以在裡面放 `.gitconfig`。
4. Reviewer：先 `docker image inspect` 取得 image ID 與 revision label，之後只用 image ID 執行。
   `--network none`、`--read-only`、候選副本唯讀掛載、不傳任何 `ANTHROPIC_*`、不加 `--ai`。
5. 驗證報表：審查的必須正是 `baseRevision..sha`，計數一致，`ai` 為 `null`，每個檔案的 `needsHuman` 與它的
   decision 一致（離線時 `needsHuman` 就是 decision 為 `HUMAN_REVIEW_REQUIRED`），而且列出的檔案正是 Harness
   在 `repo/` 以 Reviewer 同一組 git 旗標（`git diff --raw -z --no-abbrev -M`，rename 取新路徑）算出的變更。審查期間 Attempt 與
   contract 都沒有變化，才把原始報表與 envelope 存成 artifact，並記一筆 `review.completed`。

`resultTree` 是 Attempt 結束時工作樹的完整內容（含 untracked、binary、mode、symlink；不含被 ignore 的
untracked 檔），等於你當下執行 `git add -A && git commit` 會得到的 tree。commit 前另外改了東西、
只 commit 一部分，都會得到 `CANDIDATE_TREE_MISMATCH`，要重跑 Attempt。

設定（Global Policy；`policy.json` 在 state dir，同時設定時優先於環境變數）：

| 欄位 | 預設 | 說明 |
|---|---|---|
| `reviewerImage` | `HARNESS_REVIEWER_IMAGE` | Reviewer image 的 tag 或 ID，必須有 40 位 commit 的 `org.opencontainers.image.revision` label。未設定時審查失敗 |
| `reviewTimeoutMs` | `600000`（10 分鐘） | 超過就 `docker kill` |
| `maxReviewReportBytes` | `5242880`（5 MB） | 報表大小上限 |

Harness 以 uid 0 執行時，拒絕啟動 Reviewer。

| exit code | 意義 |
|---|---|
| 0 | 報表有效，沒有人工待辦（`NO_CHANGES` 或 `NO_HUMAN_REVIEW`） |
| 5 | 報表有效，Reviewer 選入了需要人工 review 的檔案（`HUMAN_REVIEW_REQUIRED`）；不算失敗，也不算完成 |
| 2 | stderr `BLOCKED <CODE>: detail`：前提不成立，沒有執行審查 |
| 3 | stderr `<CODE>: detail`：審查執行失敗或報表不可用 |
| 1 | 用法錯誤，或找不到 work／attempt |

| 代碼 | exit | 什麼時候 |
|---|---|---|
| `CANDIDATE_NOT_SHA` | 2 | `--head` 不是完整的 40 位小寫 SHA（branch、`HEAD`、縮寫、大寫都不收） |
| `WORK_NOT_FOUND`、`ATTEMPT_NOT_FOUND` | 1 | 找不到 |
| `ATTEMPT_WORK_MISMATCH` | 2 | Attempt 不屬於這個 work |
| `ATTEMPT_NOT_SUCCESS` | 2 | Attempt 的 outcome 不是 `SUCCESS` |
| `PRE_EXISTING_DIRTY` | 2 | Attempt 開始前就有未提交的修改（第一版不支援），或開始時的 dirty 快照失敗（無法確認） |
| `ATTEMPT_RESULT_UNRECORDED` | 2 | Attempt 沒有記錄 `resultTree`（本功能之前的舊 Attempt） |
| `CONTRACT_STALE` | 2 | Attempt 之後 Work Contract 改過版（`amend`） |
| `WORKSPACE_NOT_GIT_ROOT` | 2 | workspace 不是 repository 根目錄（或沙箱內的 git 無法執行） |
| `CANDIDATE_NOT_FOUND` | 2 | commit 不存在，或沒有被任何 branch／tag 指到（乾淨副本裡拿不到） |
| `CANDIDATE_TREE_MISMATCH` | 2 | candidate 的 tree 不等於 `resultTree` |
| `CANDIDATE_NOT_DESCENDANT` | 2 | candidate 不是從 `baseRevision` 長出來 |
| `VERIFICATION_FAILED` | 3 | 乾淨副本上 required check 未通過、path policy 越界，或凍結的 contract 快照不可用 |
| `REVIEW_RUNNER_FAILED` | 3 | 未設定 image、image 不存在或缺 revision label、uid 0、docker 失敗、container exit 非 0 |
| `REVIEW_TIMEOUT` | 3 | 超過 `reviewTimeoutMs` |
| `REVIEW_REPORT_INVALID` | 3 | 報表不存在、過大、不是一般檔案（例如 symlink）、不是 JSON、內容不一致，或列出的檔案與 `baseRevision..sha` 的變更不符 |
| `REVIEW_STALE` | 3 | 審查期間 Attempt、outcome、`resultTree` 或 Work Contract 版本有變化 |
| `REVIEW_INTERNAL_ERROR` | 3 | 審查流程中非預期的例外（例如 state dir 的檔案系統錯誤）；不保存成功結果，留下 `review.failed` |

失敗時不保存任何 review artifact，只記一筆 `review.failed`（含 code）。

`show` 的 `[review]` 段落顯示最新一筆 review 事件。最新一筆是失敗時印 `FAILED <code> (exit <n>): …`，
較早的成功結果不會蓋過它。最新一筆是 `review.completed` 時顯示 status、candidate、envelope 與原始報表的
sha256、Reviewer image ID 與 revision、人工待辦清單，以及未選入清單；Work Contract 之後改版時，前面多一行
`STALE: work contract is now v<n>; this review is for v<m>`。顯示前會重新確認兩個 artifact
都存在、hash 與紀錄相符；缺失或被改過時只印 `REVIEW_ARTIFACT_INVALID: …`，不會顯示成成功。
來自報表與外部程序的字串（path、reasons、錯誤 detail）中的控制字元（C0、DEL、C1，含 ESC 與換行）印成 `\xNN`。

限制（M1）：

- **未選入不等於安全。** Reviewer 的 fact layer 尚未接入（DEV-01）。未選入的檔案只代表「機械審查沒有選入」，
  envelope 與輸出都這樣標示。
- 乾淨副本只有 commit 進去的內容。依賴被 ignore 的本機檔案（例如 `node_modules`、`.env`）的 check 會失敗。
- submodule、Git LFS、`.git` 是 gitfile 的 workspace（例如 `git worktree`）都未驗證。
- `resultTree` 與 review 的 git 不採用你的全域 git 設定（例如 `core.excludesFile`、`core.autocrlf`、LFS 的 filter）。
  這些設定會讓你 commit 的 tree 與 `resultTree` 不同，結果是 `CANDIDATE_TREE_MISMATCH`（fail closed，不會誤判通過）。
- SHA-256 object format 的 repository 不支援 review：`resultTree` 只接受 40 位 hex，算不出來時 Attempt 仍可以是
  `SUCCESS`（git_diff evidence 只記下 probe error），之後的 `harness review` 回 `ATTEMPT_RESULT_UNRECORDED`。
- 需要本機 Docker。container 以 `--network none`、`--read-only`、`--cap-drop ALL` 與非 root 的 `--user` 執行；
  不加 `--security-opt no-new-privileges`，因為本機 snap 版 Docker 29.8.0 加了它就無法 exec image 的 entrypoint（D-42）。
  snap 的 `/tmp` 是私有的：state dir 放在 `/tmp` 底下時，container 看到的是空目錄，請使用預設的 state dir。

端到端驗證（M1 的完成證據）：`scripts/review-e2e.sh` 以真實的 git、bwrap、Docker 與 Reviewer image
從零跑一遍 `harness review`，不呼叫真實的 codex 或任何 AI（腳本自己寫兩支假 codex：一支改檔、一支不改）。

```bash
HARNESS_REVIEWER_IMAGE=reviewer:m1-2d84ad6 bash scripts/review-e2e.sh
```

- 前提：`git`、`bwrap`、`docker`、Node 24+，以及本機已有 `HARNESS_REVIEWER_IMAGE` 指定的 image。
  缺任何一項就 exit 1；腳本不 build、不 pull。
- 工作目錄 `OUT` 預設為 `${XDG_CACHE_HOME:-$HOME/.cache}/harness-review-e2e/<時間戳記>`，可用 `HARNESS_E2E_OUT` 覆寫。
  不要放在 `/tmp` 底下（snap 版 Docker 看不到）。每個情境有自己的 state dir（`$OUT/state-<情境>`）與 fixture repo
  （`$OUT/repos/<情境>`），各指令的輸出在 `$OUT/<情境>.*`。
- 情境：S1 改檔後人 commit → exit 5 `HUMAN_REVIEW_REQUIRED`，`show` 的 sha256 與人工待辦一致，
  review 前後 repo 的 HEAD、refs、status、`.git/index`、object 數都不變；S2 唯讀、以 base commit 審查 → exit 0 `NO_CHANGES`；
  反例 `CANDIDATE_TREE_MISMATCH`、`PRE_EXISTING_DIRTY`、`CANDIDATE_NOT_SHA`（`HEAD` 與 7 位縮寫）、
  `REVIEW_RUNNER_FAILED`（不存在的 image）。
- 每個情境印 `PASS <情境>` 或 `FAIL <情境>: <期望> vs <實際>`，最後印 `total=<n> fail=<n>` 與 `OUT`；
  有任何 FAIL 就 exit 1。`OUT` 保留供查看，但結束時會刪掉其中的 `codex-home`
  （Harness 會把操作者的 `~/.codex/auth.json` 複製進去）。

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
成功結果不會推進目前 active plan。fork 或重新規劃可引用 checkpoint artifact，但新 plan 的
milestone 一律從 PENDING 開始；artifact 可重用不等於舊 plan 的完成判定可沿用（D-34）。

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

人工從 provider 的獨立 audit／console 建立真相後，將 resolution 寫成 JSON，再解決 `WAITING_USER`：

```bash
harness fake operation resolve OP-xxx resolution.json
```

成功 resolution 必須含 `outcome: "confirmed-success"`、`authorizationRef: "human-review:<ref>"`、
非空 `note` 與完整 receipt（含實際整數用量）；確認沒有副作用則用
`outcome: "confirmed-no-effect"`。Harness 會保存 resolution artifact，並在同一交易中更新 operation
與結算或釋放 reservation。原本 UNKNOWN 的 dispatch attempt 保持不變；不要用模型輸出、猜測或逾時
當成人工證據，也不要直接改 SQLite。`authorizationRef` 只是 audit reference，不會自行授予 authority；
authority 來自 operator 主動執行這個受 execution ownership 保護的 CLI action，因此 state directory 的
作業系統存取權限必須只開放給可信 operator。

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

### Evaluation、保留與備份（P5）

P5 的指令都輸出 JSON。完成判定固定：必要或硬限制的 `fail` 優先，其次任何必要 `unknown`
（含缺少、過期、替換或損壞的 evidence）都擋住 `DONE`；critic 的 confidence 與 optional criterion
不參與判定。

```bash
harness eval show W-xxx                        # contract、runs、每個 criterion 的 verdict 與完成決策
harness replay inspect [W-xxx]                 # 從已存 evidence 重算決策與預算，並分類可否重播
harness report calibration labels.jsonl predictions.jsonl   # 依 task type × evaluator version 的誤收／誤拒／棄權
harness report recovery --seed 1 --runs 64     # recovery-v1 benchmark，含失敗與 unknown run 的尾端分布
harness gc preview --out gc.json               # 只產生 manifest，不刪任何東西
harness gc apply gc.json                       # manifest 未變且候選仍不可達才刪，留 tombstone 與證據
harness redact AR-xxx --authority user:ops --reason "外洩憑證"
harness backup create /backups/2026-09-23      # DB + artifact，一致性快照
harness backup verify /backups/2026-09-23
harness backup restore /backups/2026-09-23 /tmp/restore-drill   # 只能還原到空目錄
```

`predictions.jsonl` 每行是 `{ "evaluator": {name, version, configHash}, "caseId", "verdict": <criterion verdict> }`；
標註集只接受 `human-review` 或 `fixture-author` 來源，模型產生或受測 evaluator 自己產生的標註會被拒絕。
保留窗口、GC 審核、備份存取、還原演練、redaction 與無法重播時的處理見
[evaluation/retention runbook](runbooks/evaluation-retention.md)。

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
harness list --json                   # 同上，JSON；含最新 attempt 的 status/phase/child pid，供外部輪詢
harness skills approve <id> <dir>     # 核准 skill（hash 改變即失效，不會自動更新）
harness skills list                   # 含當下的 admission 結果
```

`list --json` 的 `outcome` 只在它屬於最新 attempt 時才有值；retry 進行中為 `null`，不會把上一輪結果當成現況。

- 設計文件：`agent-work-harness-design.md`
- 實作決策與已知限制：`DECISIONS.md`
- 驗收對照：`docs/acceptance.md`
- 跨 repo 驗證記錄：`docs/cross-repo-validation.md`
