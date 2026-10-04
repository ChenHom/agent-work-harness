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

**此啟動掃描方案已由 D-33 取代。** 保留本條作為歷史決策，不再代表目前行為。

### D-33 [取捨] P1 採保守本機 ownership 與顯式 recovery，取代 D-19 啟動掃描
只讀 CLI 不改 lifecycle state；mutating command 必須先取得 state directory 的單一 execution token。
啟動時不掃描 `RUNNING` attempt，不依 PID 或 timeout 自動接手 orphan。owner／child 無法確認時保留 lock
並回 `OWNER_UNKNOWN`。只有操作者保存 metadata 與 state backup、確認舊 harness、已知 child 和受管環境
均已停止後，才能人工隔離舊 lock，再執行只讀 recovery。

Recovery 綁定 attempt 原始 contract 與 verified input snapshot，建立新的 recovery session，只做目前
workspace readback 與 current policy 評估；不重跑模型或 verification，不改寫原 attempt/outcome，
也不把最新設定補成歷史輸入。這是單主機互斥與保守人工恢復，不是自動 orphan 接手；自動 lease、
heartbeat、execution epoch 與 supervisor 邊界留到 P4。

### D-34 [取捨] 新 plan 不繼承舊 plan 的 milestone 完成狀態
fork、重新規劃或 contract 版本變更後，新 plan 的每個 milestone 一律從 `PENDING` 開始，即使名稱、
內容與舊 plan 相同，且來源 checkpoint 已記錄該 milestone 完成。checkpoint artifact 可以列為
`reusableArtifactIds`，但 artifact 可重用只是輸入資料的 provenance，不是新 authority 下的完成證據。

自動沿用完成狀態會把舊 contract／plan 的判定提升成新 authority，違反 fail-closed 原則；若要完成新
milestone，必須建立綁定新 plan 與 contract 的 attempt 重新驗證。這是刻意的保守成本，不是進度遺失 bug。

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

## 待決草案（2026-10-03 外部評論核對）

來源：一份外部產品／架構評論，逐條對照程式碼與文件，再經獨立審查與實跑探測後整理。以下各條**尚未採納**，
標 **[草案]**。採納時改成正式標記並移到對應章節；不採納的改標 **[不採納]** 並留下理由（同 D-19 被取代仍保留的慣例）。
D-41 是已用實跑重現的缺陷，排在最前面。

### D-41 [草案] 越界後再 `run`，會直接採用 agent 改過的 contract（master 實跑重現）
重現：attempt 1 的 agent 把 `.harness/config.json` 改成 `checks: []` 並 commit → `POLICY_VIOLATION`、Work `BLOCKED`；
之後直接再 `run`（agent 只改 README）→ `SUCCESS`、Work `DONE`，理由只有「沒有 required verification check」警告。
原因：`runAttempt` 沒有 work state guard；每次 attempt 依 §34.1.1 從 workspace 重新 load contract，
base 取當下 HEAD，前一個 attempt 已 commit 的改動因此成了新 authority。只有 recovery 會比對 hash。
這違反「authority 不來自內容」。

提案：前一個 attempt 是 `POLICY_VIOLATION`，且本次 contract hash 和該 attempt 的 `contractSnapshotHash` 不同時，
不執行，要求使用者明確確認新 contract。直接擋會和 §34.1.1「使用者可以合法改 config」衝突，所以採「問」不採「擋」。
待決：確認的形式（新 CLI 旗標，或沿用 `answer`）。

### D-35 [草案] 驗證控制面：先補一條 fail-closed 規則，再加標註
verification 在 agent 改過的 workspace 跑凍結的 argv。在單一 attempt 內，contract 與 `.harness/**` 受保護；
argv 背後的 script、runner、測試內容沒有。`init` 預設產生 `npm test`（`src/repo/contract.ts:112`），
所以 `package.json` scripts 就是預設的驗證控制面。baseline 只比執行數與 skip 數，而且 post 輸出解析不出
completeness 時整段跳過（`src/evidence/verification.ts:65`）。

現行門檻「出現真實 false positive 才做 E3」要靠有人注意到，但 Cross-Repo #1 B1 已記下「Harness 目前沒有任何機制
讓使用者注意到」（`docs/cross-repo-validation.md:163`），門檻可能永遠不會觸發。採納本條等於修改 watch list 的 E3 列、
「已排除的方向」的 E3 條件，以及 `docs/evidence-model.md` 的方向三與觸發條件表，要一起改。

提案分兩步：
1. **fail-closed 規則**：baseline 解析得出 completeness、post 卻解析不出時，判 `INCONCLUSIVE`，不再跳過。
   這直接擋住「把 runner 換成解析不出的輸出」，符合規則 1；D-25 處理的是兩邊都解析不出的情況，不衝突。
2. **標註**：變更路徑碰到驗證定義（script、runner、測試設定，不含測試檔內容）時，在 evidence 與回應中列出，
   並提示用 `harness note` 記錄 false-accept／false-block，這是既有的回饋管道。標註只是提示，
   不影響 `decideOutcome`。清單必須在 attempt 開始時隨 contract 凍結。

