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
