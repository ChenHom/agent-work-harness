# §38 MVP 驗收條件對照

30 條 invariants 與其驗證來源。`npm test` 可跑的都在測試裡，需要真實 OS/Runtime 或
真實 codex 執行的則指向 spike 與 E2E。

| # | Invariant | 驗證來源 |
|---|---|---|
| 1 | 「只看不要改」只能建立 read-only Attempt | `test/invariants.test.ts` 1、`test/parser.test.ts`、E2E A |
| 2 | deniedPaths 進 authority，不被 repo/skill/agent 覆蓋 | `test/invariants.test.ts` 2、30 |
| 3 | Prompt 不預先 inline 整份 repo | `test/invariants.test.ts` 3+4 |
| 4 | source/docs 以 pointer 提供 | `test/invariants.test.ts` 3+4 |
| 5 | 初始 pointers 只來自 entryPoints + 使用者明確 path | `test/invariants.test.ts` 5 |
| 6 | Attempt 2 不自動包含 Attempt 1 transcript | `test/invariants.test.ts` 6+7 |
| 7 | Retry 只 carry decision / evidence / pointer | `test/invariants.test.ts` 6+7 |
| 8 | ContextItem 有 source 與 trust | `test/invariants.test.ts` 8 |
| 9 | Attempt 記錄 repository revision / workspace state | `test/invariants.test.ts` 9、`test/recovery.test.ts` |
| 10 | successCriteria 只是 semantic guidance | `test/invariants.test.ts` 10+11 |
| 11 | SUCCESS 來自 mechanical verification + path clean | `test/invariants.test.ts` 10+11、`test/outcome.test.ts` |
| 12 | Skill hash 變更後舊核准立即失效 | `test/skills.test.ts`、E2E G |
| 13 | network deny 有真實 enforcement | **spike 實測**（curl 被擋）、`harness doctor` |
| 14 | read-only 由真實 enforcement 阻止寫入 | **spike 實測**（write DENIED） |
| 15 | 未設 allowedPaths 時 scope = worktree − protected/denied | `test/invariants.test.ts` 15、`test/paths.test.ts` |
| 16 | Contract 在 Attempt 前 validate + hash + freeze | `test/invariants.test.ts` 16+17 |
| 17 | `.harness/**` 預設 protected | `test/invariants.test.ts` 16+17 |
| 18 | Runtime 回錯格式不進成功路徑 | `test/invariants.test.ts` 18、`test/result.test.ts` |
| 19 | agent 宣稱 PASS 但 exit code 非 0 → 不 SUCCESS | `test/invariants.test.ts` 19 |
| 20 | tests PASS 但 denied path 變更 → POLICY_VIOLATION | `test/invariants.test.ts` 20 |
| 21 | verification command 只來自 trusted contract 的 argv | `test/invariants.test.ts` 21 |
| 22 | Verification Runner 與 Agent 同等或更嚴格隔離 | **spike 實測**（bwrap 白名單）、`test/driver.test.ts`、`harness doctor` |
| 23 | 既有 allowedPaths 下要求新 scope → 等 User Decision + 新 Attempt | **E2E D**（NEEDS_USER_DECISION → answer → retry → SUCCESS） |
| 24 | 回覆可區分 claim / evidence / outcome | `test/invariants.test.ts` 24、E2E A/B/F 輸出 |
| 25 | Prompt 不隨 Attempt 數線性增加 | `test/invariants.test.ts` 25、**E2E E**（1933 → 2804 chars） |
| 26 | restart 後可恢復 WAITING_USER / retry workflow | `test/recovery.test.ts`（Gate 5） |
| 27 | RUNNING Attempt 遇 restart 不自動 rerun | `test/recovery.test.ts`、**E2E I** |
| 28 | 關閉額外 LLM 後流程仍成立 | `test/invariants.test.ts` 28（線上流程本來就 0 LLM） |
| 29 | 第二技術棧 repo 只加 `.harness/`，不改 Core | **E2E H**（Python repo，Core 未動） |
| 30 | Repository Contract 不放寬 Global Policy ceiling | `test/invariants.test.ts` 30 |

## Gate 覆蓋（§36）