不涵蓋：改弱測試檔裡的斷言。這要區分既存測試與 agent 新增或修改的測試（E3 分類），仍然延後；
把測試檔納入標註會讓幾乎每個 attempt 都被標，變成噪音。

已知限制：變更路徑來自 `git status`／`git diff`。實測 `git update-index --skip-worktree` 與 `.git/info/exclude`
能讓兩者都看不到變更，path policy 與標註都可被繞過。現行 Codex sandbox 能不能寫 `.git`，未查證。

待決：
- 被 agent 改過的 runner 算不算規則 1 所說的「替換的 evidence」。若算，第 2 步就必須擋，不能只標註。
- 清單放 repository contract 還是 global policy。

### D-36 [草案] `SUCCESS` 的對外語意：只改回應標題不夠
Outcome `SUCCESS` 在回應中顯示為「已完成」（`src/response.ts:7`）。其他出口也都把它當完成：
- Work state 是 `DONE`，事件是 `work.completed`。
- `list` 印出 `DONE … outcome=SUCCESS`。
- `run` 回傳 exit 0。
- `scripts/dogfood.sh` 看到 `SUCCESS` 就自動 commit。

write attempt 沒有任何 required check 時也是 `SUCCESS`，只多一條警告。

P5 的 criterion 規則能讓 semantic `unknown` 擋住 `DONE`，但 `src/` 裡沒有任何地方呼叫 `insertEvaluationContract`，
一般 CLI 流程不會出現「語意未驗證」。`docs/evidence-model.md:420` 把改名評為「純命名，隨時可做」，低估了成本：
outcome 以文字存在 `outcomes.outcome`，`store.ts` 也比對 `'SUCCESS'`，改名需要 migration 和舊 trace 相容。

選項：
- (a) 只改回應與 `list` 的顯示字，並在回應中說明「設定的檢查通過、變更沒有越界，不代表需求已解決」；
  沒有 required check 時改成明說「沒有任何驗證」。
- (b) enum 改名並附 migration。

採納後要同步修改 `evidence-model.md:420` 的評估。待決：選 (a) 或 (b)，以及用字。

### D-37 [草案] 外部 agent 的 begin → verify：定位翻轉，先不決定；進行中的 `verify` 分支不能照現狀合併
現行設計由 Harness 啟動 agent：§2.1「User 只操作 Harness」、§21 Driver 啟動 Codex、§36.1 Gate 1 路徑。
外部 agent 動手前已 dirty 的檔案歸為 preExisting，不算本次成果。

評論主張改成 provider-neutral：`begin` 凍結 contract、base revision、dirty 狀態、驗證定義，外部 agent 自由工作，
`verify` 產出 evidence 與 outcome。評論沒算到的代價：
- network deny 與 HOME 隔離由 Driver 施加（D-04、D-05）。外部 agent 跑時，Harness 只能證明結果，
  不能證明過程邊界，§20.4 的 enforcement evidence 會退回成 claim。
- skill admission（`admitSkills`）與 `--ignore-rules` 失效。外部 agent 會把 repo 的 `AGENTS.md`／`.rules`
  當成 authority（D-09）。
- D-15「read attempt 出現任何變更即 sandbox 失效」不再成立。
- 外部 agent 有完整的 `.git` 存取權，可以用 D-35 所列的方式遮蔽變更。
- 用 MCP 包裝現行流程（`new`／`run`／`show`）不需要翻轉，但常駐 server 和 D-33 單一 execution token
  的互動要另外設計。用 hook 強制「改檔前先 begin」接近 §2.2「不攔截每一個 tool call」，要另述理由。

`feature/verify-existing-artifacts` 名義上是額度用完後續辦，實質上就是「外部做完 → verify」。實跑探測結果：
- 外部 commit 把 checks 清空、再 commit 一個 protected 路徑的檔案 → `SUCCESS`、Work `DONE`。同樣改動不 commit → `POLICY_VIOLATION`。
- 什麼都沒改、checks 通過 → `SUCCESS`、Work `DONE`。這正是該分支 spec 自己否決的方案 A，也違背 D-16。
- verify 不帶 baseline，D-25 在這條路徑不存在。
- state guard 只擋 `DONE`／`RUNNING`／`VERIFYING`，所以 `POLICY_VIOLATION` 的 Work 能經由 verify 變成 `DONE`。

原因：contract 在驗證當下從 workspace 載入，base 取當下 HEAD，路徑檢查只看 dirty 檔。
這和該分支 spec 寫的「凍結的 snapshot」不符，也違反設計 §34「不得在執行後重新讀取 config 作為新的驗收規則」。

草案方向：先不翻轉，等 D-38 的結果。分支合併前至少要做到：
- contract 取前一個 attempt 凍結的 snapshot；
- git 從前一個 attempt 的 base 開始觀察；
- 沒有成果不算 `SUCCESS`；
- 帶 baseline。

若之後採納翻轉，外部模式的 outcome 必須標明「過程邊界未經 Harness 施加」，不能沿用同一個 `SUCCESS`。

