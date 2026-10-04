import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { BoardError } from './errors.js';
import type { BoardStore, SessionEvent } from './board-store.js';
import type { GitService } from './git.js';
import {
  EXECUTION_MODEL_MAX_LENGTH,
  EXECUTION_MODEL_PATTERN,
  normalizeTaskId,
  type BindExecutionInput,
  type ClaimExecutionInput,
  type ExecutionDeliveryInput,
  type ExecutionRequest,
  type ExecutionRecoveryInput,
  type RequestExecutionRecoveryInput,
  type ExecutionResult,
  type ReportExecutionInput,
  type RequestExecutionInput,
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

function sameResult(a: ExecutionResult, b: ExecutionResult): boolean {
  return a.threadId === b.threadId && a.hostId === b.hostId &&
    a.workspacePath === b.workspacePath && a.workspaceOwner === b.workspaceOwner && a.branch === b.branch;
}

function sameInput(request: ExecutionRequest, input: RequestExecutionInput): boolean {
  return request.action === input.action && request.workspaceMode === input.workspaceMode &&
    request.hostId === input.hostId && request.receiverThreadId === input.receiverThreadId &&
    request.message === input.message && (request.model === input.model ||
      (request.action === 'continue' && request.recoveryOf !== undefined && input.model === undefined));
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

  private current(task: WorkItem, input: { boardId: string; requestId: string; runId: string }): ExecutionRequest {
    this.guard(task, input.boardId);
    identifier(input.requestId, 'requestId');
    identifier(input.runId, 'runId');
    const request = task.executionRequests?.find((r) => r.requestId === input.requestId);
    if (!request || request.runId !== input.runId || task.execution.runId !== input.runId) {
      throw new BoardError('EXECUTION_STALE', '请求或运行代次已失效，不能覆盖当前执行');
    }
    if (request.status === 'cancelled') throw new BoardError('EXECUTION_STALE', '旧请求已人工恢复，不能再认领、绑定或回报');
    return request;
  }

  /** 已出结果的核对消息描述的是过去的状态：执行状态一旦实际变更即清除，UI 不再回显过期异常；
   *  pending 检查仍在途，保留给 CAS 与新检查覆盖逻辑处理。 */
  private static supersedeCheck(request: ExecutionRequest): void {
    if (request.recoveryCheck && request.recoveryCheck.status !== 'pending') delete request.recoveryCheck;
  }

  private transaction(
    id: string,
    boardId: string,
    change: (task: WorkItem, now: string) => {
      request: ExecutionRequest; kind?: SessionEvent['kind']; detail?: string;
      additionalEvents?: Omit<SessionEvent, 'at'>[];
    },
  ): { task: WorkItem; request: ExecutionRequest } {
    // 冷存储任务仍遵守 TASK_ARCHIVED 契约；存储事务会在锁内再次检查，
    // 防止本次读取之后另一进程完成归档而退化成 TASK_NOT_FOUND。
    const current = this.store.getTask(normalizeTaskId(id));
    if (current) this.guard(current, boardId);
    let request!: ExecutionRequest;
    const now = this.nowIso();
    const { task } = this.store.mutateTaskWithEvent(normalizeTaskId(id), (task) => {
      const result = change(task, now);
      request = result.request;
      const events: SessionEvent[] = result.kind ? [{ at: now, kind: result.kind, detail: result.detail }] : [];
      events.push(...(result.additionalEvents ?? []).map((event) => ({ ...event, at: now })));
      if (events.length) task.updatedAt = now;
      return { task, events };
    });
    return { task, request: structuredClone(request) };
  }

  async request(input: RequestExecutionInput) {
    identifier(input.requestId, 'requestId');
    if (input.hostId !== undefined) identifier(input.hostId, 'hostId', true);
    if (input.receiverThreadId !== undefined) identifier(input.receiverThreadId, 'receiverThreadId', true);
    if (!['start', 'reply', 'continue', 'retry'].includes(input.action) ||
      !['project', 'worktree', 'existing'].includes(input.workspaceMode)) {
      throw new BoardError('VALIDATION', '非法执行动作或工作区模式');
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
    let created = false;
    const result = this.transaction(input.id, input.boardId, (task, now) => {
      this.guard(task, input.boardId);
      const existing = task.executionRequests?.find((r) => r.requestId === input.requestId);
      if (existing) {
        if (!sameInput(existing, input)) throw new BoardError('EXECUTION_CONFLICT', '相同 requestId 的请求内容不能改变');
        return { request: existing };
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
      if (!board?.repo || !path.isAbsolute(board.repo)) throw new BoardError('VALIDATION', '目标看板未绑定有效仓库');
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
      const recoverySource = blockedSource ?? (!task.executionBinding
        ? [...(task.executionRequests ?? [])].reverse().find((candidate) => candidate.status === 'cancelled' && candidate.result)
        : undefined);
      if (recoverySource && !blockedSource && (input.workspaceMode !== recoverySource.workspaceMode || input.model !== recoverySource.model)) {
        throw new BoardError('EXECUTION_CONFLICT', '已有创建结果必须复用原工作区方式和模型，不能重复创建聊天');
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
        const binding = task.executionBinding ?? blockedResult;
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
        action: input.action,
        workspaceMode: input.workspaceMode,
        ...(input.hostId !== undefined ? { hostId: input.hostId } : {}),
        ...(input.receiverThreadId !== undefined ? { receiverThreadId: input.receiverThreadId } : {}),
        repo: board.repo,
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.model !== undefined ? { model: input.model } : blockedSource?.model !== undefined ? { model: blockedSource.model } : {}),
        ...(recoverySource && (blockedResult ?? recoverySource.result) ? {
          result: structuredClone(blockedResult ?? recoverySource.result!),
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

  async requestRecovery(input: RequestExecutionRecoveryInput) {
    identifier(input.checkId, 'checkId');
    if (input.purpose !== undefined && !['status', 'recovery'].includes(input.purpose)) throw new BoardError('VALIDATION', '非法核对用途');
    const purpose = input.purpose ?? 'recovery';
    let created = false;
    const result = this.transaction(input.id, input.boardId, (task, now) => {
      const request = this.current(task, input);
      if (purpose === 'recovery' && !AWAITING.has(request.status)) throw new BoardError('EXECUTION_CONFLICT', '仅能恢复等待宿主回执的请求');
      const check = request.recoveryCheck;
      if (check?.checkId === input.checkId) {
        if ((check.purpose ?? 'recovery') !== purpose) throw new BoardError('EXECUTION_CONFLICT', '同一 checkId 不能改变核对用途');
        return { request };
      }
      if (check?.status === 'pending' && Date.parse(now) - Date.parse(check.requestedAt) < 60_000) {
        if ((check.purpose ?? 'recovery') !== purpose) throw new BoardError('EXECUTION_BUSY', '另一个用途的核对仍待完成，请先核对原消息');
        return { request };
      }
      request.recoveryCheck = { checkId: input.checkId, status: 'pending', requestedAt: now,
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        observedStatus: request.status, observedUpdatedAt: request.updatedAt };
      created = true;
      return { request, kind: 'execution_recovery_requested', detail: input.checkId };
    });
    return { ...result, created };
  }

  async recover(input: ExecutionRecoveryInput) {
    identifier(input.checkId, 'checkId');
    identifier(input.checkerThreadId, 'checkerThreadId', true);
    identifier(input.hostId, 'hostId', true);
    if (!['busy', 'unknown', 'resumed', 'stopped'].includes(input.outcome) ||
      typeof input.message !== 'string' || !input.message.trim() || input.message.length > 200 ||
      !Array.isArray(input.observations) || input.observations.length > 4) {
      throw new BoardError('VALIDATION', '恢复报告须包含核对结果、非空短摘要及最多四个真实线程观测');
    }
    for (const observation of input.observations) {
      identifier(observation.threadId, 'observation.threadId', true);
      identifier(observation.hostId, 'observation.hostId', true);
      if (!['active', 'idle', 'waiting', 'unknown'].includes(observation.state) ||
        typeof observation.observedAt !== 'string' || !Number.isFinite(Date.parse(observation.observedAt)) ||
        (observation.priorOperationEnded !== undefined && typeof observation.priorOperationEnded !== 'boolean')) {
        throw new BoardError('VALIDATION', '线程状态观测无效');
      }
    }
    let changed = false;
    const result = this.transaction(input.id, input.boardId, (task, now) => {
      this.guard(task, input.boardId);
      const request = task.executionRequests?.find((candidate) => candidate.requestId === input.requestId);
      if (!request || request.runId !== input.runId || task.execution.runId !== input.runId) {
        throw new BoardError('EXECUTION_STALE', '请求或运行代次已变化');
      }
      const check = request.recoveryCheck;
      if (!check || check.checkId !== input.checkId) throw new BoardError('EXECUTION_STALE', '状态核对已被新检查取代');
      const statusOnly = check.purpose === 'status';
      if (statusOnly && input.outcome === 'stopped') throw new BoardError('EXECUTION_CONFLICT', '状态核对不能取消、重置或解除原请求');
      if (statusOnly && request.status === 'cancelled') throw new BoardError('EXECUTION_STALE', '已取消请求不能继续状态核对');
      const checkStatus = input.outcome === 'stopped' ? 'recovered' : input.outcome;
      if (check.status !== 'pending') {
        if (check.status === checkStatus && check.message === input.message &&
          check.checker?.threadId === input.checkerThreadId && check.checker?.hostId === input.hostId &&
          JSON.stringify(check.observations) === JSON.stringify(input.observations)) return { request };
        throw new BoardError('EXECUTION_CONFLICT', '同一次核对不能更改已报告结果');
      }
      const age = Date.parse(now) - Date.parse(check.requestedAt);
      if (age < 0 || age > 300_000) throw new BoardError('EXECUTION_STALE', '核对消息已过期，请重新发起检查');
      if (!statusOnly && !AWAITING.has(request.status)) throw new BoardError('EXECUTION_CONFLICT', '请求已不在等待状态，不执行恢复');
      const knownHosts = [request.receiver?.hostId, request.hostId, request.result?.hostId, task.executionBinding?.hostId].filter(Boolean);
      if (knownHosts.some((host) => host !== input.hostId)) throw new BoardError('EXECUTION_CONFLICT', '核对宿主与请求结果不符');
      const peers = [request.receiver ?? (request.receiverThreadId ? { hostId: request.hostId, threadId: request.receiverThreadId } : undefined),
        request.result, task.executionBinding].filter((peer) => peer?.hostId && peer.threadId);
      if (peers.length === 0) peers.push({ hostId: input.hostId, threadId: input.checkerThreadId });
      for (const observation of input.observations) {
        const observedAge = Date.parse(now) - Date.parse(observation.observedAt);
        if (observedAge < -5_000 || observedAge > 120_000) throw new BoardError('EXECUTION_STALE', '线程观测过期，不能推断已停止');
      }
      if (input.outcome === 'stopped') {
        if (input.confirmedStopped !== true) throw new BoardError('VALIDATION', '解除等待须核对并确认旧操作已结束');
        if (request.status !== check.observedStatus || request.updatedAt !== check.observedUpdatedAt) {
          throw new BoardError('EXECUTION_CONFLICT', '核对期间请求有新进展，不能取消');
        }
        for (const peer of peers) {
          const observation = input.observations.find((candidate) => candidate.hostId === peer!.hostId && candidate.threadId === peer!.threadId);
          if (!observation || !(observation.state === 'idle' ||
            (observation.state === 'active' && observation.threadId === input.checkerThreadId &&
              observation.hostId === input.hostId && observation.priorOperationEnded === true))) {
            throw new BoardError('EXECUTION_CONFLICT', '相关线程仍活跃、等待输入或未知，不能解除等待');
          }
        }
        // 即使多提供了线程，也不能将其中的活跃/未知状态忽略为已停止。
        if (input.observations.some((observation) => observation.state !== 'idle' &&
          !(observation.state === 'active' && observation.threadId === input.checkerThreadId &&
            observation.hostId === input.hostId && observation.priorOperationEnded === true))) {
          throw new BoardError('EXECUTION_CONFLICT', '观测含未结束的宿主操作');
        }
        request.status = 'cancelled';
        request.updatedAt = now;
        request.recovery = { at: now, reason: input.message, confirmedStopped: true, checkId: input.checkId };
        task.execution = { ...task.execution, state: task.assignee === 'agent' ? 'assigned' : 'idle',
          activity: '宿主核对后解除等待，请重新发起执行', updatedAt: now };
        delete task.execution.startedAt;
        changed = true;
      }
      request.recoveryCheck = { ...check, status: checkStatus, checkedAt: now, message: input.message,
        checker: { threadId: input.checkerThreadId, hostId: input.hostId }, observations: structuredClone(input.observations) };
      return { request, kind: changed ? 'execution_recovered' : 'execution_recovery_checked', detail: input.message };
    });
    return { ...result, changed };
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
        NativeExecution.supersedeCheck(request);
        task.execution = { ...task.execution, state: 'blocked', activity: input.error, updatedAt: now };
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
          if (request.deliveryError === input.error && task.execution.activity === activity) return { request };
          request.deliveryError = input.error;
          request.updatedAt = now;
          task.execution = { ...task.execution, activity, updatedAt: now };
          return { request, kind: 'execution_uncertain', detail: input.error };
        }
        // 认领者可以报告原生创建结果未知；已绑定和执行回执不能倒退。
        if (request.result || !['claimed', 'uncertain'].includes(request.status)) return { request };
      } else if (input.status === 'rejected' && input.claimId !== undefined) {
        this.assertClaim(request, input.claimId);
        // 创建结果已记录或执行已确认时不能伪记拒绝，未知结果继续保持待确认。
        if (request.result || !['claimed', 'uncertain'].includes(request.status)) {
          throw new BoardError('EXECUTION_CONFLICT', '已有创建结果或执行回执，不能记录为拒绝');
        }
      } else {
        // 原面板的迟到响应不能覆盖接收 Agent 已认领的工作。
        if (!['pending', 'delivered', 'uncertain'].includes(request.status) || request.claimId) return { request };
      }
      if (input.status === 'rejected') {
        request.status = 'rejected';
        request.updatedAt = now;
        request.deliveryError = input.error;
        NativeExecution.supersedeCheck(request);
        task.execution = { ...task.execution, state: task.assignee === 'agent' ? 'assigned' : 'idle', activity: input.error, updatedAt: now };
        delete task.execution.startedAt;
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
      NativeExecution.supersedeCheck(request);
      if (claimedUncertain) {
        task.execution = { ...task.execution, activity: input.error ?? '原生创建结果待确认，请核对已创建聊天和工作区', updatedAt: now };
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
      if (request.status === 'rejected') throw new BoardError('EXECUTION_STALE', '请求已明确拒绝，不能重新认领');
      const hostId = input.hostId ?? request.hostId;
      const threadId = input.receiverThreadId ?? request.receiverThreadId;
      if (!hostId || !threadId) throw new BoardError('VALIDATION', '请求无完整原路由，认领必须提供核对后的真实接收者');
      if ((request.hostId !== undefined && request.hostId !== hostId) ||
        (request.receiverThreadId !== undefined && request.receiverThreadId !== threadId) ||
        (task.executionBinding !== undefined && task.executionBinding.hostId !== hostId) ||
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
      NativeExecution.supersedeCheck(request);
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

  private async validateWorkspace(task: WorkItem, request: ExecutionRequest, result: ExecutionResult): Promise<void> {
    if (!path.isAbsolute(result.workspacePath)) throw new BoardError('VALIDATION', 'workspacePath 必须为绝对路径');
    const board = this.store.getBoard(task.boardId);
    if (!board?.repo || canonicalPath(board.repo) !== canonicalPath(request.repo)) {
      throw new BoardError('EXECUTION_CONFLICT', '请求的仓库上下文已改变');
    }
    const workspace = await this.git.identifyRepo(result.workspacePath);
    const repo = await this.git.identifyRepo(board.repo);
    if (workspace.repoKey !== repo.repoKey) throw new BoardError('GIT_ERROR', '执行目录属于其他仓库');
    if (task.executionBinding && !sameResult(task.executionBinding, result)) {
      throw new BoardError('EXECUTION_CONFLICT', '已有聊天及工作区绑定不能改变');
    }
    if (request.workspaceMode === 'project') {
      if (canonicalPath(result.workspacePath) !== canonicalPath(board.repo) || result.workspaceOwner !== 'user') {
        throw new BoardError('GIT_ERROR', '主仓库执行必须使用该仓库根目录并由用户持有');
      }
      if (result.branch) await this.git.assertWorktreeMatches(result.workspacePath, board.repo, result.branch);
    } else {
      if (request.workspaceMode === 'existing') {
        const expected = task.executionBinding?.workspacePath ?? task.worktreePath;
        const owner = task.executionBinding?.workspaceOwner ?? 'tasklane';
        if (!expected || canonicalPath(expected) !== canonicalPath(result.workspacePath) || result.workspaceOwner !== owner) {
          throw new BoardError('GIT_ERROR', '旧工作区必须原样复用，不允许静默切换或另建');
        }
      } else if (result.workspaceOwner !== 'codex' || canonicalPath(result.workspacePath) === canonicalPath(board.repo)) {
        throw new BoardError('GIT_ERROR', '独立工作区必须由 Codex 创建管理，不能使用主仓库');
      }
      if (!result.branch || (task.branch && task.branch !== result.branch)) {
        throw new BoardError('GIT_ERROR', '工作区分支必须匹配任务绑定');
      }
      await this.git.assertWorktreeMatches(result.workspacePath, board.repo, result.branch);
    }
  }

  async bind(input: BindExecutionInput) {
    identifier(input.threadId, 'threadId', true);
    identifier(input.hostId, 'hostId', true);
    if (!['created', 'bound'].includes(input.phase) || !['codex', 'tasklane', 'user'].includes(input.workspaceOwner)) {
      throw new BoardError('VALIDATION', '非法绑定阶段或工作区所有者');
    }
    if (typeof input.workspacePath !== 'string' || !path.isAbsolute(input.workspacePath)) {
      throw new BoardError('VALIDATION', 'workspacePath 必须为绝对路径');
    }
    if (input.branch !== undefined && (typeof input.branch !== 'string' || !input.branch.trim() || input.branch.length > 200)) throw new BoardError('VALIDATION', 'branch 无效');
    const result: ExecutionResult = {
      threadId: input.threadId,
      hostId: input.hostId,
      workspacePath: input.workspacePath,
      workspaceOwner: input.workspaceOwner,
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
    };
    if (input.phase === 'created') {
      // 先锁内保存原生工具的就绪结果，Git 暂不可读也不能丢失已创建的真实聊天。
      // 这里仅校验关联和不可替换规则，实际工作区核验留给 bound 阶段。
      return this.transaction(input.id, input.boardId, (task, now) => {
        const request = this.current(task, input);
        this.assertClaim(request, input.claimId);
        this.assertHost(request, input.hostId);
        if ((request.result && !sameResult(request.result, result)) ||
          (task.executionBinding && !sameResult(task.executionBinding, result))) {
          throw new BoardError('EXECUTION_CONFLICT', '原生创建结果或已有绑定不能被替换');
        }
        if (TERMINAL.has(request.status)) throw new BoardError('EXECUTION_STALE', '请求已经结束');
        if (request.result) return { request };
        request.result = result;
        request.status = 'created';
        request.updatedAt = now;
        NativeExecution.supersedeCheck(request);
        return { request, kind: 'execution_created', detail: result.threadId };
      });
    }
    const task = this.store.getTask(normalizeTaskId(input.id));
    if (!task) throw new BoardError('TASK_NOT_FOUND', `任务不存在: ${input.id}`);
    const request = this.current(task, input);
    this.assertClaim(request, input.claimId);
    this.assertHost(request, input.hostId);
    if (!request.result) throw new BoardError('EXECUTION_CONFLICT', '请先持久记录 phase=created 的就绪结果，再绑定');
    if (!sameResult(request.result, result)) throw new BoardError('EXECUTION_CONFLICT', '原生创建结果不能被替换');
    await this.validateWorkspace(task, request, result);
    return this.transaction(input.id, input.boardId, (latest, now) => {
      const current = this.current(latest, input);
      this.assertClaim(current, input.claimId);
      this.assertHost(current, input.hostId);
      // Git 只读校验有异步间隙，锁内重查目标工作区字段，不写回旧任务副本。
      if (latest.worktreePath !== task.worktreePath || latest.branch !== task.branch ||
        JSON.stringify(latest.executionBinding) !== JSON.stringify(task.executionBinding)) {
        throw new BoardError('EXECUTION_CONFLICT', '校验期间工作区绑定已改变，请重新读取');
      }
      if (current.result && !sameResult(current.result, result)) throw new BoardError('EXECUTION_CONFLICT', '原生创建结果冲突');
      if (TERMINAL.has(current.status)) throw new BoardError('EXECUTION_STALE', '请求已经结束');
      if (!current.result) throw new BoardError('EXECUTION_CONFLICT', '请先持久记录 phase=created 的就绪结果，再绑定');
      if (latest.executionBinding) {
        if (!sameResult(latest.executionBinding, result)) throw new BoardError('EXECUTION_CONFLICT', '任务已有不同真实聊天绑定');
        if (!['claimed', 'created', 'uncertain', 'blocked'].includes(current.status)) return { request: current };
      } else {
        latest.executionBinding = { ...result, provider: 'codex-desktop', boundAt: now };
        latest.repo ??= current.repo;
        if (result.branch !== undefined) latest.branch ??= result.branch;
        if (current.workspaceMode !== 'project') latest.worktreePath ??= result.workspacePath;
      }
      current.status = 'bound';
      current.updatedAt = now;
      NativeExecution.supersedeCheck(current);
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
      const binding = task.executionBinding;
      this.assertHost(request, input.hostId);
      if (!binding || binding.threadId !== input.threadId || binding.hostId !== input.hostId) {
        throw new BoardError('EXECUTION_CONFLICT', '回执必须匹配任务真实聊天和宿主绑定');
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
      const moveToDoing = input.state === 'running' && !request.startedAt && task.status === 'ready';
      if (moveToDoing) task.status = 'doing';
      request.reports = [...(request.reports ?? []), { reportId: input.reportId, state: input.state, ...(input.activity !== undefined ? { activity: input.activity } : {}) }];
      request.status = input.state;
      request.updatedAt = now;
      NativeExecution.supersedeCheck(request);
      if (input.state === 'running') request.startedAt ??= now;
      task.execution = {
        ...task.execution,
        state: input.state,
        ...(input.activity !== undefined ? { activity: input.activity } : {}),
        ...(request.startedAt !== undefined ? { startedAt: request.startedAt } : {}),
        updatedAt: now,
      };
      if (input.activity === undefined) delete task.execution.activity;
      return {
        request, kind: input.state === 'running' ? 'started' : input.state, detail: input.activity ?? input.state,
        ...(moveToDoing ? { additionalEvents: [{ kind: 'moved' as const, detail: 'ready → doing' }] } : {}),
      };
    });
  }
}
