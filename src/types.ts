// 核心型別：直接對應 agent-work-harness-design.md §6/§7/§13/§14/§15/§20/§22/§23/§24/§34.1

export type Mode = 'read' | 'write';

export type WorkState =
  | 'ACTIVE' | 'WAITING_USER' | 'RUNNING' | 'VERIFYING'
  | 'DONE' | 'BLOCKED' | 'FAILED';

export interface Work {
  id: string;
  title: string;
  repositoryId: string;
  workspace: string;
  state: WorkState;
  currentContractVersion: number;
  retryBudget: number;
  createdAt: string;
}

// §7
export interface WorkContract {
  id: string;
  workId: string;
  version: number;
  request: string;
  mode: Mode;
  constraints: string[];
  allowedPaths?: string[];   // §20.1 只有使用者明確限制時才存在
  deniedPaths: string[];
  successCriteria: string[]; // §7.1 semantic guidance only
  sourceMessageIds: string[];
  createdAt: string;
}

// §6.2
export type AttemptStatus =
  | 'CREATED' | 'RUNNING' | 'COMPLETED'
  | 'PROTOCOL_FAILED' | 'FAILED' | 'RECOVERY_REQUIRED';

export interface Attempt {
  id: string;
  workId: string;
  number: number;
  mode: Mode;
  contractVersion: number;
  contractSnapshotHash: string;  // §34.1.1 RepositoryContractSnapshot hash
  baseRevision: string;          // §36.2 C2
  preExistingDirty?: Array<{ path: string; hash: string | null }>;  // attempt 開始前就髒的檔案
  promptArtifactId: string;
  resultArtifactId?: string;
  runtime: 'codex';
  status: AttemptStatus;
  retryOf?: string;
  startedAt: string;
  endedAt?: string;
}

// §13
export type DecisionKind =
  | 'allow_path' | 'deny_path' | 'allow_change' | 'deny_change' | 'constraint';

export interface DecisionRecord {
  id: string;
  workId: string;
  sourceMessageId: string;
  kind: DecisionKind;
  value: string;
  createdAt: string;
}

// §14
export type ContextKind = 'control' | 'user_context' | 'decision' | 'pointer' | 'evidence';
export type Trust = 'authority' | 'trusted' | 'untrusted';

export interface ContextItem {
  id: string;
  kind: ContextKind;
  trust: Trust;
  source: string;
  priority: 0 | 1 | 2 | 3 | 4;  // §16 context budget
  content?: string;
  pointer?: string;
}

// §15
export interface ContextManifest {
  workId: string;
  attemptId: string;
  control: ContextItem[];
  userContext: ContextItem[];
  decisions: ContextItem[];
  pointers: ContextItem[];
  previousEvidence: ContextItem[];
}

// §20
export interface AttemptAuthority {
  filesystem: 'read-only' | 'workspace-write';
  writablePaths?: string[];
  deniedPaths: string[];
  network: 'deny';
}

// §34.1
export interface VerificationCheck {
  id: string;
  kind: 'test' | 'typecheck' | 'lint' | 'build' | 'custom';
  argv: string[];
  required: boolean;
  timeoutMs?: number;
}

export interface RepositoryContract {
  schemaVersion: '1';
  repositoryId: string;
  context: { entryPoints: string[] };
  filesystem: { protectedPaths: string[] };
  verification: { checks: VerificationCheck[] };
  skills?: string[];
}

// §34.1.1 frozen snapshot
export interface RepositoryContractSnapshot {
  contract: RepositoryContract;
  hash: string;
  loadedAt: string;
  sourcePath: string;
}

// §22
export type RuntimeStatus = 'completed' | 'needs_user_decision' | 'blocked' | 'failed';

export interface RuntimeClaim {
  type: 'finding' | 'diagnosis' | 'change' | 'verification' | 'limitation';
  text: string;
  relatedPaths?: string[];
}

export interface RuntimeQuestion {
  id: string;
  text: string;
  requestedAuthority?: string;
}

export interface RuntimeResult {
  schemaVersion: '1';
  workId: string;
  attemptId: string;
  status: RuntimeStatus;
  summary: string;
  claims: RuntimeClaim[];
  questions: RuntimeQuestion[];
  declaredChangedPaths: string[];
}

// §23.2
export type EvidenceType =
  | 'git_diff' | 'path_policy' | 'test_result'
  | 'typecheck_result' | 'build_result' | 'readback';

export interface EvidenceRecord {
  id: string;
  workId: string;
  attemptId: string;
  type: EvidenceType;
  label: string;
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  data: unknown;
  observedAt: string;
}

// §24
export type Outcome =
  | 'SUCCESS' | 'NEEDS_USER_DECISION' | 'RETRYABLE_FAILURE'
  | 'POLICY_VIOLATION' | 'BLOCKED' | 'FAILED';

export interface OutcomeDecision {
  outcome: Outcome;
  reasons: string[];
}

// §19.1
export interface ApprovedSkill {
  id: string;
  path: string;
  approvedHash: string;
  scriptsAllowed: boolean;
  externalRefsAllowed: boolean;
}

export interface SkillAdmission {
  skillId: string;
  allowed: boolean;
  reason: string;
  actualHash?: string;
  path?: string;   // registry 中登記的實際路徑（driver 由此複製）
}

// Harness global policy —— authority 來源之一（§36.2 C1），不可由 repo 提供
export interface GlobalPolicy {
  stateDir: string;
  agentHome: string;
  codexHome: string;
  verificationHome: string;
  readOnlyBinds: string[];   // verification sandbox 可讀的 toolchain 路徑
  skillsDir: string;
  defaultRetryBudget: number;
  defaultProtectedPaths: string[];
  codexBin: string;
  codexModel?: string;
  attemptTimeoutMs: number;
  verificationTimeoutMs: number;
  maxOutputBytes: number;
  promptBudgetChars: number;
}
