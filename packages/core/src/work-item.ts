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
/**
 * 工作方式：project = 在看板项目目录执行（Git 主仓库或非 Git 目录）；
 * worktree = 由 Codex 新建独立 worktree（仅 Git 项目可用）；
 * existing = 原样复用已记录的旧工作区；
 * projectless = 不归属任何项目目录的无项目执行（仅无项目看板可用，
 * 原生创建使用 create_thread target {type:'projectless'}，不传 projectId）。
 */
export type WorkspaceMode = 'project' | 'worktree' | 'existing' | 'projectless';
export type WorkspaceOwner = 'codex' | 'tasklane' | 'user';
export type ExecutionReportState = 'running' | 'waiting' | 'blocked' | 'failed' | 'completed';
export type ExecutionRequestStatus =
  | 'pending' | 'delivered' | 'claimed' | 'created' | 'bound'
  | 'running' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'uncertain' | 'rejected' | 'cancelled';

/**
 * 执行目的：implementation 指向任务实现（execution / executionBinding），
 * review 指向独立验收会话（reviewExecution / reviewBinding）。
 * 两者共用 request / claim / bind / report 协议，但永不共用会话与执行状态。
 */
export type ExecutionPurpose = 'implementation' | 'review';

/**
 * 原生执行的实际结果。workspacePath / workspaceOwner 在 projectless 执行
 * 早期可能尚未确定（目标聊天尚未核验实际目录）：两者必须成对出现或成对缺省，
 * 缺省时明确表达"尚未确定"，不伪造路径；后续补充必须匹配原绑定与执行代次。
 */
export interface ExecutionResult {
  threadId: string;
  hostId: string;
  workspacePath?: string;
  workspaceOwner?: WorkspaceOwner;
  branch?: string;
}

export interface ExecutionBinding extends ExecutionResult {
  provider: 'codex-desktop';
  boundAt: string;
}

/**
 * Review / Recheck 的 Codex 原生绑定：与 executionBinding 结构一致但语义独立。
 * 必须满足 reviewBinding.threadId != executionBinding.threadId（同一聊天不能
 * 同时充当实现与验收），且 workspacePath 等于实现实际发生修改的工作区。
 */
export interface ReviewBinding extends ExecutionResult {
  provider: 'codex-desktop';
  boundAt: string;
}

/** 非 Codex 实现会话的工作区归属（区别于 Codex 绑定的 WorkspaceOwner） */
export type ExternalWorkspaceOwner = 'user' | 'tasklane' | 'agent';

/**
 * 非 Codex Agent 的实现会话记录：sessionId 是 provider 自己的 opaque 标识，
 * 不得解释、转换或冒充 Codex threadId，也不产生 codex:// 深链或原生续接调用。
 * 该对象只说明「谁在哪个工作区执行过」，不证明当前正在运行。
 */
export interface ExternalExecutionSession {
  provider: string;
  sessionId: string;
  workspacePath: string;
  workspaceOwner: ExternalWorkspaceOwner;
  branch?: string;
  boundAt: string;
  updatedAt: string;
}