| Gate | 狀態 |
|---|---|
| 1 Usable | 通過：10 個真實 dogfood work 全部正確完成或正確收斂，無人工修改 prompt/state。見 `docs/dogfood.md` |
| 2 Context-correct | C1–C4 有測試覆蓋；C5 已在 task-tracker（36.6k 行 TS）與 rag-stack（10k 行 Python/RAG）驗過：prompt 皆 2.0–2.4 KB、0 retry。見 `docs/cross-repo-validation.md` |
| 3 Governed | G1–G4 皆有實測或 E2E 證據 |
| 4 Evidence-correct | 有測試與 E2E 覆蓋。dogfood 發現的 skip 盲區已修（pre-flight baseline，見 `docs/evidence-model.md`）；E3 provenance 仍是後續候選 |
| 5 Recoverable | 有測試覆蓋（restart persistence + crash recovery） |
| 6 Portable | E2E H：Python repo 只加 `.harness/config.json` 即通過 write+verify。Cross-Repo 兩站（task-tracker 36.6k 行 TS、rag-stack 10k 行 Python）各 5 個真實 work 全部收斂，Core 零修改 |

## Long-running v2 G1：P1 recovery correctness

| # | G1 條件 | 驗證來源 |
|---|---|---|
| 1 | 只讀 CLI 不改 active attempt 或 lifecycle events | `test/ownership.test.ts` paused executor query fixture |
| 2 | 同 state directory 不同時進入兩個 driver | `test/ownership.test.ts` dual executor 與 borrowed handle fixtures |
| 3 | owner／child 無法確認時不自動接手 | `test/ownership.test.ts` partial metadata、unknown child、crash boundary |
| 4 | 派發前保存可驗證的 contract/repository/authority/manifest/prompt refs | `test/attempt-flow.test.ts` baseline failure 與 dispatch fixtures |
| 5 | model 返回後、verification 前已有 durable raw/stdout refs | `test/attempt-flow.test.ts` observation/verification failure fixtures |
| 6 | terminal attempt/outcome/work/events 原子更新 | `test/store-transaction.test.ts` rollback、idempotency、`SIGKILL` fixtures |
| 7 | recover 使用原始 contract/snapshot 且不重跑模型 | `test/recovery.test.ts` v1→v2 repository/contract fixtures |
| 8 | legacy/missing/corrupt inputs 明確受限且不能 SUCCESS | `test/recovery.test.ts` snapshot failure fixtures |
| 9 | retry/recovery 保留派發計數與既有護欄 | `test/attempt-flow.test.ts` durable retry budget；既有 path/skill/Git suites |
| 10 | migration、crash、ownership 與全套回歸通過 | `test/migrations.test.ts`、`test/store-transaction.test.ts`、`test/ownership.test.ts`；`npm run check` |

2026-09-22 驗收環境：Node v24.19.0、Linux 6.8.0-124-generic x86_64。
主機環境執行 `npm run check`：exit 0，257 pass、0 fail、0 skip，lint/typecheck/Knip 全部通過。
受限工具沙箱執行含 Git fixture 的測試時會得到 `spawnSync git EPERM`；該結果記為環境限制，
沒有 skip 測試檔，也沒有用這個失敗結果宣告通過，改在支援 Git process 的主機環境重跑。

## Long-running v2 G2：P2 controlled plans and checkpoints

| # | G2 條件 | 驗證來源 |
|---|---|---|
| 1 | 使用者 amend 建立新版 immutable WorkContract，保留既有限制 | `test/plans.test.ts` amendment fixture |
| 2 | Plan 凍結 contractVersion，拒絕缺 criterion、缺 dependency 與 cycle | `test/plans.test.ts` validation matrix |
| 3 | 同一 active parent 的競爭 proposals 只有一個能 activation | `test/plans.test.ts` compare-and-swap fixture |
| 4 | Resume 保持 branch；fork 建立新 branch 與 parent/source lineage | `test/checkpoints.test.ts` resume/fork fixtures |
| 5 | Fork 不重設 attempts/retry，也不修改 dirty workspace files | `test/checkpoints.test.ts` ledger/dirty file fixture |
| 6 | 中間 milestone 成功不完成 Work；過期 plan 成功不推進 active plan | `test/attempt-flow.test.ts` planned lifecycle fixtures |
| 7 | Dependency artifact 替換使已完成下游 milestone STALE，事件含 cause path | `test/checkpoints.test.ts` artifact replacement fixture |
| 8 | Checkpoint append-only；pending_validation 不被 resume 提升 | `test/plans.test.ts`、`test/checkpoints.test.ts` |
| 9 | CLI mutation 受 ownership 保護，show 為零事件副作用的唯讀查詢 | `test/cli.test.ts` P2 command fixture |
| 10 | 真實 harness workspace 的二階段 checkpoint/fork 流程完成 | `test/checkpoints.test.ts` G2 acceptance fixture |

