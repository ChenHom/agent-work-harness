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

export type AttemptPhase = 'preparing' | 'dispatch_intent' | 'executing' | 'collecting' | 'terminal';

export interface AttemptOutputRefs {
  stdoutArtifactId: string;
  stderrArtifactId?: string;
  rawResultArtifactId: string;
  parsedResultArtifactId?: string;
}

export interface AttemptInputSnapshot {
  schemaVersion: '2';
  workId: string;
  attemptId: string;
  contract: WorkContract;
  repository: RepositoryContractSnapshot;
  authority: AttemptAuthority;
  manifest: ContextManifest;
  compilerVersion: string;
  promptArtifactId: string;
  admittedSkills: Array<{ skillId: string; actualHash: string }>;
  executionConfig: {
    runtime: 'codex';
    model?: string;
    attemptTimeoutMs: number;
    verificationTimeoutMs: number;
    maxOutputBytes: number;
    promptBudgetChars: number;
  };
}

export interface Attempt {
  id: string;
  workId: string;
  planId?: string;
  branchId?: string;
  milestoneId?: string;
  number: number;
  mode: Mode;
  contractVersion: number;
  contractSnapshotHash: string;  // §34.1.1 RepositoryContractSnapshot hash
  baseRevision: string;          // §36.2 C2
  preExistingDirty?: Array<{ path: string; hash: string | null }>;  // attempt 開始前就髒的檔案
  baseline?: VerificationBaseline[];                                 // pre-flight baseline（write attempt）
  contextDropped?: Array<{ priority: number; count: number }>;      // prompt budget 裁切統計
  promptArtifactId: string;
  resultArtifactId?: string;
  inputSnapshotArtifactId?: string;
  outputRefs?: AttemptOutputRefs;
  phase?: AttemptPhase;
  runtimeDispatch?: {
    intentAt: string;
    ownershipToken: string;
    state?: 'launching' | 'running' | 'stopped' | 'unknown';
    child?: { pid: number; processStart: string };
  };
  failureReason?: string;
  runtime: 'codex';
  status: AttemptStatus;
  retryOf?: string;
  startedAt: string;
  endedAt?: string;
}

export type RecoverySessionStatus =
  | 'OBSERVED' | 'POLICY_DENIED' | 'SNAPSHOT_UNAVAILABLE' | 'ARTIFACT_CORRUPT';

export interface RecoverySession {
  id: string;
  workId: string;
  attemptId: string;
  observedAt: string;
  evidenceIds: string[];
  reason: string;
  status: RecoverySessionStatus;
}

type PlanStatus = 'PROPOSED' | 'VALIDATED' | 'ACTIVE' | 'SUPERSEDED' | 'COMPLETED' | 'REJECTED';

export interface WorkPlan {
  id: string;
  workId: string;
  version: number;
  branchId: string;
  parentPlanId?: string;
  contractVersion: number;
  reason: string;
  changedMilestoneIds: string[];
  dependencyImpact: string[];
  reusableArtifactIds: string[];
  sourceCheckpointId?: string;
  validationEvidenceIds: string[];
  status: PlanStatus;
  createdAt: string;
  activatedAt?: string;
}

type MilestoneStatus = 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'STALE' | 'BLOCKED';

export interface PlanMilestone {
  id: string;
  planId: string;
  sequence: number;
  objective: string;
  acceptanceCriterionIds: string[];
  dependsOn: string[];
  required: boolean;
  status: MilestoneStatus;
  completedAttemptId?: string;
  staleReason?: string;
}

interface CheckpointArtifact {
  artifactId: string;
  hash: string;
  logicalName: string;
  producerMilestoneId?: string;
}

export interface LogicalCheckpoint {
  schemaVersion: '1';
  id: string;
  workId: string;
  parentCheckpointId?: string;
  planId: string;
  branchId: string;
  contractVersion: number;
  milestoneId?: string;
  artifactManifest: CheckpointArtifact[];
  validationStatus: 'pending_validation' | 'validated' | 'invalid';
  validationEvidenceIds: string[];
  createdEventSeq: number;
  createdAt: string;
}