/** Review 工作流状态（与 Task.status 业务列分离，返工不移动看板列） */
export const REVIEW_STATUSES = [
  'pending',
  'reviewing',
  'changes_requested',
  'fixing',
  'recheck_pending',
  'approved',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** 允许通过 task_review_update 显式提交的状态（reviewing/fixing 须有真实 running 回执） */
export const REVIEW_UPDATE_STATUSES = ['reviewing', 'changes_requested', 'fixing', 'recheck_pending', 'approved'] as const;
export type ReviewUpdateStatus = (typeof REVIEW_UPDATE_STATUSES)[number];

/** Review 更新者审计信息：sessionId 是元数据，不是执行绑定，也不是 Codex thread */
export interface ReviewActor {
  type: 'human' | 'agent';
  provider?: string;
  sessionId?: string;
}

export interface ReviewUpdate {
  id: string;
  at: string;
  status: ReviewStatus;
  conclusion?: string;
  actor?: ReviewActor;
}

/** 每一次真正开始验收形成一轮；新一轮不覆盖旧轮结论 */
export interface ReviewRound {
  id: string;
  number: number;
  status: 'reviewing' | 'changes_requested' | 'approved';
  workspacePath: string;
  conclusion?: string;
  startedAt: string;
  completedAt?: string;
  updates: ReviewUpdate[];
}

/** 任务的结构化 Review 状态；revision 用于跨 Agent CAS 更新 */
export interface TaskReview {
  status: ReviewStatus;
  revision: number;
  activeRoundId?: string;
  rounds: ReviewRound[];
  updatedAt: string;
}

export const REVIEW_CONCLUSION_MAX_LENGTH = 20_000;

export interface ExecutionRequest {
  requestId: string;
  runId: string;
  taskId: string;
  boardId: string;
  /** 执行目的：写 implementation 或 review 的执行状态，回执按此分流（v5 迁移补 implementation） */
  purpose: ExecutionPurpose;
  action: ExecutionAction;
  workspaceMode: WorkspaceMode;
  /** 请求创建时的路由提示；认领不能改写，省略时由接收 Agent 核对。 */
  hostId?: string;
  receiverThreadId?: string;
  /** 认领时核对的真实接收者，区别于执行结果中的目标聊天。 */
  receiver?: { hostId: string; threadId: string };
  /**
   * 请求创建时的仓库/项目上下文：Git 看板为仓库根或项目目录，
   * 非 Git 项目看板为项目目录，projectless 请求为 null。
   */
  repo: string | null;
  /** review 请求由服务端解析的实现工作区（不可由调用者指定）；实现请求不带该字段 */
  workspacePath?: string;
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
  /** 人工确认旧宿主操作停止后解除等待（UI 专属操作），不是原生停止回执。 */
  recovery?: { at: string; reason: string; confirmedStopped: true; releasedBy?: 'user' };
  /** 新轮复用已创建结果的来源，禁止再次创建聊天。 */
  recoveryOf?: { requestId: string; runId: string };
}

/**
 * task_execution_recover（app-only）入参：用户在 UI 显式确认旧会话已结束后，
 * 解除仍在等待宿主回执的执行请求。观测者就是用户本人，不要求核对 Agent 举证。
 */
export interface ReleaseExecutionInput {
  id: string;
  boardId: string;
  requestId: string;
  runId: string;
  /** 解除原因（必填非空，持久化到 recovery 记录与时间线） */
  reason: string;
}

export interface RequestExecutionInput {
  id: string;
  boardId: string;
  requestId: string;
  action: ExecutionAction;
  workspaceMode: WorkspaceMode;
  /** 省略按 implementation；review 请求由 UI / skill 显式提供 */
  purpose?: ExecutionPurpose;
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

/** 非 Codex 实现会话记录入参；force 用于显式替换已有会话记录 */
export interface BindExternalSessionInput {
  id: string;
  boardId: string;
  provider: string;
  sessionId: string;
  workspacePath: string;
  workspaceOwner: ExternalWorkspaceOwner;
  branch?: string;
  force?: boolean;
}

/** task_review_update 入参：expectedRevision CAS 防止跨 Agent 静默覆盖 */
export interface ReviewUpdateInput {
  id: string;
  boardId: string;
  expectedRevision: number;
  status: ReviewUpdateStatus;
  conclusion?: string;
  actor?: ReviewActor;
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
  /** 独立 Review 执行状态：与 implementation execution 分离，各自持有 runId */
  reviewExecution?: Execution;
  /** 独立 Review / Recheck 的 Codex 原生绑定；线程不得与 executionBinding 相同 */
  reviewBinding?: ReviewBinding;
  /** 非 Codex 实现会话记录（provider-local sessionId，禁止解释为 threadId） */
  externalExecutionSession?: ExternalExecutionSession;
  /** 结构化 Review 工作流（状态轮次与结论）；status=review 时读取侧惰性初始化为 pending */
  review?: TaskReview;
  changes?: ChangeSummary;
  /** 截止时间（UTC ISO，服务端规范化）：为空表示未设置；未完成任务按其升序排列 */
  deadline?: string;
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
  /**
   * 本地 Git 仓库绝对路径（最近一次能力刷新核验的主仓库根）；
   * 为空时 Git 能力降级关闭。非 Git 项目与无项目看板为空。
   */
  repo?: string | null;
  baseBranch?: string;
  /**
   * 仓库身份键（git common dir 绝对路径）：同一主仓库的子目录、符号链接与
   * worktree 共享同一键，用于注册去重与 Git 能力判断。旧看板可能缺失，注册时回填；
   * 非 Git 项目与无项目看板为空（目录后续初始化 Git 后由能力刷新采纳）。
   */
  repoKey?: string | null;
  /**
   * 项目目录绝对路径（realPath 规范化）：非 Git 项目的注册去重键；
   * Git 项目等于主仓库根（与 repo 一致）。无项目看板（default）为空。
   * 项目目录身份与 Git 仓库身份分别表达，不互相伪造。
   */
  projectDir?: string | null;
  /**
   * Git 能力刷新发现的身份冲突说明（如目录初始化 Git 后与已有看板同仓库）：
   * 仅提示用，不自动合并看板或迁移任务；冲突解除后清除。
   */
  repoConflict?: string | null;
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

export function assertReviewStatus(value: string): asserts value is ReviewStatus {
  if (!(REVIEW_STATUSES as readonly string[]).includes(value)) {
    throw new BoardError('VALIDATION', `非法 review.status: ${value}，允许值: ${REVIEW_STATUSES.join(' / ')}`);
  }
}

/** deadline 输入的严格语法：日期必填；时间/秒/毫秒/时区偏移可选（空格或 T 分隔） */
const DEADLINE_INPUT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return MONTH_DAYS[month - 1];
}

/**
 * 严格解析 deadline 输入，返回 UTC Date；非法返回 null。
 * 与 new Date()/Date.parse 的宽松行为不同：拒绝不存在的日历日期（如 2026-02-30）
 * 与越界时间分量，不做静默滚动。无时区标记的输入按 UTC 解析，
 * 保证结果不依赖服务端进程时区（浏览器等本地输入方应先转换为带时区的 ISO）。
 * 年份支持 0000-9999：两位年份不会被重映射到 1900-1999。
 */
export function parseDeadline(value: string): Date | null {
  const match = DEADLINE_INPUT_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisText, offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText ?? '0');
  const minute = Number(minuteText ?? '0');
  const second = Number(secondText ?? '0');
  const millis = Number((millisText ?? '0').padEnd(3, '0'));
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  // 用固定闰年 2000 组装再写回年份：Date.UTC 对 0-99 年施加两位年重映射
  // （50 → 1950），且重映射基准 1900 非闰年会把已通过校验的 02-29 滚到 3 月；
  // 2000 是闰年，任何通过校验的月/日组合都可先安全表示，setUTCFullYear
  // 不做两位年重映射，按字面值恢复年份。
  const base = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, millis));
  base.setUTCFullYear(year);
  if (offset === undefined || offset === 'Z') return base;
  const sign = offset[0] === '-' ? -1 : 1;
  const digits = offset.slice(1).replace(':', '');
  const offsetHours = Number(digits.slice(0, 2));
  const offsetMinutes = Number(digits.slice(2, 4));
  if (offsetHours > 23 || offsetMinutes > 59) return null;
  // +08:00 表示本地快于 UTC：UTC = 输入时刻 - 偏移
  return new Date(base.getTime() - sign * (offsetHours * 60 + offsetMinutes) * 60_000);
}

/**
 * 截止时间统一规范化为 UTC ISO 字符串：保证存储内字典序与时间序一致，
 * 列表排序可直接做字符串比较。严格拒绝不存在的日历日期与越界分量；
 * 无时区标记的输入按 UTC 解析，不依赖进程时区。
 */
export function normalizeDeadline(value: string): string {
  const parsed = parseDeadline(value);
  if (!parsed) {
    throw new BoardError('VALIDATION', `非法 deadline: ${value}，必须是真实存在的日期时间（如 2026-02-30 会被拒绝）`);
  }
  return parsed.toISOString();
}

export function normalizeTaskId(id: string): string {
  return id.trim().toUpperCase();
}
