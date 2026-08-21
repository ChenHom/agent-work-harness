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
