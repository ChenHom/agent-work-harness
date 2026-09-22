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