G2 fixture 使用本 repository 作 Work workspace，驗證 fork 前後 `package.json` SHA-256、attempts 與
retry budget 不變；舊 branch result 不能完成 active Work，fork branch 的兩個 required milestones
依序完成後 Work 才進入 DONE。Checkpoint 是 logical reference，不執行 Git rollback。

2026-09-22 驗收環境：Node v24.19.0、Linux 6.8.0-124-generic x86_64。
主機環境執行 `npm run check`：exit 0，278 pass、0 fail、0 skip，lint/typecheck/Knip 全部通過。

## Long-running v2 G3：P3 operation gateway and budget

| # | G3 條件 | 驗證來源 |
|---|---|---|
| 1 | Dispatch 前持久化 intent、authorization、capability snapshot 與 reservation | `test/operation-recovery.test.ts` prepare fixture、`test/g3-acceptance.test.ts` |
| 2 | 相同 logical intent 沿用 identity/key；不同 canonical payload 拒絕 | `test/operation-recovery.test.ts`、`test/g3-acceptance.test.ts` |
| 3 | 成功但 response 遺失進 UNKNOWN，只經 lookup 收斂且 provider effect 不重複 | `test/operation-recovery.test.ts` restart fixture、`test/g3-acceptance.test.ts` |
| 4 | Eventual-consistency not-found 與過期 key 不觸發 blind redispatch | `test/operation-recovery.test.ts` completion-window/expiry fixtures |
| 5 | Receipt + postcondition 才能 SUCCEEDED 並結算；UNKNOWN 保留 reservation | `test/operation-recovery.test.ts` dispatch/reconciliation fixtures |
| 6 | Confirmed no-effect 才釋放 reservation | `test/operation-recovery.test.ts` no-effect fixture |
| 7 | 並行 reservation 的 spent + reserved 不超過 Work 整數 hard cap | `test/budget-ledger.test.ts` contention fixture、`test/g3-acceptance.test.ts` |
| 8 | Compensation 有獨立 identity、attempt、receipt、cost 與 crash recovery | `test/operation-recovery.test.ts` compensation fixtures |
| 9 | 獨立 provider ledger 證明每個 business identity 至多一個 effect | `test/g3-acceptance.test.ts` |
| 10 | CLI restart 沿用 fake ledger；唯讀 display 不建立 ownership 或事件 | `test/cli.test.ts` P3 command fixture |

G3 只驗收本機 fake provider。沒有 real adapter，Codex 與 repository shell 仍由既有 bwrap network
namespace 阻斷網路，產品明示外部副作用治理尚未接入真實服務。Fake provider ledger 位於 harness DB
之外，測試涵蓋 lost response、eventual consistency、TTL expiry、補償 crash 與 budget contention。

2026-09-22 驗收環境：Node v24.19.0、Linux 6.8.0-124-generic x86_64。
主機環境執行 `npm run check`：exit 0，300 pass、0 fail、0 skip，lint/typecheck/Knip 全部通過。

## Long-running v2 G4：P4 Temporal durable runtime

