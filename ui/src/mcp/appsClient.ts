/** MCP Apps 数据调用只回原 MCP 服务，原生聊天操作由关联宿主 Agent 执行。 */
import { translate } from '../i18n/messages';
import type { ConnState, BoardClient } from './client';
import {
  emptyHostSnapshot, hostIdentity, hostBlockReason, hostRequest, HostOperationError,
  parseHostInfo, type ExecutionHost, type HostCapabilities, type HostInfo, type HostSnapshot,
} from '../host';

type StateListener = (s: ConnState) => void;

export interface ExecutionReportSnapshot {
  taskId: string;
  title: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  state: 'running' | 'waiting' | 'blocked' | 'failed' | 'completed';
  activity?: string;
  updatedAt: string;
}

export interface WidgetContext {
  mode: 'project' | 'global';
  boardHome?: string;
  projectDir?: string;
  repoRoot?: string;
  lockedBoardId?: string;
  boardName?: string;
  /** 普通看板入口可聚焦任务；报告卡片只有用户点击后才打开详情。 */
  taskId?: string;
  presentation?: 'report-card';
  reportCard?: ExecutionReportSnapshot;
  mcpClient?: HostInfo;
  error?: string;
}

interface AppsGlobal {
  App: new (info: HostInfo, capabilities?: Record<string, unknown>, options?: Record<string, unknown>) => AppsApp;
}

interface AppsApp {
  connect(): Promise<void>;
  close(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  ontoolresult?: (params: unknown) => void;
  onhostcontextchanged?: (params: unknown) => void;
  getHostVersion(): HostInfo | undefined;
  getHostCapabilities(): HostCapabilities | undefined;
  getHostContext(): Record<string, unknown> | undefined;
  sendMessage(params: { role: 'user'; content: { type: 'text'; text: string }[] }): Promise<{ isError?: boolean }>;
  openLink(params: { url: string }): Promise<{ isError?: boolean }>;
  requestDisplayMode?(params: { mode: 'fullscreen' }): Promise<{ mode: string }>;
  callServerTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
    content?: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean;
  }>;
}

const WIDGET_CTX_KEY = 'tasklane-ctx:';
const APP_VERSION = '0.3.20';

/** 专用报告资源在 bundle 执行前注入标记，等待工具结果时也不能闪现完整看板。 */
export function isReportCardResource(): boolean {
  return (globalThis as Record<string, unknown>).__TASKLANE_REPORT_CARD__ === true;
}

export function hasMcpAppsHost(): boolean {
  const apps = (globalThis as Record<string, unknown>).__KANBAN_MCP_APPS__;
  return typeof apps === 'object' && apps !== null && typeof (apps as AppsGlobal).App === 'function';
}

function parseWidgetContext(result: unknown): WidgetContext | null {
  const res = result as { isError?: boolean; content?: { text?: string }[]; structuredContent?: Partial<WidgetContext> & { widget?: string }; _meta?: { widgetData?: Partial<WidgetContext> & { widget?: string } } } | undefined;
  // 部分宿主只透传 widget 的元数据；顶层结果优先，不能用元数据覆盖失败或错误范围。
  const data = res?.structuredContent ?? res?._meta?.widgetData;
  if (!data || data.widget !== 'tasklane-board' || (data.mode !== 'project' && data.mode !== 'global')) return null;
  if (res?.isError) return { mode: data.mode, error: res.content?.[0]?.text ?? 'open_tasklane failed' };
  if (data.mode === 'project' && (!data.lockedBoardId || !data.repoRoot?.startsWith('/') || !data.projectDir?.startsWith('/'))) {
    return { mode: 'project', error: 'open_tasklane returned an incomplete project context' };
  }
  // taskId 与服务端标识符同规：非空、trim 后长度 ≤ 200；非法值直接丢弃，不影响看板上下文
  const taskId = typeof data.taskId === 'string' && data.taskId.trim().length > 0 && data.taskId.trim().length <= 200
    ? data.taskId.trim()
    : undefined;
  let reportCard: ExecutionReportSnapshot | undefined;
  if (data.presentation === 'report-card') {
    const card = data.reportCard;
    if (data.mode !== 'project' || !taskId || !card || card.taskId !== taskId ||
      typeof card.title !== 'string' || !card.title.trim() ||
      !['P0', 'P1', 'P2', 'P3'].includes(card.priority) ||
      !['running', 'waiting', 'blocked', 'failed', 'completed'].includes(card.state) ||
      typeof card.updatedAt !== 'string' || !Number.isFinite(Date.parse(card.updatedAt)) ||
      (card.activity !== undefined && typeof card.activity !== 'string')) {
      return { mode: 'project', presentation: 'report-card', error: 'task_execution action=report returned an invalid report card' };
    }
    reportCard = { taskId, title: card.title, priority: card.priority, state: card.state,
      activity: card.activity, updatedAt: card.updatedAt };
  }
  return {
    mode: data.mode, boardHome: data.boardHome, projectDir: data.projectDir, repoRoot: data.repoRoot,
    lockedBoardId: data.lockedBoardId, boardName: data.boardName, taskId,
    presentation: data.presentation === 'report-card' ? 'report-card' : undefined, reportCard,
    mcpClient: parseHostInfo(data.mcpClient),
  };
}

