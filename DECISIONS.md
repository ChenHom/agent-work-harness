# 實作決策記錄

對照 `agent-work-harness-design.md`。凡是設計文件沒有指定、或指定後與實測不符而必須自行決定的，
都記在這裡。標記說明：**[預設]** = 採用文件的 MVP default；**[實測]** = 由 spike 結果決定；
**[取捨]** = 文件未涵蓋、由實作端裁量。

## 技術選型

### D-01 [取捨] TypeScript on Node 24，零 build step、零 runtime 依賴
文件的 interface 全部以 TS 表達，且 Codex CLI 本身在 Node 生態。Node 24 可直接執行 `.ts`
（type stripping），因此不需要 build 產物 —— 堆疊追蹤直接指向原始碼，符合「好除錯」目標。
連帶限制：不能使用 constructor parameter properties、enum 等不可抹除語法，
`tsconfig` 已開 `erasableSyntaxOnly` 讓型別檢查就攔下來。

### D-02 [預設] Persistence 用 `node:sqlite`（§39.3 允許 SQLite 或 JSONL）
內建模組，無原生編譯依賴。schema 見 `src/trace/store.ts`。只要求 restart-safe，
不做 Event Sourcing（§29）。大內容（prompt、stdout、diff）走 artifact store，
event 只留 artifact id 與 hash。

### D-03 [取捨] 測試用 `node:test`，不引入框架
安全關鍵邏輯（glob path policy、skill hash、outcome 規則、protocol parser）各有一組測試。

## 安全與隔離（§39.2 的三個 blocker）

### D-04 [實測] Codex network deny 必須顯式設定
實測 `-s workspace-write` 不擋 curl。Driver 因此寫死
`[sandbox_workspace_write] network_access = false` 在 Harness 自己的 `CODEX_HOME/config.toml`。
細節見 `docs/spikes/2026-08-21-isolation-spike.md`。

### D-05 [實測] Agent HOME 隔離用 `env -i` + 專用 HOME/CODEX_HOME
實測預設情況 agent 讀得到 `~/.ssh`、`~/.secrets`。定案：以最小環境變數啟動 codex，
`HOME` 指向 `~/.local/share/agent-work-harness/agent-home`。

### D-06 [實測] Verification 隔離用 bwrap 白名單 bind，不用 `--ro-bind / /`
`--ro-bind / /` 會讓操作者 HOME 進入沙箱（實測讀得到 API key）。
定案：白名單 bind 系統路徑 + `--tmpfs /home` + 單獨 bind worktree 與 verification home。
**git evidence 收集也走同一個 runner** —— `git diff` 可經 `.gitattributes` textconv 執行程式碼，
不能在 unrestricted host 上跑（§20.3 的精神）。

### D-07 [取捨] state dir 預設 `~/.local/share/agent-work-harness`
不能放 `/tmp`：codex 拒絕在暫存目錄建立 helper binaries（實測）。可用 `HARNESS_STATE_DIR` 覆蓋。

### D-08 [取捨] 已知限制：codex 的 `auth.json` 對 agent 可見
codex 需要自己的憑證才能運作，該檔位於專用 `CODEX_HOME`，agent 可讀。
能隔離的是操作者的其他 credentials（`~/.ssh`、`~/.secrets`、其他工具的 token），這些已被擋掉。
若要進一步收斂，需要 codex 提供 credential broker 或改用短期憑證 —— 不在 MVP 範圍。

### D-09 [取捨] repository `AGENTS.md` 與 `.rules` 不得成為 authority
Driver 固定加 `-c project_doc_max_bytes=0` 與 `--ignore-rules`（§30.1）。

### D-10 [取捨] verification 的 toolchain 路徑放在 Harness Global Policy，不放 Repository Contract
repo 若能指定要 bind 進沙箱的路徑，等於能自行擴大讀取面（§34.3 repo 不能放寬上限）。
預設只 bind 目前 node 的安裝根目錄，其他語言 toolchain 由使用者在 `policy.json` 的
`readOnlyBinds` 增加。

