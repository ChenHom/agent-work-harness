# Calibration Human Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a complete, source-faithful Markdown review sheet for a human to approve, modify, or leave undecided for all 12 calibration cases.

**Architecture:** The review sheet is a read-only projection of `test/fixtures/evaluation/labels.jsonl`; it does not alter labels or provenance. Each case receives a stable section with the original criterion, artifact, proposed verdict, rationale, and an empty human-decision field. Human decisions arrive later through the conversation and are applied in a separate change.

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
