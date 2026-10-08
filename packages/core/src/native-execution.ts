import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { BoardError } from './errors.js';
import type { BoardStore, SessionEvent } from './board-store.js';
import type { GitService } from './git.js';
import {
  EXECUTION_MODEL_MAX_LENGTH,
  EXECUTION_MODEL_PATTERN,
  REVIEW_CONCLUSION_MAX_LENGTH,
  REVIEW_UPDATE_STATUSES,
  normalizeTaskId,
  type BindExternalSessionInput,
  type BindExecutionInput,
  type ClaimExecutionInput,
  type Execution,
  type ExecutionDeliveryInput,
  type ExecutionPurpose,
  type ExecutionRequest,
  type ReleaseExecutionInput,
  type ExecutionResult,
  type ReportExecutionInput,
  type RequestExecutionInput,
  type ReviewRound,
  type ReviewUpdate,
  type ReviewUpdateInput,
  type TaskReview,
  type WorkItem,
} from './work-item.js';

const TERMINAL = new Set(['completed', 'failed', 'rejected', 'cancelled']);
const AWAITING = new Set(['pending', 'delivered', 'claimed', 'created', 'bound', 'uncertain', 'blocked']);

function identifier(value: string, label: string, native = false): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\s\u0000-\u001f]/.test(value) ||
    (native && /^(sess-|pending|creating|placeholder|clientThreadId|client-new-thread:)/i.test(value))) {
    throw new BoardError('VALIDATION', `${label} 必须为就绪标识（不能使用内部 session 或创建中占位值）`);
  }
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

