# Evidence 四層模型

> 狀態：**第一版（E2 Completeness）已實作**，E3/E4 仍是設計。
> 本文件定義 Evidence 可信度的分層與演進方向，對應設計文件 §23（Evidence-first 驗證）的延伸。
>
> 已實作範圍：evidence 綁定 revision / contract hash、pre-flight baseline、
> 與 baseline 比較的判定規則、`outputTruncated`。
> 對應 `src/evidence/verification.ts`、`test/verification.test.ts`、
> `test/verification-integration.test.ts`。

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
| E1 | 成立。verification evidence 記 `exitCode`、`timedOut`、`outputTruncated`、`durationMs`、`baseRevision`、`headRevision`、`contractHash`。輸出超限時 `tail` 會明確標示「這是保留段的末端，不是真正結尾」。 |
| E2 | **已實作**。exit 0 之外還比對 pre-flight baseline 的執行數與 skip 數；解析不出來的 runner 標為未知而不是失敗。 |
| E3 | 部分。`path_policy` 能擋 denied path，`.harness/**` 預設 protected（agent 改不了自己的驗收規則），但無法區分「既存測試通過」與「agent 剛寫的測試通過」。**降級為後續候選** —— 見方向三。 |
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

MVP 只用它回答一件事：**這次有沒有比 agent 動手前變差或少跑？**

```text
本來 PASS   → 現在 FAIL
本來跑 63   → 現在只跑 55
本來 skip 0 → 現在 skip 8
```

它還會順帶產出兩個副產品，但**刻意不在 MVP 使用**：

```text
副產品 1：區分「agent 弄壞的」與「本來就壞的」
  pre-flight 就 FAIL 的測試，post-agent 仍 FAIL → 不是 agent 造成的
  → 屬於「既存 failing repo 如何仍能接受工作」，是另一個需求

副產品 2：E3 最強的指標
  pre-flight FAIL 的既存測試在 post-agent 變 PASS
  → 等到 provenance 有真實需求時再取用（見方向三）
```

先把它們記下來，等有真實案例時取用的成本很低。

### 最小資料模型

只保留有真實失敗案例支撐的欄位。

```ts
interface VerificationEvidence {
  checkId: string;

  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';

  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;

  baseRevision: string;
  headRevision: string;
  contractHash: string;

  executed?: number;    // runner 解析得出來才填
  skipped?: number;     // 同上
}
```

| 項目 | 必填 | 原因 |
|---|---:|---|
| `checkId` | ✓ | 知道是哪個 verification |
| `status` | ✓ | PASS / FAIL / INCONCLUSIVE |
| `exitCode` | ✓ | 最基本的機械證據 |
| `timedOut` | ✓ | timeout 不能算 PASS |
| `baseRevision` | ✓ | 防 stale evidence |
| `headRevision` | ✓ | 確認驗證的是哪份修改 |
| `contractHash` | ✓ | 確認驗證規則沒換 |
| `outputTruncated` | ✓ | 避免把不完整輸出當完整證據 |
| `executed` / `skipped` | 選填 | runner 能解析才填 |
| provenance | 後續候選 | 沒有解已發生的 false positive |
| `environmentHash` | 不做 | 太早 |
| `workspaceStateHash` | 不做 | 不值得增加複雜度 |
| numeric confidence | 不做 | 沒必要 |

**不要為了填滿欄位而猜**。解析不出來就是 `undefined`，response 顯示 `completeness: unknown`。
這跟 §3.2「能安全機械處理的才結構化」是同一條原則。

第一批只需要支援少數 runner 的輸出格式（`node:test` 的 `ℹ tests/pass/fail/skipped`、
pytest 的結尾摘要），其他一律 unknown。

### `outputTruncated` 的實際機制

名字容易誤導。實測（`execFile` + `maxBuffer`）的行為是：

```text
輸出超過 maxBuffer
→ 行程被殺掉
→ err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'（字串，不是數字）
→ 保留的是輸出的「開頭」，結尾丟失
```

所以它不是「輸出被截短但行程正常結束」，而是**執行根本沒跑完**，語意上更接近 timeout。
三個後果：

1. 判為 INCONCLUSIVE 的理由比「證據不完整」更強 —— 是執行不完整。
2. 目前的實作會把它誤判成 FAIL：`err.code` 是字串，`exitCode` 變成 `null`，
   落到「其他 → FAIL」，而且 evidence 上看不出原因。
3. 測試摘要在結尾，必然丟失，所以這種情況下 `executed` / `skipped` 一定解析不到 ——
   兩條規則天然一致，不會互相打架。

順帶：evidence 的 `tail` 目前取的是「保留下來那段的末端」，也就是輸出開頭 2MB 的尾巴，
不是真正的結尾。對使用者極具誤導性（看起來像測試跑到一半卡住），應一併修正為明確標示。

### Baseline

不需要先設計一整套狀態機（`FIXED_BASELINE_FAILURE` / `UNCHANGED_BASELINE_FAILURE` /
`REGRESSION` …）。MVP 只需要回答一件事：

