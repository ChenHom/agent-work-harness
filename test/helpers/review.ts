// Reviewer 原始報表的 fixture，形狀照 `node bin/review.js --out` 實際產生的結構（M1 規格 §4）。
// 路徑是 test/review.test.ts 預設 Attempt 的兩個變更（Harness 會比對報表的檔案與 base..candidate 的變更）；
// track 用 Reviewer 真正的 enum（src/routing.js 的 AUTO_PASS／AI_TRACK／ESCALATED）。

export type ReportKind = 'human' | 'not-selected' | 'no-changes';

interface FileSpec { path: string; human: boolean; reasons: string[] }

const FILES: Record<ReportKind, FileSpec[]> = {
  human: [
    { path: 'src/a.txt', human: true, reasons: ['PUBLIC_API_CHANGED'] },
    { path: 'src/new.txt', human: false, reasons: [] },
  ],
  'not-selected': [
    { path: 'src/a.txt', human: false, reasons: [] },
    { path: 'src/new.txt', human: false, reasons: [] },
  ],
  'no-changes': [],
};

export interface ReportFileFixture {
  path: string; status: string; contentHash: string; analyzed: boolean; decision: string; fallback: string | null;
  reasons: string[]; facts: unknown[]; changedLines: number[]; track: string; oneWayDoors: unknown[];
  findings: unknown[]; needsHuman: boolean; [key: string]: unknown;
}

export interface ReviewerReportFixture {
  repository: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  mergeBase: string;
  config: Record<string, unknown>;
  decision: { status: string; reasons: string[]; files: number; notSelected: number; targeted: number; full: number };
  routing: Record<string, unknown>;
  ai: unknown;
  human: { required: boolean; files: number; findings: number; pendingFixes: number };
  files: ReportFileFixture[];
  [key: string]: unknown;
}

export function reviewerReport(kind: ReportKind, ids: { base: string; head: string }): ReviewerReportFixture {
  return reviewerReportFor(FILES[kind], ids);
}

/** 任意檔案清單的一致報表（離線：選入人工的檔案 needsHuman 為 true、走 AI_TRACK）。 */
export function reviewerReportFor(specs: readonly FileSpec[], ids: { base: string; head: string }): ReviewerReportFixture {
  const files = specs.map((file) => ({
    path: file.path, status: 'M', contentHash: 'h'.repeat(64), analyzed: true,
    decision: file.human ? 'HUMAN_REVIEW_REQUIRED' : 'NOT_SELECTED_FOR_HUMAN_REVIEW',
    fallback: file.human ? 'FULL' : null, reasons: file.reasons, facts: [], changedLines: [1],
    track: file.human ? 'AI_TRACK' : 'AUTO_PASS', oneWayDoors: [], findings: [], needsHuman: file.human,
  }));
  const human = files.filter((file) => file.needsHuman).length;
  return {
    repository: 'repo',
    base: { ref: ids.base, sha: ids.base },
    head: { ref: ids.head, sha: ids.head },
    mergeBase: ids.base,
    config: { path: '.reviewer.json', commit: ids.head, status: 'MISSING', errors: [], digest: 'd'.repeat(64) },
    decision: {
      status: human ? 'HUMAN_REVIEW_REQUIRED' : 'NOT_SELECTED_FOR_HUMAN_REVIEW',
      reasons: files.length ? [...new Set(files.flatMap((file) => file.reasons))] : ['NO_CHANGES'],
      files: files.length, notSelected: files.length - human, targeted: 0, full: human,
    },
    routing: { track: human ? 'AI_TRACK' : 'AUTO_PASS', autoPass: files.length - human, aiTrack: human, escalated: 0 },
    ai: null,
    human: { required: human > 0, files: human, findings: 0, pendingFixes: 0 },
    files,
  };
}