function cacheScope(ctx: WidgetContext): WidgetContext {
  return { mode: ctx.mode, boardHome: ctx.boardHome, projectDir: ctx.projectDir,
    repoRoot: ctx.repoRoot, lockedBoardId: ctx.lockedBoardId, boardName: ctx.boardName, taskId: ctx.taskId,
    presentation: ctx.presentation, reportCard: ctx.reportCard, error: ctx.error };
}

export class McpAppsClient implements BoardClient, ExecutionHost {
  private app: AppsApp | null = null;
  private state: ConnState = 'connecting';
  private stateListener: StateListener = () => {};
  private connectStarted = false;
  private widgetCtx: WidgetContext | null = null;
  private snapshot = emptyHostSnapshot();
  private livePeer: HostInfo | undefined;
  onWidgetContext: ((ctx: WidgetContext) => void) | null = null;
  onHostSnapshot: ((snapshot: HostSnapshot) => void) | null = null;
  onDisplayMode: ((mode: string) => void) | null = null;

  constructor() {
    try {
      if (window.name.startsWith(WIDGET_CTX_KEY)) {
        const data = JSON.parse(window.name.slice(WIDGET_CTX_KEY.length));
        // 缓存恢复看板范围与报告快照；宿主身份只能来自本次真实连接。
        this.widgetCtx = parseWidgetContext({ structuredContent: { ...cacheScope(data), widget: 'tasklane-board' } });
      }
    } catch {
      /* 无缓存时等待本次工具结果，执行保持关闭。 */
    }
  }

  set onState(fn: StateListener) { this.stateListener = fn; }
  get connectionState(): ConnState { return this.state; }
  get initialWidgetContext(): WidgetContext | null { return this.widgetCtx; }
  getSnapshot(): HostSnapshot { return structuredClone(this.snapshot); }

  private publishHost(invalidate = false) {
    const ctx = this.widgetCtx;
    const info = this.state === 'connected' ? parseHostInfo(this.app?.getHostVersion()) : undefined;
    const mcpClient = this.state === 'connected' ? this.livePeer : undefined;
    this.snapshot = {
      connected: this.state === 'connected', info, mcpClient, identity: hostIdentity(info, mcpClient),
      capabilities: this.state === 'connected' ? this.app?.getHostCapabilities() ?? {} : {},
      scope: ctx ? {
        mode: ctx.error ? 'project-error' : ctx.mode, lockedBoardId: ctx.lockedBoardId,
        projectDir: ctx.projectDir, repoRoot: ctx.repoRoot,
      } : undefined,
      contextVersion: this.snapshot.contextVersion + (invalidate ? 1 : 0),
    };
    this.onHostSnapshot?.(this.getSnapshot());
  }

  private cacheWidgetScope() {
    if (!this.widgetCtx) return;
    try {
      window.name = WIDGET_CTX_KEY + JSON.stringify(cacheScope(this.widgetCtx));
    } catch { /* 缓存失败不影响当前连接。 */ }
  }

  /** iframe 重载可能收不到原工具结果，直接向原 MCP 服务读取本次 initialize 的客户端。 */
  private async refreshPeer() {
    const app = this.app;
    const version = this.snapshot.contextVersion;
    if (!app || this.state !== 'connected') return;
    try {
      const result = await app.callServerTool({ name: 'tasklane_host_info', arguments: {} });
      if (this.app !== app || this.state !== 'connected' || version !== this.snapshot.contextVersion || this.livePeer) return;
      if (result.isError) return;
      const data = result.structuredContent as { mcpClient?: unknown } | undefined;
      this.livePeer = parseHostInfo(data?.mcpClient);
      this.publishHost();
    } catch { /* 读取失败保持未知，不根据缓存或工具名称猜测客户端。 */ }
  }

