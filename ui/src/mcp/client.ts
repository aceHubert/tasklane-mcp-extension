/**
 * MCP WebSocket 客户端：UI 的所有读写都是 tools/call，无旁路。
 * 断线自动重连（指数退避），连接状态回调供 UI 展示断连横幅。
 */
import { translate } from '../i18n/messages';

export type ConnState = 'connecting' | 'connected' | 'disconnected';

type StateListener = (s: ConnState) => void;

/** UI 与 MCP 的传输无关接口：WebSocket 桥（独立模式）与 MCP Apps 宿主桥（侧栏嵌入）共用 */
export interface BoardClient {
  connect(): void;
  connectionState: ConnState;
  onState: StateListener;
  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
}

export class McpClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private backoff = 500;
  private closed = false;
  private state: ConnState = 'connecting';
  private stateListener: StateListener = () => {};

  constructor(
    private url: string,
    onState?: StateListener,
  ) {
    if (onState) this.stateListener = onState;
  }

  /** 连接状态监听（UI 挂载时设置） */
  set onState(fn: StateListener) {
    this.stateListener = fn;
  }

  get connectionState(): ConnState {
    return this.state;
  }

  connect(): void {
    this.closed = false;
    // 重入保护：已有连接中/已打开的 socket 时不重复建连（BoardContext 的
    // effect 重跑不得叠加 WebSocket；断线重连走 onclose，此时旧 socket 已 CLOSED）
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setState('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      this.setState('connected');
    };
    ws.onmessage = (ev) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'));
        else p.resolve(msg.result);
      }
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('connection closed'));
      this.pending.clear();
      this.setState('disconnected');
      if (!this.closed) {
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 8000);
      }
    };
    ws.onerror = () => ws.close();
  }

  private setState(s: ConnState) {
    if (this.state === s) return;
    this.state = s;
    this.stateListener(s);
  }

  /** 调用 MCP tool，返回 content[0].text 解析后的 JSON；isError 时抛错 */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(translate('mcp.notConnected'));
    }
    const id = ++this.seq;
    const result = (await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }));
    })) as { content?: { type: string; text: string }[]; isError?: boolean };

    const text = result?.content?.[0]?.text ?? '';
    if (result?.isError) throw new Error(text || 'MCP tool error');
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined as T;
    }
  }
}