> **這次 verification 有沒有比執行 Agent 前變差或少跑？**

```ts
interface VerificationBaseline {
  checkId: string;
  exitCode: number | null;
  executed?: number;
  skipped?: number;
}
```

### 判定規則

```text
post timedOut                    → INCONCLUSIVE
post outputTruncated             → INCONCLUSIVE
baseline 不可用                   → 退回現行行為（exit 0 → PASS），evidence 標明 baseline unavailable
baseline PASS 且 post FAIL       → FAIL
executed < baseline.executed     → INCONCLUSIVE
skipped  > baseline.skipped      → INCONCLUSIVE
post exit 0                      → PASS
其他                              → FAIL
```

兩條原則貫穿其中：

- **未知不等於失敗**。runner 解析不出 completeness、或 baseline 本身跑不起來，
  都退回現行行為而不是判失敗。否則 Harness 解析能力的缺口會變成 repo 的驗收障礙。
- **不完整不等於通過**。timeout 與 outputTruncated 代表執行沒跑完，一律 INCONCLUSIVE。

### 「本來就 FAIL」怎麼辦

```text
baseline FAIL + post FAIL → FAIL
```

就這樣，不加狀態。這最簡單也最安全。

baseline 在 MVP 的用途只有三個，都是抓「變差」：

```text
本來 PASS   → 現在 FAIL
本來跑 63   → 現在只跑 55
本來 skip 0 → 現在 skip 8
```

「既存 failing 的 repo 要如何仍能接受工作」是另一個需求，不要在這裡順便解。

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

## 方向三：Independence —— 後續候選，先不做

**降級理由：它沒有解任何已經發生的 false positive。**

真正已經發生的問題只有一個：

```text
測試被 skip → exit 0 → Harness 誤以為完整 PASS
```

provenance 解不了這個。它要解的是另一種尚未在真實案例中造成誤判的情況
（agent 改測試來配合自己的實作）。dogfood 確實觀察到 agent 會迎合寫錯的測試，
但那是**使用者提供的測試本來就寫錯**，不是 agent 竄改測試 —— provenance 對前者無效。

因此以下暫不加入：

```text
testPaths（Repository Contract 新欄位）
pre-existing / agent-added / agent-modified 分類
```

### 若未來要做，設計要點先記著

真正該問的問題不是「agent 有沒有改測試」，而是：

> 把這次 attempt 新增和修改的測試全部拿掉之後，還剩下什麼證據？

最強的單一指標是**既存的失敗測試轉綠**：

```text
pre-flight:  test_login_500  FAIL
post-agent:  test_login_500  PASS
```

那個測試在 agent 介入前就存在，不可能是為了配合這次修改而寫的。
而它是 pre-flight baseline 的免費副產品 —— 等到有真實案例證明需要時再取用，成本很低。

分類依據必須是 git 觀察到的 changedPaths，不採信 agent 宣告；
而「哪些檔案是測試」必須由 Repository Contract 提供（`testPaths`），
Core 不該內建各語言的路徑慣例（§34）。

呈現方式應該是攤開組成而不是壓成分數：

```text
- test (npm test)：PASS
    63 個測試全部執行，0 skip（baseline: 63 / 0）
    既存測試 58 通過，其中 1 個由 FAIL 轉 PASS
    本次新增測試 3 個通過
```

MVP 不需要 numeric confidence score。

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

第一版只有三步，加一個順手的修正：

```text
1. Evidence 綁定 baseRevision / headRevision / contractHash
   ↓
2. Attempt 前跑一次 baseline（agent 動手之前）
   ↓
3. post verification 與 baseline 比較
```

同時補 `outputTruncated`（含前述的 exitCode 誤判與 tail 誤導）。

這樣就完成第一版。

### 成本

pre-flight baseline 讓每個 write attempt 的 verification 時間翻倍。
用 `baseRevision + contractHash + commandHash` 當快取鍵可以重用，
但第一次仍然是實打實的額外時間。需要 `--no-baseline` 逃生口，
並在 evidence 中標明本次沒有 baseline（走「baseline 不可用」那條規則）。

### 後續候選

| 項目 | 條件 |
|---|---|
| Test provenance（E3） | 出現真實的 false positive 案例 |
| `SUCCESS` → `ACCEPTED_BY_EVIDENCE` | 純命名，隨時可做 |
| 既存 failing repo 的接受策略 | 有真實需求時 |

## 最小 Evidence 原則

> **Evidence 必須證明它驗的是正確 revision、命令確實執行完成，
> 而且相較 Agent 執行前沒有少跑或增加 skip。**

其餘先不做。這符合 Harness 一貫的方向：**只加已經有真實失敗案例證明需要的機制。**

## 明確不做

- **用第二個 LLM 判斷 evidence 是否可信**。那只是把不可驗證性搬到另一個地方，還多一層。§3.3 已禁止。
- **numeric confidence score**。把組成攤開比壓成一個數字更有用。
- **通用 Evidence Sufficiency Engine**。見方向四。
- **為了填滿 completeness 欄位而猜測 runner 輸出**。解析不出來就是 unknown。