/** 目录当前存在且可访问（非 Git 工作区核验用）：返回真实路径，失效返回 null */
function accessibleDirectory(value: string): string | null {
  try {
    const real = realpathSync(value);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function sameResult(a: ExecutionResult, b: ExecutionResult): boolean {
  return a.threadId === b.threadId && a.hostId === b.hostId &&
    a.workspacePath === b.workspacePath && a.workspaceOwner === b.workspaceOwner && a.branch === b.branch;
}

function sameInput(request: ExecutionRequest, input: RequestExecutionInput, reviewWorkspace?: string): boolean {
  return request.action === input.action && request.workspaceMode === input.workspaceMode &&
    (request.purpose ?? 'implementation') === (input.purpose ?? 'implementation') &&
    request.workspacePath === reviewWorkspace &&
    request.hostId === input.hostId && request.receiverThreadId === input.receiverThreadId &&
    request.message === input.message && (request.model === input.model ||
      (request.recoveryOf !== undefined && input.model === undefined));
}

/** 目的对应的执行状态对象（review 未持久化时按 idle 读写，不落库） */
function executionOf(task: WorkItem, purpose: ExecutionPurpose): Execution {
  return purpose === 'review' ? task.reviewExecution ?? { state: 'idle' } : task.execution;
}

/** 目的对应的 Codex 绑定 */
function bindingOf(task: WorkItem, purpose: ExecutionPurpose) {
  return purpose === 'review' ? task.reviewBinding : task.executionBinding;
}

/** 同一 Codex 聊天（thread+host）不能同时充当实现与验收会话 */
function sharesCodexThread(implementation: ExecutionResult | undefined, review: ExecutionResult | undefined): boolean {
  return Boolean(implementation && review && implementation.threadId === review.threadId &&
    implementation.hostId === review.hostId);
}

export class NativeExecution {
  constructor(
    private readonly store: BoardStore,
    private readonly git: GitService,
    private readonly nowIso: () => string,
  ) {}

  private guard(task: WorkItem, boardId: string): void {
    identifier(boardId, 'boardId');
    if (task.boardId !== boardId) {
      throw new BoardError('BOARD_MISMATCH', `任务 ${task.id} 不属于看板 ${boardId}`);
    }
    if (task.archivedAt) throw new BoardError('TASK_ARCHIVED', `任务 ${task.id} 已归档，请先恢复`);
  }

  /** 验收受阻不能作为返工依据；只检查当前验收代次，不扫描历史阻塞记录。 */
  private guardImplementationReview(task: WorkItem): void {
    const currentReview = task.executionRequests?.find((request) =>
      request.purpose === 'review' && request.runId === task.reviewExecution?.runId);
    if (task.reviewExecution?.state === 'blocked' || currentReview?.status === 'blocked') {
      throw new BoardError('EXECUTION_CONFLICT', '验收受阻，不能继续修改；请先恢复验收、形成结论并结束本轮验收执行');
    }
  }

  private current(task: WorkItem, input: { boardId: string; requestId: string; runId: string }): ExecutionRequest {
    this.guard(task, input.boardId);
    identifier(input.requestId, 'requestId');
    identifier(input.runId, 'runId');
    const request = task.executionRequests?.find((r) => r.requestId === input.requestId);
    // 回执按请求自身 purpose 分流到对应执行状态：review 请求不得写实现执行代次
    const execution = request?.purpose === 'review' ? task.reviewExecution : task.execution;
    if (!request || request.runId !== input.runId || execution?.runId !== input.runId) {
      throw new BoardError('EXECUTION_STALE', '请求或运行代次已失效，不能覆盖当前执行');
    }
    if (request.status === 'cancelled') throw new BoardError('EXECUTION_STALE', '旧请求已人工恢复，不能再认领、绑定或回报');
    return request;
  }

  /** 按 purpose 写执行状态：review 请求只写 reviewExecution，实现执行状态不受影响 */
  private static setExecution(
    task: WorkItem,
    purpose: ExecutionPurpose,
    patch: (execution: Execution) => Execution,
  ): void {
    if (purpose === 'review') {
      task.reviewExecution = patch(task.reviewExecution ?? { state: 'idle' });
    } else {
      task.execution = patch(task.execution);
    }
  }

  /**
   * 事务闭包允许返回的结果形状：request 可选（review/外部会话事务没有请求对象）。
   * kind / detail / additionalEvents 仅用于时间线事件，不进入返回值，
   * 保持工具输出与既有 { task, request } 契约一致（幂等重放结果可 deepEqual）。
   */
  private transaction<R extends {
    request?: ExecutionRequest; kind?: SessionEvent['kind']; detail?: string;
    additionalEvents?: Omit<SessionEvent, 'at'>[];
  }>(
    id: string,
    boardId: string,
    change: (task: WorkItem, now: string) => R,
  ): { task: WorkItem } & Omit<R, 'kind' | 'detail' | 'additionalEvents'> {
    // 冷存储任务仍遵守 TASK_ARCHIVED 契约；存储事务会在锁内再次检查，
    // 防止本次读取之后另一进程完成归档而退化成 TASK_NOT_FOUND。
    const current = this.store.getTask(normalizeTaskId(id));
    if (current) this.guard(current, boardId);
    let captured: R | undefined;
    const now = this.nowIso();
    const { task } = this.store.mutateTaskWithEvent(normalizeTaskId(id), (task) => {
      const result = change(task, now);
      captured = result;
      const events: SessionEvent[] = result.kind ? [{ at: now, kind: result.kind, detail: result.detail }] : [];
      events.push(...(result.additionalEvents ?? []).map((event) => ({ ...event, at: now })));
      if (events.length) task.updatedAt = now;
      return { task, events };
    });
    const result = captured as R;
    const { kind, detail, additionalEvents, ...rest } = result;
    void kind; void detail; void additionalEvents;
    if (rest.request !== undefined) rest.request = structuredClone(rest.request);
    return { ...rest, task };
  }

  /**
   * Review 启动/续接前的实现工作区解析：按 executionBinding →
   * externalExecutionSession → task.worktreePath 收集来源；0 个来源拒绝启动，
   * 多个互不相同的来源视为上下文冲突。board 仓库不作工作区猜测来源。
   * 核验按看板类型分流：Git 项目校验仓库身份；非 Git 项目校验真实项目目录；
   * 无项目任务记录了存在、可访问的实际目录即可验收，不强制 Git 仓库。
   */
  async resolveReviewWorkspace(task: WorkItem): Promise<string> {
    const sources: string[] = [];
    if (task.executionBinding?.workspacePath) sources.push(task.executionBinding.workspacePath);
    if (task.externalExecutionSession?.workspacePath) sources.push(task.externalExecutionSession.workspacePath);
    if (task.worktreePath) sources.push(task.worktreePath);
    if (sources.length === 0) {
      throw new BoardError('REVIEW_WORKSPACE_REQUIRED', '无法确定实现工作区，Review 不能启动：请先绑定实现会话或记录真实工作区');
    }
    const distinct = [...new Set(sources.map((source) => canonicalPath(source)))];
    if (distinct.length > 1) {
      throw new BoardError(
        'REVIEW_WORKSPACE_CONFLICT',
        `存在多个互不相同的实现工作区（${distinct.join(' | ')}），不能猜测待验收目录；请先解决上下文冲突`,
      );
    }
    const workspace = distinct[0];
    if (!path.isAbsolute(workspace)) throw new BoardError('VALIDATION', `实现工作区必须是绝对路径: ${workspace}`);
    const board = this.store.getBoard(task.boardId);
    if (!board) throw new BoardError('BOARD_NOT_FOUND', `看板不存在: ${task.boardId}`);
    if (board.repoKey && board.repo) {
      // Git 项目：仓库身份核验（原语义不变）
      let workspaceKey: string;
      let repoKey: string;
      try {
        workspaceKey = (await this.git.identifyRepo(workspace)).repoKey;
        repoKey = (await this.git.identifyRepo(board.repo)).repoKey;
      } catch (err) {
        throw new BoardError(
          'REVIEW_WORKSPACE_REQUIRED',
          `待验收工作区已失效或不是有效 Git 仓库: ${workspace}（${err instanceof Error ? err.message : String(err)}）`,
        );
      }
      if (workspaceKey !== repoKey) throw new BoardError('GIT_ERROR', `待验收工作区属于其他仓库: ${workspace}`);
      return workspace;
    }
    if (!board.projectDir) {
      // 防御：无项目看板的 review 请求在入口已拒绝，这里不应到达
      throw new BoardError('VALIDATION', '无项目任务不参与 Review 流转');
    }
    // 非 Git 项目：按真实项目目录核验（存在、可访问），不调用必须依赖 Git 的仓库身份校验
    if (canonicalPath(board.projectDir) !== workspace) {
      throw new BoardError('VALIDATION', `待验收工作区不属于项目目录（期望 ${board.projectDir}）: ${workspace}`);
    }
    if (!accessibleDirectory(workspace)) {
      throw new BoardError('REVIEW_WORKSPACE_REQUIRED', `待验收工作区目录已失效或不可访问: ${workspace}`);
    }
    return workspace;
  }

  async request(input: RequestExecutionInput) {
    identifier(input.requestId, 'requestId');
    if (input.hostId !== undefined) identifier(input.hostId, 'hostId', true);
    if (input.receiverThreadId !== undefined) identifier(input.receiverThreadId, 'receiverThreadId', true);
    if (input.purpose !== undefined && !['implementation', 'review'].includes(input.purpose)) {
      throw new BoardError('VALIDATION', '非法执行目的 purpose（允许 implementation / review）');
    }
    const purpose: ExecutionPurpose = input.purpose ?? 'implementation';
    if (!['start', 'reply', 'continue', 'retry'].includes(input.action) ||
        !['project', 'worktree', 'existing', 'projectless'].includes(input.workspaceMode)) {
      throw new BoardError('VALIDATION', '非法执行动作或工作区模式');
    }
    if (purpose === 'review') {
      // Review 只有两类动作：首次验收 start（新建会话）与复查 continue（复用验收会话）
      if (!['start', 'continue'].includes(input.action)) {
        throw new BoardError('VALIDATION', 'Review 执行只支持 start / continue，回复与重试请使用实现会话');
      }
      if (input.workspaceMode !== 'existing') {
        throw new BoardError('VALIDATION', 'Review 必须复用实现工作区（workspaceMode=existing），不能另建工作区');
      }
    }
    if (input.message !== undefined && (typeof input.message !== 'string' || input.message.length > 20_000)) {
      throw new BoardError('VALIDATION', '完整回复不能超过 20,000 字符');
    }
    if (input.action === 'reply' && !input.message?.trim()) throw new BoardError('VALIDATION', '回复不能为空');
    if (input.model !== undefined) {
      if (input.action !== 'start') throw new BoardError('VALIDATION', '模型只能在创建新会话前选择，后续执行沿用原会话设置');
      if (typeof input.model !== 'string' || !input.model.trim() ||
        input.model.trim().length > EXECUTION_MODEL_MAX_LENGTH || !EXECUTION_MODEL_PATTERN.test(input.model.trim())) {
        throw new BoardError('VALIDATION', '模型 ID 必须为 1–128 字符，只允许字母、数字及 . _ : / -');
      }
      input = { ...input, model: input.model.trim() };
    }
    // Review 请求的服务端工作区解析含异步 Git 核验，必须在事务外完成；
    // 事务内基于磁盘状态重做全部业务守卫，绑定阶段还会再次核验漂移。
    let reviewWorkspace: string | undefined;
    if (purpose === 'review') {
      const task = this.store.getTask(normalizeTaskId(input.id));
      if (!task) throw new BoardError('TASK_NOT_FOUND', `任务不存在: ${normalizeTaskId(input.id)}`);
      this.guard(task, input.boardId);
      // 无项目任务不参与 Review 流转：没有待验收目录语义，独立验收会话无从谈起
      const board = this.store.getBoard(task.boardId);
      if (board && !board.projectDir && !board.repo) {
        throw new BoardError('VALIDATION', '无项目任务不参与 Review 流转，不支持独立验收执行');
      }
      reviewWorkspace = await this.resolveReviewWorkspace(task);
    }
    let created = false;
    const result = this.transaction(input.id, input.boardId, (task, now) => {
      this.guard(task, input.boardId);
      if (purpose === 'implementation') this.guardImplementationReview(task);
      const existing = task.executionRequests?.find((r) => r.requestId === input.requestId);
      if (existing) {
        if (!sameInput(existing, input, reviewWorkspace)) throw new BoardError('EXECUTION_CONFLICT', '相同 requestId 的请求内容不能改变');
        return { request: existing };
      }
      if (purpose === 'review') {
        const { request, merged } = this.createReviewRequest(task, now, input, reviewWorkspace!);
        created = !merged;
        return { request, kind: 'execution_requested', detail: `review ${request.action} ${request.requestId}` };
      }
      const current = task.executionRequests?.find((r) => r.runId === task.execution.runId);
      const blockedSource = current?.status === 'blocked' && input.action === 'continue' ? current : undefined;
      if (current && AWAITING.has(current.status) && !blockedSource) {
        if (sameInput(current, input)) return { request: current };
        throw new BoardError('EXECUTION_BUSY', '原请求仍待确认，请先核对已创建聊天和执行回执，不得重复创建');
      }
      if (current?.status === 'running') throw new BoardError('EXECUTION_BUSY', '当前执行尚未结束，不能并发启动另一轮');
      if (task.status === 'done') throw new BoardError('VALIDATION', '已完成任务需先回到 review 再请求执行');
      const board = this.store.getBoard(task.boardId);
      if (!board) throw new BoardError('BOARD_NOT_FOUND', `看板不存在: ${task.boardId}`);
      // 工作方式与看板类型匹配：无项目看板只能 projectless；项目目录可 project/
      // existing；worktree 需要 Git 能力（绑定阶段还会只读核验真实仓库身份）。
      if (input.workspaceMode === 'projectless') {
        if (board.projectDir || board.repo) {
          throw new BoardError('VALIDATION', '该看板已绑定项目目录，不能使用无项目执行；请在项目目录或工作区执行');
        }
      } else if (input.workspaceMode === 'worktree') {
        if (!board.projectDir && !board.repo) {
          throw new BoardError('VALIDATION', '无项目看板不能创建 worktree，请使用无项目执行（projectless）');
        }
        if (!board.repoKey || !board.repo) {
          throw new BoardError('VALIDATION', '非 Git 项目不能创建 worktree 执行；可在项目目录执行或原样复用旧工作区');
        }
      } else if (input.workspaceMode === 'project' && !board.projectDir && !board.repo) {
        throw new BoardError('VALIDATION', '无项目看板没有项目目录，请使用无项目执行（projectless）');
      }
      // 请求锚定的目录上下文：Git 仓库根或项目目录；projectless 为 null
      const boardRepo = board.repo ?? board.projectDir ?? null;
      const blockedResult = blockedSource ? blockedSource.result ?? task.executionBinding : undefined;
      if (blockedSource && !blockedResult) {
        throw new BoardError('EXECUTION_CONFLICT', '阻塞请求尚无真实会话结果，请先核对原创建操作并记录真实聊天，不能重新创建');
      }
      if (blockedResult && task.executionBinding && !sameResult(blockedResult, task.executionBinding)) {
        throw new BoardError('EXECUTION_CONFLICT', '阻塞结果与已有聊天绑定不一致，不能替换工作区');
      }
      if (blockedSource && input.workspaceMode !== blockedSource.workspaceMode) {
        throw new BoardError('EXECUTION_CONFLICT', '阻塞后的继续必须复用原聊天工作区模式');
      }
      const rejectedSource = current?.status === 'rejected' && current.result ? current : undefined;
      const recoverySource = blockedSource ?? rejectedSource ?? (!task.executionBinding
        ? [...(task.executionRequests ?? [])].reverse().find((candidate) => candidate.purpose === 'implementation' &&
          ['cancelled', 'rejected'].includes(candidate.status) && candidate.result)
        : undefined);
      if (recoverySource && !blockedSource && (input.workspaceMode !== recoverySource.workspaceMode ||
        (recoverySource.status === 'cancelled' ? input.model !== recoverySource.model :
          input.model !== undefined && input.model !== recoverySource.model))) {
        throw new BoardError('EXECUTION_CONFLICT', '已有创建结果必须复用原工作区方式和模型，不能重复创建聊天');
      }
      const recoveryResult = blockedResult ?? recoverySource?.result;
      if (recoveryResult && ((task.executionBinding && !sameResult(recoveryResult, task.executionBinding)) ||
        (input.hostId !== undefined && recoveryResult.hostId !== input.hostId))) {
        throw new BoardError('EXECUTION_CONFLICT', '失败分发的真实结果与原绑定或宿主不一致，不能更换聊天或工作区');
      }
      if (input.action === 'start') {
        if (task.executionBinding) throw new BoardError('EXECUTION_CONFLICT', '任务已有真实聊天，请继续原聊天');
        if (task.worktreePath && input.workspaceMode !== 'existing') {
          throw new BoardError('EXECUTION_CONFLICT', '已有工作区必须原样复用，不能另建或切回主仓库');
        }
        if (!task.worktreePath && input.workspaceMode === 'existing') {
          throw new BoardError('VALIDATION', '任务没有可复用的旧工作区');
        }
      } else {
        const binding = task.executionBinding ?? recoveryResult;
        if (!binding) throw new BoardError('EXECUTION_CONFLICT', '任务尚未绑定真实聊天');
        if (input.hostId !== undefined && binding.hostId !== input.hostId) throw new BoardError('EXECUTION_CONFLICT', '请求宿主与绑定宿主不一致');
        const original = blockedSource ?? task.executionRequests?.find((r) => r.result && sameResult(r.result, binding));
        const mode = original?.workspaceMode ?? (binding.workspaceOwner === 'user' ? 'project' : 'existing');
        if (mode !== input.workspaceMode) throw new BoardError('EXECUTION_CONFLICT', '后续执行必须复用原聊天工作区模式');
      }
      const request: ExecutionRequest = {
        requestId: input.requestId,
        runId: `run-${randomUUID()}`,
        taskId: task.id,
        boardId: task.boardId,
        purpose: 'implementation',
        action: input.action,
        workspaceMode: input.workspaceMode,
        ...(input.hostId !== undefined ? { hostId: input.hostId } : {}),
        ...(input.receiverThreadId !== undefined ? { receiverThreadId: input.receiverThreadId } : {}),
        repo: boardRepo,
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.model !== undefined ? { model: input.model } : recoverySource?.model !== undefined ? { model: recoverySource.model } : {}),
        ...(recoverySource && recoveryResult ? {
          result: structuredClone(recoveryResult),
          recoveryOf: { requestId: recoverySource.requestId, runId: recoverySource.runId },
        } : {}),
        status: 'pending',
        requestedAt: now,
        updatedAt: now,
      };
      task.executionRequests = [...(task.executionRequests ?? []), request];
      // 标识跟随持久化的执行意图；请求提交不证明目标 Agent 已经开始运行。
      task.assignee = 'agent';
      task.execution = { ...task.execution, runId: request.runId, state: 'starting', activity: '等待宿主执行回执', updatedAt: now };
      delete task.execution.startedAt;
      created = true;
      return { request, kind: 'execution_requested', detail: `${request.action} ${request.requestId}` };
    });
    return { ...result, created };
  }

  /**
   * review 请求创建（锁内，基于磁盘最新状态执行全部 Review 守卫）：
   * start 仅限 pending 且无验收绑定；continue 仅限 recheck_pending 且工作区未漂移。
   * 返回 merged=true 表示同内容待确认请求已存在（幂等合并不重复投递）。
   */
  private createReviewRequest(
    task: WorkItem,
    now: string,
    input: RequestExecutionInput,
    workspace: string,
  ): { request: ExecutionRequest; merged: boolean } {
    if (task.status !== 'review') throw new BoardError('VALIDATION', '任务不在 review 列，验收执行要求 Task.status = review');
    const review = task.review ?? { status: 'pending' as const, revision: 0, rounds: [] as ReviewRound[], updatedAt: now };
    const current = task.executionRequests?.find((r) => r.purpose === 'review' && r.runId === task.reviewExecution?.runId);
    if (current?.recoveryOf && AWAITING.has(current.status)) {
      if (sameInput(current, input, workspace)) return { request: current, merged: true };
      throw new BoardError('EXECUTION_BUSY', '原验收请求仍待确认，请先核对已创建聊天和验收回执，不得重复创建');
    }
    const recoverySource = current?.status === 'rejected' && current.result ? current : undefined;
    if (recoverySource) {
      if (canonicalPath(recoverySource.result!.workspacePath!) !== canonicalPath(workspace) ||
        (task.reviewBinding && !sameResult(recoverySource.result!, task.reviewBinding))) {
        throw new BoardError('REVIEW_WORKSPACE_CONFLICT', '失败验收分发的工作区已变化，不能重建或替换原验收聊天');
      }
      if (input.workspaceMode !== recoverySource.workspaceMode ||
        (input.model !== undefined && input.model !== recoverySource.model) ||
        (input.hostId !== undefined && input.hostId !== recoverySource.result!.hostId)) {
        throw new BoardError('EXECUTION_CONFLICT', '重新发起验收必须复用原工作方式、模型和宿主');
      }
    }
    if (input.action === 'start') {
      if (task.reviewBinding && !recoverySource) throw new BoardError('EXECUTION_CONFLICT', '任务已有验收会话，请继续原验收聊天');
      if (review.status !== 'pending') {
        throw new BoardError('EXECUTION_CONFLICT', `Review 状态为 ${review.status}，仅 pending 可首次启动验收`);
      }
    } else {
      if (!task.reviewBinding && !recoverySource) throw new BoardError('EXECUTION_CONFLICT', '尚未绑定验收会话，请先启动 Review');
      if (review.status !== 'recheck_pending') {
        throw new BoardError('EXECUTION_CONFLICT', `Review 状态为 ${review.status}，仅 recheck_pending 可继续验收`);
      }
      // 每次继续验收重新核对实现工作区：漂移时拒绝，旧 reviewBinding 不能冒充当前 Reviewer
      const boundWorkspace = task.reviewBinding?.workspacePath ?? recoverySource?.result?.workspacePath;
      if (boundWorkspace === undefined || canonicalPath(boundWorkspace) !== canonicalPath(workspace)) {
        throw new BoardError(
          'REVIEW_WORKSPACE_CONFLICT',
          `实现工作区已变化（当前解析为 ${workspace}，验收绑定 ${boundWorkspace ?? '未记录'}），请先解决工作区冲突`,
        );
      }
    }
    if (current && AWAITING.has(current.status)) {
      if (sameInput(current, input, workspace)) return { request: current, merged: true };
      throw new BoardError('EXECUTION_BUSY', '原验收请求仍待确认，请先核对已创建聊天和验收回执，不得重复创建');
    }
    if (current?.status === 'running') throw new BoardError('EXECUTION_BUSY', '当前验收尚未结束，不能并发启动另一轮');
    if (current?.status === 'blocked') {
      throw new BoardError('EXECUTION_CONFLICT', '验收请求处于阻塞状态，请先通过核对恢复流程解除或确认结果');
    }
    const board = this.store.getBoard(task.boardId);
    if (!board) throw new BoardError('BOARD_NOT_FOUND', `看板不存在: ${task.boardId}`);
    // Review 请求锚定的目录上下文：Git 仓库根或项目目录（无项目看板为 null，
    // 解析出的实际目录已记录在 request.workspacePath）
    const boardRepo = board.repo ?? board.projectDir ?? null;
    const request: ExecutionRequest = {
      requestId: input.requestId,
      runId: `run-${randomUUID()}`,
      taskId: task.id,
      boardId: task.boardId,
      purpose: 'review',
      action: input.action,
      workspaceMode: 'existing',
      ...(input.hostId !== undefined ? { hostId: input.hostId } : {}),
      ...(input.receiverThreadId !== undefined ? { receiverThreadId: input.receiverThreadId } : {}),
      repo: boardRepo,
      workspacePath: workspace,
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.model !== undefined ? { model: input.model } : recoverySource?.model !== undefined ? { model: recoverySource.model } : {}),
      ...(recoverySource ? {
        result: structuredClone(recoverySource.result!),
        recoveryOf: { requestId: recoverySource.requestId, runId: recoverySource.runId },
      } : {}),
      status: 'pending',
      requestedAt: now,
      updatedAt: now,
    };
    task.executionRequests = [...(task.executionRequests ?? []), request];
    // 验收执行状态独立推进：不改派任务负责人，也不触碰实现执行状态
    task.reviewExecution = { state: 'starting', activity: '等待宿主验收回执', runId: request.runId, updatedAt: now };
    return { request, merged: false };
  }

  /**
   * task_execution_recover（app-only）：用户在 UI 显式确认旧会话已结束，解除仍在
   * 等待宿主回执的执行请求。核对 Agent 观测举证流程已移除：观测者就是用户本人，
   * 守卫收敛为「仅等待态可解除 + 非空原因 + 幂等重放」；解除即取消该请求并复位
   * 执行状态，已有创建结果后续必须复用（recoveryOf），禁止重建。运行中的真实状态
   * 变化仍只能由目标会话通过回执写入，本方法不是停止证明。
   */
  async release(input: ReleaseExecutionInput) {
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length > 200) throw new BoardError('VALIDATION', '解除等待须提供非空原因（最多 200 字符）');
    const result = this.transaction(input.id, input.boardId, (task, now) => {
      this.guard(task, input.boardId);
      const request = task.executionRequests?.find((candidate) => candidate.requestId === input.requestId);
      if (!request || request.runId !== input.runId || executionOf(task, request.purpose)?.runId !== input.runId) {
        throw new BoardError('EXECUTION_STALE', '请求或运行代次已变化');
      }
      // 已解除的请求幂等返回：重复点击或重放不重复复位执行状态
      if (request.status === 'cancelled') return { request, changed: false };
      if (!AWAITING.has(request.status)) throw new BoardError('EXECUTION_CONFLICT', '请求已不在等待状态，不能解除');
      request.status = 'cancelled';
      request.updatedAt = now;
      request.recovery = { at: now, reason, confirmedStopped: true, releasedBy: 'user' };
      if (request.purpose === 'review') {
        // 验收请求解除等待只重置 reviewExecution，实现执行状态不受影响
        task.reviewExecution = { state: 'idle', activity: 'User confirmed the old session ended; wait released, please re-initiate review execution', updatedAt: now };
        delete task.reviewExecution.runId;
      } else {
        task.execution = { ...task.execution, state: task.assignee === 'agent' ? 'assigned' : 'idle',
          activity: 'User confirmed the old session ended; wait released, please re-initiate execution', updatedAt: now };
        delete task.execution.startedAt;
      }
      return { request, changed: true, kind: 'execution_recovered', detail: reason };
    });
    return result;
  }

  async delivery(input: ExecutionDeliveryInput) {
    if (!['delivered', 'uncertain', 'blocked', 'rejected'].includes(input.status)) throw new BoardError('VALIDATION', '非法投递状态');
    if (input.error !== undefined && (typeof input.error !== 'string' || input.error.length > 200)) {
      throw new BoardError('VALIDATION', '投递错误摘要最多 200 字符');
    }
    if (input.claimId !== undefined) identifier(input.claimId, 'claimId');
    if (input.status === 'rejected' && !input.error?.trim()) throw new BoardError('VALIDATION', '明确拒绝必须提供非空错误摘要');
    if (input.status === 'blocked' && (!input.claimId || !input.error?.trim())) throw new BoardError('VALIDATION', '阻塞回执必须提供原认领和非空原因');
    return this.transaction(input.id, input.boardId, (task, now) => {
      const request = this.current(task, input);
      if (input.status === 'blocked') {
        this.assertClaim(request, input.claimId!);
        // 绑定后的阻塞必须由目标聊天回报；这里只记录认领、创建与核验阶段的阻塞。
        if (!['claimed', 'created', 'uncertain', 'blocked'].includes(request.status) ||
          request.reports?.some((report) => report.state === 'blocked')) return { request };
        if (request.status === 'blocked' && request.deliveryError === input.error) return { request };
        request.status = 'blocked';
        request.deliveryError = input.error;
        request.updatedAt = now;
        NativeExecution.setExecution(task, request.purpose, (execution) => ({ ...execution, state: 'blocked', activity: input.error, updatedAt: now }));
        return { request, kind: 'blocked', detail: input.error };
      }
      if (request.status === 'rejected') {
        if (input.claimId !== undefined) this.assertClaim(request, input.claimId);
        return { request };
      }
      const claimedUncertain = input.status === 'uncertain' && input.claimId !== undefined;
      if (claimedUncertain) {
        this.assertClaim(request, input.claimId!);
        if (request.status === 'created' && request.result) {
          // 已创建的聊天标识完整保留；绑定失败只补写原因，不伪造已运行或降级创建结果。
          const activity = input.error ?? '工作区绑定结果待确认，请核对已创建聊天和工作区';
          if (request.deliveryError === input.error && executionOf(task, request.purpose).activity === activity) return { request };
          request.deliveryError = input.error;
          request.updatedAt = now;
          NativeExecution.setExecution(task, request.purpose, (execution) => ({ ...execution, activity, updatedAt: now }));
          return { request, kind: 'execution_uncertain', detail: input.error };
        }
        // 认领者可以报告原生创建结果未知；已绑定和执行回执不能倒退。
        if (request.result || !['claimed', 'uncertain'].includes(request.status)) return { request };
      } else if (input.status === 'rejected' && input.claimId !== undefined) {
        this.assertClaim(request, input.claimId);
        // 所有明确分发失败统一结束启动等待；已创建结果必须保留供下一次请求复用。
        // 目标的任意真实回执都证明已接手，不能再由分发者回退为未分发。
        if (request.startedAt !== undefined || request.reports?.length ||
          !['claimed', 'created', 'bound', 'uncertain', 'blocked'].includes(request.status)) {
          throw new BoardError('EXECUTION_CONFLICT', '已有目标执行回执或本轮分发已结束，不能记录为分发失败');
        }
      } else {
        // 原面板的迟到响应不能覆盖接收 Agent 已认领的工作。
        if (!['pending', 'delivered', 'uncertain'].includes(request.status) || request.claimId) return { request };
      }
      if (input.status === 'rejected') {
        request.status = 'rejected';
        request.updatedAt = now;
        request.deliveryError = input.error;
        if (request.purpose === 'review') {
          // 保留本轮 runId 支持拒绝幂等；下一次用户请求才替换代次，迟到回执不能运行。
          task.reviewExecution = { state: 'idle', runId: request.runId, activity: input.error, updatedAt: now };
        } else {
          task.execution = { ...task.execution, state: task.assignee === 'agent' ? 'assigned' : 'idle', activity: input.error, updatedAt: now };
          delete task.execution.startedAt;
        }
        return { request, kind: 'execution_rejected', detail: input.error };
      }
      // 消息响应可能晚于目标聊天的真实回执，不能倒退已确认的执行阶段。
      if (request.status === input.status && request.deliveryError === input.error) return { request };
      // 已确认投递优先于迟到的超时回执：delivered 是消息通道的确认结果，
      // 迟到 error 只描述"结果未知"，不能把确认降级回 uncertain（认领前窗口）。
      if (request.status === 'delivered' && input.status === 'uncertain') return { request };
      request.status = input.status;
      request.updatedAt = now;
      request.deliveryError = input.status === 'uncertain' ? input.error : undefined;
      if (claimedUncertain) {
        NativeExecution.setExecution(task, request.purpose, (execution) =>
          ({ ...execution, activity: input.error ?? '原生创建结果待确认，请核对已创建聊天和工作区', updatedAt: now }));
      }
      return { request, kind: input.status === 'delivered' ? 'execution_delivered' : 'execution_uncertain', detail: input.error };
    });
  }

  async claim(input: ClaimExecutionInput) {
    identifier(input.claimId, 'claimId');
    if ((input.hostId === undefined) !== (input.receiverThreadId === undefined)) {
      throw new BoardError('VALIDATION', '真实接收者的 hostId 和 receiverThreadId 必须同时提供');
    }
    if (input.hostId !== undefined) identifier(input.hostId, 'hostId', true);
    if (input.receiverThreadId !== undefined) identifier(input.receiverThreadId, 'receiverThreadId', true);
    let claimed = false;
    const result = this.transaction(input.id, input.boardId, (task, now) => {
      const request = this.current(task, input);
      if (request.purpose === 'implementation') this.guardImplementationReview(task);
      if (request.status === 'rejected') throw new BoardError('EXECUTION_STALE', '请求已明确拒绝，不能重新认领');
      const hostId = input.hostId ?? request.hostId;
      const threadId = input.receiverThreadId ?? request.receiverThreadId;
      if (!hostId || !threadId) throw new BoardError('VALIDATION', '请求无完整原路由，认领必须提供核对后的真实接收者');
      if ((request.hostId !== undefined && request.hostId !== hostId) ||
        (request.receiverThreadId !== undefined && request.receiverThreadId !== threadId) ||
        (bindingOf(task, request.purpose) !== undefined && bindingOf(task, request.purpose)!.hostId !== hostId) ||
        (request.result !== undefined && request.result.hostId !== hostId)) {
        throw new BoardError('EXECUTION_CONFLICT', '真实接收者与请求路由或绑定宿主不匹配');
      }
      if (request.claimId) {
        if (request.claimId !== input.claimId) throw new BoardError('EXECUTION_CONFLICT', '请求已被认领；禁止重复创建或自动抢占');
        if (request.receiver && (request.receiver.hostId !== hostId || request.receiver.threadId !== threadId)) {
          throw new BoardError('EXECUTION_CONFLICT', '同一认领不能替换真实接收者');
        }
        return { request };
      }
      if (TERMINAL.has(request.status)) throw new BoardError('EXECUTION_STALE', '请求已结束，不能重新认领');
      request.claimId = input.claimId;
      request.receiver = { hostId, threadId };
      request.status = 'claimed';
      request.updatedAt = now;
      claimed = true;
      return { request, kind: 'execution_claimed', detail: request.requestId };
    });
    return { ...result, claimed };
  }

  private assertClaim(request: ExecutionRequest, claimId: string): void {
    identifier(claimId, 'claimId');
    if (!request.claimId || request.claimId !== claimId) throw new BoardError('EXECUTION_CONFLICT', '绑定必须匹配原请求的认领记录');
  }

  private assertHost(request: ExecutionRequest, hostId: string): void {
    // 已认领的旧 v4 请求沿用原宿主，读取时不改写历史真实数据。
    const resolvedHost = request.receiver?.hostId ?? (request.claimId ? request.hostId : undefined);
    if (!resolvedHost || resolvedHost !== hostId) throw new BoardError('EXECUTION_CONFLICT', '宿主必须匹配已核对的真实接收者');
  }

  /**
   * bound 阶段的只读工作区核验（异步 Git 校验留在这里，created 阶段不阻塞保存）：
   * - projectless：不锚定任何目录，不猜测归属，也不做 Git 校验；
   * - project：工作区必须等于看板目录（Git 主仓库根或非 Git 项目目录）且 user 持有；
   * - worktree：独立工作区由 Codex 创建管理，仅 Git 项目可用；
   * - existing：原样复用任务已记录的旧工作区。
   * Git 看板同时校验仓库身份与分支；非 Git 项目以路径等价核验，不伪造 Git 校验。
   */
  private async validateWorkspace(task: WorkItem, request: ExecutionRequest, result: ExecutionResult): Promise<void> {
    if (request.workspaceMode === 'projectless') {
      if (result.workspacePath !== undefined || result.branch !== undefined) {
        throw new BoardError('VALIDATION', '无项目执行不记录工作区或分支');
      }
      return;
    }
    if (result.workspacePath === undefined) {
      throw new BoardError('VALIDATION', '该工作方式必须记录实际执行目录（workspacePath）');
    }
    if (!path.isAbsolute(result.workspacePath)) throw new BoardError('VALIDATION', 'workspacePath 必须为绝对路径');
    const board = this.store.getBoard(task.boardId);
    if (!board) throw new BoardError('BOARD_NOT_FOUND', `看板不存在: ${task.boardId}`);
    const isGit = Boolean(board.repoKey && board.repo);
    if (request.workspaceMode === 'project' || request.workspaceMode === 'worktree' || request.repo !== null) {
      // projectless 请求（repo=null）没有目录上下文可漂移；其余请求锚定看板目录
      const context = board.repo ?? board.projectDir ?? null;
      if (!context || !request.repo || canonicalPath(context) !== canonicalPath(request.repo)) {
        throw new BoardError('EXECUTION_CONFLICT', '请求的项目/仓库上下文已改变');
      }
    }
    if (isGit) {
      const workspace = await this.git.identifyRepo(result.workspacePath);
      const repo = await this.git.identifyRepo(board.repo!);
      if (workspace.repoKey !== repo.repoKey) throw new BoardError('GIT_ERROR', '执行目录属于其他仓库');
    } else if (request.workspaceMode === 'worktree') {
      throw new BoardError('GIT_ERROR', '非 Git 项目不能创建 worktree 执行');
    }
    if (task.executionBinding && !sameResult(task.executionBinding, result)) {
      throw new BoardError('EXECUTION_CONFLICT', '已有聊天及工作区绑定不能改变');
    }
    if (request.workspaceMode === 'project') {
      const expectedDir = board.repo ?? board.projectDir!;
      if (canonicalPath(result.workspacePath) !== canonicalPath(expectedDir) || result.workspaceOwner !== 'user') {
        throw new BoardError('GIT_ERROR', '项目目录执行必须使用看板目录（Git 主仓库根或项目目录）并由用户持有');
      }
      if (isGit) {
        if (result.branch) await this.git.assertWorktreeMatches(result.workspacePath, board.repo!, result.branch);
      } else if (result.branch !== undefined) {
        throw new BoardError('VALIDATION', '非 Git 项目没有分支信息，不能伪造分支');
      }
    } else if (request.workspaceMode === 'existing') {
      const expected = task.executionBinding?.workspacePath ?? task.worktreePath;
      const owner = task.executionBinding?.workspaceOwner ?? 'tasklane';
      if (!expected || canonicalPath(expected) !== canonicalPath(result.workspacePath) || result.workspaceOwner !== owner) {
        throw new BoardError('GIT_ERROR', '旧工作区必须原样复用，不允许静默切换或另建');
      }
      if (isGit) {
        if (!result.branch || (task.branch && task.branch !== result.branch)) {
          throw new BoardError('GIT_ERROR', '工作区分支必须匹配任务绑定');
        }
        await this.git.assertWorktreeMatches(result.workspacePath, board.repo!, result.branch);
      } else if ((task.branch || result.branch) && task.branch !== result.branch) {
        throw new BoardError('GIT_ERROR', '工作区分支必须匹配任务绑定');
      }
    } else {
      if (!isGit || !board.repo) throw new BoardError('GIT_ERROR', '非 Git 项目不能创建 worktree 执行');
      if (result.workspaceOwner !== 'codex' || canonicalPath(result.workspacePath) === canonicalPath(board.repo)) {
        throw new BoardError('GIT_ERROR', '独立工作区必须由 Codex 创建管理，不能使用主仓库');
      }
      if (!result.branch || (task.branch && task.branch !== result.branch)) {
        throw new BoardError('GIT_ERROR', '工作区分支必须匹配任务绑定');
      }
      await this.git.assertWorktreeMatches(result.workspacePath, board.repo, result.branch);
    }
  }

  /**
   * review 绑定的只读核验：复用实现工作区、不与实现聊天共用线程；
   * Git 项目校验仓库身份，非 Git / 无项目看板按真实目录核验（不调用
   * 必须依赖 Git 的身份校验，也不伪造分支信息）。
   */
  private async validateReviewWorkspace(task: WorkItem, request: ExecutionRequest, result: ExecutionResult): Promise<void> {
    if (result.workspacePath === undefined || !path.isAbsolute(result.workspacePath)) {
      throw new BoardError('VALIDATION', '验收会话必须记录实际待验收目录（workspacePath）');
    }
    const board = this.store.getBoard(task.boardId);
    if (!board) throw new BoardError('BOARD_NOT_FOUND', `看板不存在: ${task.boardId}`);
    const context = board.repo ?? board.projectDir ?? null;
    // projectless 请求（repo=null）要求看板同样没有目录上下文；其余请求锚定看板目录
    if (request.repo === null ? context !== null : context === null || canonicalPath(context) !== canonicalPath(request.repo)) {
      throw new BoardError('EXECUTION_CONFLICT', '请求的项目/仓库上下文已改变');
    }
    if (sharesCodexThread(task.executionBinding, result)) {
      throw new BoardError('EXECUTION_CONFLICT', 'Review 会话不能复用实现聊天：实现与验收必须是不同 Codex 会话');
    }
    if (task.reviewBinding && !sameResult(task.reviewBinding, result)) {
      throw new BoardError('EXECUTION_CONFLICT', '已有验收聊天及工作区绑定不能改变');
    }
    if (request.workspacePath !== undefined && canonicalPath(request.workspacePath) !== canonicalPath(result.workspacePath)) {
      throw new BoardError('EXECUTION_CONFLICT', '绑定工作区与请求解析的实现工作区不一致');
    }
    if (board.repoKey && board.repo) {
      const workspace = await this.git.identifyRepo(result.workspacePath).catch(() => null);
      const repo = await this.git.identifyRepo(board.repo).catch(() => null);
      if (!workspace || !repo) throw new BoardError('GIT_ERROR', `待验收工作区不是有效 Git 仓库: ${result.workspacePath}`);
      if (workspace.repoKey !== repo.repoKey) throw new BoardError('GIT_ERROR', '验收目录属于其他仓库');
      if (result.branch !== undefined) await this.git.assertWorktreeMatches(result.workspacePath, board.repo, result.branch);
      return;
    }
    if (!accessibleDirectory(result.workspacePath)) {
      throw new BoardError('GIT_ERROR', `待验收工作区目录已失效或不可访问: ${result.workspacePath}`);
    }
    if (result.branch !== undefined) throw new BoardError('VALIDATION', '非 Git 项目工作区没有分支信息，不能伪造分支');
  }

  async bind(input: BindExecutionInput) {
    identifier(input.threadId, 'threadId', true);
    identifier(input.hostId, 'hostId', true);
    if (!['created', 'bound'].includes(input.phase)) {
      throw new BoardError('VALIDATION', '非法绑定阶段');
    }
    // 工作区字段成对提供或成对省略：projectless 尚未确定目录时允许先保存真实会话
    const hasWorkspace = input.workspacePath !== undefined;
    if (hasWorkspace !== (input.workspaceOwner !== undefined)) {
      throw new BoardError('VALIDATION', 'workspacePath 与 workspaceOwner 必须成对提供或成对省略');
    }
    if (hasWorkspace) {
      if (!['codex', 'tasklane', 'user'].includes(input.workspaceOwner!)) {
        throw new BoardError('VALIDATION', '非法工作区所有者');
      }
      if (typeof input.workspacePath !== 'string' || !path.isAbsolute(input.workspacePath)) {
        throw new BoardError('VALIDATION', 'workspacePath 必须为绝对路径');
      }
    }
    if (input.branch !== undefined && (typeof input.branch !== 'string' || !input.branch.trim() || input.branch.length > 200)) throw new BoardError('VALIDATION', 'branch 无效');
    const result: ExecutionResult = {
      threadId: input.threadId,
      hostId: input.hostId,
      ...(hasWorkspace ? { workspacePath: input.workspacePath, workspaceOwner: input.workspaceOwner } : {}),
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
    };
    if (input.phase === 'created') {
      // 先锁内保存原生工具的就绪结果，Git 暂不可读也不能丢失已创建的真实聊天。
      // 这里仅校验关联和不可替换规则，实际工作区核验留给 bound 阶段。
      return this.transaction(input.id, input.boardId, (task, now) => {
        const request = this.current(task, input);
        this.assertClaim(request, input.claimId);
        this.assertHost(request, input.hostId);
        if (request.workspaceMode === 'projectless') {
          // 无项目执行不记录工作区：会话之外没有目录语义可更新
          if (result.workspacePath !== undefined || result.branch !== undefined) {
            throw new BoardError('VALIDATION', '无项目执行不记录工作区或分支，绑定只需真实会话标识');
          }
        } else if (result.workspacePath === undefined) {
          throw new BoardError('VALIDATION', '该工作方式必须在 created 阶段记录实际执行目录（workspacePath）');
        }
        const binding = bindingOf(task, request.purpose);
        if ((request.result && !sameResult(request.result, result)) ||
          (binding && !sameResult(binding, result))) {
          throw new BoardError('EXECUTION_CONFLICT', '原生创建结果或已有绑定不能被替换');
        }
        // review 结果在 created 阶段就拒绝复用实现聊天，避免先落库再返工
        if (request.purpose === 'review' && sharesCodexThread(task.executionBinding, result)) {
          throw new BoardError('EXECUTION_CONFLICT', 'Review 会话不能复用实现聊天：实现与验收必须是不同 Codex 会话');
        }
        if (TERMINAL.has(request.status)) throw new BoardError('EXECUTION_STALE', '请求已经结束');
        if (request.result) return { request };
        request.result = result;
        request.status = 'created';
        request.updatedAt = now;
        return { request, kind: 'execution_created', detail: result.threadId };
      });
    }
    const task = this.store.getTask(normalizeTaskId(input.id));
    if (!task) throw new BoardError('TASK_NOT_FOUND', `任务不存在: ${input.id}`);
    const request = this.current(task, input);
    this.assertClaim(request, input.claimId);
    this.assertHost(request, input.hostId);
    if (!request.result) throw new BoardError('EXECUTION_CONFLICT', '请先持久记录 phase=created 的就绪结果，再绑定');
    if (request.workspaceMode === 'projectless' && (result.workspacePath !== undefined || result.branch !== undefined)) {
      throw new BoardError('VALIDATION', '无项目执行不记录工作区或分支，绑定只需真实会话标识');
    }
    if (!sameResult(request.result, result)) throw new BoardError('EXECUTION_CONFLICT', '原生创建结果不能被替换');
    if (request.purpose === 'review') {
      await this.validateReviewWorkspace(task, request, result);
    } else {
      await this.validateWorkspace(task, request, result);
    }
    return this.transaction(input.id, input.boardId, (latest, now) => {
      const current = this.current(latest, input);
      this.assertClaim(current, input.claimId);
      this.assertHost(current, input.hostId);
      // Git 只读校验有异步间隙，锁内重查目标工作区字段，不写回旧任务副本。
      if (latest.worktreePath !== task.worktreePath || latest.branch !== task.branch ||
        JSON.stringify(latest.executionBinding) !== JSON.stringify(task.executionBinding) ||
        JSON.stringify(latest.reviewBinding) !== JSON.stringify(task.reviewBinding) ||
        JSON.stringify(latest.externalExecutionSession) !== JSON.stringify(task.externalExecutionSession)) {
        throw new BoardError('EXECUTION_CONFLICT', '校验期间工作区绑定已改变，请重新读取');
      }
      if (current.result && !sameResult(current.result, result)) throw new BoardError('EXECUTION_CONFLICT', '原生创建结果冲突');
      if (TERMINAL.has(current.status)) throw new BoardError('EXECUTION_STALE', '请求已经结束');
      if (!current.result) throw new BoardError('EXECUTION_CONFLICT', '请先持久记录 phase=created 的就绪结果，再绑定');
      if (current.purpose === 'review') {
        if (sharesCodexThread(latest.executionBinding, result)) {
          throw new BoardError('EXECUTION_CONFLICT', 'Review 会话不能复用实现聊天');
        }
        if (latest.reviewBinding) {
          if (!sameResult(latest.reviewBinding, result)) throw new BoardError('EXECUTION_CONFLICT', '任务已有不同验收聊天绑定');
          if (!['claimed', 'created', 'uncertain', 'blocked'].includes(current.status)) return { request: current };
        } else {
          latest.reviewBinding = { ...result, provider: 'codex-desktop', boundAt: now };
        }
      } else if (latest.executionBinding) {
        if (!sameResult(latest.executionBinding, result)) throw new BoardError('EXECUTION_CONFLICT', '任务已有不同真实聊天绑定');
        if (!['claimed', 'created', 'uncertain', 'blocked'].includes(current.status)) return { request: current };
      } else {
        latest.executionBinding = { ...result, provider: 'codex-desktop', boundAt: now };
        if (current.repo) latest.repo ??= current.repo;
        if (result.branch !== undefined) latest.branch ??= result.branch;
        if (current.workspaceMode !== 'project' && result.workspacePath !== undefined) {
          latest.worktreePath ??= result.workspacePath;
        }
      }
      current.status = 'bound';
      current.updatedAt = now;
      return { request: current, kind: 'execution_bound', detail: result.threadId };
    });
  }

  async report(input: ReportExecutionInput) {
    identifier(input.threadId, 'threadId', true);
    identifier(input.hostId, 'hostId', true);
    identifier(input.reportId, 'reportId');
    if (!['running', 'waiting', 'blocked', 'failed', 'completed'].includes(input.state)) throw new BoardError('VALIDATION', '非法执行回执状态');
    if (input.activity !== undefined && (typeof input.activity !== 'string' || input.activity.length > 200)) {
      throw new BoardError('VALIDATION', '活动摘要最多 200 字符');
    }
    if (input.state === 'blocked' && !input.activity?.trim()) throw new BoardError('VALIDATION', '阻塞回执必须提供非空原因');
    return this.transaction(input.id, input.boardId, (task, now) => {
      const request = this.current(task, input);
      const binding = bindingOf(task, request.purpose);
      this.assertHost(request, input.hostId);
      if (!binding || binding.threadId !== input.threadId || binding.hostId !== input.hostId) {
        throw new BoardError(
          'EXECUTION_CONFLICT',
          request.purpose === 'review' ? '回执必须匹配任务真实验收聊天和宿主绑定' : '回执必须匹配任务真实聊天和宿主绑定',
        );
      }
      if (!request.claimId || !request.result || !sameResult(request.result, binding) ||
        !['bound', 'running', 'waiting', 'blocked', 'completed', 'failed'].includes(request.status) ||
        (request.status === 'blocked' && !request.reports?.some((report) => report.state === 'blocked'))) {
        throw new BoardError('EXECUTION_CONFLICT', '本轮请求尚未完成绑定，不能上报执行');
      }
      const existing = request.reports?.find((r) => r.reportId === input.reportId);
      if (existing) {
        if (existing.state !== input.state || existing.activity !== input.activity) throw new BoardError('EXECUTION_CONFLICT', '同一回执标识不能更改内容');
        return { request };
      }
      if (TERMINAL.has(request.status)) throw new BoardError('EXECUTION_STALE', '已完成或失败的执行不能被迟到回执回退');
      if (input.state === 'completed' && !request.startedAt) throw new BoardError('EXECUTION_CONFLICT', '完成回执须有本轮真实开始回执');
      // 只有本轮首次真实开始才同步待执行列；后续活动回执不覆盖用户手动流转。
      const firstRunning = input.state === 'running' && request.startedAt === undefined;
      const moveToDoing = request.purpose === 'implementation' && firstRunning && task.status === 'ready';
      if (moveToDoing) task.status = 'doing';
      request.reports = [...(request.reports ?? []), { reportId: input.reportId, state: input.state, ...(input.activity !== undefined ? { activity: input.activity } : {}) }];
      request.status = input.state;
      request.updatedAt = now;
      if (input.state === 'running') request.startedAt ??= now;
      NativeExecution.setExecution(task, request.purpose, (execution) => ({
        ...execution,
        state: input.state,
        ...(input.activity !== undefined ? { activity: input.activity } : {}),
        ...(request.startedAt !== undefined ? { startedAt: request.startedAt } : {}),
        updatedAt: now,
      }));
      if (input.activity === undefined) delete executionOf(task, request.purpose).activity;
      const additionalEvents: Omit<SessionEvent, 'at'>[] = [];
      if (request.purpose === 'review' && firstRunning) {
        // 真实 running 回执才开轮：pending / recheck_pending → reviewing + 新 Round；
        // 重复 running 回执（不同 reportId）不会再次开轮。
        const review = task.review ?? { status: 'pending' as const, revision: 0, rounds: [] as ReviewRound[], updatedAt: now };
        if (review.status === 'pending' || review.status === 'recheck_pending') {
          const roundWorkspace = request.workspacePath ?? binding.workspacePath;
          if (!roundWorkspace) throw new BoardError('EXECUTION_CONFLICT', '验收轮次缺少实际待验收目录，无法开轮');
          const round: ReviewRound = {
            id: `round-${randomUUID()}`,
            number: review.rounds.length + 1,
            status: 'reviewing',
            workspacePath: roundWorkspace,
            startedAt: now,
            updates: [{
              id: `ru-${randomUUID()}`,
              at: now,
              status: 'reviewing',
              actor: { type: 'agent', provider: 'codex-desktop', sessionId: binding.threadId },
            }],
          };
          review.rounds.push(round);
          review.activeRoundId = round.id;
          review.status = 'reviewing';
          review.revision += 1;
          review.updatedAt = now;
          task.review = review;
          additionalEvents.push({ kind: 'review_round', detail: `round #${round.number} reviewing` });
        }
      }
      if (request.purpose === 'implementation' && firstRunning &&
        task.status === 'review' && task.review?.status === 'changes_requested') {
        // Review 列内继续实现：真实 running 回执把 Review 推进到 fixing，任务不移动看板列
        const review = task.review;
        review.status = 'fixing';
        review.revision += 1;
        review.updatedAt = now;
        review.rounds[review.rounds.length - 1]?.updates.push({
          id: `ru-${randomUUID()}`,
          at: now,
          status: 'fixing',
          actor: { type: 'agent', provider: 'codex-desktop', sessionId: binding.threadId },
        });
        additionalEvents.push({ kind: 'review_updated', detail: 'changes_requested → fixing' });
      }
      // review 的 completed 只是会话执行完成，不等于 approved；verdict 必须由 task_review_update 记录
      return {
        request,
        kind: input.state === 'running' ? 'started' : input.state,
        detail: input.activity ?? input.state,
        ...(moveToDoing ? { additionalEvents: [...additionalEvents, { kind: 'moved' as const, detail: 'ready → doing' }] } : {}),
        ...(additionalEvents.length && !moveToDoing ? { additionalEvents } : {}),
      };
    });
  }

  /** 实现/验收会话是否已收到真实 running 回执（reviewing/fixing 显式更新不得绕过） */
  private static hasStarted(execution: Execution | undefined): boolean {
    return execution !== undefined && (execution.state === 'running' || execution.startedAt !== undefined);
  }

  /**
   * task_review_update：跨 Agent 的 Review 状态更新入口。
   * revision/expectedRevision CAS 防止基于旧数据的静默覆盖；状态机：
   * reviewing（须真实验收 running 回执）/ changes_requested、approved（须非空结论，
   * 关闭当前轮）/ fixing（须真实实现 running 回执）/ recheck_pending。
   */
  async updateReview(input: ReviewUpdateInput) {
    identifier(input.id, 'id');
    identifier(input.boardId, 'boardId');
    if (!REVIEW_UPDATE_STATUSES.includes(input.status as (typeof REVIEW_UPDATE_STATUSES)[number])) {
      throw new BoardError('VALIDATION', `非法 review 更新状态: ${String(input.status)}`);
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new BoardError('VALIDATION', 'expectedRevision 必须为非负整数');
    }
    if (input.conclusion !== undefined && (typeof input.conclusion !== 'string' || input.conclusion.length > REVIEW_CONCLUSION_MAX_LENGTH)) {
      throw new BoardError('VALIDATION', `Review 结论不能超过 ${REVIEW_CONCLUSION_MAX_LENGTH} 字符`);
    }
    const needsConclusion = input.status === 'changes_requested' || input.status === 'approved';
    if (needsConclusion && !input.conclusion?.trim()) {
      throw new BoardError('VALIDATION', `${input.status} 必须提供非空结论`);
    }
    if (input.actor !== undefined) {
      if (!['human', 'agent'].includes(input.actor.type)) throw new BoardError('VALIDATION', 'actor.type 只允许 human / agent');
      if (input.actor.provider !== undefined && (typeof input.actor.provider !== 'string' || !input.actor.provider.trim() || input.actor.provider.length > 64)) {
        throw new BoardError('VALIDATION', 'actor.provider 无效');
      }
      if (input.actor.sessionId !== undefined && (typeof input.actor.sessionId !== 'string' || !input.actor.sessionId.trim() || input.actor.sessionId.length > 200)) {
        throw new BoardError('VALIDATION', 'actor.sessionId 无效');
      }
    }
    return this.transaction(input.id, input.boardId, (task, now) => {
      this.guard(task, input.boardId);
      if (task.status !== 'review') throw new BoardError('VALIDATION', `任务 ${task.id} 不在 review 列（当前 ${task.status}），Review 状态更新仅限 review 列`);
      // 无项目任务不参与 Review 流转：锁内按看板身份拒绝，跨 Agent 的 MCP 写入同样被拦
      const board = this.store.getBoard(task.boardId);
      if (board && !board.projectDir && !board.repo) {
        throw new BoardError('VALIDATION', `无项目任务 ${task.id} 不参与 Review 流转，不能更新验收状态`);
      }
      const review = task.review ?? { status: 'pending' as const, revision: 0, rounds: [] as ReviewRound[], updatedAt: now };
      if (review.revision !== input.expectedRevision) {
        throw new BoardError('REVIEW_STALE', `Review 已被其他更新推进（当前 revision ${review.revision}），请 task_get 读取最新状态后重试`);
      }
      if (review.status === input.status) throw new BoardError('VALIDATION', `Review 状态已是 ${input.status}`);
      const update: ReviewUpdate = {
        id: `ru-${randomUUID()}`,
        at: now,
        status: input.status,
        ...(input.conclusion !== undefined ? { conclusion: input.conclusion } : {}),
        ...(input.actor !== undefined ? { actor: input.actor } : {}),
      };
      switch (input.status) {
        case 'reviewing': {
          if (review.status !== 'pending' && review.status !== 'recheck_pending') {
            throw new BoardError('EXECUTION_CONFLICT', `reviewing 只能从 pending / recheck_pending 进入（当前 ${review.status}）`);
          }
          if (review.activeRoundId) throw new BoardError('EXECUTION_CONFLICT', '已有进行中的验收轮次');
          if (!task.reviewBinding) throw new BoardError('EXECUTION_CONFLICT', '尚未绑定验收会话，reviewing 须由真实验收回执推进');
          if (!NativeExecution.hasStarted(task.reviewExecution)) {
            throw new BoardError('EXECUTION_CONFLICT', 'reviewing 不得绕过真实 running 回执：请先通过验收会话回报 running');
          }
          if (!task.reviewBinding.workspacePath) {
            throw new BoardError('EXECUTION_CONFLICT', '验收绑定缺少实际待验收目录，无法开轮');
          }
          const round: ReviewRound = {
            id: `round-${randomUUID()}`,
            number: review.rounds.length + 1,
            status: 'reviewing',
            workspacePath: task.reviewBinding.workspacePath,
            startedAt: now,
            updates: [update],
          };
          review.rounds.push(round);
          review.activeRoundId = round.id;
          break;
        }
        case 'changes_requested':
        case 'approved': {
          if (review.status !== 'reviewing') {
            throw new BoardError('EXECUTION_CONFLICT', `${input.status} 只能从 reviewing 进入（当前 ${review.status}）`);
          }
          const round = review.rounds.find((candidate) => candidate.id === review.activeRoundId);
          if (!round) throw new BoardError('EXECUTION_CONFLICT', '没有进行中的验收轮次，不能记录结论');
          round.status = input.status;
          round.conclusion = input.conclusion!.trim();
          round.completedAt = now;
          round.updates.push(update);
          review.activeRoundId = undefined;
          break;
        }
        case 'fixing': {
          if (review.status !== 'changes_requested') {
            throw new BoardError('EXECUTION_CONFLICT', `fixing 只能从 changes_requested 进入（当前 ${review.status}）`);
          }
          if (!NativeExecution.hasStarted(task.execution)) {
            throw new BoardError('EXECUTION_CONFLICT', 'fixing 不得绕过真实 running 回执：请先通过实现会话回报 running');
          }
          review.rounds[review.rounds.length - 1]?.updates.push(update);
          break;
        }
        case 'recheck_pending': {
          if (review.status !== 'changes_requested' && review.status !== 'fixing') {
            throw new BoardError('EXECUTION_CONFLICT', `recheck_pending 只能从 changes_requested / fixing 进入（当前 ${review.status}）`);
          }
          review.rounds[review.rounds.length - 1]?.updates.push(update);
          break;
        }
      }
      review.status = input.status;
      review.revision += 1;
      review.updatedAt = now;
      task.review = review;
      return {
        kind: 'review_updated',
        detail: `${update.status} (revision ${review.revision})`,
      };
    });
  }

  /**
   * task_execution_external_bind：记录非 Codex 实现会话（provider-local sessionId
   * 与实际工作区）。sessionId 保持 opaque，不产生 Codex threadId / 深链 / 原生续接；
   * 不因记录推断 running。替换不同已有会话必须显式 force，且不得在有未知执行
   * 仍活跃（请求待确认 / 执行 running）时进行。
   */
  async bindExternal(input: BindExternalSessionInput) {
    identifier(input.id, 'id');
    identifier(input.boardId, 'boardId');
    const provider = input.provider?.trim() ?? '';
    if (!provider || provider.length > 64 || /[\u0000-\u001f]/.test(provider)) {
      throw new BoardError('VALIDATION', 'provider 必须为 1–64 字符且不含控制字符');
    }
    if (provider === 'codex-desktop') {
      throw new BoardError('VALIDATION', 'Codex 会话必须走原生绑定（task_execution action=bind），不能用外部会话对象记录');
    }
    const sessionId = input.sessionId?.trim() ?? '';
    // opaque 标识：不套用 Codex thread 规则，仅要求非空、长度与无控制字符
    if (!sessionId || sessionId.length > 200 || /[\u0000-\u001f]/.test(sessionId)) {
      throw new BoardError('VALIDATION', 'sessionId 必须为 1–200 字符且不含控制字符（provider 本地标识，不套用 Codex thread 规则）');
    }
    if (typeof input.workspacePath !== 'string' || !path.isAbsolute(input.workspacePath)) {
      throw new BoardError('VALIDATION', 'workspacePath 必须为绝对路径');
    }
    if (!['user', 'tasklane', 'agent'].includes(input.workspaceOwner)) {
      throw new BoardError('VALIDATION', 'workspaceOwner 只允许 user / tasklane / agent');
    }
    if (input.branch !== undefined && (typeof input.branch !== 'string' || !input.branch.trim() || input.branch.length > 200)) {
      throw new BoardError('VALIDATION', 'branch 无效');
    }
    const task = this.store.getTask(normalizeTaskId(input.id));
    if (!task) throw new BoardError('TASK_NOT_FOUND', `任务不存在: ${normalizeTaskId(input.id)}`);
    this.guard(task, input.boardId);
    const board = this.store.getBoard(task.boardId);
    if (!board) throw new BoardError('BOARD_NOT_FOUND', `看板不存在: ${task.boardId}`);
    if (board.repoKey && board.repo) {
      // Git 看板：工作区必须真实存在且属于任务所在仓库，不把目录存在当作绑定正确
      const workspace = await this.git.identifyRepo(input.workspacePath).catch(() => null);
      const repo = await this.git.identifyRepo(board.repo).catch(() => null);
      if (!workspace || !repo) throw new BoardError('GIT_ERROR', `外部会话工作区不是有效 Git 仓库: ${input.workspacePath}`);
      if (workspace.repoKey !== repo.repoKey) throw new BoardError('GIT_ERROR', `外部会话工作区属于其他仓库: ${input.workspacePath}`);
      if (input.branch !== undefined) await this.git.assertWorktreeMatches(input.workspacePath, board.repo, input.branch);
    } else if (board.projectDir) {
      // 非 Git 项目：工作区必须是真实项目目录（存在、可访问），不伪造 Git 校验
      if (canonicalPath(input.workspacePath) !== canonicalPath(board.projectDir) || !accessibleDirectory(input.workspacePath)) {
        throw new BoardError('GIT_ERROR', `外部会话工作区不是项目目录或目录不可访问: ${input.workspacePath}`);
      }
      if (input.branch !== undefined) throw new BoardError('VALIDATION', '非 Git 项目没有分支信息，不能记录分支');
    } else {
      // 无项目看板：任务不记录工作区、不参与 Review，外部会话工作区无承载语义
      throw new BoardError('VALIDATION', '无项目任务不记录实现工作区，外部会话绑定仅支持项目看板任务');
    }
    return this.transaction(input.id, input.boardId, (latest, now) => {
      this.guard(latest, input.boardId);
      const existing = latest.externalExecutionSession;
      if (existing && (existing.provider !== provider || existing.sessionId !== sessionId ||
        canonicalPath(existing.workspacePath) !== canonicalPath(input.workspacePath) ||
        existing.workspaceOwner !== input.workspaceOwner || existing.branch !== input.branch)) {
        const sameSession = existing.provider === provider && existing.sessionId === sessionId;
        if (!input.force) {
          throw new BoardError('EXECUTION_CONFLICT', `已有外部实现会话（${existing.provider}/${existing.sessionId}）；替换或改写必须显式 force=true`);
        }
        if (!sameSession) {
          // 未知执行仍活跃时禁止静默替换：待确认请求或 running 执行期间不换实现上下文
          const activeUnknown = latest.executionRequests?.some((request) =>
            AWAITING.has(request.status) || request.status === 'running');
          if (activeUnknown || ['starting', 'running'].includes(latest.execution.state) ||
            ['starting', 'running'].includes(latest.reviewExecution?.state ?? 'idle')) {
            throw new BoardError('EXECUTION_CONFLICT', '存在待确认或运行中的执行，不能替换外部实现会话；请先核对并结束在途请求');
          }
        }
      }
      const sameContent = existing && existing.provider === provider && existing.sessionId === sessionId &&
        canonicalPath(existing.workspacePath) === canonicalPath(input.workspacePath) &&
        existing.workspaceOwner === input.workspaceOwner && existing.branch === input.branch;
      latest.externalExecutionSession = {
        provider,
        sessionId,
        workspacePath: input.workspacePath,
        workspaceOwner: input.workspaceOwner,
        ...(input.branch !== undefined ? { branch: input.branch } : {}),
        boundAt: existing?.boundAt ?? now,
        updatedAt: now,
      };
      // 只记录会话与工作区：不写 threadId、不推断 running、不改执行状态与负责人
      return sameContent
        ? { kind: 'execution_external_bound', detail: `${provider} refreshed` }
        : { kind: 'execution_external_bound', detail: `${provider} ${sessionId}` };
    });
  }
}
