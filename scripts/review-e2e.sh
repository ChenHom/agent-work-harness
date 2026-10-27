#!/usr/bin/env bash
# shellcheck disable=SC2016
# （SC2016：node -e 的 JS 含 ${...} 樣板字串，刻意放在單引號內。）
# M1 完成證據：以真實的 git、bwrap、Docker 與 Reviewer image，從零驗證 `harness review`。
# 不呼叫真實的 codex 或任何 AI（假 codex 由本腳本寫在 $OUT/bin/），Reviewer container 為 --network none。
#
# 用法：HARNESS_REVIEWER_IMAGE=reviewer:m1-2d84ad6 bash scripts/review-e2e.sh
#   HARNESS_REVIEWER_IMAGE  必填；本腳本不 build、不 pull
#   HARNESS_E2E_OUT         工作目錄，預設 ${XDG_CACHE_HOME:-$HOME/.cache}/harness-review-e2e/<時間戳記>
#                           不要放在 /tmp：snap 版 Docker 的 /tmp 是私有的，--mount 找不到來源
# 每個情境印 PASS／FAIL；全部通過 exit 0，任何 FAIL 或缺前提 exit 1。
# 結束時保留 OUT，只刪掉其中的 codex-home（Harness 會把操作者的 ~/.codex/auth.json 複製進去）。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

die() { printf 'review-e2e: %s\n' "$*" >&2; exit 1; }

for tool in git bwrap docker node; do
  command -v "$tool" > /dev/null || die "missing prerequisite: $tool"
done
NODE="$(command -v node)"
node_major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "${node_major:-0}" -ge 24 ] 2> /dev/null || die "Node 24+ required, found $("$NODE" --version)"
[ -n "${HARNESS_REVIEWER_IMAGE:-}" ] \
  || die "HARNESS_REVIEWER_IMAGE is not set (M1 uses reviewer:m1-2d84ad6); this script never builds or pulls it"
export HARNESS_REVIEWER_IMAGE