### D-11 [取捨] Repository Contract 的 `verification.checks[].argv[0]` 禁止絕對路徑
避免 repo 指向 worktree 外的執行檔。相對路徑（`vendor/bin/phpstan`）與 PATH 名稱（`npm`）都允許。

## 契約與語意

### D-12 [取捨] 「可以改 X」不產生 `allowedPaths`，「只改 X」才會
§18 A 的範例與 §20.1 的規則有張力。採 §20.1：`allowedPaths` 代表「使用者明確限縮範圍」。
「可以改 X」記成 `allow_path` decision（會出現在 prompt 的 USER DECISIONS），
但不會憑空製造比實際 enforcement 更細的 allowlist。

### D-13 [取捨] read 與 write 語句同時出現時取 read
例如「只看不要改，可以的話修一下」。fail-safe 取較小權限，由使用者再明確擴權。

### D-14 [預設] `successCriteria` 預設值
使用者沒給時填入兩條：required verification 全部通過、denied/protected paths 未變更。
它們只是 semantic guidance，acceptance 仍只看 mechanical evidence（§7.1）。

### D-15 [取捨] read attempt 的 path policy 是 `deniedPaths: ['**']`
read attempt 若出現任何變更，代表 sandbox enforcement 失效，直接 POLICY_VIOLATION。
這同時是 §20.4 想要的 enforcement evidence。

### D-16 [取捨] write attempt 沒有任何變更時不算 SUCCESS
agent 回報 completed、evidence 卻顯示 worktree 全無變更 → RETRYABLE_FAILURE（§23.1）。

### D-17 [取捨] 越界（POLICY_VIOLATION）時不執行 verification
先讓使用者處理越界，不把時間花在跑測試上；也避免在已違規的樹上留下更多副作用。

## 執行與復原

### D-18 [預設] retry budget 預設 1（§39.3），`harness new --retry N` 可調。

### D-19 [預設] crash recovery 不 auto-rerun（§D5）
CLI 每次啟動先把殘留 `RUNNING` 的 attempt 標成 `RECOVERY_REQUIRED`、work 轉 `BLOCKED`，
`harness recover <workId>` 重新收集 evidence 後交由使用者決定。

### D-20 [取捨] Protocol 失敗不做「請重輸出 JSON」的 in-session 重試
§22 允許有限次重新輸出，但那需要 resume 同一個 codex session。MVP 直接判 RETRYABLE_FAILURE，
由 retry 建立新 attempt（context 只帶 evidence，不重播 transcript）。真實使用若發現這類失敗頻繁，
再實作 `codex exec resume`。

### D-21 [實測] `--output-schema` 的 JSON Schema 必須讓 `required` 涵蓋所有 properties
OpenAI structured outputs 的限制；optional 欄位改用 nullable 型別。不照做會 400 且整個 attempt 失敗。

### D-22 [實測] Skill 以 `[[skills.config]]` 送進 codex
approved skill 複製到 `CODEX_HOME/skills/<id>/`，並在 `CODEX_HOME/config.toml` 寫入
`[[skills.config]] path=".../SKILL.md" enabled=true`。已用一個含暗號的 skill 實跑驗證
agent 確實讀到內容。清理時只刪除非 `.` 開頭的項目 —— codex 會自己 populate `.system` 內建 skills，
整個刪掉會破壞它。操作者個人的 `~/.agents/skills` 因 HOME 隔離而看不到，這是預期行為。

### D-23 [實測] 已知限制：read-only attempt 可讀 workspace 以外的檔案
codex 的 `read-only` 只限制寫入，讀取範圍是整個檔案系統。實測中 agent 讀到了 workspace 外的檔案。
寫入邊界、network、HOME 都有 enforcement，但「讀取範圍」目前只靠 prompt 約束。
要收斂需要把 codex 本身也放進 bwrap（agent 執行與 verification 用同一套 mount 白名單）——
可行但會影響 codex 自身的運作（helper binaries、session 檔案），不在 MVP 範圍。
`~/.ssh`、`~/.secrets` 等操作者憑證不受此影響，因為 HOME 已被隔離。