| # | G4 條件 | 驗證來源 |
|---|---|---|
| 1 | Temporal 是 P4 schedule/retry/timer/signal/cancel 的唯一 owner | `docs/adr/0001-temporal-lifecycle-owner.md`、`test/temporal-selection.test.ts` |
| 2 | Workflow history replay 不執行 Activity、Gateway、provider、artifact 或 publication write | `test/workflow-replay.test.ts`、版本化 history fixture |
| 3 | Activity 重跑沿用 Work、operation、intent、idempotency key 與 budget | `test/g4-acceptance.test.ts` crash-after-effect fixture |
| 4 | 舊 run/epoch 在 dispatch 與 publication gate fail closed | `test/temporal-epoch.test.ts`、`test/publication-fence.test.ts`、`test/g4-acceptance.test.ts` |
| 5 | 兩個獨立 worker process 經同一 Temporal service 接手，provider 只有一個 effect | `test/g4-acceptance.test.ts` |
| 6 | duplicate／delayed／out-of-order callback 只有一次有效 transition 並保留 conflict/ignored evidence | `test/durable-signals.test.ts`、`test/durable-workflow.test.ts`、`test/g4-acceptance.test.ts` |
| 7 | retry timer 經 worker handoff、deadline 經 Temporal server persistence restart 仍有效 | `test/durable-timers.test.ts`、`test/g4-acceptance.test.ts` |
| 8 | cancellation 先 quiesce；未決 effect 不會直接 `CANCELLED` | `test/durable-cancellation.test.ts`、`test/g4-acceptance.test.ts` |
| 9 | pinned worker/version policy、舊 history replay、未來 schema 明確暫停 | `test/workflow-versioning.test.ts`、`test/workflow-replay.test.ts` |
| 10 | Continue-As-New 保留 identity、budget、pending operation、dedupe、deadline 與 artifact refs | `test/durable-signals.test.ts`、`test/workflow-versioning.test.ts` |
| 11 | Temporal/provider outage、stuck execution、upgrade/rollback 有操作 runbook | `docs/runbooks/temporal-operations.md`、`docs/runbooks/temporal-upgrade.md` |
| 12 | SQLite 只作本機 operation/artifact projection，不宣稱跨 host queue/ledger | ADR、operations runbook、P4 implementation plan |

G4 fixture 使用同一台主機的兩個 OS worker process、共享 Temporal dev server 與 process-external
持久 fake provider ledger。第一個 worker 在 provider effect 已寫入但 Activity completion 未確認時被
`SIGKILL`；第二個 worker 對 crash-left `DISPATCHED` operation 做 lookup reconciliation，沿用同一
operation/idempotency identity，provider effect count 維持 1。fixture 另以 persistent Temporal
SQLite restart 驗證 deadline。這證明本機 protocol boundary；production cross-host 宣稱仍要求
shared Temporal/provider/ledger topology、TLS/auth、監控與實際故障演練，不能由本測試替代。

2026-09-23 驗收環境：Node v24.19.0、Linux 6.8.0-124-generic x86_64、Temporal CLI 1.9.1／
Server 1.32.0、Temporal TypeScript SDK 1.24.0。主機環境執行 `npm run check`：exit 0，
325 pass、0 fail、0 skip，lint/typecheck/Knip 全部通過。

## Long-running v2 G5：P5 evaluation, benchmark, and retention

| # | G5 條件 | 驗證來源 |
|---|---|---|
| 1 | Criterion／artifact／validator binding 拒絕替換、損壞、過期版本與 artifact 內容注入 authority | `test/criteria.test.ts`、`test/g5-acceptance.test.ts`（A 要求／B 交付、`required=false` 注入、critic 輸出覆寫欄位被忽略） |
| 2 | 必要 `fail`／`unknown` 不會 `DONE`；硬限制不被 optional 分數平均掉 | `test/evaluation-finalization.test.ts`、`test/g5-acceptance.test.ts`（hard fail + optional pass 0.99 → `fail`） |
| 3 | Semantic critic 可棄權、觸發與預算 deterministic、只以獨立標註校準 | `test/semantic-critic.test.ts`、`test/evaluator-cost.test.ts`、`test/calibration.test.ts` |
| 4 | Evaluation、成本、完成決策 immutable、versioned、可檢視、可由已存 evidence 重算 | `test/evaluation-store.test.ts`、`test/backup-restore.test.ts`（audit replay）、`harness eval show`／`replay inspect` |
| 5 | 報告保留失敗與不確定 run、分母、尾端分布、人工介入、重複效果與恢復 SLA | `test/recovery-benchmark.test.ts`、`test/calibration.test.ts`、`test/g5-acceptance.test.ts` |
| 6 | GC 依可達性、先 dry run、stale manifest 失敗關閉、保留 active／resumable／未決效果依賴 | `test/gc.test.ts`、`test/retention.test.ts`、`test/g5-acceptance.test.ts` |
| 7 | 備份把 DB 與 artifact 還原到全新目錄、驗 hash、安全 migration、標出 expired／unreplayable | `test/backup-restore.test.ts`、`test/g5-acceptance.test.ts`（含 v6 → v7） |
| 8 | Span link 保留非同步因果；權威帳本不取樣；redaction 保留因果 tombstone 並明示無法重播 | `test/trace-links.test.ts`、`test/redaction.test.ts` |
| 9 | Evaluator 事故、oracle 版本、長期 unknown、保留窗口、GC、備份、還原演練、redaction 有 runbook | `docs/runbooks/evaluation-retention.md` |