OUT="${HARNESS_E2E_OUT:-${XDG_CACHE_HOME:-$HOME/.cache}/harness-review-e2e/$(date +%Y%m%dT%H%M%S)}"
mkdir -p "$OUT/bin" "$OUT/repos" || die "cannot create $OUT"
OUT="$(cd "$OUT" && pwd -P)"
case "$OUT" in
  /tmp/*) printf 'review-e2e: warning: OUT=%s is under /tmp; snap Docker cannot see it\n' "$OUT" >&2 ;;
esac

cleanup() {
  local found; found="$(find "$OUT" -type d -name codex-home -prune | wc -l)"
  find "$OUT" -type d -name codex-home -prune -exec rm -rf {} + 2> /dev/null
  printf 'codex-home dirs under OUT: removed %s, left %s\n' "$found" "$(find "$OUT" -type d -name codex-home | wc -l)"
}
trap cleanup EXIT

# --- harness 與斷言 -------------------------------------------------------

STATE=""   # 每個情境自己的 HARNESS_STATE_DIR
CODEX=""   # 每個情境自己的假 codex
harness_cmd() { HARNESS_STATE_DIR="$STATE" HARNESS_CODEX_BIN="$CODEX" "$NODE" "$ROOT/src/cli.ts" "$@"; }

TOTAL=0
FAILS=0
SC=""
ERRS=()
begin() { SC="$1"; ERRS=(); printf '\n=== %s ===\n' "$SC"; }
info() { printf '  %s\n' "$*"; }
expect_eq() {  # $1=what $2=expected $3=actual
  [ "$2" = "$3" ] || ERRS+=("$1: expected '$2' vs actual '$3'")
}
expect_has() {  # $1=what $2=fixed string $3=file
  grep -qF -- "$2" "$3" || ERRS+=("$1: expected '$2' in ${3#"$OUT"/} vs not found")
}
expect_lacks() {  # $1=what $2=fixed string $3=file
  ! grep -qF -- "$2" "$3" || ERRS+=("$1: expected no '$2' in ${3#"$OUT"/} vs found")
}
finish() {
  TOTAL=$((TOTAL + 1))
  if [ ${#ERRS[@]} -eq 0 ]; then
    printf 'PASS %s\n' "$SC"
  else
    FAILS=$((FAILS + 1))
    local joined; joined="$(printf '%s; ' "${ERRS[@]}")"
    printf 'FAIL %s: %s\n' "$SC" "${joined%; }"
  fi
}

git_commit() {  # $1=repo $2=message；固定的測試身分，不簽章
  git -C "$1" -c user.name=review-e2e -c user.email=review-e2e@example.invalid -c commit.gpgsign=false \
    commit -qm "$2"
}

# Harness 不得動使用者 repo 的 refs、index、工作樹或 object DB。status 用 GIT_OPTIONAL_LOCKS=0，
# 避免量測本身刷新 index。
repo_state() {
  local r="$1"
  printf 'HEAD=%s\n' "$(git -C "$r" rev-parse HEAD)"
  printf 'refs=%s\n' "$(git -C "$r" for-each-ref --format='%(refname) %(objectname)' | sha256sum | cut -c1-64)"
  printf 'status=%s\n' "$(GIT_OPTIONAL_LOCKS=0 git -C "$r" status --porcelain --untracked-files=all | sha256sum | cut -c1-64)"
  printf 'index=%s\n' "$(sha256sum < "$r/.git/index" | cut -c1-64)"
  printf 'objects=%s\n' "$(git -C "$r" count-objects -v | tr '\n' ' ')"
}

# --- fixture 與假 codex ---------------------------------------------------

fixture() {  # $1=dir
  local d="$1"
  rm -rf "$d"
  mkdir -p "$d/src" "$d/.harness"
  cat > "$d/README.md" <<'EOF'
# review-e2e fixture

Minimal TypeScript project used by scripts/review-e2e.sh.
EOF
  cat > "$d/src/math.ts" <<'EOF'
/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}
EOF
  cat > "$d/.harness/config.json" <<EOF
{
  "schemaVersion": "1",
  "repositoryId": "$(basename "$d")",
  "context": { "entryPoints": ["src/"] },
  "filesystem": { "protectedPaths": [".git/**", ".harness/**"] },
  "verification": {
    "checks": [
      { "id": "diff-check", "kind": "custom", "argv": ["git", "diff", "--check"], "required": true }
    ]
  }
}
EOF
  git -C "$d" init -q
  git -C "$d" add -A
  git_commit "$d" base
}

# 每種行為一支獨立的執行檔（Harness 只給 codex 最小 env，不能靠環境變數切換模式）。
# stdin 是行為本身的 JS，前面接共用的 argv／prompt 解析。
fake_codex() {  # $1=name
  local f="$OUT/bin/$1"
  {
    printf '#!%s\n' "$NODE"
    cat <<'EOF'
'use strict';
// 假 codex（scripts/review-e2e.sh 產生）：不呼叫任何 AI。
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const option = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) { console.error(`fake codex: ${flag} missing from argv`); process.exit(2); }
  return argv[i + 1];
};
const workspace = option('-C');
const lastMessagePath = option('-o');
const prompt = fs.readFileSync(0, 'utf8');
const field = (key) => {
  const m = prompt.match(new RegExp(`"${key}": "([^"]+)"`));
  if (!m) { console.error(`fake codex: "${key}" missing from prompt`); process.exit(2); }
  return m[1];
};
const done = (summary, declaredChangedPaths) => {
  fs.writeFileSync(lastMessagePath, JSON.stringify({
    schemaVersion: '1', status: 'completed', summary,
    workId: field('workId'), attemptId: field('attemptId'),
    claims: [], questions: [], declaredChangedPaths,
  }, null, 2));
};
EOF
    cat
  } > "$f"
  chmod +x "$f"
}

fake_codex codex-edit <<'EOF'
fs.appendFileSync(path.join(workspace, 'src/math.ts'),
  '\n/** Multiplies two numbers. */\nexport function multiply(a: number, b: number): number {\n  return a * b;\n}\n');