### D-25 [實測] pre-flight baseline：verification 時間翻倍，換掉一個真實的 false positive
dogfood 中 agent 新增的錯誤斷言沒被抓到，因為該測試檔在隔離環境被 skip、`npm test` 仍 exit 0。
現在 write attempt 會在 agent 動手前先跑一次 required checks 當基準，post 與它比較執行數與 skip 數。

代價是 required checks 跑兩次。`harness run/retry --no-baseline` 可關閉，代價是失去這個判斷。
MVP 不做 baseline 快取 —— 快取需要持久化與失效邏輯，等真的痛了再說。

兩條原則寫進判定規則：**未知不等於失敗**（runner 解析不出 completeness、或 baseline 跑不起來，
都退回現行行為）、**不完整不等於通過**（timeout 與輸出超限一律 INCONCLUSIVE）。

同時修正 `outputTruncated`：實測 `execFile` 超過 `maxBuffer` 是殺掉行程而非截斷輸出，
`err.code` 是字串常數導致 `exitCode` 變 `null`、原本被誤判成 FAIL 且原因不可見；
保留的是輸出開頭，所以 evidence 的 `tail` 會明確標示那不是真正的結尾。

### D-27 [實測] agent 的執行環境比 verification 更受限，會產生假失敗 claim
Cross-Repo Validation 第一站發現：

```text
agent execution:  codex sandbox，exclude_slash_tmp = true  → /tmp 唯讀
verification:     bwrap --tmpfs /tmp                       → /tmp 可寫
```

後果一：agent 跑 `npm test` 會因為寫不了暫存檔而中止，於是在 claim 裡回報「測試沒跑完」，
而 Harness 的 verification 判 PASS。實測手動連跑三次都 exit 0，**Harness 是對的，
agent 看到的是環境假象**。使用者會看到兩邊說法不一致。

後果二：這**不是** isolation 強弱問題。要區分 capability 與 isolation ——
verification 的 `--tmpfs /tmp` 是 private tmpfs，host `/tmp` 對 agent 與 verification 同樣不可見。
從 host security boundary 看沒有誰比誰弱，§20.3 沒有被違反。
準確的說法是 **agent 與 verification 的 execution semantics 不一致**，也就是 execution parity 問題。

理想解是給 agent 一個私有的可寫 tmpfs，但 codex 的 `exclude_slash_tmp` 只有開關兩種，
關掉會讓 agent 看到主機的 `/tmp`，那更危險。這是 runtime 限制，不是 Harness 的選擇。
現在只記錄，見 `docs/cross-repo-validation.md` 發現 2。

Cross-Repo #2 又出現兩次，形態不同（read-only sandbox 中沒有可用暫存目錄，
unittest 載入失敗後長時間無輸出）。三次的共同根因都是 agent 無法重現 verification 環境。

### D-31 [實測] 機械檢測工具選型：裝四個、拒四個
逐項對照常見的 AI 程式碼檢測工具表，用「這個專案真的會犯的錯」當標準，不是「業界標配」。

**裝**

| 工具 | 這裡的具體理由 | 導入時的真實發現 |
|---|---|---|
| `tsc` | 已有 | — |
| ESLint + typescript-eslint | `no-floating-promises`（見 D-29）＋ 架構界線規則 | src 3 個 finding，已修 |
| Knip | 22 個檔卻有 11 個沒人用的 export；公開面積是要維持穩定的東西 | 11 個全部屬實，已收斂 |
| StrykerJS | 本專案的整個論點就是「測試通過不等於真的驗到」，mutation 正好回答這題 | 五個檔 71.13%，**抓到一個沒被測到的 security gate**（見下） |
| Coverage | Node 內建 `--experimental-test-coverage`，零安裝 | line 94.39% / branch 85.51% |

