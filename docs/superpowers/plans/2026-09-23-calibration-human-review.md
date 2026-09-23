# Calibration Human Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a complete Traditional Chinese Markdown review sheet for a human to approve, modify, or leave undecided for all 12 calibration cases.

**Architecture:** The review sheet is a read-only projection of `test/fixtures/evaluation/labels.jsonl`; it does not alter labels or provenance. Human-facing descriptions use Traditional Chinese while stable IDs, code, filenames, commands, and schema values remain unchanged. Human decisions arrive later through the conversation and are applied in a separate change.

**Tech Stack:** Markdown, JSONL fixtures, ripgrep, Git.

---

### Task 1: Create the 12-case review sheet

**Files:**
- Read: `test/fixtures/evaluation/labels.jsonl`
- Create: `docs/calibration-review-2026-09-23.1.md`

- [x] **Step 1: Add the review instructions and authority warning**

Create the document with corpus version `2026-09-23.1`, explain that the reviewer may answer `核准`, `修改`, or `無法確認`, and state explicitly that generating the sheet does not change provenance.

- [x] **Step 2: Add every source case in JSONL order**

Add exactly these case IDs in this order:

```text
code-01 code-02 code-03 code-04 code-05
doc-01 doc-02 doc-03 doc-04
cfg-01 cfg-02 cfg-03
```

For each case copy these source values without paraphrasing:

```text
taskType
criterion.description
artifactText
expected
rationale
```

End every case with:

```markdown
**人工決定：** 尚未審閱

**人工備註：** —
```

- [x] **Step 3: Explain how the reviewer responds**

End the document with these accepted response forms:

```text
12 筆全部核准
code-03：修改為 pass；理由：人工確認 artifact 已包含要求的 guard 與測試證據
doc-02：無法確認；原因：artifact 沒有提供可核對的 README 內容
```

State that `無法確認` keeps the case unapproved and does not promote its provenance.

### Task 2: Verify source fidelity and commit

**Files:**
- Verify: `test/fixtures/evaluation/labels.jsonl`
- Verify: `docs/calibration-review-2026-09-23.1.md`

- [x] **Step 1: Verify all case IDs appear exactly once**

Run:

```bash
for id in code-01 code-02 code-03 code-04 code-05 doc-01 doc-02 doc-03 doc-04 cfg-01 cfg-02 cfg-03; do
  test "$(rg -c "^## $id$" docs/calibration-review-2026-09-23.1.md)" -eq 1 || exit 1
done
```

Expected: exit 0 with no output.

- [x] **Step 2: Verify the sheet has 12 undecided human decisions**

Run:

```bash
test "$(rg -c '^\*\*人工決定：\*\* 尚未審閱$' docs/calibration-review-2026-09-23.1.md)" -eq 12
```

Expected: exit 0 with no output.

- [x] **Step 3: Compare the criterion, artifact, verdict, and rationale against every JSONL row**

Run:

```bash
node --input-type=module --eval '
  import { readFileSync } from "node:fs";
  const rows = readFileSync("test/fixtures/evaluation/labels.jsonl", "utf8").trim().split("\n").map(JSON.parse);
  const doc = readFileSync("docs/calibration-review-2026-09-23.1.md", "utf8");
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const start = doc.indexOf(`## ${row.caseId}\n`);
    const end = index + 1 < rows.length ? doc.indexOf(`## ${rows[index + 1].caseId}\n`) : doc.length;
    if (start < 0 || end < 0) throw new Error(`missing section ${row.caseId}`);
    const section = doc.slice(start, end);
    for (const value of [row.taskType, row.criterion.description, row.artifactText, row.expected, row.rationale]) {
      if (!section.includes(value)) throw new Error(`source mismatch ${row.caseId}: ${value}`);
    }
  }
'
```

Expected: exit 0 with no output. Any mismatch is a documentation defect: correct the Markdown; never change the fixture to make the comparison pass.

- [x] **Step 4: Run repository document checks**

Run:

```bash
git diff --check
```

Expected: exit 0 with no output. Confirm that every relative Markdown link introduced by the sheet resolves; the planned sheet introduces none.

- [x] **Step 5: Commit the review sheet (`d9dba61`)**

Run:

```bash
git add docs/calibration-review-2026-09-23.1.md docs/superpowers/plans/2026-09-23-calibration-human-review.md
git commit -m "docs: prepare calibration label human review"
```

The commit body records that this is review material only and does not establish `human-review` provenance.

### Task 3: Hand off without changing authority

**Files:**
- Read: `docs/calibration-review-2026-09-23.1.md`

- [x] **Step 1: Give the user the absolute clickable path**

Use:

```text
/home/hom/code/harness/.worktrees/five-wave-hardening/docs/calibration-review-2026-09-23.1.md
```

- [x] **Step 2: Stop before editing the fixture**

Do not modify `test/fixtures/evaluation/labels.jsonl`, the follow-up checkbox, or acceptance evidence until the user supplies explicit human decisions for the cases.

### Task 4: Localize the review sheet to Traditional Chinese

**Files:**
- Modify: `docs/calibration-review-2026-09-23.1.md`
- Modify: `docs/superpowers/specs/2026-09-23-calibration-human-review-design.md`

- [x] **Step 1: Translate human-facing content**

Translate instructions, task types, criteria, artifact descriptions, verdict labels, rationales, and response examples into Traditional Chinese. Preserve case IDs, code, filenames, commands, and `pass`／`fail` schema values.

- [x] **Step 2: Preserve the authority boundary**

Keep all 12 decisions at `尚未審閱`; do not modify `test/fixtures/evaluation/labels.jsonl` or claim `human-review` provenance. An unable-to-confirm decision must be explicit and include a reason; it never becomes a blank or `unknown` fixture value.

- [x] **Step 3: Verify localized structure and repository cleanliness**

Confirm all 12 case IDs occur once, all 12 decisions remain undecided, the proposed verdict mapping remains 5 `pass` and 7 `fail`, and `git diff --check` exits 0.

### Task 5: Apply explicit human decisions to a new corpus version

**Files:**
- Modify: `test/fixtures/evaluation/labels.jsonl`
- Modify: `test/calibration.test.ts`
- Modify: `docs/calibration-review-2026-09-23.1.md`
- Modify: `docs/acceptance.md`
- Modify: `docs/runbooks/evaluation-retention.md`
- Modify: `docs/superpowers/plans/2026-09-23-review-followups.md`

- [x] **Step 1: Parse and validate all human decisions**

Normalize decision casing and confirm all 12 entries are explicit `pass`／`fail`, none are blank or unable to confirm, and every decision matches its proposed verdict.

- [x] **Step 2: Require human-reviewed provenance in the calibration test**

Update the corpus test to require version `2026-09-23.2`, `source: human-review`, `author: workspace-owner`, and the review date. Run it before updating the fixture and confirm it fails.

- [x] **Step 3: Apply provenance without rewriting approved labels**

Keep every criterion, artifact, expected verdict, and rationale unchanged; bump `corpusVersion` to `2026-09-23.2` and set the reviewed provenance on all 12 cases. Preserve the two additional human notes in the review record.

- [x] **Step 4: Update current documentation**

Record the reviewed corpus version and evidence, and mark the human-review follow-up complete without changing the offsite-backup limitation.

- [x] **Step 5: Verify calibration and the complete repository gate**

Run the calibration tests, validate the review-to-fixture mapping, run `npm run check`, and commit only after all checks pass.