### D-38 [草案] 擴張前先做有／無 Harness 的成對試行
文件中沒有任何對照。dogfood 與 cross-repo 共 20 個真實 Work 屬定性驗證；其中唯一一次 false accept 是 Harness 誤收、
由人發現，因此有了 D-25。`harness note/stats` 有 false-accept／false-block／friction 類別，但預設 state DB 一筆都沒有。

提案：同一題分兩組，A 由 agent 直接做加既有 CI，B 由同一個 agent 經 Harness 做。
這個試行只回答「Harness 在 agent＋CI 之外多抓到什麼、代價多少」：
- 回答不了 P3／P4，coding 題目用不到它們。
- 要回答 D-37，得加 C 組（外部 agent＋verify），而且要先修好 D-37 列出的缺口。

設計限制：
- false accept 的基率約 1/20，小樣本只分得出很大的差異。要嘛接受這點，要嘛加入刻意設計的題目
  （容易誘使 agent 改弱驗證的題）。
- D-27 的環境差異是干擾變因。
- 評判者不能知道組別，而且必須是獨立來源（`human-review`／`fixture-author`）。
- 要先估額度成本。
- 指標定義沿用 v2 spec 的 `false_accept_rate` 等（該表原本用於比較架構版本）。

待決：題數、題目來源、誰當評判者。

### D-39 [草案] Temporal 依賴：D-01 與 `AGENTS.md` 的敘述已不成立
`package.json` 有 4 個 `@temporalio/*` runtime 依賴（共 176M，含原生 core-bridge）。ADR 0001 已記錄
「P4 code and deployment now depend on Temporal」，但 D-01 與 `AGENTS.md`「零 runtime 依賴」沒有跟著改。
另外 ADR 0001 寫測試第一次跑可能下載 pinned 依賴，和 `AGENTS.md`「`npm test` 不需要網路」也不一致。

`src/cli.ts` 靜態 import `durable/client.ts`（後者靜態 import `@temporalio/client`、`@temporalio/worker`），
所以每個 CLI 指令都會載入 Temporal SDK。實測 import 時間：`durable/client.ts` 0.24s、`orchestrator.ts` 0.07s，
等於每個指令多約 0.17s（各 3 次）。

提案：先把 D-01 與 `AGENTS.md` 改成符合現況：「P1–P3 核心無 runtime 依賴；P4 依賴 Temporal（ADR 0001），
目前所有 CLI 指令都會載入」。只有改成 dynamic import 之後，才能寫「Temporal 只屬 durable 子指令」。
待決：0.17s 值不值得改 dynamic import。

### D-40 [草案] v2（P3／P4）擴張與 §2.2、§35 的關係
§35 寫「只有觀察到需求才擴充」。v2 的動機來自外部「Long-Running AI Agent Architecture Review Draft」（v2 spec 第 16 行），
沒有找到由真實 Work 觸發的紀錄。v2 的 Gateway 也已越過 §2.2「不做完整 Tool Pipeline」（v2 spec 第 20 行自己承認）。
實際範圍有限：P3 只接本機 fake provider，P4 只整合一個 fake workflow、不遷移 CLI orchestrator。

提案：明記 §2.2 是 MVP 範圍，已被 v2 局部取代，不再當成永久排除。之後 durable／gateway 的擴張
（接真實 provider、把 orchestrator 遷到 Temporal）一律要有 §35 所說的觀察到的需求，外部審查不能單獨構成動機。
這是新增的規則，不是補記：本檔「升級為實作項目的條件」原本只管 watch list。同一原則也適用 D-37。
D-35 屬 watch list 項目，所以它要明確改寫該項的門檻。

### 評論中不需新決定的部分
- ClaudeDriver、RAG、多 runtime：§2.2 列為 MVP 不做；§35 允許在有真實 use case 時重新設計。
  Planner：§2.2 沒有列，設計只寫「不做通用 Evidence Planner」，v2 plan 寫「不為拆計畫強制新增 Planner LLM」。
- 「規劃歸呼叫者、驗證歸 Harness」：就是現況。plan 由 `harness plan propose <json>` 提交，Harness 只做決定性檢查；
  有 active plan 時不指定 milestone 會報 `PLAN_MILESTONE_REQUIRED`。
- CLI 數量：27 個頂層指令、49 個 action。USAGE 已經分組，但是按 P1–P5 階段分，10 個 `fake` action 混在
  「P1–P3 local runtime」裡。要處理的是分組依據，改成日常／協定驗證／維運，不刪指令。
- Prompt／Context／Skill security 搬出核心：取決於 D-37。只要 Harness 還啟動 Codex 就需要。

### 文件修正（不需決策，可直接做）
- `docs/evidence-model.md:57`「agent 改不了自己的驗收規則」：在單一 attempt 內只保護 contract 與 `.harness/**`。
  argv 背後的 script／runner 可以被改；跨 attempt（D-41）與 verify 分支連 contract 都可以被改。
- 狀態過期或互相矛盾：v2 spec 第 5 行 vs `README.md:190`；`README.md:199` vs `docs/evidence-model.md:3`；
  `docs/e2e-scenarios.md:44`。
- 本檔「已排除的方向」標題與內文「後續候選」不一致。
- `README.md` 沒有 non-goals 段落（設計 §2.2 有）。
