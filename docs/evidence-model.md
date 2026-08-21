# Evidence 四層模型

> 狀態：設計，**尚未實作**。本文件定義 Evidence 可信度的分層與演進方向，
> 對應設計文件 §23（Evidence-first 驗證）的延伸。

## 為什麼需要分層

MVP 已經解掉第一層不等式：

```text
Agent claim ≠ truth
```

Harness 不採信 agent 自述，自己觀察 git、自己執行 verification。這是對的，但 dogfood
（`docs/dogfood.md`）暴露了後面還有兩層：

```text
Verification PASS ≠ Verification 完整
Verification 完整 ≠ Verification 足以證明需求真的正確
```

實際發生的事：agent 為它的修正補了一條斷言，那條斷言在正常環境會失敗。
但該測試檔在隔離環境被整個 skip，`npm test` 仍然 exit 0，Evidence 記為 PASS，
Outcome 判為 SUCCESS。

目前的判定鏈是：

```text
Repository Contract → argv → isolated execution → exitCode == 0 → PASS
```

`exitCode == 0` 只能回答「這條命令沒有失敗」，不能回答「該跑的東西跑了沒有」。

## 四層

| 層級 | 要回答的問題 | 觀察對象 |
|---|---|---|
| **E1 Integrity** | 這份 Evidence 是真的執行出來的嗎？ | exit code、timeout、實際 argv、執行環境、輸出是否完整 |
| **E2 Completeness** | 該跑的東西真的都跑了嗎？ | 執行數量、skip 數量、runner 是否降級 |
| **E3 Independence** | Evidence 是不是 agent 自己製造來證明自己的？ | 測試的來源：既存 / 本次新增 / 本次修改 |
| **E4 Sufficiency** | 這些 Evidence 足以支撐這個完成宣告嗎？ | unit test PASS 能不能證明 login 500 被修掉 |

四層是**遞進**的：E2 只有在 E1 成立時才有意義，E3 只有在 E2 成立時才有意義。
一份 timeout 的 evidence 談不上完整性；一份跳過一半測試的 evidence 談不上獨立性。

## 目前的實際狀態

| 層級 | 狀態 |
|---|---|
| E1 | 大致成立。`EvidenceRecord.data` 已記 `exitCode`、`timedOut`、`argv`、`durationMs`；attempt 記 `baseRevision` 與 `contractSnapshotHash`。**已知缺口**：stdout/stderr 超過 `maxOutputBytes`（2MB）會被截斷，但 evidence 沒有記錄「被截斷」這件事，`tail` 取的是截斷後的末段，看起來像完整結尾。 |
| E2 | **缺口**。只看 exit code。 |
| E3 | 部分。`path_policy` 能擋 denied path，`.harness/**` 預設 protected（agent 改不了自己的驗收規則），但無法區分「既存測試通過」與「agent 剛寫的測試通過」。 |
| E4 | 刻意不宣稱能解。見下文。 |

這個邊界是合理的：**Harness 能保證的上限，等於它能獨立取得的觀察的上限。**

---

## 方向一：Completeness

目標是把判定鏈從

```text
exit 0 → PASS
```

變成

```text
exit 0
+ 預期的測試有執行
+ skip 沒有異常增加
+ runner 沒有降級
→ PASS
```

例如同一個 repo 的兩次執行：

```text
pre-flight:  total 63, pass 63, skip 0
post-agent:  total 63, pass 55, skip 8
```

即使 `exit = 0`，也應該是 `INCONCLUSIVE` 而不是 `PASS`。

### baseline 從哪裡來

這是 completeness 的關鍵問題，兩個直覺的來源都不能用：

- **從上一次成功的 attempt 取** —— 第一次 attempt 沒有 baseline。
- **由 Repository Contract 靜態宣告** —— repo 可以謊報，且會隨著測試增減立刻過期。

正解是 **pre-flight baseline**：attempt 開始前、agent 動任何東西之前，
Harness 自己先跑一次 required checks。

它一次解掉三件事：