**不裝**

- **Biome** —— 與 ESLint 重疊，且它的主賣點是 formatter。D-29 已決定不加格式規則：縮排爭議不值得一個 CI 步驟。
- **Vitest** —— `node:test` 跑得好好的，coverage 也內建。把 155 條測試遷過去換不到任何東西。
- **dependency-cruiser** —— 實測 22 節點 52 邊、**0 個循環**。它真正有價值的是「持續守住分層」，而那兩條界線用 ESLint `no-restricted-imports` 就能表達，不必再多一套 config：
  - `node:child_process` 只准 `evidence/exec.ts` 與 `runtime/codex-driver.ts` import，其他地方一律走 `runIsolated()`（繞過沙箱是安全問題）
  - 下層模組不得回頭 import `orchestrator.ts`
  兩條都實測會擋（故意加違規 import 驗證過）。**升級條件**：src 超過 ~50 檔，或出現第一個循環。
- **Semgrep** —— 需要另一套 toolchain；本專案想表達的自訂規則（上面那兩條）ESLint 已經夠用。**升級條件**：出現 ESLint 表達不了的跨檔 pattern。
- **Playwright** —— 沒有 web UI。

**Gitleaks / npm audit** 放進 CI（`.github/workflows/check.yml`），不進本機 `npm run check` —— 它們要掃的是完整 git 歷史與相依樹，不是工作目錄。

**副作用**：Stryker 帶進 `typed-rest-client → qs` 的 moderate 漏洞，用 `overrides.qs` 釘住解決，`npm audit` 回到 0。零 runtime 相依的專案在 devDependencies 上仍要看這個。

**兩個要記下來的雜訊來源**：
- ESLint 會去 lint Stryker 的 sandbox 複本（`.stryker-tmp/`），要在 flat config 加 global ignores，否則 `npm run check` 會噴三百個 `ban-ts-comment`。
- Knip 把 `@stryker-mutator/command-runner` 報成未列相依 —— 它不是獨立套件，包在 core 裡。已加進 `ignoreDependencies`。

### D-32 [實測] mutation 首跑基準，以及它抓到的第一個真洞
2026-08-22，679 個 mutant、7 分 57 秒：

| 檔案 | 分數 | 存活 | 這個檔案在守什麼 |
|---|---|---|---|
| `repo/paths.ts` | 87.50% | 8 | 越界判定 |
| `evidence/outcome.ts` | 76.42% | 29 | fail-closed 判定 |
| `evidence/verification.ts` | 70.09% | 32 | E2 completeness |
| `runtime/isolation.ts` | 64.71% | 12 | 沙箱 argv |
| `security/skills.ts` | **58.10%** → 78.10% | **44** → 23 | §19.2 skill admission |
| 全部 | 71.13% → 75.98% | 125 → 104 | |

**最值得看的一個**：`skills.ts:70` 一行就有 15 個 mutant 存活 ——

```ts
if (!skill.externalRefsAllowed && (ext === '.md' || ext === '.txt' || ext === '.json')) {
```

把 `!` 拿掉、把副檔名清單改空、把整段刪掉，155 條測試**沒有一條**會紅。
追下去發現：唯一相關的測試叫「預設拒絕腳本與外部參照」，但它只寫了一個 `run.sh`
然後 `assert.match(a.reason, /腳本/)` —— **只測了腳本那一半**。
外部參照（也就是 prompt injection 的入口）那一半從來沒被驗證過，而測試名字讓人以為有。

這正是裝 mutation 的理由：coverage 對這一行是 100%（它確實被執行到），
但「執行到」不等於「被驗證」。這條與整個專案的 E1–E4 論點是同一件事。