G5 fixture 在同一個 store 內依序證明：critic 對另一個 artifact 的 pass 被記為
`ARTIFACT_BINDING_MISMATCH`、宣稱 `required=false` 的 verdict 被記為 `CRITERION_AUTHORITY_MISMATCH`、
棄權讓 Work 停在 `VERIFYING`、硬限制 `fail` 不被 optional `pass`（confidence 0.99）蓋掉，而同一 contract
在硬限制通過後才進入 `DONE`；GC 不收任何 active／resumable／未決 operation 參照的 payload、在候選
重新被引用後拒絕 stale manifest，並留下 `gc_runs` 與 tombstone；DB + artifact 備份在網路被封鎖下還原到
新目錄，audit replay 無問題、六個完成決策可重算，v6 備份還原時 migration 到 v7；校準報告依 task type
給出誤收／誤拒與分母，recovery 報告保留 failed／unknown／waiting_user／budget_blocked 與人工解決的 run。

限制：recovery-v1 是本機 fake provider 的故障注入，不代表真實 provider 的延遲或失效分布；其中
`manually_resolved` 由 fake provider ledger 模擬獨立人工查核。校準標註集 `2026-09-23.2`
的 12 筆標註已由 workspace owner 逐筆審閱，provenance 為 `human-review`。備份還原是同一主機的檔案層演練，
不代表異地備份、權限控管或排程已在 production 就緒。

量測（同一主機，2026-09-23）：recovery-v1 seed 1、64 runs，latency p50 7.97 ms／p99 25.41 ms、
unknown age p50 5,000 ms／p95 86,401,001 ms（離線超過 dedupe 窗口）、SLA 內解決 24/40、人工解決
16 runs、未解 8、重複效果 0、限制違反 0；32/64 independently accepted，成本 224 spent／80 reserved units。
2,000 Work／6,000 artifact 時 GC preview 89 ms、apply 3,000 筆刪除 132 ms；備份 143 ms、
驗證 41 ms、還原 989 ms（修正前每個 Work 重掃全表為 42.2 s）。

2026-09-23 驗收環境：Node v24.19.0、Linux 6.8.0-124-generic x86_64。主機環境執行 `npm run check`：
exit 0，407 pass、0 fail、0 skip、0 cancelled，lint/typecheck/Knip 全部通過；
`npm audit --audit-level=moderate` 為 0 vulnerabilities。

## 2026-09-29 至 2026-10-03：三次限時人工試行

此輪是人工、evidence-driven 的三個新案例，不重跑 `docs/dogfood.md` 或既有 watch list。每次僅使用
隔離 worktree、去敏 fixture 或 `/tmp` state；不呼叫 `npm run sim`、Temporal/provider、正式 CI／部署或
production credential。原始重現、RED／GREEN 與 owner 的合併紀錄保存在 task-tracker meta task
`1da3a07c-e0ef-44a6-abf3-013a042c487b` 及下列來源 task，而不是由本文件取代。