```text
1. completeness 的比較基準
   skip 從 0 變 8 → INCONCLUSIVE

2. 區分「agent 弄壞的」與「本來就壞的」
   pre-flight 就 FAIL 的 3 個測試，post-agent 仍 FAIL
   → 不是 agent 造成的，不該讓 agent 背這個鍋

3. E3 最強的單一指標（見方向三）
   pre-flight FAIL 的既存測試在 post-agent 變 PASS
```

第二點修掉一個目前存在的真實問題：在一個測試本來就有失敗的 repo 上跑 write attempt，
agent 就算把該修的修好了，Harness 仍會判 required verification FAIL。

### 最小資料模型

```ts
interface VerificationEvidenceData {
  checkId: string;
  kind: VerificationCheck['kind'];
  argv: string[];
  required: boolean;

  execution: {
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    outputTruncated: boolean;      // E1 的缺口
  };

  completeness?: {                  // 只有解析得出來的 runner 才填
    executed?: number;
    passed?: number;
    failed?: number;
    skipped?: number;
    baseline?: { executed: number; skipped: number };
  };
}
```

**不要為了填滿欄位而猜**。解析不出來就是 `completeness: undefined`，
response 誠實顯示 `completeness: unknown`。這跟 §3.2「能安全機械處理的才結構化」是同一條原則。

第一批只需要支援少數 runner 的輸出格式（`node:test` 的 `ℹ tests/pass/fail/skipped`、
pytest 的結尾摘要），其他一律 unknown。

### 判定規則

```text
exitCode != 0                          → FAIL
timedOut                               → INCONCLUSIVE
completeness unknown                   → PASS（維持現狀，不假裝知道）
skipped > baseline.skipped             → INCONCLUSIVE
executed < baseline.executed           → INCONCLUSIVE
否則                                    → PASS
```

注意 `completeness unknown → PASS` 是刻意的：不能因為 Harness 解析不了某個 runner 的輸出，
就讓所有用該 runner 的 repo 永遠無法通過驗收。**未知不等於失敗**，
但它應該在 response 中可見。

---

## 方向二：Evidence State Binding

一份 Evidence 必須能回答「這是對哪一個狀態的觀察」，否則它可能被拿去證明別的狀態。

```ts
interface EvidenceSubject {
  repositoryId: string;
  baseRevision: string;
  headRevision: string;
  repositoryContractHash: string;
  commandHash: string;
  environmentHash?: string;
}
```

```text
tests PASS @ head AAA
```

不能被拿去證明：

```text
head BBB
```

這不是新功能，是防 stale evidence。目前 attempt 層級已經記了 `baseRevision` 與
`contractSnapshotHash`（§36.2 C2），但個別 evidence 沒有綁定 head。

### 它同時是 baseline 的快取鍵

pre-flight baseline 的成本是 verification 時間翻倍。要負擔得起就必須能重用，
而重用的判斷條件正好就是 subject：

```text
同一個 repositoryId + baseRevision + repositoryContractHash + commandHash
→ 直接重用先前的 baseline，不重跑
```

所以方向二不是獨立的第二件事，**它是方向一能不能負擔得起的前提**，兩者必須一起做。

即使有快取，對測試跑十分鐘的 repo 來說第一次仍然是實打實加十分鐘。
需要一個逃生口（`--no-baseline`），並在 evidence 中標明本次沒有 baseline。

---

## 方向三：Independence

### 真正該問的問題

不是「agent 有沒有改測試」，而是：

> **把這次 attempt 新增和修改的測試全部拿掉之後，還剩下什麼證據？**

如果一個 bug fix 的證據全部來自 agent 本次新寫的測試，那是自己出題自己答。
反過來，如果有一個**既存**的失敗測試在這次變成通過，那是強得多的證據 ——
因為那個測試在 agent 介入之前就存在，它不可能是為了配合這次修改而寫的。

```text
pre-flight:  test_login_500  FAIL
post-agent:  test_login_500  PASS
```

**這是 E3 最強的單一指標，而且是 pre-flight baseline 的免費副產品**，不需要額外成本。

### Provenance 分類

```text
pre-existing test        既存測試
agent-added test         本次 attempt 新增
agent-modified test      本次 attempt 修改
harness-generated check  Harness 自己產生的檢查
external readback        外部狀態回讀
```

