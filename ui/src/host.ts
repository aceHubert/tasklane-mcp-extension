import type { ExecutionBinding, ExecutionRequest, ExecutionResult, WorkItem, WorkspaceMode } from './mcp/types';
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
export type HostBlockReason =
  | 'disconnected' | 'unknown' | 'context'
  | 'message' | 'open' | 'workspace' | 'archived'
  | 'busy' | 'binding' | 'repo' | 'stop' | 'selection' | 'done' | 'blocked';

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
  Partial<Pick<WorkItem, 'status' | 'archivedAt' | 'worktreePath' | 'executionBinding' | 'executionRequests'>>;

export function currentExecutionRequest(task: ExecutionTask): ExecutionRequest | undefined {
  return task.executionRequests?.find((request) => request.runId === task.execution.runId);
}

export function executionRecoverySource(task: ExecutionTask): ExecutionRequest | undefined {
  if (hasRealBinding(task.executionBinding)) return undefined;
  return [...(task.executionRequests ?? [])].reverse().find((request) => request.status === 'cancelled' && request.result);
}

export function executionPending(task: ExecutionTask): boolean {
  const request = currentExecutionRequest(task);
  return Boolean(request && ['pending', 'delivered', 'claimed', 'created', 'bound', 'uncertain'].includes(request.status));
}

export function hasRealBinding(binding?: ExecutionBinding): binding is ExecutionBinding {
  return binding?.provider === 'codex-desktop' && identifier(binding.threadId) &&
    !/^(sess-|creating|pending)/i.test(binding.threadId) && identifier(binding.hostId) &&
    typeof binding.workspacePath === 'string' && binding.workspacePath.startsWith('/');
}

/** created 已持久化的真实结果可用于打开聊天，尚不代表工作区已通过绑定核验。 */
export function executionTarget(task: ExecutionTask): ExecutionResult | undefined {
  if (hasRealBinding(task.executionBinding)) return task.executionBinding;
  const result = currentExecutionRequest(task)?.result;
  return result && identifier(result.threadId) && identifier(result.hostId) &&
    typeof result.workspacePath === 'string' && result.workspacePath.startsWith('/') ? result : undefined;
}

export function executionBlocked(task: ExecutionTask): boolean {
  return currentExecutionRequest(task)?.status === 'blocked';
}

export function executionBlockReason(
  snapshot: HostSnapshot,
  task: ExecutionTask,
  repo: string | null | undefined,
  action: ExecutionAction,
  workspaceMode?: WorkspaceMode,
): HostBlockReason | null {
  if (task.archivedAt) return 'archived';
  if (task.status === 'done') return 'done';
  const hostReason = hostBlockReason(snapshot);
  if (hostReason) return hostReason;
  if (!task.id || !task.boardId || (snapshot.scope?.mode === 'project' && snapshot.scope.lockedBoardId !== task.boardId)) return 'context';
  if (!repo?.startsWith('/')) return 'repo';
  if (snapshot.scope?.mode === 'project' && snapshot.scope.repoRoot !== repo) return 'context';
  if (!snapshot.capabilities.message?.text) return 'message';
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
  } else {
    if (!hasRealBinding(task.executionBinding)) return 'binding';
    const original = task.executionRequests?.find((request) => request.result?.threadId === task.executionBinding?.threadId);
    const expectedMode = original?.workspaceMode ?? (task.executionBinding.workspaceOwner === 'user' ? 'project' : 'existing');
    if (workspaceMode !== expectedMode) return 'workspace';
  }
  const recovery = executionRecoverySource(task);
  if (action === 'start' && recovery && workspaceMode !== recovery.workspaceMode) return 'workspace';
  return null;
}

export function openThreadBlockReason(snapshot: HostSnapshot, task: ExecutionTask): HostBlockReason | null {
  const reason = hostBlockReason(snapshot);
  if (reason) return reason;
  if (snapshot.scope?.mode === 'project' && snapshot.scope.lockedBoardId !== task.boardId) return 'context';
  if (!executionTarget(task)) return 'binding';
  if (!snapshot.capabilities.openLinks) return 'open';
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
