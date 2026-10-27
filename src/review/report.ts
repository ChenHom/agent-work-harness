// HR-02 子集：在交接邊界驗證 Reviewer 的原始 JSON，再包成 Harness 自己的 envelope（schemaVersion 1）。
// 純函式。任何缺欄位、型別不符或計數矛盾都是 REVIEW_REPORT_INVALID —— 不以預設值補齊，
// 也不猜 Reviewer 的意思（AGENTS 規則 1：無法解析的 evidence 永遠不能讀成通過）。

const HUMAN = 'HUMAN_REVIEW_REQUIRED';
const NOT_SELECTED = 'NOT_SELECTED_FOR_HUMAN_REVIEW';
const DECISIONS: readonly unknown[] = [HUMAN, NOT_SELECTED];

export const DEV01_LIMITATION = 'DEV-01: Reviewer fact layer is not wired; '
  + 'notSelected files were not selected by mechanical review only and are not verified safe';

export type ReviewStatus = 'NO_CHANGES' | 'NO_HUMAN_REVIEW' | 'HUMAN_REVIEW_REQUIRED';

export interface ReviewedFile { path: string; reasons: string[] }

export interface ValidatedReport {
  status: ReviewStatus;
  mergeBase: string;
  /** Reviewer 判定 needsHuman 的檔案（C7：照 Reviewer 的決策）。 */
  humanReview: ReviewedFile[];
  /** 其餘檔案：只代表機械審查未選入，不代表已驗證安全（DEV-01）。 */
  notSelected: ReviewedFile[];
}

export type ReportValidation = { ok: true; report: ValidatedReport } | { ok: false; reason: string };

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

/** 驗證 `node bin/review.js --out` 產生的報表，並確認它審的正是 baseRevision..candidate。 */
export function validateReviewerReport(
  text: string, expected: { baseRevision: string; candidate: string },
): ReportValidation {
  const fail = (reason: string): ReportValidation => ({ ok: false, reason });
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return fail('report is not valid JSON'); }

  if (!isObj(raw)) return fail('report is not an object');
  if (!isObj(raw.base) || raw.base.sha !== expected.baseRevision) return fail('base.sha does not match baseRevision');
  if (!isObj(raw.head) || raw.head.sha !== expected.candidate) return fail('head.sha does not match candidate');
  if (raw.mergeBase !== expected.baseRevision) return fail('mergeBase does not match baseRevision');

  const decision = raw.decision;
  if (!isObj(decision) || !DECISIONS.includes(decision.status)) return fail('decision.status is unknown');
  if (!isStrings(decision.reasons)) return fail('decision.reasons is not a string array');
  for (const key of ['files', 'notSelected', 'targeted', 'full']) {
    if (!isCount(decision[key])) return fail(`decision.${key} is not a non-negative integer`);
  }
  const counts = decision as Obj & Record<'files' | 'notSelected' | 'targeted' | 'full', number>;

  const files = raw.files;
  if (!Array.isArray(files)) return fail('files is not an array');
  if (counts.notSelected + counts.targeted + counts.full !== counts.files || counts.files !== files.length) {
    return fail('decision counts do not add up to files');
  }

  const seen = new Set<string>();
  const humanReview: ReviewedFile[] = [];
  const notSelected: ReviewedFile[] = [];
  let notSelectedDecisions = 0;
  for (const [index, file] of files.entries()) {
    const at = `files[${index}]`;
    if (!isObj(file)) return fail(`${at} is not an object`);
    if (typeof file.path !== 'string' || file.path === '') return fail(`${at}.path is not a non-empty string`);
    if (seen.has(file.path)) return fail(`${at}.path is a duplicate path`);
    seen.add(file.path);
    if (!DECISIONS.includes(file.decision)) return fail(`${at}.decision is unknown`);
    if (typeof file.needsHuman !== 'boolean') return fail(`${at}.needsHuman is not a boolean`);
    if (!isStrings(file.reasons)) return fail(`${at}.reasons is not a string array`);
    if (file.decision === NOT_SELECTED) notSelectedDecisions++;
    (file.needsHuman ? humanReview : notSelected).push({ path: file.path, reasons: [...file.reasons] });
  }
  if (notSelectedDecisions !== counts.notSelected) return fail('decision.notSelected does not match files');
  if ((decision.status === HUMAN) !== (counts.targeted + counts.full > 0)) {
    return fail('decision.status must be HUMAN_REVIEW_REQUIRED exactly when targeted + full > 0');
  }

  const human = raw.human;
  if (!isObj(human) || typeof human.required !== 'boolean') return fail('human.required is not a boolean');
  if (!isCount(human.files) || human.files !== humanReview.length) return fail('human.files does not match needsHuman files');
  if (human.pendingFixes !== 0) return fail('human.pendingFixes is not 0');
  if (human.required !== (human.files > 0)) return fail('human.required does not match human.files > 0');

  if (!('ai' in raw) || raw.ai !== null) return fail('ai must be null for an offline review');
  if (files.length === 0 && !decision.reasons.includes('NO_CHANGES')) {
    return fail('decision.reasons lacks NO_CHANGES for an empty file list');
  }

  const status: ReviewStatus = files.length === 0 ? 'NO_CHANGES' : human.required ? 'HUMAN_REVIEW_REQUIRED' : 'NO_HUMAN_REVIEW';
  return { ok: true, report: { status, mergeBase: raw.mergeBase, humanReview, notSelected } };
}

export interface ReviewVerificationSummary {
  /** 在哪個 revision 的乾淨副本上重跑。 */
  revision: string;
  /** Attempt 凍結的 Repository Contract 快照 hash。 */
  contractHash: string;
  /** baseRevision..candidate 的變更路徑數（path policy 重新評估的對象）。 */
  changedPaths: number;
  checks: Array<{
    checkId: string; required: boolean; status: string; exitCode: number | null;
    executed?: number; skipped?: number; reason?: string;
  }>;
}

export interface ReviewEnvelope {
  schemaVersion: 1;
  workId: string;
  attemptId: string;
  contractVersion: number;
  contractSnapshotHash: string;
  /** 只供顯示，不當 identity。 */
  workspace: string;
  baseRevision: string;
  candidate: string;
  mergeBase: string;
  resultTree: string;
  reviewer: { imageId: string; revision: string };
  rawReport: { sha256: string; artifactId: string };
  status: ReviewStatus;
  humanReview: ReviewedFile[];
  notSelected: ReviewedFile[];
  limitations: string[];
  verification: ReviewVerificationSummary;
  createdAt: string;
}

export function buildReviewEnvelope(
  input: Omit<ReviewEnvelope, 'schemaVersion' | 'mergeBase' | 'status' | 'humanReview' | 'notSelected' | 'limitations' | 'createdAt'>,
  report: ValidatedReport,
  createdAt: string,
): ReviewEnvelope {
  return {
    schemaVersion: 1, ...input, mergeBase: report.mergeBase, status: report.status,
    humanReview: report.humanReview, notSelected: report.notSelected,
    limitations: [DEV01_LIMITATION], createdAt,
  };
}

/** A3：有人工待辦是 5（不算失敗，也不算完成）；其餘有效結果是 0。 */
export function reviewExitCode(status: ReviewStatus): 0 | 5 {
  return status === 'HUMAN_REVIEW_REQUIRED' ? 5 : 0;
}