分類依據是 git 觀察到的 changedPaths 與測試路徑的交集 —— 不採信 agent 宣告。

### Core 不能猜哪些檔案是測試

`test/**` 是 Node 慣例、`tests/test_*.py` 是 Python 慣例、`*_test.go` 是 Go 慣例。
讓 Core 內建這些規則，正是 §34 要避免的 domain 洩漏。應該由 Repository Contract 提供：

```ts
verification: {
  checks: VerificationCheck[];
  testPaths?: string[];      // 例如 ["test/**", "tests/**"]
}
```

沒有宣告就是 `provenance: unknown`，不假裝知道 —— 與 completeness 同一原則。

### 呈現，而不是阻擋

agent 修改測試不該一律視為不可信 —— 正當的測試更新非常常見。
應該做的是讓 response 顯示可信度的組成：

```text
驗證（Harness 執行）
- test (npm test)：PASS
    63 個測試全部執行，0 skip（baseline: 63 / 0）
    既存測試 58 通過，其中 1 個在本次由 FAIL 轉 PASS
    本次新增測試 3 個通過
    本次修改既存測試 2 個
```

比單純一行 `npm test: PASS` 的資訊量高得多，而且使用者能自己判斷。

MVP 不需要 numeric confidence score。把組成攤開來就夠了；
把它壓成一個 0.87 反而丟失資訊。

未來若要更嚴，可以由 Repository Contract 宣告策略（例如「證明 bug fix 的測試若全部是
本次新寫的，則不接受」），但那是 repo 的政策選擇，不是 Core 的預設。

---

## 方向四：Sufficiency —— 刻意不做通用 Engine

需求是「修掉登入偶發 500」，Harness 看到的是：

```text
unit test PASS
typecheck PASS
lint PASS
```

它能證明的是 `configured checks passed`，不能證明 `production login 500 一定不存在`。

這就是 §7.1 那條界線。Outcome 的正確語意應該是：

```text
ACCEPTED BY EVIDENCE CONTRACT
```

而不是：

```text
Semantic truth proven
```

（目前實作用的字是 `SUCCESS`，語意上過度承諾，應改名。）

### 機制其實已經存在

「Repo-specific Evidence Profile」聽起來需要新框架，但它**已經是 `verification.checks[]` 了**：

```text
一般 library     unit + typecheck
HTTP service     unit + integration
frontend         unit + build + browser smoke
deployment       CI + deploy + health + readback
```

Core 完全不需要知道 `browser smoke` 是什麼意思，它只負責用 argv 在隔離環境執行、收集 exit code。
repo 想要更高的 sufficiency，就在 contract 裡多寫 checks。

所以 E4 缺的不是機制，是 Core 是否該去**表達**覆蓋強度。目前傾向：不表達。
使用者看到 `test (npm test): PASS` 就知道那是 unit level；
加一個 `coverageClaim` 欄位反而是 §7.2 警告的 God Object 傾向。

真正需要的話，優先做法是讓 response 列出實際執行的 checks（已經有了），
而不是讓 repo 自我宣告一個抽象等級。

---

## 實作順序

| 順序 | 內容 | 影響範圍 |
|---|---|---|
| 1 | Evidence subject（state binding） | 新增欄位，是 2 的前提 |
| 2 | Pre-flight baseline + completeness | orchestrator、verification、outcome |
| 3 | 輸出截斷旗標（補 E1 缺口） | `exec.ts`，數行 |
| 4 | Test provenance | Repository Contract schema（會動到 §38 invariant 21 的測試） |
| 5 | `SUCCESS` → `ACCEPTED_BY_EVIDENCE` | 純命名，掃過多個檔案但無風險 |

1–3 是同一組改動，建議一起做。4 動 contract schema，需要 schema 版本相容考量。
5 隨時可做。

## 明確不做

- **用第二個 LLM 判斷 evidence 是否可信**。那只是把不可驗證性搬到另一個地方，還多一層。§3.3 已禁止。
- **numeric confidence score**。把組成攤開比壓成一個數字更有用。
- **通用 Evidence Sufficiency Engine**。見方向四。
- **為了填滿 completeness 欄位而猜測 runner 輸出**。解析不出來就是 unknown。
