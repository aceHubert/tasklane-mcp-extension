import { homedir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { EXECUTION_MODEL_MAX_LENGTH, EXECUTION_MODEL_PATTERN, type Board, type WorkItem } from './work-item.js';
import { BoardError } from './errors.js';

export interface TaskFilter {
  /** 只返回指定看板下的任务 */
  boardId?: string;
  status?: string;
  assignee?: string;
  priority?: string;
  /**
   * 归档范围：active=未归档，archived=已归档，all=全部。
   * 缺省为 active；只有显式 archived/all 才读取冷存储。
   */
  archive?: 'active' | 'archived' | 'all';
}

const SESSION_EVENT_KINDS = [
  'created',
  'assigned',
  'started',
  'activity',
  'waiting',
  'blocked',
  'failed',
  'completed',
  'stopped',
  'moved',
  'archived',
  'restored',
  'execution_requested',
  'execution_delivered',
  'execution_claimed',
  'execution_created',
  'execution_bound',
  'execution_uncertain',
  'execution_rejected',
  'execution_recovered',
  'execution_external_bound',
  'review_round',
  'review_updated',
] as const;
export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number];

export interface SessionEvent {
  at: string;
  kind: SessionEventKind;
  detail?: string;
}

export interface SessionRecord {
  taskId: string;
  events: SessionEvent[];
}

const MAX_EVENTS_PER_TASK = 50;

/** 注册看板入参（Git 探测由引擎层完成，存储只负责锁内去重与落盘） */
export interface RegisterBoardInput {
  /** 仓库身份键（git common dir）；非 Git 项目为 null */
  repoKey: string | null;
  /** Git 主仓库根目录绝对路径；非 Git 项目为 null */
  repo: string | null;
  /** 项目目录绝对路径（realPath 规范化）：Git 项目等于主仓库根，非 Git 项目为目录本身 */
  projectDir: string;
  name: string;
  /** 基线分支；仅 Git 项目有意义，非 Git 项目省略 */
  baseBranch?: string;
}

export interface RegisterBoardResult {
  board: Board;
  /** false = 仓库已注册，返回既有看板（名称/基线/任务归属不变） */
  created: boolean;
}

export interface BoardStore {
  readonly boards: Board[];
  readonly archivedCounts: Record<string, number>;
  readonly filePath: string;
  getActiveSnapshot(): { boards: Board[]; tasks: WorkItem[]; archivedCounts: Record<string, number> };
  /** 锁内分配全新 ID 并创建任务，热路径不扫描冷文件。 */
  createTask(input: Omit<WorkItem, 'id'>): WorkItem;
  getBoard(id: string): Board | undefined;
  /** 锁内原子注册：按 repoKey 去重，并发注册不产生重复看板 */
  registerBoard(input: RegisterBoardInput): RegisterBoardResult;
  /** 锁内按 ID 修改看板（回填 repoKey 等；看板不存在抛 BOARD_NOT_FOUND） */
  mutateBoard(id: string, fn: (board: Board) => Board): Board;
  listTasks(filter?: TaskFilter): WorkItem[];
  getTask(id: string): WorkItem | undefined;
  /** 新建任务落盘（createTask 用；按 ID 覆盖） */
  putTask(task: WorkItem): void;
  /**
   * 读-改-写单个任务：fn 基于磁盘最新数据收到当前任务副本，返回写入后的任务。
   * 任务不存在时抛 TASK_NOT_FOUND。引擎层所有"克隆旧副本、异步操作后整份写回"
   * 的写法都必须改走这里，避免覆盖并发更新。
   */
  mutateTask(id: string, fn: (current: WorkItem) => WorkItem): WorkItem;
  /**
   * 读-改-写单个任务并在同一事务内追加时间线事件：任务修改与事件提交
   * 原子完成，避免任务已变更而事件丢失（归档/恢复使用）。返回新任务与
   * 实际追加的事件（幂等跳过时为空数组）。
   */
  mutateTaskWithEvent(
    id: string,
    fn: (current: WorkItem) => { task: WorkItem; events: SessionEvent[] },
  ): { task: WorkItem; events: SessionEvent[] };
  /**
   * 锁内原子批量修改：基于磁盘最新数据逐任务调用 fn，返回 null 跳过。
   * 目标集合的选取（如"当前看板未归档的 done"）也发生在锁内——并发回退
   * 到 review 的任务不会被选中。所有修改与事件单次提交，失败无部分写入。
   */
  mutateTasksWhere(
    fn: (task: WorkItem) => { task: WorkItem; events: SessionEvent[] } | null,
  ): WorkItem[];
  moveToArchive(id: string, fn: TaskMutation): TaskMutationResult;
  restoreFromArchive(id: string, fn: TaskMutation): TaskMutationResult;
  moveTasksToArchive(boardId: string, fn: (task: WorkItem) => TaskMutationResult | null): WorkItem[];
  deleteTask(id: string): boolean;
  nextId(): string;
  getSession(taskId: string): SessionRecord | undefined;
  appendEvent(taskId: string, event: SessionEvent): void;
  /**
   * 任务级跨进程互斥：JSON 文件锁不覆盖异步 Git 调用，两个 MCP 进程
   * 同时指派同一任务时靠它串行化 worktree 创建，避免重复工作区。
   */
  withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T>;
}

type TaskMutationResult = { task: WorkItem; events: SessionEvent[] };
type TaskMutation = (current: WorkItem) => TaskMutationResult;

/**
 * v7 新增：Board.projectDir / repoConflict（非 Git 项目身份与能力冲突提示）、
 * projectless 请求（repo 可空）与缺省 workspace 的执行结果（workspacePath/
 * workspaceOwner 可成对缺省）。归档冷文件 v3 与主文件同批升级；v1/v2 归档
 * 读取时按实现语义补 purpose（沿用 v6 规则），迁移时统一重写为 v3。
 */
const STORE_VERSION = 7;
/** 归档冷文件当前版本；读取兼容 v1/v2（旧文件按 implementation 补 purpose） */
const ARCHIVE_VERSION = 3;
interface ArchiveData {
  version: typeof ARCHIVE_VERSION;
  boardId: string;
  tasks: Record<string, WorkItem>;
  sessions: Record<string, SessionRecord>;
}

interface StoreData {
  version: typeof STORE_VERSION;
  boards: Board[];
  tasks: Record<string, WorkItem>;
  sessions: Record<string, SessionRecord>;
  seq: number;
  archivedCounts: Record<string, number>;
}

type StoreObject = Record<string, unknown>;

