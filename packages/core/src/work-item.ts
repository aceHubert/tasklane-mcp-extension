import { BoardError } from './errors.js';

export const TASK_STATUSES = ['backlog', 'ready', 'doing', 'review', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ASSIGNEES = ['human', 'agent'] as const;
export type Assignee = (typeof ASSIGNEES)[number];

/** Agent 执行状态（区别于任务业务状态） */
export const EXECUTION_STATES = [
  'idle',
  'assigned',
  'starting',
  'running',
  'waiting',
  'blocked',
  'failed',
  'completed',
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export interface Execution {
  state: ExecutionState;
  /** 短摘要，如 "Editing 3 files"；Sidebar 展示用，禁止塞 terminal log */
  activity?: string;
  /** 旧内部标识，不代表宿主聊天，不再生成新值 */
  sessionId?: string;
  runId?: string;
  startedAt?: string;
  updatedAt?: string;
}

export type ExecutionAction = 'start' | 'reply' | 'continue' | 'retry';
export const EXECUTION_MODEL_MAX_LENGTH = 128;
export const EXECUTION_MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;
export type WorkspaceMode = 'project' | 'worktree' | 'existing';
export type WorkspaceOwner = 'codex' | 'tasklane' | 'user';
export type ExecutionReportState = 'running' | 'waiting' | 'blocked' | 'failed' | 'completed';
export type ExecutionRequestStatus =
  | 'pending' | 'delivered' | 'claimed' | 'created' | 'bound'
  | 'running' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'uncertain' | 'rejected' | 'cancelled';

export interface ExecutionResult {
  threadId: string;
  hostId: string;
  workspacePath: string;
  workspaceOwner: WorkspaceOwner;
  branch?: string;
}

export interface ExecutionBinding extends ExecutionResult {
  provider: 'codex-desktop';
  boundAt: string;
}

export interface ExecutionRequest {
  requestId: string;
  runId: string;
  taskId: string;
  boardId: string;
  action: ExecutionAction;
  workspaceMode: WorkspaceMode;
  /** 请求创建时的路由提示；认领不能改写，省略时由接收 Agent 核对。 */
  hostId?: string;
  receiverThreadId?: string;
  /** 认领时核对的真实接收者，区别于执行结果中的目标聊天。 */
  receiver?: { hostId: string; threadId: string };
  repo: string;
  message?: string;
  /** 创建时的模型 ID；阻塞后的继续请求继承原模型，其他后续请求不覆盖。 */
  model?: string;
  status: ExecutionRequestStatus;
  requestedAt: string;
  updatedAt: string;
  claimId?: string;
  result?: ExecutionResult;
  startedAt?: string;
  reports?: { reportId: string; state: ExecutionReportState; activity?: string }[];
  deliveryError?: string;
  /** 人工确认旧宿主操作停止后解除等待，不是原生停止回执。 */
  recovery?: { at: string; reason: string; confirmedStopped: true; checkId: string };
  recoveryCheck?: ExecutionRecoveryCheck;
  /** 新轮复用已创建结果的来源，禁止再次创建聊天。 */
  recoveryOf?: { requestId: string; runId: string };
}

export interface ExecutionThreadObservation {
  threadId: string;
  hostId: string;
  state: 'active' | 'idle' | 'waiting' | 'unknown';
  observedAt: string;
  /** 核对消息会激活当前聊天，此字段仅用于当前核对 Agent 确认上一操作已经结束。 */
  priorOperationEnded?: boolean;
}

export interface ExecutionRecoveryCheck {
  checkId: string;
  /** status 仅核对与补回执，不授权解除请求；缺省保持旧恢复语义。 */
  purpose?: 'status' | 'recovery';
  status: 'pending' | 'busy' | 'unknown' | 'resumed' | 'recovered';
  requestedAt: string;
  observedStatus: ExecutionRequestStatus;
  observedUpdatedAt: string;
  checkedAt?: string;
  message?: string;
  checker?: { threadId: string; hostId: string };
  observations?: ExecutionThreadObservation[];
}

export interface RequestExecutionRecoveryInput {
  id: string;
  boardId: string;
  requestId: string;
  runId: string;
  checkId: string;
  purpose?: 'status' | 'recovery';
}

export interface ExecutionRecoveryInput extends RequestExecutionRecoveryInput {
  checkerThreadId: string;
  hostId: string;
  outcome: 'busy' | 'unknown' | 'resumed' | 'stopped';
  message: string;
  confirmedStopped?: true;
  observations: ExecutionThreadObservation[];
}

export interface RequestExecutionInput {
  id: string;
  boardId: string;
  requestId: string;
  action: ExecutionAction;
  workspaceMode: WorkspaceMode;
  hostId?: string;
  receiverThreadId?: string;
  message?: string;
  model?: string;
}

export interface ExecutionDeliveryInput {
  id: string;
  boardId: string;
  requestId: string;
  runId: string;
  status: 'delivered' | 'uncertain' | 'blocked' | 'rejected';
  error?: string;
  /** 接收 Agent 认领后拒绝、阻塞或报告未知时必须匹配原认领。 */
  claimId?: string;
}

export interface ClaimExecutionInput {
  id: string;
  boardId: string;
  requestId: string;
  runId: string;
  claimId: string;
  /** 真实接收者，必须同时提供；旧请求可沿用原路由提示。 */
  hostId?: string;
  receiverThreadId?: string;
}

export interface BindExecutionInput extends Omit<ClaimExecutionInput, 'hostId'>, ExecutionResult {
  phase: 'created' | 'bound';
}

export interface ReportExecutionInput {
  id: string;
  boardId: string;
  requestId: string;
  runId: string;
  threadId: string;
  hostId: string;
  reportId: string;
  state: ExecutionReportState;
  activity?: string;
}

export interface FileChange {
  name: string;
  added: number;
  removed: number;
}

export interface ChangeSummary {
  filesChanged: number;
  additions: number;
  deletions: number;
  testStatus: 'unknown' | 'passing' | 'failing';
  files: FileChange[];
}

export interface WorkItem {
  id: string;
  /** 所属看板 ID（持久化归属字段；创建后本轮不允许修改） */
  boardId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: Priority;
  assignee: Assignee;
  repo?: string;
  baseBranch?: string;
  branch?: string;
  worktreePath?: string;
  execution: Execution;
  executionBinding?: ExecutionBinding;
  executionRequests?: ExecutionRequest[];
  changes?: ChangeSummary;
  createdAt: string;
  updatedAt: string;
  /**
   * 归档时间（ISO，服务端生成）：设置后任务从日常看板与状态计数移出，
   * 仍保持 status: done，内容、执行记录与 Git 绑定保留；恢复时移除该字段。
   */
  archivedAt?: string;
}

export interface Board {
  id: string;
  name: string;
  /** 本地仓库绝对路径；为空时 git 能力降级关闭 */
  repo?: string | null;
  baseBranch?: string;
  /**
   * 仓库身份键（git common dir 绝对路径）：同一主仓库的子目录、符号链接与
   * worktree 共享同一键，用于注册去重。旧看板可能缺失，注册时回填。
   */
  repoKey?: string | null;
}

export interface BoardSummary extends Board {
  /** 各状态计数（仅未归档任务） */
  counts: Record<TaskStatus, number>;
  /** 未归档任务总数 */
  total: number;
  /** 已归档任务数量（不参与 counts / total） */
  archivedCount: number;
}

export function assertStatus(value: string): asserts value is TaskStatus {
  if (!(TASK_STATUSES as readonly string[]).includes(value)) {
    throw new BoardError('VALIDATION', `非法 status: ${value}，允许值: ${TASK_STATUSES.join(' / ')}`);
  }
}

export function assertPriority(value: string): asserts value is Priority {
  if (!(PRIORITIES as readonly string[]).includes(value)) {
    throw new BoardError('VALIDATION', `非法 priority: ${value}，允许值: ${PRIORITIES.join(' / ')}`);
  }
}

export function assertAssignee(value: string): asserts value is Assignee {
  if (!(ASSIGNEES as readonly string[]).includes(value)) {
    throw new BoardError('VALIDATION', `非法 assignee: ${value}，允许值: ${ASSIGNEES.join(' / ')}`);
  }
}

export function assertExecutionState(value: string): asserts value is ExecutionState {
  if (!(EXECUTION_STATES as readonly string[]).includes(value)) {
    throw new BoardError('VALIDATION', `非法 execution.state: ${value}，允许值: ${EXECUTION_STATES.join(' / ')}`);
  }
}

export function normalizeTaskId(id: string): string {
  return id.trim().toUpperCase();
}