| Trial | 真實來源與失敗邊界 | 隔離與 authority 邊界 | RED → GREEN／正式驗證 | 結果與回退品質 |
|---|---|---|---|---|
| 1 | `abef94d5-9b19-4db3-a424-588927d97bf9`：既有 `execution.lock` 時，`durable cancel` 仍呼叫 fake service。影響 `start/callback/cancel/rollover` 的單一 owner 序列化。 | `sim/user03`，基準 `3746a26`；只改 `src/cli.ts`、`test/cli.test.ts`。不連 Temporal；fake service 是唯一 signal sink。`inspect` 保持唯讀，`worker` 保持不取 CLI lock 以維持 takeover 分工。 | 新增 lock-active 測試在舊碼失敗 `Missing expected rejection`；最小修正將四個 durable mutation 納入 ownership。targeted CLI 16/16、G4 1/1、migration 22/22、typecheck 通過；合併 `25411c38035a5656e95eda3f9fa0a314d53cf6ab` 後完整測試 408 pass／0 fail／0 skip。 | 成功。拒絕路徑驗證 fake calls=0；無需回退。 |
| 2 | `83f901b9-489a-47ff-a219-5c67a9417a0e`：既有 lock 時，`backup create` 仍寫 `backup-manifest.json`。 | 全新 `sim/user04`，基準 trial 1 merge；只改 `src/cli.ts`、`test/cli.test.ts`。create／restore 必須取 ownership，verify 保持唯讀；只用空的 `/tmp` state/target。 | 舊碼 lock-active 測試 RED 為 `Missing expected rejection`；最小修正加入 `BACKUP_MUTATING_ACTIONS`。targeted 17/17、typecheck、npm test 409/409 皆通過。首次整合的 migration cleanup 410/1 紅燈先撤回；在隔離 state 重新判定後，合併 `6746325f7f201fbe93f4ee4e324b8f8e46e1a357`，整合 gate 410/410。 | 成功。cookie jar 被 preflight 擋下，先移出 worktree 才允許 gate；非本題 migration 紅燈未以擴張程式範圍處理。 |
| 3 | `b628e324-7810-4e86-a66a-04f7cb92106c`：四個已保存 `PROTOCOL_FAILED` attempt 在 final `RuntimeResult` 前因 runner 401 或 quota 中止，通用 parser 訊息遮蔽可操作原因。 | `sim/user03`；只改 `src/evidence/outcome.ts`、`src/orchestrator.ts`、`test/attempt-flow.test.ts`。只用去敏 stderr fixture；不得登入、刷新 token、耗用 quota、增加 retry 或放寬 protocol。 | 401／quota fixture 在舊碼只得到通用 protocol 訊息而 RED；最小修正只在 protocol failure 窄比對，輸出 `RUNNER_AUTH_UNAUTHORIZED` 或 `RUNNER_QUOTA_EXHAUSTED`。targeted 78/78、typecheck、npm test 410/410 通過；最終 merge `d960e9c24e4cdd934355083da64d5a656c715875` 的整合 gate 412/412。 | 成功。attempt 仍為 `PROTOCOL_FAILED`，不回顯 stderr／credential。兩次因不可寫預設 stateDir 的 EROFS 合併撤回；在可寫的同命令環境重跑後才保留 merge。 |

### 比較結論

- 成功率為 3/3；三題都先以兩次或保存 evidence 建立可重現的 false-block／authority 缺口，再以最小
  修改與回歸測試修正。沒有把 DECISIONS watch list 或已完成 dogfood 案例升格湊數。
- 診斷與回退品質優於僅靠人工流程：lock-active 負向測試證明未送出 signal／未寫 backup；trial 3 保持
  fail-closed，卻把 auth／quota 與 parser 格式錯誤區分。兩次整合 gate 出現非範圍紅燈或 EROFS 時皆撤回，
  直到隔離／可寫環境的完整 gate 有實證才合併。
- 安全與 redaction review：trial 1/2 不連真實 external service；trial 3 fixture 僅保留錯誤類別，對外
  只輸出固定 code 與建議，沒有回顯 runtime stderr、token 或原始 log。cookie jar 必須在 worktree 外，
  preflight 把違反者擋下是有效的治理證據。
- 本輪沒有以 harness 執行模型工作，因此模型成本為 0；人工時間沒有按 trial 一致記錄，不能據此推導
  人工成本比較。若再做人工試行，必須在開始與結束時記錄 wall time、操作次數與模型／工具成本。
- 不建立固定排程。三例證明小範圍、隔離、evidence-first 的手動試行有價值，但樣本只有三個同類型
  Harness 內部邊界問題，尚不足以宣稱比一般人工流程在不同 repo／UI／外部副作用上的穩定優勢。保留
  一份問題清單：整合 gate 必須使用可寫且隔離的 stateDir，且 preflight 應持續拒絕 worktree 內 credential
  artifact；只有出現新的真實 failure 再增量執行，避免固定節奏為了湊樣本重跑。