**已處理**：`skills.ts:70` 的 15 個 mutant 全數殺掉，補了 11 條測試涵蓋
三種外部參照形態（`https://` / `git@` / `ssh://`）、三種正當放行（無參照、
明確核准 `externalRefsAllowed`、副檔名不在掃描清單）與副檔名解析的邊界
（檔名本身就是 `.md` 的檔案不能靠命名繞過掃描）。順帶把原本那條名不副實的
「預設拒絕腳本與外部參照」改名為「預設拒絕腳本」—— 它本來就只測了腳本。

`skills.ts:68` 還剩一個 `dot >= 0` → `true` 的 mutant，這是**等價變異**：
`dot === -1` 時 `rel.slice(-1)` 取到的是最後一個字元，永遠不會以 `.` 開頭，
因此不可能命中任何副檔名清單，行為完全相同。沒有測試能殺掉它，也不該為它扭曲測試。

其餘存活的 mutant 仍在 watch list，不是 backlog。

### D-30 [決定] mutation 測試不進 `npm run check`
Stryker 跑一個檔（171 mutant）要 2 分鐘，五個判定相關的檔（679 mutant）要十幾分鐘。
這是**定期稽核**，不是每次提交的關卡。`npm run mutation` 手動跑。

`mutate` 只列五個檔 —— `evidence/outcome.ts`、`evidence/verification.ts`、`repo/paths.ts`、
`security/skills.ts`、`runtime/isolation.ts`。挑選標準是「一個活下來的 mutant 就代表一條
fail-open 路徑」；其餘檔案的 mutant 存活多半只代表訊息文字沒被斷言，不值得看。

同理排除 `StringLiteral` 與 `Regex` mutator：`reasons.push("")` 活下來不是測試缺陷，
是我們本來就不該去斷言錯誤訊息的字面內容。開著會讓分數低估 7 個百分點且全是雜訊。

### D-29 [決定] ESLint 只留型別檢查看不到的那一類，不當風格工具
`tsc --noEmit` 已經涵蓋型別。加 ESLint 的理由只有一個：`no-floating-promises`。
整條 attempt 流程都是 async，漏掉一個 await 會讓 evidence 收集或落地靜默跳過 ——
型別檢查不會抱怨，測試也未必抓得到（Promise 還是會跑完，只是順序錯了），是 fail-open。

採 `recommendedTypeChecked`（需要 `projectService`），並關掉三條：
`no-explicit-any`（本專案在 SQLite 邊界刻意用）、`require-await`、
測試檔的 `no-floating-promises`（node:test 的 `test()` 回傳 Promise 但 top-level
本來就不該 await，開著只會得到滿螢幕假陽性）。

不加格式規則、不加 prettier —— 縮排與換行的爭議不值得一個 CI 步驟。

導入時 src 只有 3 個 finding（2 個 `JSON.parse` 的 unsafe assignment、
1 個多餘斷言），全部已修。`npm run check` = lint + typecheck + test。

### D-28 [實測] Repository Contract 用 `env(1)` 表達環境變數需求，不需要新欄位
rag-stack 的測試需要 `PYTHONPATH=app`，而 `VerificationCheck` 沒有 env 欄位。
看起來像 Contract 缺資訊，但 `env(1)` 當 argv[0] 就解決了：

```json
["env", "PYTHONPATH=app", ".venv/bin/python", "-m", "unittest", "discover", "-s", "tests"]
```

argv[0] 不是絕對路徑、不是 shell 字串、是純 argv 陣列，完全符合現有契約。
在為 schema 增加表達力之前，先確認現有機制真的不夠。

### D-26 [實測] verification sandbox 內連不到主機上既有的服務
`bwrapArgv` 用 `--unshare-all`，其中包含 `--unshare-net`，沙箱裡是全新的 network namespace。
實測：

```text
測試自己起 server 再連自己（純 loopback）  → 可以（新 netns 自帶 lo）
連主機上已在跑的服務（127.0.0.1:<port>）   → Connection refused
```