function isStoreObject(value: unknown): value is StoreObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 运行时校验不依赖新模型类型，避免旧任务因缺少可选执行字段被拒绝。 */
function validateNativeExecution(task: StoreObject, invalid: (field: string) => never): void {
  const object = (value: unknown, field: string): StoreObject => {
    if (!isStoreObject(value)) invalid(field);
    return value as StoreObject;
  };
  const text = (value: unknown, field: string, maxLength = Infinity): string => {
    if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) invalid(field);
    return value as string;
  };
  const identifier = (value: unknown, field: string, native = false): string => {
    const id = text(value, field, 200);
    if (/[\u0000-\u001f\u007f]/.test(id) ||
        (native && (/\s/.test(id) || /^(sess-|pending|creating|placeholder|clientThreadId|client-new-thread:)/i.test(id)))) invalid(field);
    return id;
  };
  const oneOf = (value: unknown, values: readonly string[], field: string): void => {
    if (typeof value !== 'string' || !values.includes(value)) invalid(field);
  };
  const absolutePath = (value: unknown, field: string): void => {
    const file = text(value, field);
    if (!path.isAbsolute(file) || /[\u0000-\u001f\u007f]/.test(file)) invalid(field);
  };
  const timestamp = (value: unknown, field: string): void => {
    const at = text(value, field);
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(at) ||
        !Number.isFinite(Date.parse(at))) invalid(field);
    // Date.parse 会把 2 月 30 日等日期顺延；绑定和请求时间不能接受这种损坏数据。
    const day = new Date(`${at.slice(0, 10)}T00:00:00.000Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== at.slice(0, 10)) invalid(field);
  };
  const result = (value: unknown, field: string): void => {
    const mapping = object(value, field);
    identifier(mapping.threadId, `${field}.threadId`, true);
    identifier(mapping.hostId, `${field}.hostId`, true);
    // projectless 早期可能尚未确定工作区：路径与归属必须成对出现或成对缺省，
    // 缺省明确表达"尚未确定"，不允许只带其一或伪造路径。
    const hasPath = mapping.workspacePath !== undefined;
    const hasOwner = mapping.workspaceOwner !== undefined;
    if (hasPath !== hasOwner) invalid(`${field}.workspacePath`);
    if (hasPath) {
      absolutePath(mapping.workspacePath, `${field}.workspacePath`);
      oneOf(mapping.workspaceOwner, ['codex', 'tasklane', 'user'], `${field}.workspaceOwner`);
    }
    if (mapping.branch !== undefined) text(mapping.branch, `${field}.branch`);
  };
  const integer = (value: unknown, field: string): void => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(field);
  };
  const executionShape = (value: unknown, field: string): void => {
    const mapping = object(value, field);
    oneOf(mapping.state, ['idle', 'assigned', 'starting', 'running', 'waiting', 'blocked', 'failed', 'completed'], `${field}.state`);
    if (mapping.activity !== undefined && typeof mapping.activity !== 'string') invalid(`${field}.activity`);
    for (const name of ['sessionId', 'runId', 'startedAt', 'updatedAt']) {
      if (mapping[name] !== undefined) text(mapping[name], `${field}.${name}`);
    }
  };
  const reviewActor = (value: unknown, field: string): void => {
    const mapping = object(value, field);
    oneOf(mapping.type, ['human', 'agent'], `${field}.type`);
    if (mapping.provider !== undefined) text(mapping.provider, `${field}.provider`, 64);
    if (mapping.sessionId !== undefined) text(mapping.sessionId, `${field}.sessionId`, 200);
  };

  executionShape(task.execution, 'execution');
  if (task.executionBinding !== undefined) {
    const binding = object(task.executionBinding, 'executionBinding');
    oneOf(binding.provider, ['codex-desktop'], 'executionBinding.provider');
    result(binding, 'executionBinding');
    timestamp(binding.boundAt, 'executionBinding.boundAt');
  }
  if (task.reviewExecution !== undefined) executionShape(task.reviewExecution, 'reviewExecution');
  if (task.reviewBinding !== undefined) {
    const binding = object(task.reviewBinding, 'reviewBinding');
    oneOf(binding.provider, ['codex-desktop'], 'reviewBinding.provider');
    result(binding, 'reviewBinding');
    timestamp(binding.boundAt, 'reviewBinding.boundAt');
  }
  // 同一 Codex 聊天不得同时充当实现与验收会话（thread + host 联合判定）
  if (task.executionBinding !== undefined && task.reviewBinding !== undefined) {
    const implementation = object(task.executionBinding, 'executionBinding');
    const reviewBinding = object(task.reviewBinding, 'reviewBinding');
    if (implementation.threadId === reviewBinding.threadId && implementation.hostId === reviewBinding.hostId) {
      invalid('reviewBinding.threadId');
    }
  }
  if (task.externalExecutionSession !== undefined) {
    const session = object(task.externalExecutionSession, 'externalExecutionSession');
    const provider = text(session.provider, 'externalExecutionSession.provider', 64);
    // Codex 会话必须走原生绑定，不能借外部会话对象写入 thread 语义
    if (provider === 'codex-desktop') invalid('externalExecutionSession.provider');
    // sessionId 是 provider-local opaque 标识：只做长度与控制字符校验，不套用 thread 规则
    const sessionId = text(session.sessionId, 'externalExecutionSession.sessionId', 200);
    if (/[\u0000-\u001f\u007f]/.test(sessionId)) invalid('externalExecutionSession.sessionId');
    absolutePath(session.workspacePath, 'externalExecutionSession.workspacePath');
    oneOf(session.workspaceOwner, ['user', 'tasklane', 'agent'], 'externalExecutionSession.workspaceOwner');
    if (session.branch !== undefined) text(session.branch, 'externalExecutionSession.branch', 200);
    timestamp(session.boundAt, 'externalExecutionSession.boundAt');
    timestamp(session.updatedAt, 'externalExecutionSession.updatedAt');
  }
  if (task.review !== undefined) {
    const review = object(task.review, 'review');
    oneOf(review.status, ['pending', 'reviewing', 'changes_requested', 'fixing', 'recheck_pending', 'approved'], 'review.status');
    integer(review.revision, 'review.revision');
    if (review.activeRoundId !== undefined) text(review.activeRoundId, 'review.activeRoundId');
    timestamp(review.updatedAt, 'review.updatedAt');
    if (!Array.isArray(review.rounds)) invalid('review.rounds');
    const roundIds = new Set<string>();
    for (const [index, value] of (review.rounds as unknown[]).entries()) {
      const field = `review.rounds[${index}]`;
      const round = object(value, field);
      const roundId = identifier(round.id, `${field}.id`);
      if (roundIds.has(roundId)) invalid(`${field}.id`);
      roundIds.add(roundId);
      integer(round.number, `${field}.number`);
      if (round.number !== index + 1) invalid(`${field}.number`);
      oneOf(round.status, ['reviewing', 'changes_requested', 'approved'], `${field}.status`);
      absolutePath(round.workspacePath, `${field}.workspacePath`);
      if (round.conclusion !== undefined && (typeof round.conclusion !== 'string' || round.conclusion.length > 20_000)) invalid(`${field}.conclusion`);
      if (round.status !== 'reviewing' && !(typeof round.conclusion === 'string' && round.conclusion.trim())) invalid(`${field}.conclusion`);
      timestamp(round.startedAt, `${field}.startedAt`);
      if (round.completedAt !== undefined) timestamp(round.completedAt, `${field}.completedAt`);
      if (round.status === 'reviewing' && round.completedAt !== undefined) invalid(`${field}.completedAt`);
      if (!Array.isArray(round.updates)) invalid(`${field}.updates`);
      for (const [updateIndex, updateValue] of (round.updates as unknown[]).entries()) {
        const updateField = `${field}.updates[${updateIndex}]`;
        const update = object(updateValue, updateField);
        identifier(update.id, `${updateField}.id`);
        timestamp(update.at, `${updateField}.at`);
        oneOf(update.status, ['pending', 'reviewing', 'changes_requested', 'fixing', 'recheck_pending', 'approved'], `${updateField}.status`);
        if (update.conclusion !== undefined && (typeof update.conclusion !== 'string' || update.conclusion.length > 20_000)) invalid(`${updateField}.conclusion`);
        if (update.actor !== undefined) reviewActor(update.actor, `${updateField}.actor`);
      }
    }
    if (review.activeRoundId !== undefined &&
      (typeof review.activeRoundId !== 'string' || !roundIds.has(review.activeRoundId))) {
      invalid('review.activeRoundId');
    }
  }
  if (task.executionRequests === undefined) return;
  if (!Array.isArray(task.executionRequests)) invalid('executionRequests');
  const requestIds = new Set<string>();
  for (const [index, value] of (task.executionRequests as unknown[]).entries()) {
    const field = `executionRequests[${index}]`;
    const request = object(value, field);
    const requestId = identifier(request.requestId, `${field}.requestId`);
    if (requestIds.has(requestId)) invalid(`${field}.requestId`);
    requestIds.add(requestId);
    identifier(request.runId, `${field}.runId`);
    identifier(request.taskId, `${field}.taskId`);
    identifier(request.boardId, `${field}.boardId`);
    if (request.taskId !== task.id) invalid(`${field}.taskId`);
    if (request.boardId !== task.boardId) invalid(`${field}.boardId`);
    oneOf(request.action, ['start', 'reply', 'continue', 'retry'], `${field}.action`);
    oneOf(request.purpose, ['implementation', 'review'], `${field}.purpose`);
    oneOf(request.workspaceMode, ['project', 'worktree', 'existing', 'projectless'], `${field}.workspaceMode`);
    if (request.purpose === 'review') {
      // review 请求必须携带服务端解析的实现工作区；实现请求不得携带该字段
      absolutePath(request.workspacePath, `${field}.workspacePath`);
    } else if (request.workspacePath !== undefined) invalid(`${field}.workspacePath`);
    if (request.hostId !== undefined) identifier(request.hostId, `${field}.hostId`, true);
    if (request.receiverThreadId !== undefined) identifier(request.receiverThreadId, `${field}.receiverThreadId`, true);
    if (request.receiver !== undefined) {
      const receiver = object(request.receiver, `${field}.receiver`);
      identifier(receiver.hostId, `${field}.receiver.hostId`, true);
      identifier(receiver.threadId, `${field}.receiver.threadId`, true);
      if (request.claimId === undefined) invalid(`${field}.claimId`);
      if (request.hostId !== undefined && request.hostId !== receiver.hostId) invalid(`${field}.receiver.hostId`);
      if (request.receiverThreadId !== undefined && request.receiverThreadId !== receiver.threadId) invalid(`${field}.receiver.threadId`);
    }
    // projectless 请求没有项目/仓库上下文：repo 为 null；其余请求必须是绝对路径
    if (request.repo !== null && request.repo !== undefined) absolutePath(request.repo, `${field}.repo`);
    oneOf(request.status, [
      'pending', 'delivered', 'claimed', 'created', 'bound',
      'running', 'waiting', 'blocked', 'completed', 'failed', 'uncertain', 'rejected', 'cancelled',
    ], `${field}.status`);
    timestamp(request.requestedAt, `${field}.requestedAt`);
    timestamp(request.updatedAt, `${field}.updatedAt`);
    if (request.message !== undefined && (typeof request.message !== 'string' || request.message.length > 20_000)) invalid(`${field}.message`);
    if (request.action === 'reply' && (typeof request.message !== 'string' || !request.message.trim())) invalid(`${field}.message`);
    if (request.model !== undefined && ((request.action !== 'start' && !request.recoveryOf) || typeof request.model !== 'string' ||
      request.model !== request.model.trim() || request.model.length > EXECUTION_MODEL_MAX_LENGTH ||
      !EXECUTION_MODEL_PATTERN.test(request.model))) invalid(`${field}.model`);
    if (request.claimId !== undefined) identifier(request.claimId, `${field}.claimId`);
    if (request.result !== undefined) result(request.result, `${field}.result`);
    if (request.startedAt !== undefined) timestamp(request.startedAt, `${field}.startedAt`);
    if (request.deliveryError !== undefined && (typeof request.deliveryError !== 'string' || request.deliveryError.length > 200)) invalid(`${field}.deliveryError`);
    if (request.status === 'rejected') {
      const binding = request.purpose === 'review' ? task.reviewBinding : task.executionBinding;
      const retainedResult = request.result;
      // 明确创建、准备或投递失败均保留已知聊天结果；任何目标回执都不能伪记分发失败。
      const preservedResult = retainedResult === undefined ||
        ((request.claimId !== undefined || request.recoveryOf !== undefined) && isStoreObject(retainedResult) &&
          (binding === undefined || (isStoreObject(binding) &&
            ['threadId', 'hostId', 'workspacePath', 'workspaceOwner', 'branch']
              .every((key) => retainedResult[key] === binding[key]))));
      if (typeof request.deliveryError !== 'string' || !request.deliveryError.trim() || !preservedResult ||
        request.startedAt !== undefined || (Array.isArray(request.reports) && request.reports.length > 0)) invalid(`${field}.status`);
    }
    if (request.status === 'blocked' && (request.claimId === undefined ||
      !(typeof request.deliveryError === 'string' && request.deliveryError.trim()) &&
      !(Array.isArray(request.reports) && request.reports.some((report) => isStoreObject(report) && report.state === 'blocked' &&
        typeof report.activity === 'string' && report.activity.trim())))) invalid(`${field}.status`);
    if (request.recovery !== undefined) {
      const recovery = object(request.recovery, `${field}.recovery`);
      timestamp(recovery.at, `${field}.recovery.at`);
      text(recovery.reason, `${field}.recovery.reason`, 200);
      if (recovery.releasedBy !== 'user') invalid(`${field}.recovery.releasedBy`);
      if (recovery.confirmedStopped !== true || request.status !== 'cancelled') invalid(`${field}.recovery`);
    }
    if (request.status === 'cancelled' && request.recovery === undefined) invalid(`${field}.recovery`);
    if (request.recoveryOf !== undefined) {
      const source = object(request.recoveryOf, `${field}.recoveryOf`);
      identifier(source.requestId, `${field}.recoveryOf.requestId`);
      identifier(source.runId, `${field}.recoveryOf.runId`);
      const origin = (task.executionRequests as StoreObject[]).find((candidate) => candidate.requestId === source.requestId && candidate.runId === source.runId);
      const originResult = origin?.result ?? (origin?.status === 'blocked' ? task.executionBinding : undefined);
      if (!origin || !['cancelled', 'blocked', 'rejected'].includes(String(origin.status)) || !originResult || !request.result ||
        request.purpose !== origin.purpose ||
        request.workspaceMode !== origin.workspaceMode || request.model !== origin.model ||
        ['threadId', 'hostId', 'workspacePath', 'workspaceOwner', 'branch'].some((key) =>
          (request.result as StoreObject)[key] !== (originResult as StoreObject)[key])) invalid(`${field}.recoveryOf`);
    }
    if (request.reports !== undefined) {
      if (!Array.isArray(request.reports)) invalid(`${field}.reports`);
      const reportIds = new Set<string>();
      for (const [reportIndex, reportValue] of (request.reports as unknown[]).entries()) {
        const reportField = `${field}.reports[${reportIndex}]`;
        const report = object(reportValue, reportField);
        const reportId = identifier(report.reportId, `${reportField}.reportId`);
        if (reportIds.has(reportId)) invalid(`${reportField}.reportId`);
        reportIds.add(reportId);
        oneOf(report.state, ['running', 'waiting', 'blocked', 'failed', 'completed'], `${reportField}.state`);
        if (report.activity !== undefined && (typeof report.activity !== 'string' || report.activity.length > 200)) invalid(`${reportField}.activity`);
        if (report.state === 'blocked' && (typeof report.activity !== 'string' || !report.activity.trim())) invalid(`${reportField}.activity`);
      }
    }
  }
}

/* ---------- 文件锁：多进程共用同一 board.json 时的互斥 ---------- */

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 20;
/** 任务锁覆盖异步 Git 调用，等待与陈旧阈值都比数据锁宽 */
const TASK_LOCK_STALE_MS = 60_000;
const TASK_LOCK_TIMEOUT_MS = 30_000;
const TASK_LOCK_RETRY_MS = 50;
/** 本次进程持有的锁标识；释放时只删除属于自己的锁，避免误删他人新锁 */
const LOCK_TOKEN = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockPath: string): void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, LOCK_TOKEN);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      // 持有者崩溃留下的陈旧锁（超过 stale 阈值）强制抢占
      const st = statSync(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        console.warn(`[tasklane] 抢占陈旧存储锁: ${lockPath}`);
        rmSync(lockPath, { force: true });
      }
    } catch {
      /* 锁刚被他人释放，直接进入下一轮重试 */
    }
    if (Date.now() > deadline) {
      throw new BoardError('STORE_ERROR', `获取存储锁超时: ${lockPath}`);
    }
    sleepSync(LOCK_RETRY_MS);
  }
}

function releaseLock(lockPath: string): void {
  try {
    if (readFileSync(lockPath, 'utf8') === LOCK_TOKEN) {
      rmSync(lockPath, { force: true });
    }
  } catch {
    /* 锁已被抢占或移除，无需处理 */
  }
}

/**
 * JSON 热存储与按看板拆分的归档冷存储，共用一把文件锁。
 * 写入为原子写
 * （tmp + rename）。多个 MCP 进程共用同一文件时，靠目录内 lockfile 互斥：
 * 每次改动前重新从磁盘加载最新数据，杜绝"整份旧数据覆盖他人写入 / nextId 撞号"。
 * 临界区全部为同步小读写，锁持有时间为毫秒级。
 * 换 SQLite 时实现同一 BoardStore 接口即可，上层无感。
 */
export class JsonFileBoardStore implements BoardStore {
  private data: StoreData;
  private readonly lockPath: string;

  constructor(readonly filePath: string) {
    this.lockPath = `${filePath}.lock`;
    // 锁文件先于任何 persist 创建，目录必须在这里就绪
    mkdirSync(path.dirname(this.lockPath), { recursive: true });
    this.data = this.loadOrMigrate();
  }

  /** 读取磁盘并按需完成 v1-v4/v5 → v7 或 v6 → v7；事务内不重复获取锁。 */
  private loadOrMigrate(alreadyLocked = false): StoreData {
    const parsed = this.readRaw();
    if (parsed.version === STORE_VERSION) return this.normalizeV7(parsed);
    if (parsed.version === 6) return this.migrateV6(alreadyLocked);
    if (parsed.version === 5) return this.migrateV5(alreadyLocked);
    if (parsed.version === 1 || parsed.version === 2 || parsed.version === 3 || parsed.version === 4) {
      return this.migrateLegacy(alreadyLocked);
    }
    throw this.unknownVersion(parsed.version);
  }

  private unknownVersion(version: unknown): BoardError {
    return new BoardError(
      'STORE_ERROR',
      `未知存储文件版本: ${String(version)}（支持: 1, 2, 3, 4, 5, 6, ${STORE_VERSION}）: ${this.filePath}`,
    );
  }

  /** v5 及更早的请求缺省 purpose：迁移时一律按 implementation 补齐（就地修改解析对象） */
  private static fillRequestPurpose(parsed: StoreObject): void {
    const tasks = parsed.tasks;
    if (!isStoreObject(tasks)) return;
    for (const task of Object.values(tasks)) {
      if (!isStoreObject(task) || !Array.isArray(task.executionRequests)) continue;
      for (const request of task.executionRequests) {
        if (isStoreObject(request) && request.purpose === undefined) request.purpose = 'implementation';
      }
    }
  }

  /** 仅在文件不存在时初始化；显式损坏字段不能回退到空看板。 */
  private readRaw(): StoreObject {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ...freshStore() };
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BoardError('STORE_ERROR', `存储文件损坏（JSON 解析失败）: ${this.filePath}`);
    }
    if (!isStoreObject(parsed) || !Array.isArray(parsed.boards)) {
      throw new BoardError('STORE_ERROR', `存储文件结构损坏（缺少 boards 数组）: ${this.filePath}`);
    }
    return parsed;
  }

  /**
   * 锁内重读并完整校验后，备份原版本、先写冷文件、最后提交 v6 主文件。
   * v1 只为缺省 boardId 的任务补唯一看板归属；v2/v3/v4 原样保留任务、归档、
   * Git、时间线及序号，不推测原生绑定，也不改写旧 running/sessionId；
   * 所有旧请求补 purpose=implementation，新 Review 字段保持缺省。
   */
  private migrateLegacy(alreadyLocked: boolean): StoreData {
    if (!alreadyLocked) acquireLock(this.lockPath);
    try {
      const parsed = this.readRaw();
      if (parsed.version === STORE_VERSION) return this.normalizeV7(parsed);
      const version = parsed.version;
      if (version !== 1 && version !== 2 && version !== 3 && version !== 4) {
        if (version === 5) return this.migrateV5(true);
        if (version === 6) return this.migrateV6(true);
        throw this.unknownVersion(version);
      }

      let input = parsed;
      if (version === 1) {
        const boards = parsed.boards as unknown[];
        if (boards.length > 1) {
          throw new BoardError(
            'STORE_ERROR',
            `旧数据包含 ${boards.length} 个看板但任务缺少 boardId 归属，无法自动迁移；` +
              `请手工为 tasks 指定归属后重试: ${this.filePath}`,
          );
        }
        const ownerBoards = boards.length === 0 ? freshBoardList() : boards;
        if (!isStoreObject(ownerBoards[0])) this.invalidField('boards[0]');
        const ownerBoardId = (ownerBoards[0] as StoreObject).id;
        const oldTasks = parsed.tasks === undefined ? {} : parsed.tasks;
        if (!isStoreObject(oldTasks)) this.invalidField('tasks');
        const tasks: StoreObject = {};
        for (const [id, task] of Object.entries(oldTasks as StoreObject)) {
          if (!isStoreObject(task)) this.invalidField(`tasks.${id}`);
          // 已有归属不覆盖，未知看板由完整校验明确拒绝。
          tasks[id] = { ...task, boardId: task.boardId === undefined ? ownerBoardId : task.boardId };
        }
        input = { ...parsed, boards: ownerBoards, tasks };
      }
      // 旧版本请求一律按实现语义补 purpose；归档任务在下方搬运时随任务一并落盘
      JsonFileBoardStore.fillRequestPurpose(input);
      const migrated = this.normalizeV4(input);
      this.backupBeforeMigrate(`.v${version}.bak`);
      const archives = new Map<string, ArchiveData>();
      for (const task of Object.values(migrated.tasks)) {
        if (!task.archivedAt) continue;
        const archive = archives.get(task.boardId) ?? this.readArchive(task.boardId, 0);
        archives.set(task.boardId, archive);
        archive.tasks[task.id] = task;
        if (migrated.sessions[task.id]) archive.sessions[task.id] = migrated.sessions[task.id];
        else delete archive.sessions[task.id];
        delete migrated.tasks[task.id];
        delete migrated.sessions[task.id];
        migrated.archivedCounts[task.boardId] = (migrated.archivedCounts[task.boardId] ?? 0) + 1;
      }
      for (const archive of archives.values()) this.persistArchive(archive);
      this.persistData(migrated);
      console.error(`[tasklane] 已升级存储 v${version} → v7（备份: ${this.filePath}.v${version}.bak）`);
      return migrated;
    } finally {
      if (!alreadyLocked) releaseLock(this.lockPath);
    }
  }

  /**
   * v5 → v6：锁内补 purpose=implementation（热任务与归档任务），备份 .v5.bak，
   * 归档冷文件统一重写为 v2，最后提交 v6 主文件。原任务、请求、时间线、ID、
   * 归档计数与 Git 绑定原样保留；review / reviewExecution / reviewBinding /
   * externalExecutionSession 保持缺省（旧任务不因此被推断为已验收）。
   */
  private migrateV5(alreadyLocked: boolean): StoreData {
    if (!alreadyLocked) acquireLock(this.lockPath);
    try {
      const parsed = this.readRaw();
      if (parsed.version === STORE_VERSION) return this.normalizeV7(parsed);
      if (parsed.version !== 5) {
        if (parsed.version === 1 || parsed.version === 2 || parsed.version === 3 || parsed.version === 4) {
          return this.migrateLegacy(true);
        }
        if (parsed.version === 6) return this.migrateV6(true);
        throw this.unknownVersion(parsed.version);
      }
      JsonFileBoardStore.fillRequestPurpose(parsed);
      const migrated = this.normalizeV5(parsed);
      this.backupBeforeMigrate('.v5.bak');
      // 归档冷文件与主文件同批升级：回滚到 v5 的旧服务无法静默继续写新语义数据
      for (const board of migrated.boards) {
        const archive = this.readArchive(board.id, migrated.archivedCounts[board.id] ?? 0);
        if (!Object.keys(archive.tasks).length && !Object.keys(archive.sessions).length) continue;
        this.persistArchive(archive);
      }
      this.persistData(migrated);
      console.error(`[tasklane] 已升级存储 v5 → v6（备份: ${this.filePath}.v5.bak；归档冷文件已重写为 v2）`);
      return migrated;
    } finally {
      if (!alreadyLocked) releaseLock(this.lockPath);
    }
  }

  /** 迁移前备份原始文件；失败则中止升级（原文件保持可用） */
  private backupBeforeMigrate(suffix: string): void {
    const backupPath = `${this.filePath}${suffix}`;
    const temporaryPath = `${backupPath}.${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
    try {
      let existing: Buffer | undefined;
      try {
        existing = readFileSync(backupPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (existing) {
        if (existing.equals(readFileSync(this.filePath))) return;
        throw new BoardError('STORE_ERROR', `已有迁移备份与当前源文件不一致，已中止升级: ${backupPath}`);
      }
      // 全局锁内先完整复制再原子发布，崩溃留下的临时文件不会冒充有效备份。
      copyFileSync(this.filePath, temporaryPath, constants.COPYFILE_EXCL);
      renameSync(temporaryPath, backupPath);
    } catch (err) {
      if (err instanceof BoardError) throw err;
      throw new BoardError(
        'STORE_ERROR',
        `迁移前备份失败，已中止升级（原文件保持可用）: ${backupPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // 仅清理本次生成的临时文件，失败不覆盖原始迁移错误。
      try { rmSync(temporaryPath, { force: true }); } catch { /* 保留残留供排查 */ }
    }
  }

  private invalidField(field: string): never {
    throw new BoardError('STORE_ERROR', `存储字段损坏: ${field}；请修正后重试: ${this.filePath}`);
  }

  /** 完整结构校验；原生字段可缺省，旧运行状态不等同于已经验证的原生执行。 */
  private normalizeV4(parsed: StoreObject): StoreData {
    const requiredText = (value: unknown, field: string): void => {
      if (typeof value !== 'string' || value.trim() === '') this.invalidField(field);
    };
    const optionalText = (value: unknown, field: string, nullable = false): void => {
      if (value !== undefined && !(nullable && value === null)) requiredText(value, field);
    };
    const oneOf = (value: unknown, values: readonly string[], field: string): void => {
      if (typeof value !== 'string' || !values.includes(value)) this.invalidField(field);
    };
    const count = (value: unknown, field: string): void => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) this.invalidField(field);
    };
    const boards = parsed.boards;
    if (!Array.isArray(boards)) this.invalidField('boards');
    const boardIds = new Set<string>();
    for (const [index, board] of (boards as unknown[]).entries()) {
      const field = `boards[${index}]`;
      if (!isStoreObject(board)) this.invalidField(field);
      requiredText(board.id, `${field}.id`);
      requiredText(board.name, `${field}.name`);
      if (boardIds.has(board.id as string)) this.invalidField(`${field}.id`);
      boardIds.add(board.id as string);
      optionalText(board.repo, `${field}.repo`, true);
      optionalText(board.repoKey, `${field}.repoKey`, true);
      optionalText(board.baseBranch, `${field}.baseBranch`);
      optionalText(board.projectDir, `${field}.projectDir`, true);
      optionalText(board.repoConflict, `${field}.repoConflict`, true);
      // v7 项目目录身份回填：有仓库的看板 projectDir 等于主仓库根（读取即归一，
      // 覆盖 v1-v6 全部迁移路径与当前文件）；无仓库看板保持缺省
      if (typeof board.repo === 'string' && board.repo.trim() && board.projectDir === undefined) {
        board.projectDir = board.repo;
      }
    }
    const tasks = parsed.tasks === undefined ? {} : parsed.tasks;
    if (!isStoreObject(tasks)) this.invalidField('tasks');
    for (const [id, task] of Object.entries(tasks as StoreObject)) {
      const field = `tasks.${id}`;
      if (!isStoreObject(task)) this.invalidField(field);
      requiredText(task.id, `${field}.id`);
      if (task.id !== id) this.invalidField(`${field}.id`);
      requiredText(task.title, `${field}.title`);
      oneOf(task.status, ['backlog', 'ready', 'doing', 'review', 'done'], `${field}.status`);
      oneOf(task.priority, ['P0', 'P1', 'P2', 'P3'], `${field}.priority`);
      // 保留既有枚举兼容；不会把旧 sessionId 推断为真实线程。
      if (task.assignee === 'codex') task.assignee = 'agent';
      oneOf(task.assignee, ['human', 'agent'], `${field}.assignee`);
      if (typeof task.boardId !== 'string' || !boardIds.has(task.boardId)) {
        throw new BoardError(
          'STORE_ERROR',
          `任务 ${id} 引用了不存在的看板: ${String(task.boardId)}；` +
            `请修正 boardId 或看板定义后重试: ${this.filePath}`,
        );
      }
      if (task.description !== undefined && typeof task.description !== 'string') this.invalidField(`${field}.description`);
      // deadline 只做类型校验（与 description 同级），坏值不阻断整个看板加载；
      // 严格日期解析发生在写入路径（engine / MCP 校验）。
      if (task.deadline !== undefined && typeof task.deadline !== 'string') this.invalidField(`${field}.deadline`);
      for (const name of ['repo', 'baseBranch', 'branch', 'worktreePath', 'archivedAt']) {
        optionalText(task[name], `${field}.${name}`);
      }
      requiredText(task.createdAt, `${field}.createdAt`);
      requiredText(task.updatedAt, `${field}.updatedAt`);
      if (!isStoreObject(task.execution)) this.invalidField(`${field}.execution`);
      const execution = task.execution;
      oneOf(execution.state, ['idle', 'assigned', 'starting', 'running', 'waiting', 'blocked', 'failed', 'completed'], `${field}.execution.state`);
      if (execution.activity !== undefined && typeof execution.activity !== 'string') this.invalidField(`${field}.execution.activity`);
      for (const name of ['sessionId', 'startedAt', 'updatedAt']) {
        optionalText(execution[name], `${field}.execution.${name}`);
      }
      validateNativeExecution(task, (name) => this.invalidField(`${field}.${name}`));
      if (task.changes !== undefined) {
        if (!isStoreObject(task.changes)) this.invalidField(`${field}.changes`);
        const changes = task.changes;
        for (const name of ['filesChanged', 'additions', 'deletions']) count(changes[name], `${field}.changes.${name}`);
        oneOf(changes.testStatus, ['unknown', 'passing', 'failing'], `${field}.changes.testStatus`);
        if (!Array.isArray(changes.files)) this.invalidField(`${field}.changes.files`);
        for (const [index, change] of (changes.files as unknown[]).entries()) {
          const changeField = `${field}.changes.files[${index}]`;
          if (!isStoreObject(change)) this.invalidField(changeField);
          requiredText(change.name, `${changeField}.name`);
          count(change.added, `${changeField}.added`);
          count(change.removed, `${changeField}.removed`);
        }
      }
    }
    const sessions = parsed.sessions === undefined ? {} : parsed.sessions;
    if (!isStoreObject(sessions)) this.invalidField('sessions');
    for (const [id, session] of Object.entries(sessions as StoreObject)) {
      const field = `sessions.${id}`;
      if (!isStoreObject(session) || session.taskId !== id || !Array.isArray(session.events)) this.invalidField(field);
      for (const [index, event] of (session.events as unknown[]).entries()) {
        const eventField = `${field}.events[${index}]`;
        if (!isStoreObject(event)) this.invalidField(eventField);
        requiredText(event.at, `${eventField}.at`);
        oneOf(event.kind, SESSION_EVENT_KINDS, `${eventField}.kind`);
        if (event.detail !== undefined && typeof event.detail !== 'string') this.invalidField(`${eventField}.detail`);
      }
    }
    const seq = parsed.seq === undefined ? 100 : parsed.seq;
    count(seq, 'seq');
    return {
      version: STORE_VERSION,
      boards: boards as Board[],
      tasks: tasks as Record<string, WorkItem>,
      sessions: sessions as Record<string, SessionRecord>,
      seq: seq as number,
      archivedCounts: {},
    };
  }

  private normalizeV5(parsed: StoreObject): StoreData {
    const data = this.normalizeV4(parsed);
    const counts = parsed.archivedCounts ?? {};
    if (!isStoreObject(counts)) this.invalidField('archivedCounts');
    for (const [id, count] of Object.entries(counts)) {
      if (!data.boards.some((board) => board.id === id) || typeof count !== 'number' ||
        !Number.isSafeInteger(count) || count < 0) this.invalidField(`archivedCounts.${id}`);
    }
    for (const task of Object.values(data.tasks)) {
      if (task.archivedAt) this.invalidField(`tasks.${task.id}.archivedAt`);
    }
    data.archivedCounts = counts as Record<string, number>;
    return data;
  }

  /** v6 在 v5 结构上仅新增可选任务字段，字段级校验在任务循环内完成 */
  private normalizeV6(parsed: StoreObject): StoreData {
    return this.normalizeV5(parsed);
  }

  /**
   * v6 → v7：锁内为已有 repo 的看板回填 projectDir（等于主仓库根，保持去重与
   * 非 Git 注册一致），备份 .v6.bak，归档冷文件统一重写为 v3，最后提交 v7 主文件。
   * 任务、请求、时间线、ID、序号、归档计数与 Git 绑定原样保留；
   * 旧请求的 repo 本就是绝对路径，projectless 的可空 repo 只影响新写入。
   */
  private migrateV6(alreadyLocked: boolean): StoreData {
    if (!alreadyLocked) acquireLock(this.lockPath);
    try {
      const parsed = this.readRaw();
      if (parsed.version === STORE_VERSION) return this.normalizeV7(parsed);
      if (parsed.version !== 6) {
        if (parsed.version === 1 || parsed.version === 2 || parsed.version === 3 || parsed.version === 4) {
          return this.migrateLegacy(true);
        }
        if (parsed.version === 5) return this.migrateV5(true);
        throw this.unknownVersion(parsed.version);
      }
      const boards = parsed.boards;
      if (!Array.isArray(boards)) this.invalidField('boards');
      for (const board of boards) {
        if (!isStoreObject(board)) this.invalidField('boards[]');
        // 项目目录身份回填：Git 看板的 projectDir 等于主仓库根；
        // repo 为空的看板（无项目 default）保持 projectDir 缺省
        if (board.projectDir === undefined && typeof board.repo === 'string' && board.repo.trim()) {
          board.projectDir = board.repo;
        }
      }
      const migrated = this.normalizeV6(parsed);
      this.backupBeforeMigrate('.v6.bak');
      // 归档冷文件与主文件同批升级为 v3：回滚到 v6 的旧服务无法静默继续写新语义数据
      for (const board of migrated.boards) {
        const archive = this.readArchive(board.id, migrated.archivedCounts[board.id] ?? 0);
        if (!Object.keys(archive.tasks).length && !Object.keys(archive.sessions).length) continue;
        this.persistArchive(archive);
      }
      this.persistData(migrated);
      console.error(`[tasklane] 已升级存储 v6 → v7（备份: ${this.filePath}.v6.bak；归档冷文件已重写为 v3）`);
      return migrated;
    } finally {
      if (!alreadyLocked) releaseLock(this.lockPath);
    }
  }

  /** v7 在 v6 结构上新增看板可选字段与可空 repo/缺省 workspace，校验在共享循环内完成 */
  private normalizeV7(parsed: StoreObject): StoreData {
    return this.normalizeV5(parsed);
  }

  private archivePath(boardId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(boardId)) this.invalidField('archive.boardId');
    return path.join(path.dirname(this.filePath), 'archive', `${boardId}.json`);
  }

  /** 使用合成看板复用任务和事件校验，不依赖主文件的看板列表。读取兼容归档 v1/v2。 */
  private readArchive(boardId: string, expectedCount = this.data?.archivedCounts[boardId] ?? 0): ArchiveData {
    const file = this.archivePath(boardId);
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (expectedCount > 0) throw new BoardError('STORE_ERROR', `归档文件缺失，但看板记录了 ${expectedCount} 条归档任务: ${file}`);
        return { version: ARCHIVE_VERSION, boardId, tasks: {}, sessions: {} };
      }
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      throw new BoardError('STORE_ERROR', `归档文件损坏（JSON 解析失败）: ${file}`);
    }
    if (!isStoreObject(parsed) || (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== ARCHIVE_VERSION) ||
      parsed.boardId !== boardId ||
      !isStoreObject(parsed.tasks) || !isStoreObject(parsed.sessions)) this.invalidField(`archive.${boardId}`);
    // v1 归档是 v6 之前的冷数据：读取时按实现语义补 purpose，不修改磁盘版本
    if (parsed.version === 1) JsonFileBoardStore.fillRequestPurpose(parsed);
    const data = this.normalizeV4({ ...parsed, boards: [{ id: boardId, name: boardId }] });
    for (const task of Object.values(data.tasks)) {
      if (!task.archivedAt || task.status !== 'done') this.invalidField(`archive.${boardId}.tasks.${task.id}`);
    }
    for (const id of Object.keys(data.sessions)) {
      if (!Object.hasOwn(data.tasks, id)) this.invalidField(`archive.${boardId}.sessions.${id}`);
    }
    return { version: ARCHIVE_VERSION, boardId, tasks: data.tasks, sessions: data.sessions };
  }

  private persistArchive(archive: ArchiveData): void {
    const file = this.archivePath(archive.boardId);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');
    renameSync(`${file}.tmp`, file);
  }

  private findArchived(id: string): ArchiveData | undefined {
    for (const board of this.data.boards) {
      const archive = this.readArchive(board.id);
      if (Object.hasOwn(archive.tasks, id)) return archive;
    }
    return undefined;
  }

  /** 普通写入口在同一把锁内拒绝冷文件任务，避免错误码退化和并发穿透。 */
  private requireActive(id: string): WorkItem {
    const task = this.data.tasks[id];
    if (task) return task;
    if (this.findArchived(id)) throw new BoardError('TASK_ARCHIVED', `任务 ${id} 已归档，请先恢复后再修改`);
    throw new BoardError('TASK_NOT_FOUND', `任务不存在: ${id}`);
  }

  private persistData(data: StoreData): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.filePath);
  }

  private persist(): void {
    this.persistData(this.data);
  }

  /** 互斥事务：持锁 → 磁盘重读 → 改动落盘 → 放锁 */
  private transaction<T>(fn: () => T): T {
    acquireLock(this.lockPath);
    try {
      this.data = this.loadOrMigrate(true);
      return fn();
    } finally {
      releaseLock(this.lockPath);
    }
  }

  /** 读取前重读磁盘，保证能看到其他进程的最新写入 */
  private reload(): void {
    this.data = this.loadOrMigrate();
  }

  get boards(): Board[] {
    this.reload();
    return structuredClone(this.data.boards);
  }

  get archivedCounts(): Record<string, number> {
    this.reload();
    return { ...this.data.archivedCounts };
  }

  getActiveSnapshot(): { boards: Board[]; tasks: WorkItem[]; archivedCounts: Record<string, number> } {
    this.reload();
    return structuredClone({ boards: this.data.boards, tasks: Object.values(this.data.tasks), archivedCounts: this.data.archivedCounts });
  }

  getBoard(id: string): Board | undefined {
    this.reload();
    const board = this.data.boards.find((b) => b.id === id);
    return board ? structuredClone(board) : undefined;
  }

  registerBoard(input: RegisterBoardInput): RegisterBoardResult {
    return this.transaction(() => {
      // 锁内重读后判定项目/Git 身份：两个进程并发注册同一目录或仓库只落一个看板。
      // Git 项目按 repoKey（或旧看板的 repo 路径）去重；非 Git 项目按规范化
      // projectDir 去重——同一物理目录（含符号链接视角）重复添加返回同一看板。
      const normalizeDir = (value: string): string => {
        try {
          return realpathSync(value);
        } catch {
          return path.resolve(value);
        }
      };
      const existing = this.data.boards.find(
        (b) =>
          (input.repoKey !== null && (b.repoKey === input.repoKey ||
            (input.repo !== null && b.repo != null && b.repo === input.repo))) ||
          (b.projectDir != null && normalizeDir(b.projectDir) === normalizeDir(input.projectDir)),
      );
      if (existing) {
        // 幂等：返回已有看板，不改变名称、基线与任务归属；顺手补齐身份键
        let changed = false;
        if (input.repoKey !== null && !existing.repoKey) {
          existing.repoKey = input.repoKey;
          changed = true;
        }
        if (input.repo !== null && existing.repo == null && existing.projectDir != null &&
          normalizeDir(existing.projectDir) === normalizeDir(input.repo)) {
          existing.repo = input.repo;
          changed = true;
        }
        if (!existing.projectDir) {
          existing.projectDir = input.projectDir;
          changed = true;
        }
        if (changed) this.persist();
        return { board: structuredClone(existing), created: false };
      }
      const board: Board = {
        id: `board-${randomBytes(4).toString('hex')}`,
        name: input.name,
        repo: input.repo,
        ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
        repoKey: input.repoKey,
        projectDir: input.projectDir,
      };
      this.data.boards.push(board);
      this.persist();
      return { board: structuredClone(board), created: true };
    });
  }

  mutateBoard(id: string, fn: (board: Board) => Board): Board {
    return this.transaction(() => {
      const idx = this.data.boards.findIndex((b) => b.id === id);
      if (idx < 0) throw new BoardError('BOARD_NOT_FOUND', `看板不存在: ${id}`);
      this.data.boards[idx] = fn(structuredClone(this.data.boards[idx]));
      this.persist();
      return structuredClone(this.data.boards[idx]);
    });
  }

  listTasks(filter?: TaskFilter): WorkItem[] {
    const collect = (): WorkItem[] => {
      const archive = filter?.archive ?? 'active';
      const all = archive === 'archived' ? [] : Object.values(this.data.tasks);
      if (archive !== 'active') {
        const boards = filter?.boardId === undefined ? this.data.boards : [{ id: filter.boardId }];
        for (const board of boards) {
          for (const task of Object.values(this.readArchive(board.id).tasks)) {
            if (!Object.hasOwn(this.data.tasks, task.id)) all.push(task);
          }
        }
      }
      return structuredClone(all.filter((task) =>
        (filter?.boardId === undefined || task.boardId === filter.boardId) &&
        (filter?.status === undefined || task.status === filter.status) &&
        (filter?.assignee === undefined || task.assignee === filter.assignee) &&
        (filter?.priority === undefined || task.priority === filter.priority),
      ).sort(compareTasks));
    };
    if (filter?.archive === 'archived' || filter?.archive === 'all') return this.transaction(collect);
    this.reload();
    return collect();
  }

  getTask(id: string): WorkItem | undefined {
    this.reload();
    const task = this.data.tasks[id];
    if (task) return structuredClone(task);
    return this.transaction(() => {
      const latest = this.data.tasks[id] ?? this.findArchived(id)?.tasks[id];
      return latest ? structuredClone(latest) : undefined;
    });
  }

  putTask(task: WorkItem): void {
    this.transaction(() => {
      if (!this.data.tasks[task.id] && Object.values(this.data.archivedCounts).some((count) => count > 0) && this.findArchived(task.id)) {
        throw new BoardError('TASK_ARCHIVED', `任务 ${task.id} 已归档，请先恢复后再修改`);
      }
      if (task.archivedAt) {
        if (task.status !== 'done') this.invalidField(`tasks.${task.id}.status`);
        const archive = this.readArchive(task.boardId);
        archive.tasks[task.id] = structuredClone(task);
        if (this.data.sessions[task.id]) archive.sessions[task.id] = this.data.sessions[task.id];
        this.persistArchive(archive);
        delete this.data.tasks[task.id];
        delete this.data.sessions[task.id];
        this.data.archivedCounts[task.boardId] = (this.data.archivedCounts[task.boardId] ?? 0) + 1;
      } else this.data.tasks[task.id] = structuredClone(task);
      this.data.seq = Math.max(this.data.seq, Number.parseInt(task.id.replace(/^TASK-/i, ''), 10) || 0);
      this.persist();
    });
  }

  createTask(input: Omit<WorkItem, 'id'>): WorkItem {
    return this.transaction(() => {
      if (input.archivedAt) throw new BoardError('VALIDATION', '新任务不能直接归档');
      this.data.seq += 1;
      const task = { ...structuredClone(input), id: `TASK-${this.data.seq}` };
      this.data.tasks[task.id] = task;
      this.persist();
      return structuredClone(task);
    });
  }

  private assertActiveMutation(current: WorkItem, next: WorkItem): void {
    if (next.id !== current.id || next.boardId !== current.boardId || next.archivedAt) {
      throw new BoardError('VALIDATION', '普通任务修改不能改变 ID、看板或归档状态');
    }
  }

  mutateTask(id: string, fn: (current: WorkItem) => WorkItem): WorkItem {
    return this.transaction(() => {
      const current = this.requireActive(id);
      const next = fn(structuredClone(current));
      this.assertActiveMutation(current, next);
      this.data.tasks[next.id] = next;
      this.persist();
      return structuredClone(next);
    });
  }

  mutateTaskWithEvent(
    id: string,
    fn: (current: WorkItem) => { task: WorkItem; events: SessionEvent[] },
  ): { task: WorkItem; events: SessionEvent[] } {
    return this.transaction(() => {
      const current = this.requireActive(id);
      const { task, events } = fn(structuredClone(current));
      this.assertActiveMutation(current, task);
      this.data.tasks[task.id] = task;
      this.appendEventsLocked(task.id, events);
      this.persist();
      return { task: structuredClone(task), events: structuredClone(events) };
    });
  }

  mutateTasksWhere(
    fn: (task: WorkItem) => { task: WorkItem; events: SessionEvent[] } | null,
  ): WorkItem[] {
    return this.transaction(() => {
      const changed: WorkItem[] = [];
      for (const id of Object.keys(this.data.tasks)) {
        const r = fn(structuredClone(this.data.tasks[id]));
        if (!r) continue;
        this.assertActiveMutation(this.data.tasks[id], r.task);
        this.data.tasks[r.task.id] = r.task;
        this.appendEventsLocked(r.task.id, r.events);
        changed.push(r.task);
      }
      if (changed.length > 0) this.persist();
      return structuredClone(changed);
    });
  }

  /** 事务内向任务追加事件并遵守上限（不单独 persist，由调用方统一提交） */
  private appendEventsLocked(taskId: string, events: SessionEvent[]): void {
    if (events.length === 0) return;
    const rec = (this.data.sessions[taskId] ??= { taskId, events: [] });
    rec.events.push(...events);
    if (rec.events.length > MAX_EVENTS_PER_TASK) {
      rec.events.splice(0, rec.events.length - MAX_EVENTS_PER_TASK);
    }
  }

  /** 冷文件先落盘；主文件提交前的冷副本始终被主文件遮蔽。 */
  private archiveChanges(changes: TaskMutationResult[]): WorkItem[] {
    const archives = new Map<string, ArchiveData>();
    for (const { task, events } of changes) {
      if (!task.archivedAt || task.status !== 'done') this.invalidField(`tasks.${task.id}.archivedAt`);
      const archive = archives.get(task.boardId) ?? this.readArchive(task.boardId);
      archives.set(task.boardId, archive);
      archive.tasks[task.id] = task;
      const record = structuredClone(this.data.sessions[task.id] ?? { taskId: task.id, events: [] });
      record.events = [...record.events, ...events].slice(-MAX_EVENTS_PER_TASK);
      archive.sessions[task.id] = record;
    }
    for (const archive of archives.values()) this.persistArchive(archive);
    for (const { task } of changes) {
      delete this.data.tasks[task.id];
      delete this.data.sessions[task.id];
      this.data.archivedCounts[task.boardId] = (this.data.archivedCounts[task.boardId] ?? 0) + 1;
    }
    if (changes.length) this.persist();
    return structuredClone(changes.map(({ task }) => task));
  }

  moveToArchive(id: string, fn: TaskMutation): TaskMutationResult {
    return this.transaction(() => {
      const active = this.data.tasks[id];
      if (!active) {
        const archived = this.findArchived(id)?.tasks[id];
        if (!archived) throw new BoardError('TASK_NOT_FOUND', `任务不存在: ${id}`);
        return { task: structuredClone(archived), events: [] };
      }
      const change = fn(structuredClone(active));
      this.archiveChanges([change]);
      return structuredClone(change);
    });
  }

  moveTasksToArchive(boardId: string, fn: (task: WorkItem) => TaskMutationResult | null): WorkItem[] {
    return this.transaction(() => {
      const changes: TaskMutationResult[] = [];
      for (const task of Object.values(this.data.tasks)) {
        if (task.boardId !== boardId) continue;
        const change = fn(structuredClone(task));
        if (change) changes.push(change);
      }
      return this.archiveChanges(changes);
    });
  }

  restoreFromArchive(id: string, fn: TaskMutation): TaskMutationResult {
    return this.transaction(() => {
      const active = this.data.tasks[id];
      const archive = active ? this.readArchive(active.boardId) : this.findArchived(id);
      if (active) {
        // 恢复提交主文件后崩溃，重试只清理隐藏副本，不重复事件或递减计数。
        if (archive?.tasks[id]) {
          delete archive.tasks[id];
          delete archive.sessions[id];
          this.persistArchive(archive);
        }
        return { task: structuredClone(active), events: [] };
      }
      if (!archive) throw new BoardError('TASK_NOT_FOUND', `任务不存在: ${id}`);
      const change = fn(structuredClone(archive.tasks[id]));
      if (change.task.archivedAt) this.invalidField(`tasks.${id}.archivedAt`);
      this.data.tasks[id] = change.task;
      if (archive.sessions[id]) this.data.sessions[id] = structuredClone(archive.sessions[id]);
      this.appendEventsLocked(id, change.events);
      this.data.archivedCounts[archive.boardId] = Math.max(0, (this.data.archivedCounts[archive.boardId] ?? 0) - 1);
      // 主文件先写，随后删除冷副本；两步间读者仍只看到主文件版本。
      this.persist();
      delete archive.tasks[id];
      delete archive.sessions[id];
      this.persistArchive(archive);
      return structuredClone(change);
    });
  }

  deleteTask(id: string): boolean {
    return this.transaction(() => {
      if (!(id in this.data.tasks)) {
        if (this.findArchived(id)) throw new BoardError('TASK_ARCHIVED', `任务 ${id} 已归档，请先恢复后再修改`);
        return false;
      }
      // 恢复中断可能遗留被热任务遮蔽的副本；先清冷副本，删除热任务才不会复活它。
      const archive = this.readArchive(this.data.tasks[id].boardId);
      if (archive.tasks[id]) {
        delete archive.tasks[id];
        delete archive.sessions[id];
        this.persistArchive(archive);
      }
      delete this.data.tasks[id];
      // 会话/时间线与任务同生命周期：删除任务必须级联清理，避免 board.json 留孤儿记录
      delete this.data.sessions[id];
      this.persist();
      return true;
    });
  }

  nextId(): string {
    return this.transaction(() => {
      this.data.seq += 1;
      const id = `TASK-${this.data.seq}`;
      this.persist();
      return id;
    });
  }

  getSession(taskId: string): SessionRecord | undefined {
    this.reload();
    if (this.data.tasks[taskId]) {
      const record = this.data.sessions[taskId];
      return record ? structuredClone(record) : undefined;
    }
    return this.transaction(() => {
      const record = this.data.tasks[taskId] ? this.data.sessions[taskId] : this.findArchived(taskId)?.sessions[taskId];
      return record ? structuredClone(record) : undefined;
    });
  }

  appendEvent(taskId: string, event: SessionEvent): void {
    this.transaction(() => {
      this.requireActive(taskId);
      const rec = (this.data.sessions[taskId] ??= { taskId, events: [] });
      rec.events.push(event);
      if (rec.events.length > MAX_EVENTS_PER_TASK) {
        rec.events.splice(0, rec.events.length - MAX_EVENTS_PER_TASK);
      }
      this.persist();
    });
  }

  async withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.${taskId}.tlock`;
    const deadline = Date.now() + TASK_LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(lockPath, 'wx');
        try {
          writeSync(fd, LOCK_TOKEN);
        } finally {
          closeSync(fd);
        }
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          const st = statSync(lockPath);
          // 覆盖异步 git：阈值放宽，只有明显崩溃残留才抢占
          if (Date.now() - st.mtimeMs > TASK_LOCK_STALE_MS) {
            console.warn(`[tasklane] 抢占陈旧任务锁: ${lockPath}`);
            rmSync(lockPath, { force: true });
            continue;
          }
        } catch {
          /* 锁刚被他人释放，进入下一轮重试 */
        }
        if (Date.now() > deadline) {
          throw new BoardError('STORE_ERROR', `获取任务锁超时: ${taskId}`);
        }
        await new Promise((r) => setTimeout(r, TASK_LOCK_RETRY_MS));
      }
    }
    try {
      return await fn();
    } finally {
      releaseLock(lockPath);
    }
  }
}

function idNumber(id: string): number {
  const n = Number.parseInt(id.replace(/^TASK-/i, ''), 10);
  return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
}

/**
 * 任务列表排序：未完成任务按截止时间从近到远排在前（deadline 为 UTC ISO，
 * 字典序即时间序；无 deadline 靠后），done 任务不参与截止排序、保持 ID 序
 * 排在最后；各分组内以任务 ID 兜底，保证顺序稳定可复现。
 */
function compareTasks(a: WorkItem, b: WorkItem): number {
  const aDone = a.status === 'done';
  const bDone = b.status === 'done';
  if (aDone !== bDone) return aDone ? 1 : -1;
  if (!aDone && Boolean(a.deadline) !== Boolean(b.deadline)) return a.deadline ? -1 : 1;
  if (!aDone && a.deadline && b.deadline && a.deadline !== b.deadline) {
    return a.deadline < b.deadline ? -1 : 1;
  }
  return idNumber(a.id) - idNumber(b.id);
}

function freshBoardList(): Board[] {
  return [
    {
      id: 'default',
      name: process.env.TASKLANE_BOARD_NAME || 'Default Board',
      repo: process.env.TASKLANE_REPO || null,
      baseBranch: process.env.TASKLANE_BASE_BRANCH || 'main',
    },
  ];
}

function freshStore(): StoreData {
  return { version: STORE_VERSION, boards: freshBoardList(), tasks: {}, sessions: {}, seq: 100, archivedCounts: {} };
}

export function defaultStorePath(): string {
  const home = process.env.TASKLANE_HOME;
  return home
    ? path.join(home, 'board.json')
    : path.join(homedir(), '.tasklane', 'board.json');
}
