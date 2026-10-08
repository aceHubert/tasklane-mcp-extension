import type { ExecutionBinding, ExecutionRequest, ExecutionResult, ReviewBinding, TaskReview, WorkItem, WorkspaceMode } from './mcp/types';
import { translate } from './i18n/messages';

export interface HostInfo {
  name: string;
  version: string;
}

export interface HostCapabilities {
  message?: { text?: object };
  openLinks?: object;
  serverTools?: object;
}

export interface HostScope {
  mode: 'project' | 'global' | 'project-error';
  lockedBoardId?: string;
  projectDir?: string;
  repoRoot?: string;
}

export interface HostSnapshot {
  connected: boolean;
  identity: 'codex' | 'unknown';
  info?: HostInfo;
  /** 服务端从 MCP initialize 取得；与 UI 桥的通用 hostInfo 分开。 */
  mcpClient?: HostInfo;
  capabilities: HostCapabilities;
  scope?: HostScope;
  /** 实时面板/连接上下文代次；变更后旧操作不得继续投递。 */
  contextVersion: number;
}

export interface ExecutionHost {
  getSnapshot(): HostSnapshot;
  sendMessage(text: string, contextVersion: number): Promise<void>;
  openLink(url: string, contextVersion: number): Promise<void>;
}

export type ExecutionAction = 'start' | 'reply' | 'continue' | 'retry';
export type ReviewAction = 'review-start' | 'review-continue' | 'review-fix';
export type HostBlockReason =
  | 'disconnected' | 'unknown' | 'context'
  | 'message' | 'open' | 'workspace' | 'archived'
  | 'busy' | 'binding' | 'repo' | 'stop' | 'selection' | 'done' | 'blocked'
  | 'gitUnavailable' | 'reviewWorkspace' | 'reviewConflict' | 'reviewBinding' | 'reviewBusy' | 'reviewBlocked' | 'reviewUnsupported';

/**
 * 看板能力视图（board_list 结果的字段子集）：projectDir 表达项目目录身份，
 * repoKey 表达当前 Git 能力。展示口径来自最近一次能力刷新；分支/worktree
 * 操作的最终准入仍由服务端在执行前核验。
 */
export interface BoardCapability {
  repo?: string | null;
  projectDir?: string | null;
  repoKey?: string | null;
}

/** 无项目看板：既没有项目目录也没有仓库（default 看板未绑定仓库时） */
export function isProjectlessBoard(board: BoardCapability | null | undefined): boolean {
  return !board?.projectDir && !board?.repo;
}

/** 看板当前具备 Git 能力（以最近能力刷新持久化的 repoKey 为准） */
export function boardGitCapable(board: BoardCapability | null | undefined): boolean {
  return Boolean(board?.repoKey);
}

export const HOST_REQUEST_TIMEOUT_MS = 15_000;

export function emptyHostSnapshot(): HostSnapshot {
  return { connected: false, identity: 'unknown', capabilities: {}, contextVersion: 0 };
}