  connect(): void {
    if (this.connectStarted) return;
    this.connectStarted = true;
    const apps = (globalThis as Record<string, unknown>).__KANBAN_MCP_APPS__ as AppsGlobal | undefined;
    if (!apps || typeof apps.App !== 'function') { this.setState('disconnected'); return; }
    try {
      const reportResource = isReportCardResource() || this.widgetCtx?.presentation === 'report-card';
      const app = new apps.App({ name: 'tasklane', version: APP_VERSION },
        { availableDisplayModes: reportResource ? ['inline', 'fullscreen'] : ['fullscreen'] }, { autoResize: true });
      this.app = app;
      app.ontoolresult = (params) => {
        const ctx = parseWidgetContext(params);
        if (!ctx) return;
        this.widgetCtx = ctx;
        this.livePeer = ctx.error ? undefined : ctx.mcpClient;
        this.publishHost(true);
        if (!this.livePeer && !ctx.error) void this.refreshPeer();
        this.cacheWidgetScope();
        this.onWidgetContext?.(ctx);
      };
      app.onhostcontextchanged = (params) => {
        // 展示通知不影响执行；标准宿主元数据需要重读身份，但沿用已确认的 widget 范围。
        // 未知扩展或空通知无法确定路由和范围，等待新的工具结果确认。
        app.getHostContext();
        const presentationKeys = new Set(['theme', 'styles', 'displayMode', 'availableDisplayModes',
          'containerDimensions', 'locale', 'timeZone', 'safeAreaInsets']);
        const metadataKeys = new Set(['toolInfo', 'userAgent', 'platform', 'deviceCapabilities']);
        const keys = params && typeof params === 'object' && !Array.isArray(params) ? Object.keys(params) : [];
        const changed = keys.length === 0 || keys.some((key) => !presentationKeys.has(key));
        const unknown = keys.length === 0 || keys.some((key) => !presentationKeys.has(key) && !metadataKeys.has(key));
        if (changed) {
          this.livePeer = undefined;
          if (unknown) {
            this.widgetCtx = null;
            // 未知路由变化撤销旧范围缓存，避免 iframe 重载后恢复未经确认的范围。
            try {
              if (window.name.startsWith(WIDGET_CTX_KEY)) window.name = '';
            } catch { /* 无法访问缓存时，当前实例仍保持范围关闭。 */ }
          }
        }
        this.publishHost(changed);
        if (params && typeof params === 'object' && 'displayMode' in params && typeof params.displayMode === 'string') {
          this.onDisplayMode?.(params.displayMode);
        }
        if (changed) void this.refreshPeer();
      };
      app.onclose = () => this.setState('disconnected');
      app.onerror = () => this.setState('disconnected');
      void app.connect().then(() => {
        // 握手期间已经关闭的连接，不能因迟到完成结果重新获得发送权限。
        if (this.app === app && this.state === 'connecting') this.setState('connected');
      }).catch(() => this.setState('disconnected'));
    } catch { this.setState('disconnected'); }
  }

  private setState(state: ConnState) {
    const changed = this.state !== state;
    this.state = state;
    if (state !== 'connected') this.livePeer = undefined;
    this.publishHost(state !== 'connected');
    if (state === 'connected') void this.refreshPeer();
    if (changed) this.stateListener(state);
  }

  private assertContext(contextVersion: number): AppsApp {
    if (!this.app || contextVersion !== this.snapshot.contextVersion) throw new HostOperationError('contextChanged');
    if (hostBlockReason(this.snapshot)) throw new HostOperationError('unavailable');
    return this.app;
  }

  async sendMessage(text: string, contextVersion: number): Promise<void> {
    const app = this.assertContext(contextVersion);
    if (!this.snapshot.capabilities.message?.text) throw new HostOperationError('unavailable');
    await hostRequest(() => app.sendMessage({ role: 'user', content: [{ type: 'text', text }] }));
    if (contextVersion !== this.snapshot.contextVersion) throw new HostOperationError('transport', '投递后面板上下文已改变，结果需核对');
  }

  async openLink(url: string, contextVersion: number): Promise<void> {
    const app = this.assertContext(contextVersion);
    if (!this.snapshot.capabilities.openLinks ||
      !/^codex:\/\/threads\/[A-Za-z0-9._~-]+$/.test(url)) throw new HostOperationError('unavailable');
    await hostRequest(() => app.openLink({ url }));
    if (contextVersion !== this.snapshot.contextVersion) throw new HostOperationError('contextChanged');
  }

  /** 只由报告卡片的用户点击调用；展示变更与发送执行消息使用不同能力守卫。 */
  async expandReportCard(contextVersion: number, taskId: string, boardId: string): Promise<void> {
    const current = () => {
      const ctx = this.widgetCtx;
      return this.app && this.state === 'connected' && this.snapshot.contextVersion === contextVersion &&
        ctx?.presentation === 'report-card' && !ctx.error && ctx.taskId === taskId && ctx.lockedBoardId === boardId;
    };
    if (!current()) throw new Error(translate('reportCard.contextChanged'));
    const app = this.app!;
    const modes = app.getHostContext()?.availableDisplayModes;
    if (!app.requestDisplayMode || (Array.isArray(modes) && !modes.includes('fullscreen'))) {
      throw new Error(translate('reportCard.unsupported'));
    }
    let result: { mode: string } | undefined;
    try {
      await hostRequest(async () => {
        result = await app.requestDisplayMode!({ mode: 'fullscreen' });
        return {};
      });
    } catch {
      if (!current()) throw new Error(translate('reportCard.contextChanged'));
      throw new Error(translate('reportCard.refused'));
    }
    if (!current()) throw new Error(translate('reportCard.contextChanged'));
    if (result?.mode !== 'fullscreen') throw new Error(translate('reportCard.refused'));
  }

  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.app || this.state !== 'connected') throw new Error(translate('mcp.notConnected'));
    const result = await this.app.callServerTool({ name, arguments: args });
    const text = result?.content?.[0]?.text ?? '';
    if (result?.isError) throw new Error(text || 'MCP tool error');
    if (result?.structuredContent !== undefined) return result.structuredContent as T;
    try { return JSON.parse(text) as T; } catch { throw new Error('MCP tool returned invalid JSON'); }
  }
}