fs.writeFileSync(path.join(workspace, 'src/extra.ts'), "export const EXTRA = 'extra';\n");
done('added multiply() to src/math.ts and created src/extra.ts', ['src/math.ts', 'src/extra.ts']);
EOF

fake_codex codex-none <<'EOF'
done('read src/math.ts; no files changed', []);
EOF

# --- 共用步驟 -------------------------------------------------------------

W=""
A=""
# harness new + run，要求 outcome 為 SUCCESS。設定 W、A；失敗時記錄錯誤並回 1。
start_attempt() {  # $1=tag $2=repo $3=request
  local tag="$1" repo="$2" request="$3" rc facts outcome
  W=""; A=""
  harness_cmd new "$request" --dir "$repo" > "$OUT/$tag.new.out" 2>&1
  W="$(head -1 "$OUT/$tag.new.out" | awk '{print $2}')"
  case "$W" in
    W-*) ;;
    *) ERRS+=("harness new: expected a work id vs '$(head -1 "$OUT/$tag.new.out")'"); W=""; return 1 ;;
  esac
  harness_cmd run "$W" > "$OUT/$tag.run.out" 2>&1
  rc=$?
  facts="$(harness_cmd list --json | "$NODE" -e '
    const [w] = JSON.parse(require("fs").readFileSync(0, "utf8"));
    console.log(`${w?.attempt?.id ?? ""} ${w?.outcome?.outcome ?? "none"}`);')"
  A="${facts%% *}"
  outcome="${facts#* }"
  info "work=$W attempt=$A run exit=$rc outcome=$outcome"
  expect_eq "harness run exit" 0 "$rc"
  expect_eq "attempt outcome" SUCCESS "$outcome"
  [ "$rc" = 0 ] && [ "$outcome" = SUCCESS ] && [ -n "$A" ]
}

RC=""
# harness review，stdout／stderr 存到 $OUT/<tag>.out／.err；比較 review 前後的 repo 狀態。
review() {  # $1=tag $2=repo $3..=review args
  local tag="$1" repo="$2" before after
  shift 2
  before="$(repo_state "$repo")"
  harness_cmd review "$@" > "$OUT/$tag.out" 2> "$OUT/$tag.err"
  RC=$?
  after="$(repo_state "$repo")"
  [ "$before" = "$after" ] \
    || ERRS+=("repo untouched by '$tag': expected '$(echo "$before" | tr '\n' ' ')' vs actual '$(echo "$after" | tr '\n' ' ')'")
}