/** MCP Apps 可使用通用桥名；Codex MCP 客户端标识来自另一条真实握手。 */
export function hostIdentity(info?: HostInfo, mcpClient?: HostInfo): HostSnapshot['identity'] {
  if (!parseHostInfo(info)) return 'unknown';
  const name = info!.name.trim().toLowerCase();
  const client = parseHostInfo(mcpClient)?.name.trim().toLowerCase();
  return name === 'codex' || client === 'codex' || client === 'codex-mcp-client' ? 'codex' : 'unknown';
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** 实际桥名称允许空格；名称和版本只是身份提示，不是原生执行授权。 */
export function parseHostInfo(value: unknown): HostInfo | undefined {
  const info = record(value);
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 &&
    v.length <= 200 && !/[\u0000-\u001f]/.test(v);
  return info && text(info.name) && text(info.version) ? { name: info.name, version: info.version } : undefined;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    !/[\s\u0000-\u001f]/.test(value) && !/^(sess-|client-|pending|creating|placeholder)/i.test(value);
}

export function hostBlockReason(snapshot: HostSnapshot): HostBlockReason | null {
  if (!snapshot.connected) return 'disconnected';
  if (hostIdentity(snapshot.info, snapshot.mcpClient) !== 'codex') return 'unknown';
  if (!snapshot.scope || snapshot.scope.mode === 'project-error') return 'context';
  return null;
}

export type ExecutionTask = Pick<WorkItem, 'id' | 'boardId' | 'execution'> &
  Partial<Pick<WorkItem, 'status' | 'archivedAt' | 'worktreePath' | 'executionBinding' | 'executionRequests'
    | 'review' | 'reviewBinding' | 'reviewExecution' | 'externalExecutionSession'>>;

export function currentExecutionRequest(task: ExecutionTask): ExecutionRequest | undefined {
  return task.executionRequests?.find((request) => request.runId === task.execution.runId);
}

/** 当前验收代次的请求（review purpose，runId 对齐 reviewExecution） */
export function currentReviewRequest(task: ExecutionTask): ExecutionRequest | undefined {
  const runId = task.reviewExecution?.runId;
  if (!runId) return undefined;
  return task.executionRequests?.find((request) => request.purpose === 'review' && request.runId === runId);
}

/** review 惰性缺省视图：仅用于展示判断，与服务端读取口径一致 */
export function reviewStatusOf(task: ExecutionTask): TaskReview['status'] {
  if (task.status !== 'review') return task.review?.status ?? 'pending';
  return task.review?.status ?? 'pending';
}

export function hasReviewBinding(binding?: ReviewBinding): binding is ReviewBinding {
  return binding?.provider === 'codex-desktop' && identifier(binding.threadId) &&
    !/^(sess-|creating|pending)/i.test(binding.threadId) && identifier(binding.hostId) &&
    typeof binding.workspacePath === 'string' && binding.workspacePath.startsWith('/');
}

export function executionRecoverySource(task: ExecutionTask): ExecutionRequest | undefined {
  if (hasRealBinding(task.executionBinding)) return undefined;
  return [...(task.executionRequests ?? [])].reverse().find((request) => request.purpose !== 'review' &&
    ['cancelled', 'rejected'].includes(request.status) && request.result);
}

/** 明确分发失败后保留的验收会话，只恢复当前验收代次，避免误用历史轮次。 */
export function reviewRecoverySource(task: ExecutionTask): ExecutionRequest | undefined {
  const request = currentReviewRequest(task);
  return request?.status === 'rejected' && request.result && !request.startedAt && !request.reports?.length
    ? request : undefined;
}

export function executionPending(task: ExecutionTask): boolean {
  const request = currentExecutionRequest(task);
  return Boolean(request && ['pending', 'delivered', 'claimed', 'created', 'bound', 'uncertain'].includes(request.status));
}

/** 验收请求仍在途（等待宿主回执） */
export function reviewPending(task: ExecutionTask): boolean {
  const request = currentReviewRequest(task);
  return Boolean(request && ['pending', 'delivered', 'claimed', 'created', 'bound', 'uncertain'].includes(request.status));
}

/**
 * 客户端可判定的实现工作区解析结果（服务端在请求/绑定时做权威校验）：
 * ok = 唯一来源；required = 无来源；conflict = 多个互不相同的来源。
 * board.repo 不参与来源猜测。
 */
export function resolveReviewWorkspacePreview(task: ExecutionTask): { ok: true; workspacePath: string } | { ok: false; reason: 'reviewWorkspace' | 'reviewConflict' } {
  const sources = [task.executionBinding?.workspacePath, task.externalExecutionSession?.workspacePath, task.worktreePath]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (sources.length === 0) return { ok: false, reason: 'reviewWorkspace' };
  const distinct = new Set(sources.map((value) => value.replace(/\/+$/, '')));
  if (distinct.size > 1) return { ok: false, reason: 'reviewConflict' };
  return { ok: true, workspacePath: sources[0] };
}

export function hasRealBinding(binding?: ExecutionBinding): binding is ExecutionBinding {
  return binding?.provider === 'codex-desktop' && identifier(binding.threadId) &&
    !/^(sess-|creating|pending)/i.test(binding.threadId) && identifier(binding.hostId) &&
    typeof binding.workspacePath === 'string' && binding.workspacePath.startsWith('/');
}

/** created 已持久化的真实结果可用于打开聊天，尚不代表工作区已通过绑定核验。 */
export function executionTarget(task: ExecutionTask, purpose: 'implementation' | 'review' = 'implementation'): ExecutionResult | undefined {
  const binding = purpose === 'review' ? task.reviewBinding : task.executionBinding;
  if (hasRealBinding(binding)) return binding;
  const result = (purpose === 'review' ? currentReviewRequest(task) : currentExecutionRequest(task))?.result;
  return result && identifier(result.threadId) && identifier(result.hostId) &&
    typeof result.workspacePath === 'string' && result.workspacePath.startsWith('/') ? result : undefined;
}

export function executionBlocked(task: ExecutionTask): boolean {
  return currentExecutionRequest(task)?.status === 'blocked';
}

/** 仅当前验收执行及其代次的请求参与阻塞判断，历史阻塞不影响已结束的本轮。 */
export function reviewExecutionBlocked(task: ExecutionTask): boolean {
  return task.reviewExecution?.state === 'blocked' || currentReviewRequest(task)?.status === 'blocked';
}

export function executionBlockReason(
  snapshot: HostSnapshot,
  task: ExecutionTask,
  board: BoardCapability | null | undefined,
  action: ExecutionAction,
  workspaceMode?: WorkspaceMode,
): HostBlockReason | null {
  if (task.archivedAt) return 'archived';
  if (task.status === 'done') return 'done';
  const hostReason = hostBlockReason(snapshot);
  if (hostReason) return hostReason;
  if (!task.id || !task.boardId || (snapshot.scope?.mode === 'project' && snapshot.scope.lockedBoardId !== task.boardId)) return 'context';
  // 看板信息未加载时不能判定能力：保持原有仓库守卫语义
  if (!board) return 'repo';
  const projectless = isProjectlessBoard(board);
  const boardDir = board.repo ?? board.projectDir ?? null;
  // 无项目看板走 projectless；项目看板必须锚定项目目录/仓库根
  if (projectless ? workspaceMode === 'project' || workspaceMode === 'worktree' : !boardDir?.startsWith('/')) return 'repo';
  if (!projectless && snapshot.scope?.mode === 'project' && snapshot.scope.repoRoot !== boardDir) return 'context';
  if (!snapshot.capabilities.message?.text) return 'message';
  if (reviewExecutionBlocked(task)) return 'reviewBlocked';
  if (executionPending(task) || (task.execution.runId && task.execution.state === 'running')) return 'busy';
  if (executionBlocked(task)) {
    if (action !== 'continue') return 'blocked';
    if (!executionTarget(task)) return 'binding';
    return workspaceMode === currentExecutionRequest(task)?.workspaceMode ? null : 'workspace';
  }
  if (action === 'start') {
    if (hasRealBinding(task.executionBinding)) return 'binding';
    if (!workspaceMode) return 'selection';
    if (task.worktreePath && workspaceMode !== 'existing') return 'workspace';
    if (!task.worktreePath && workspaceMode === 'existing') return 'workspace';
    // 无项目看板只接受 projectless；非 Git 项目不接受 worktree（Git 项目保持原逻辑）
    if (projectless && workspaceMode !== 'projectless') return 'workspace';
    if (!projectless && workspaceMode === 'projectless') return 'workspace';
    if (workspaceMode === 'worktree' && !boardGitCapable(board)) return 'gitUnavailable';
  } else {
    if (!hasRealBinding(task.executionBinding)) return 'binding';
    const original = task.executionRequests?.find((request) => request.result?.threadId === task.executionBinding?.threadId);
    const expectedMode = original?.workspaceMode ??
      (task.executionBinding.workspaceOwner === 'user' ? 'project'
        : task.executionBinding.workspaceOwner === undefined ? 'projectless' : 'existing');
    if (workspaceMode !== expectedMode) return 'workspace';
  }
  const recovery = executionRecoverySource(task);
  if (action === 'start' && recovery && workspaceMode !== recovery.workspaceMode) return 'workspace';
  return null;
}

export function openThreadBlockReason(snapshot: HostSnapshot, task: ExecutionTask, purpose: 'implementation' | 'review' = 'implementation'): HostBlockReason | null {
  const reason = hostBlockReason(snapshot);
  if (reason) return reason;
  if (snapshot.scope?.mode === 'project' && snapshot.scope.lockedBoardId !== task.boardId) return 'context';
  if (!executionTarget(task, purpose)) return 'binding';
  if (!snapshot.capabilities.openLinks) return 'open';
  return null;
}

/**
 * Review 执行入口守卫：无项目看板不参与验收；工作区解析（客户端预判，
 * 服务端权威校验）、验收会话绑定与在途请求；继续修改（fix）走实现会话口径。
 */
export function reviewBlockReason(
  snapshot: HostSnapshot,
  task: ExecutionTask,
  action: ReviewAction,
  board?: BoardCapability | null,
): HostBlockReason | null {
  if (task.archivedAt) return 'archived';
  if (task.status !== 'review') return 'context';
  const hostReason = hostBlockReason(snapshot);
  if (hostReason) return hostReason;
  if (!task.id || !task.boardId || (snapshot.scope?.mode === 'project' && snapshot.scope.lockedBoardId !== task.boardId)) return 'context';
  // 看板信息可用时，无项目看板任务不参与验收流转；信息未加载时交由服务端权威拒绝
  if (board && isProjectlessBoard(board)) return 'reviewUnsupported';
  if (!snapshot.capabilities.message?.text) return 'message';
  if (action === 'review-fix') {
    if (reviewExecutionBlocked(task)) return 'reviewBlocked';
    // 实现会话运行中或等待输入时禁止再派修改：waiting 表示会话已请求用户输入，需先处理
    if (executionPending(task) ||
      (task.execution.runId !== undefined && ['running', 'waiting'].includes(task.execution.state))) return 'busy';
    if (!hasRealBinding(task.executionBinding)) return 'binding';
    return null;
  }
  const workspace = resolveReviewWorkspacePreview(task);
  if (!workspace.ok) return workspace.reason;
  if (reviewPending(task) || task.reviewExecution?.state === 'running') return 'reviewBusy';
  if (action === 'review-start' && hasReviewBinding(task.reviewBinding) &&
    !(reviewStatusOf(task) === 'pending' && reviewRecoverySource(task))) return 'reviewBinding';
  if (action === 'review-continue' && !hasReviewBinding(task.reviewBinding)) return 'reviewBinding';
  return null;
}

/** 状态只来自真实绑定与本轮回执；本地自动生成的会话 ID 不参与状态推导。 */
export function executionStatus(task: ExecutionTask): 'unbound' | 'bound' | 'pending' | 'uncertain' | 'blocked' | 'running' | 'waiting' | 'failed' | 'completed' {
  const request = currentExecutionRequest(task);
  if (executionBlocked(task)) return 'blocked';
  if (request?.status === 'uncertain') return 'uncertain';
  if (executionPending(task)) return 'pending';
  if (!hasRealBinding(task.executionBinding)) return 'unbound';
  if (request?.reports?.some((report) => report.state === request.status) &&
    ['running', 'waiting', 'failed', 'completed'].includes(request.status)) {
    return request.status as 'running' | 'waiting' | 'failed' | 'completed';
  }
  return 'bound';
}

export class HostOperationError extends Error {
  constructor(public readonly code: 'timeout' | 'rejected' | 'transport' | 'unavailable' | 'contextChanged', message?: string) {
    const keys = { timeout: 'native.deliveryUncertain', rejected: 'native.deliveryRejected',
      transport: 'native.deliveryUncertain', unavailable: 'native.error.unavailable', contextChanged: 'native.reason.context' } as const;
    super(message ?? translate(keys[code]));
    this.name = 'HostOperationError';
  }
}

/** 超时只表示结果未知；底层可能迟到，绝不自动重发。 */
export async function hostRequest(
  operation: () => Promise<{ isError?: boolean }>,
  timeoutMs = HOST_REQUEST_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HostOperationError('timeout')), timeoutMs);
      }),
    ]);
    if (!result) throw new HostOperationError('transport', '宿主未返回投递结果');
    if (result.isError) throw new HostOperationError('rejected', translate('native.deliveryRejected'));
  } catch (err) {
    if (err instanceof HostOperationError) throw err;
    throw new HostOperationError('transport', err instanceof Error ? err.message : String(err));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