因此**測試需要外部 DB / redis / docker-compose 服務的專案，目前跑不了 verification**。

這不是 bug，是 §20.3「verification 隔離必須 ≥ agent execution」的直接後果 ——
agent 是 network deny，verification 就不能比它寬。三者無法同時成立：

```text
verification 隔離 ≥ agent
agent network deny
整合測試需要連服務
```

未來若真的撞到，選項大致是：放寬 verification 的 network（破壞第一條）、
由 Repository Contract 提供依賴服務的啟動方式並在同一個 netns 內拉起（複雜）、
或承認這類 repo 不適用（縮小適用範圍）。**現在不預先決定**，等有真實案例再談。

### D-24 [實測] read-only attempt 中 agent 無法執行任何需要寫入的測試
codex 的 read-only sandbox 擋掉所有寫入，包括 `mkdtemp` / 寫 `/tmp`。
第一次 dogfood 時 agent 在 read attempt 裡自己跑 `npm test`，10 個測試檔有 5 個因此失敗，
它據實回報為「測試未通過」—— 對它而言那是真的觀察，但原因是 sandbox 而非程式碼。
Harness 自己在 read attempt 不執行 verification（§23.3），所以 outcome 不受影響。
使用者要留意 read-only 調查的 agent claim 中可能出現這類假失敗。

## Observed Limitations（watch list，不是 backlog）

以下都是已經觀察到、但**還沒有造成實際損害**的限制。它們留在這裡是為了被認出來，
不是為了被做完。

| 項目 | 觀察到的形態 | 目前影響 |
|---|---|---|
| D-26 host-service network | Cross-Repo #2 B1：連 `127.0.0.1:8010` 失敗 → 正確 BLOCKED | 無誤判，fail-closed 正確 |
| D-27 execution parity | 三次：agent 環境沒有可寫 `/tmp`、沒有暫存目錄，claim 出現假失敗 | evidence 仍然正確，但使用者會看到兩邊說法不一致 |
| E2 unknown completeness | task-tracker 自訂 runner、rag-stack `unittest` 都解析不出執行規模 | 保護退化為 exit code fallback，無 false positive |
| E3 provenance | Cross-Repo #1 B1：agent 改了 test runner 與 build script | 人工檢查為良性，無 false positive |
| baseline 成本 | 兩站測試分別 12 秒與 0.567 秒 | 翻倍完全無感，cache 沒有必要 |
| Gate 2 C5 上限 | 最大驗證到 36.6k 行 | 更大的 repo 未知 |
| mutation 存活 | D-32 首跑 125 個。`skills.ts` 外部參照 gate 已補測（15 個 mutant 殺光），其餘未處理 | 尚無實際損害 |
| baseline 例外無降級 | `collectBaseline` 丟例外會炸掉整個 attempt 且不留紀錄 | fail-closed，但使用者只看到 stack trace |

### 升級為實作項目的條件

只有出現下列情況，才把上面任何一項移出 watch list：

```text
false ACCEPT        evidence 判 PASS 但實際上壞了
false BLOCK         正當的工作被錯誤擋下
大量 retry          context 或 evidence 不足導致重跑成為常態
無法完成重要 Work    某類真實工作因為該限制根本做不了
明顯操作成本         使用者為了繞過它必須反覆做額外的事
```

不符合以上任一條，就維持觀察。**不為了把清單清空而實作。**

### 尚未證明的假設

```text
slow verification economics   required checks 要跑數分鐘時，baseline ×2 是否還可接受
C 型依賴（Docker network）     需要什麼 capability
E 型依賴（Internet）           需要什麼 capability
```

這三項需要一個天然符合條件的真實 repo 才驗得到。**不為了測試而找測試** ——
沒有這樣的 repo 出現前，維持未知。

## 已排除的方向

- **Evidence E3 provenance / E4 sufficiency**：仍是後續候選，見 `docs/evidence-model.md`。
  E3 要等到出現真實的 false positive 案例才做。
