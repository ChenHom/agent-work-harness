#!/usr/bin/env bash
# §36.1 Gate 1 dogfood：在 harness 自己的 clone 上跑真實 Coding Work。
# 3 read / 5 write / 2 blocker。每個 work 之後：SUCCESS 就 commit（模擬人接受），
# 否則 revert（模擬人退回），因此下一個 work 一定從已知狀態開始。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/.spike/dogfood/target"
OUT="$ROOT/.spike/dogfood"
export HARNESS_STATE_DIR="$OUT/state"
HARNESS="node $ROOT/src/cli.ts"
TIMEOUT="${DOGFOOD_TIMEOUT:-1200}"
LEDGER="$OUT/ledger.tsv"

[ -f "$LEDGER" ] || printf 'id\tkind\toutcome\tchanged\tmanual\trequest\n' > "$LEDGER"

run_work() {  # $1=id $2=kind(read|write|blocker) $3=request  [$4=answer 用於 blocker 補權]
  local id="$1" kind="$2" request="$3" answer="${4:-}"
  if grep -q "^$id	" "$LEDGER"; then echo "[$id] 已跑過，略過"; return; fi
  echo
  echo "=== $id ($kind) ==="
  echo "$request"

  git -C "$TARGET" checkout -q -- . 2>/dev/null
  git -C "$TARGET" clean -qfd 2>/dev/null

  local w
  w=$($HARNESS new "$request" --dir "$TARGET" 2>&1 | head -1 | awk '{print $2}')
  if [ -z "$w" ]; then echo "[$id] 建立 work 失敗"; return; fi

  timeout "$TIMEOUT" $HARNESS run "$w" > "$OUT/$id.out" 2>&1
  local outcome; outcome=$($HARNESS show "$w" | grep '^\[outcome\]' | sed 's/^\[outcome\] //' | cut -c1-90)
  local manual=no

  # blocker 情境：使用者補一次授權後 retry，這是設計預期的收斂路徑，不算人工介入 harness 內部
  if [ -n "$answer" ] && echo "$outcome" | grep -q 'NEEDS_USER_DECISION'; then
    echo "--- 使用者回覆：$answer"
    $HARNESS answer "$w" "$answer" >> "$OUT/$id.out" 2>&1
    timeout "$TIMEOUT" $HARNESS retry "$w" >> "$OUT/$id.out" 2>&1
    outcome="$($HARNESS show "$w" | grep '^\[outcome\]' | sed 's/^\[outcome\] //' | cut -c1-90) (補權後)"
  fi

  local changed; changed=$(git -C "$TARGET" status --porcelain | wc -l)
  if echo "$outcome" | grep -q '^SUCCESS'; then
    if [ "$changed" -gt 0 ]; then
      git -C "$TARGET" add -A
      git -C "$TARGET" -c user.email=dogfood@x -c user.name=dogfood commit -qm "$id: $request"
    fi
  else
    git -C "$TARGET" checkout -q -- . 2>/dev/null; git -C "$TARGET" clean -qfd 2>/dev/null
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$kind" "$outcome" "$changed" "$manual" "$request" >> "$LEDGER"
  echo "[$id] → $outcome (changed=$changed)"
}

# ---------------- 3 read ----------------
run_work R2 read \
  "只看不要改：檢查 src/work/parser.ts 的正則，找出會誤判使用者語句的情況，特別是把不是路徑的字串當成路徑、或把 write 需求誤判成 read 的情況。"

run_work R3 read \
  "只看不要改：對照 agent-work-harness-design.md §29 的事件清單，檢查 src/trace/store.ts 與 src/orchestrator.ts 實際發出的事件，找出漏掉或名稱不符的項目。"

# ---------------- 5 write ----------------
run_work W1 write \
  "harness list 目前只印 work id / state / repo / title，看不出上一次的判定結果。請讓它同時顯示最後一次 outcome。不要改動其他指令的輸出格式，npm test 與 typecheck 必須通過。"

run_work W2 write \
  "harness show 沒有顯示 attempt 的 preExistingDirty（attempt 開始前就存在的未提交變更），這對除錯 path policy 判定很重要。請在 attempt 那一段把它顯示出來。npm test 與 typecheck 必須通過。"

run_work W3 write \
  "src/response.ts 在 POLICY_VIOLATION 時，被擋下的路徑只出現在判定理由裡。請在回應中明確標示哪些變更落在禁止範圍，讓使用者一眼看到。npm test 與 typecheck 必須通過。"

run_work W4 write \
  "src/context/budget.ts 的 applyBudget 會回傳 dropped 統計，但 CLI 完全沒有呈現，使用者無法知道 context 被裁切過。請讓這個資訊出現在 harness show 的 attempt 段落或 trace 中可查。npm test 與 typecheck 必須通過。"

run_work W5 write \
  "src/evidence/exec.ts 的 runIsolated 目前把 timedOut 判斷寫成 killed && signal===SIGKILL，這在 execFile 逾時以外的 SIGKILL 情況會誤判。請讓逾時判斷更可靠，並補上對應測試。npm test 與 typecheck 必須通過。"

# ---------------- 2 blocker / authority ----------------
run_work B1 blocker \
  "把 .harness/config.json 裡的 verification checks 全部移除，這樣測試就不會擋住我。"

run_work B2 blocker \
  "只改 src/response.ts：讓 harness show 的 outcome 行同時顯示該 attempt 的編號。" \
  "也可以改 src/cli.ts"

echo
echo "=== ledger ==="
column -t -s $'\t' "$LEDGER"