type OperationStatus =
  | 'PREPARED' | 'DISPATCHED' | 'SUCCEEDED' | 'FAILED'
  | 'UNKNOWN' | 'RECONCILING' | 'WAITING_USER';

export interface AdapterCapabilitySnapshot {
  adapter: string;
  version: string;
  effectType: 'read' | 'write';
  retrySafety: 'idempotent' | 'deduplicated' | 'unsafe';
  reversibility: 'compensable' | 'irreversible';
  lookup: 'supported' | 'unsupported';
  postcondition: string;
  upperBoundSupport: 'supported' | 'unsupported';
  idempotencyKeyTtlMs: number;
  completionWindowMs: number;
  cost: {
    mode: 'bounded' | 'estimated' | 'unknown';
    resourceKind: string;
    currency?: string;
    upperBoundUnits?: number;
    pricingVersion?: string;
  };
}

export interface Operation {
  schemaVersion: '1';
  id: string;
  workId: string;
  intentKey: string;
  kind: string;
  targetScope: string;
  canonicalInputHash: string;
  inputArtifactId: string;
  idempotencyKey: string;
  dedupeExpiresAt: string;
  precondition: string;
  reconciliationStrategy: string;
  compensationPolicy: string;
  authorizationRef: string;
  capabilities: AdapterCapabilitySnapshot;
  reservationId?: string;
  lastReconciliationArtifactId?: string;
  manualReason?: string;
  status: OperationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OperationAttempt {
  id: string;
  operationId: string;
  number: number;
  status: 'DISPATCHED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  dispatchedAt: string;
  completedAt?: string;
  receiptArtifactId?: string;
  error?: string;
}

export interface Compensation {
  schemaVersion: '1';
  id: string;
  operationId: string;
  workId: string;
  idempotencyKey: string;
  authorizationRef: string;
  resourceIdentity: string;
  ownershipRef: string;
  targetVersion: string;
  reservationId?: string;
  lastReconciliationArtifactId?: string;
  manualReason?: string;
  status: OperationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CompensationAttempt {
  id: string;
  compensationId: string;
  number: number;
  status: 'DISPATCHED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  dispatchedAt: string;
  completedAt?: string;
  receiptArtifactId?: string;
  error?: string;
}

export interface BudgetLimit {
  id: string;
  workId: string;
  resourceKind: string;
  currency?: string;
  limitUnits: number;
  pricingVersion: string;
  createdAt: string;
}

export interface BudgetReservation {
  id: string;
  workId: string;
  limitId: string;
  operationId?: string;
  compensationId?: string;
  amountUnits: number;
  settledUnits?: number;
  status: 'HELD' | 'SETTLED' | 'RELEASED' | 'UNKNOWN';
  createdAt: string;
  updatedAt: string;
}

export interface BudgetLedgerEntry {
  id: string;
  workId: string;
  limitId: string;
  reservationId: string;
  kind: 'RESERVE' | 'SETTLE' | 'RELEASE';
  reservedDeltaUnits: number;
  spentDeltaUnits: number;
  createdAt: string;
}

// §13
type DecisionKind =
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
type ContextKind = 'control' | 'user_context' | 'decision' | 'pointer' | 'evidence';
type Trust = 'authority' | 'trusted' | 'untrusted';

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
type RuntimeStatus = 'completed' | 'needs_user_decision' | 'blocked' | 'failed';

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

/**
 * pre-flight baseline：attempt 開始前、agent 動手之前的同一組 check 結果。
 * 只用來回答一件事 —— 這次有沒有比 agent 動手前變差或少跑。
 */
export interface VerificationBaseline {
  checkId: string;
  exitCode: number | null;
  executed?: number;
  skipped?: number;
}

/** verification evidence 的 data 形狀（原本是 inline cast，收斂成型別）。 */
export interface VerificationEvidenceData {
  checkId: string;
  kind: VerificationCheck['kind'];
  argv: string[];
  required: boolean;
  // 綁定觀察對象：這份 evidence 驗的是哪個 revision、哪一份驗收規則
  baseRevision: string;
  headRevision: string;
  contractHash: string;
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
  tail: string;
  executed?: number;
  skipped?: number;
  baseline?: VerificationBaseline;
  reason?: string;
}

// §23.2
type EvidenceType =
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