# envelope 的重點欄位，一行一個 key=value。
envelope_facts() {  # $1=file
  "$NODE" -e '
    let e;
    try { e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { console.log("parse=error"); process.exit(0); }
    const paths = (list) => Array.isArray(list) ? list.map((f) => f.path).sort().join(",") : "";
    console.log([
      "parse=ok", `status=${e.status}`, `workId=${e.workId}`, `attemptId=${e.attemptId}`,
      `candidate=${e.candidate}`, `baseRevision=${e.baseRevision}`, `mergeBase=${e.mergeBase}`, `resultTree=${e.resultTree}`,
      `imageId=${e.reviewer?.imageId}`, `revision=${e.reviewer?.revision}`, `reportSha256=${e.rawReport?.sha256}`,
      `humanReviewCount=${Array.isArray(e.humanReview) ? e.humanReview.length : "missing"}`,
      `humanReview=${paths(e.humanReview)}`, `notSelected=${paths(e.notSelected)}`,
    ].join("\n"));' "$1"
}
fact() { printf '%s\n' "$1" | sed -n "s/^$2=//p"; }

# show 中「人工待辦」那一段的 path，排序後以逗號連接。
show_human_paths() {  # $1=show output file
  awk '/^人工待辦/ { on = 1; next } /^機械審查未選入/ { on = 0 } on' "$1" \
    | sed -n 's/^- \([^:]*\).*/\1/p' | sort | paste -sd, -
}

IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$HARNESS_REVIEWER_IMAGE" 2> /dev/null)"

# --- 情境 -----------------------------------------------------------------

S1_REPO=""; S1_STATE=""; S1_W=""; S1_A=""; S1_SHA=""; S1_BEFORE=""; S1_ENVELOPE_SHA=""; S1_FACTS=""

scenario_S1() {
  begin "S1 human review required"
  S1_REPO="$OUT/repos/s1"; fixture "$S1_REPO"
  STATE="$OUT/state-s1"; CODEX="$OUT/bin/codex-edit"; rm -rf "$STATE"; S1_STATE="$STATE"
  local base; base="$(git -C "$S1_REPO" rev-parse HEAD)"
  if start_attempt s1 "$S1_REPO" "在 src/math.ts 新增 multiply 函式，並新增 src/extra.ts"; then
    S1_W="$W"; S1_A="$A"
    git -C "$S1_REPO" add -A && git_commit "$S1_REPO" "human commit of $A"
    S1_SHA="$(git -C "$S1_REPO" rev-parse HEAD)"
    S1_BEFORE="$(repo_state "$S1_REPO")"
    review s1.review "$S1_REPO" "$W" --attempt "$A" --head "$S1_SHA" --json
    S1_FACTS="$(envelope_facts "$OUT/s1.review.out")"
    S1_ENVELOPE_SHA="$(printf '%s' "$(cat "$OUT/s1.review.out")" | sha256sum | cut -c1-64)"
    info "review exit=$RC status=$(fact "$S1_FACTS" status) humanReview=[$(fact "$S1_FACTS" humanReview)] notSelected=[$(fact "$S1_FACTS" notSelected)]"
    info "candidate=$S1_SHA envelope(stdout) sha256=$S1_ENVELOPE_SHA"
    expect_eq "review exit" 5 "$RC"
    expect_eq "envelope JSON" ok "$(fact "$S1_FACTS" parse)"
    expect_eq "envelope status" HUMAN_REVIEW_REQUIRED "$(fact "$S1_FACTS" status)"
    [ "$(fact "$S1_FACTS" humanReviewCount)" -ge 1 ] 2> /dev/null \
      || ERRS+=("humanReview: expected >= 1 item vs actual '$(fact "$S1_FACTS" humanReviewCount)'")
    expect_eq "envelope workId" "$W" "$(fact "$S1_FACTS" workId)"
    expect_eq "envelope attemptId" "$A" "$(fact "$S1_FACTS" attemptId)"
    expect_eq "envelope candidate" "$S1_SHA" "$(fact "$S1_FACTS" candidate)"
    expect_eq "envelope baseRevision" "$base" "$(fact "$S1_FACTS" baseRevision)"
    expect_eq "envelope mergeBase" "$base" "$(fact "$S1_FACTS" mergeBase)"
    expect_eq "envelope resultTree" "$(git -C "$S1_REPO" rev-parse "$S1_SHA^{tree}")" "$(fact "$S1_FACTS" resultTree)"
    expect_eq "envelope reviewer imageId" "$IMAGE_ID" "$(fact "$S1_FACTS" imageId)"
    expect_eq "review-work left behind" "" "$(ls -A "$STATE/review-work")"
  fi
  finish
}

scenario_S1_show() {
  begin "S1 show"
  if [ -z "$S1_A" ]; then ERRS+=("S1 attempt: expected available vs missing"); finish; return; fi
  STATE="$S1_STATE"
  harness_cmd show "$S1_W" > "$OUT/s1.show.out" 2>&1
  local rc=$? report_sha
  report_sha="$(fact "$S1_FACTS" reportSha256)"
  grep -E '^(status|candidate|envelope sha256|report sha256|reviewer):' "$OUT/s1.show.out" | sed 's/^/  /'
  expect_eq "show exit" 0 "$rc"
  expect_has "show status" "status: HUMAN_REVIEW_REQUIRED" "$OUT/s1.show.out"
  expect_has "show candidate" "candidate: $S1_SHA" "$OUT/s1.show.out"
  expect_has "show envelope sha256" "envelope sha256: $S1_ENVELOPE_SHA" "$OUT/s1.show.out"
  expect_has "show report sha256" "report sha256: $report_sha" "$OUT/s1.show.out"
  expect_eq "show human review paths" "$(fact "$S1_FACTS" humanReview)" "$(show_human_paths "$OUT/s1.show.out")"
  expect_lacks "show review artifacts" REVIEW_ARTIFACT_INVALID "$OUT/s1.show.out"
  finish
}

scenario_S1_repo() {
  begin "S1 repo untouched"
  if [ -z "$S1_BEFORE" ]; then ERRS+=("S1 commit: expected available vs missing"); finish; return; fi
  local after; after="$(repo_state "$S1_REPO")"
  printf '%s\n' "$after" | sed 's/^/  /'
  expect_eq "repo state after review + show" "$(echo "$S1_BEFORE" | tr '\n' ' ')" "$(echo "$after" | tr '\n' ' ')"
  finish
}

scenario_S2() {
  begin "S2 no changes"
  local repo="$OUT/repos/s2" base facts
  fixture "$repo"
  STATE="$OUT/state-s2"; CODEX="$OUT/bin/codex-none"; rm -rf "$STATE"
  base="$(git -C "$repo" rev-parse HEAD)"
  if start_attempt s2 "$repo" "只看不要改：說明 src/math.ts 的 add 函式在做什麼"; then
    expect_eq "worktree after read-only attempt" "" "$(git -C "$repo" status --porcelain)"
    review s2.review "$repo" "$W" --attempt "$A" --head "$base" --json
    facts="$(envelope_facts "$OUT/s2.review.out")"
    info "review exit=$RC status=$(fact "$facts" status) candidate=$base"
    expect_eq "review exit" 0 "$RC"
    expect_eq "envelope status" NO_CHANGES "$(fact "$facts" status)"
    expect_eq "envelope humanReview" "0" "$(fact "$facts" humanReviewCount)"
    expect_eq "envelope candidate" "$base" "$(fact "$facts" candidate)"
    harness_cmd show "$W" > "$OUT/s2.show.out" 2>&1
    expect_eq "show exit" 0 "$?"
    grep -E '^(status|envelope sha256|report sha256):' "$OUT/s2.show.out" | sed 's/^/  /'
    expect_has "show status" "status: NO_CHANGES" "$OUT/s2.show.out"
    expect_has "show envelope sha256" \
      "envelope sha256: $(printf '%s' "$(cat "$OUT/s2.review.out")" | sha256sum | cut -c1-64)" "$OUT/s2.show.out"
    expect_has "show report sha256" "report sha256: $(fact "$facts" reportSha256)" "$OUT/s2.show.out"
    expect_eq "show human review list" "(none)" \
      "$(awk '/^人工待辦/ { getline; print; exit }' "$OUT/s2.show.out")"
    expect_lacks "show review artifacts" REVIEW_ARTIFACT_INVALID "$OUT/s2.show.out"
  fi
  finish
}

# BLOCKED／failed 的共同斷言：exit code、stderr 的錯誤代碼、stdout 沒有 envelope。
expect_stop() {  # $1=tag $2=exit $3=stderr prefix
  info "$1 exit=$RC stderr: $(grep -m1 -E '^(BLOCKED )?[A-Z_]+:' "$OUT/$1.err")"
  expect_eq "$1 exit" "$2" "$RC"
  expect_has "$1 stderr" "$3" "$OUT/$1.err"
  expect_eq "$1 stdout" "" "$(cat "$OUT/$1.out")"
}

scenario_N1() {
  begin "N1 candidate tree mismatch"
  local repo="$OUT/repos/n1" sha
  fixture "$repo"
  STATE="$OUT/state-n1"; CODEX="$OUT/bin/codex-edit"; rm -rf "$STATE"
  if start_attempt n1 "$repo" "在 src/math.ts 新增 multiply 函式，並新增 src/extra.ts"; then
    printf '\nEdited by the human after the attempt.\n' >> "$repo/README.md"
    git -C "$repo" add -A && git_commit "$repo" "human commit with an extra edit"
    sha="$(git -C "$repo" rev-parse HEAD)"
    review n1.review "$repo" "$W" --attempt "$A" --head "$sha" --json
    expect_stop n1.review 2 "BLOCKED CANDIDATE_TREE_MISMATCH:"
  fi
  finish
}

scenario_N2() {
  begin "N2 pre-existing dirty"
  local repo="$OUT/repos/n2" sha
  fixture "$repo"
  STATE="$OUT/state-n2"; CODEX="$OUT/bin/codex-edit"; rm -rf "$STATE"
  printf '\nUncommitted edit made before the attempt.\n' >> "$repo/README.md"
  if start_attempt n2 "$repo" "在 src/math.ts 新增 multiply 函式，並新增 src/extra.ts"; then
    git -C "$repo" add -A && git_commit "$repo" "human commit of everything"
    sha="$(git -C "$repo" rev-parse HEAD)"
    review n2.review "$repo" "$W" --attempt "$A" --head "$sha" --json
    expect_stop n2.review 2 "BLOCKED PRE_EXISTING_DIRTY:"
  fi
  finish
}

scenario_N3() {
  begin "N3 candidate not a full SHA"
  if [ -z "$S1_SHA" ]; then ERRS+=("S1 commit: expected available vs missing"); finish; return; fi
  STATE="$S1_STATE"; CODEX="$OUT/bin/codex-edit"
  review n3.head "$S1_REPO" "$S1_W" --attempt "$S1_A" --head HEAD --json
  expect_stop n3.head 2 "BLOCKED CANDIDATE_NOT_SHA:"
  review n3.short "$S1_REPO" "$S1_W" --attempt "$S1_A" --head "${S1_SHA:0:7}" --json
  expect_stop n3.short 2 "BLOCKED CANDIDATE_NOT_SHA:"
  finish
}

scenario_N4() {
  begin "N4 reviewer runner failed"
  if [ -z "$S1_SHA" ]; then ERRS+=("S1 commit: expected available vs missing"); finish; return; fi
  STATE="$S1_STATE"; CODEX="$OUT/bin/codex-edit"
  HARNESS_REVIEWER_IMAGE=reviewer:does-not-exist \
    review n4.review "$S1_REPO" "$S1_W" --attempt "$S1_A" --head "$S1_SHA" --json
  expect_stop n4.review 3 "REVIEW_RUNNER_FAILED:"
  expect_lacks "n4.review stderr" "BLOCKED" "$OUT/n4.review.err"
  expect_eq "review-work left behind" "" "$(ls -A "$STATE/review-work")"
  finish
}

# --- main -----------------------------------------------------------------

printf 'OUT=%s\nHARNESS_REVIEWER_IMAGE=%s (%s)\n' "$OUT" "$HARNESS_REVIEWER_IMAGE" "${IMAGE_ID:-not found}"
scenario_S1
scenario_S1_show
scenario_S1_repo
scenario_S2
scenario_N1
scenario_N2
scenario_N3
scenario_N4

printf '\ntotal=%s fail=%s\nOUT=%s\n' "$TOTAL" "$FAILS" "$OUT"
[ "$FAILS" -eq 0 ]
