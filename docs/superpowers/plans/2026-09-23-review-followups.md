# Code review 後續處理計畫（2026-09-23）

**來源：** 2026-09-23 對 `master...codex/p1-recovery-correctness`（P1–P5，46 commits）的 code review，15 項發現。
其中 #7、#2、#3、#4、#6、#9 已修正並在 `d494c56` 合併進 `master`（見下方「已完成」）。本檔記錄剩下的項目。

**證據等級：** 「已重現」＝ review 或修正時實際跑過；「讀碼」＝ 從程式碼推得，動手前要先寫出會失敗的測試確認。

**執行規則（同 P5）：** 一次一項；先寫在現行程式碼上會失敗的測試，再修；跑該項的定點測試與一次 `npm run check`；
暫時撤回修正確認測試會失敗；一項一個 commit。以不打到使用上限為前提放慢，但驗證與量測不能省。

---

## 環境（合併後立即）

- [x] 隔離 checkout 執行 `npm ci` 並確認 Temporal 相依完整；2026-09-23 baseline `npm test` 為
  389 pass、0 fail、0 skip。受限 sandbox 會讓測試內 `git init` 出現 `spawnSync git EPERM`，提交 gate
  須在允許暫存子行程與本機 Temporal server 的環境執行。

## 第一組：會讓恢復失敗或效果重複（優先）

- [x] **#1＋#14 崩潰後 attempt 永遠卡在 RUNNING**（已重現、修正並做 manual mutation）
  - `src/orchestrator.ts:634`：CLI 啟動時不再呼叫 `markCrashedAttempts`，也沒有替代；硬崩潰（SIGKILL、OOM、斷電）或
    `finalizeAttempt` 拋 STATE_CONFLICT 後，attempt 停在 RUNNING，`harness recover` 一律回 `RECOVERY_NOT_APPLICABLE`，
    `docs/usage.md` 的 OWNER_UNKNOWN 處理步驟走不通。
  - `src/runtime/codex-driver.ts:158`：`child.stdin` 沒有 `'error'` listener；codex 立即退出時寫 prompt 觸發 EPIPE，
    harness 在持鎖狀態下崩潰，正好落入上一條。
  - 方向：recover 在確認 ownership 已失效（OWNER_UNKNOWN 經人工處理）後，接受 RUNNING attempt 並轉成 recovery session；
    stdin 加 error handler，把 EPIPE 當成 runtime 失敗結果。驗證：kill 子行程與 EPIPE 各一個測試。
- [x] **#5 取消後 worker 仍派發**（已重現並改由 production reader 查詢 workflow durable state）
  - `src/durable/client.ts:131`：worker 的 `readRuntime` 對 RUNNING workflow 一律回 ACTIVE，不讀 workflow 自己的
    CANCEL_REQUESTED/QUIESCING；`TemporalDispatchAuthority.validate('dispatch')` 在取消後仍放行 provider 呼叫。
    G4 測試換用 `projectDurableRuntime` 所以沒抓到。
  - 方向：production 路徑改用（或共用）`projectDurableRuntime` 的狀態對應；G4 測試改走 production 路徑。
- [x] **#13 過時寫入覆蓋較新狀態**（已重現 operation race；operation／compensation 全部改用 CAS）
  - `src/tools/gateway.ts:101`：失去 dispatch authority 後仍經 `recordFailure` 寫 UNKNOWN；`updateOperation` 等 update
    沒有 expected-status 條件，另一個 worker 已 reconcile 成 SUCCEEDED 的 operation 會被改回 UNKNOWN。compensation 同樣。
  - 方向：update 帶 `where status = <expected>`（compare-and-set），不符就丟 STATE_CONFLICT；失去 authority 後不寫狀態。

## 第二組：可用性與一致性

- [x] **#8 沒有 SQLite busy timeout**（已重現、修正並做 manual mutation）
  - `src/trace/store.ts`：durable worker（每個 activity 一個 Store）與 CLI 同時寫同一 DB 時立即 `database is locked`；
    `provider.execute` 之後的 `recordSuccess`／`recordFailure` 也可能撞 SQLITE_BUSY，operation 停在 DISPATCHED。
  - 方向：開啟時設 `pragma busy_timeout`；注意 GC／redaction 現在在寫鎖內 unlink，timeout 要涵蓋那段時間。
- [ ] **#10 沒有 parent 的 checkpoint 不會標記下游 milestone stale**（讀碼）
  - `src/trace/checkpoints.ts:192`：`findArtifactReplacements` 只沿 `parentCheckpointId` 鏈比對；同一 plan、改了
    artifact hash 但沒填 parent 的 checkpoint，會讓已完成的 M-2 以過時輸入維持 COMPLETED。
  - 方向：以同一 plan 的最新已驗證 checkpoint 比對，而非只看 parent 鏈。
- [ ] **#12 retry 預設沿用已失效 plan 的 milestone**（讀碼）
  - `src/orchestrator.ts:604`：plan 已完成（evaluation gate 讓 Work 停在 VERIFYING）時 `harness retry` 丟 PLAN_NOT_ACTIVE；
    重新規劃改了 milestone 名稱時丟 PLAN_MILESTONE_INVALID。
  - 方向：只有上一個 milestone 仍屬啟用中的 plan 才沿用；否則要求 `--milestone` 並給明確訊息，或在沒有 plan 時走無 milestone 路徑。
- [ ] **#15 checkout 路徑含空白或中文時 worker 起不來**（讀碼）
  - `src/durable/worker.ts:19`：`new URL(...).pathname` 保留百分比編碼；改用 `fileURLToPath`。

## 需要決定

- [ ] **#11 fork／重新規劃會把所有 milestone 重設為 PENDING**（讀碼）
  - `src/work/plans.ts:156`：未變動、已完成、且已記在 checkpoint 裡的 milestone 也要重跑；`harness answer` 提高 contract
    版本會讓 plan 過期而強制重新規劃，同樣歸零。
  - **待使用者決定：** 這是刻意的保守設計（新 contract／新 plan 下重新驗證一切），還是應沿用 checkpoint 內已驗證的進度？
    決定前不動。

## 整理（不影響行為）

- [ ] `canonicalJson` 重複於 `src/trace/store.ts:61` 與 `src/tools/operations.ts:65`。
- [ ] `processStart` 重複於 `src/runtime/ownership.ts:50` 與 `src/runtime/codex-driver.ts:189`。

## P5 留下的限制（非 bug，列入考量）

- [ ] 校準標註集 `2026-09-23.1` 由 fixture 作者（Claude Code session）手寫，尚未人工審閱；審閱後將 provenance 改為 `human-review`。
- [ ] Recovery benchmark 無法產生 `manually_resolved` run：gateway 沒有人工解決 `WAITING_USER` operation 的 API。
- [ ] 備份還原只做過同主機檔案層演練；異地備份、存取控管、排程未實作。

---

## 已完成（2026-09-23，已合併進 master）

| Commit | 項目 |
|---|---|
| `3fd38de` | #7 verdict 值不在 pass/fail/unknown 時一律 unknown，不能到 DONE |
| `ab5a69a` | #3 備份接受 v7 以前的 16 hex 檔名；#4 redaction 以 hash 找所有副本；#6 GC／redaction 在寫鎖內刪檔、`putArtifact` 補寫 |
| `7a76288` | #2 唯讀開舊 schema 改讀遷移後的私有快照，不再 `no such table` |
| `2395586` | #9 `CriticScheduler.fail()` 讓失敗的 critic 呼叫結清 dispatch 與預算 |
| `d494c56` | 新增 `AGENTS.md` |
