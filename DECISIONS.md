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

### D-24 [實測] read-only attempt 中 agent 無法執行任何需要寫入的測試
codex 的 read-only sandbox 擋掉所有寫入，包括 `mkdtemp` / 寫 `/tmp`。
第一次 dogfood 時 agent 在 read attempt 裡自己跑 `npm test`，10 個測試檔有 5 個因此失敗，
它據實回報為「測試未通過」—— 對它而言那是真的觀察，但原因是 sandbox 而非程式碼。
Harness 自己在 read attempt 不執行 verification（§23.3），所以 outcome 不受影響。
使用者要留意 read-only 調查的 agent claim 中可能出現這類假失敗。

## 尚未實作 / 待驗證

- **Gate 1 dogfood**：文件要求 10 個真實 Coding Work（3 read / 5 write / 2 blocker），尚未累積。
- **Gate 2 C5（pointer-first 在大型 repo）**：目前只在小型 fixture 驗證過。
- **§22 的 in-session 協議重試**：見 D-20，MVP 直接走 retry attempt。
