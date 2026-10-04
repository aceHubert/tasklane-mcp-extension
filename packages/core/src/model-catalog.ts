import { spawn, type ChildProcess } from 'node:child_process';
import { BoardError } from './errors.js';

/** 宿主模型目录条目：仅保留 UI 候选与展示需要的字段 */
export interface ModelCatalogEntry {
  id: string;
  displayName?: string;
  isDefault?: boolean;
  supportedReasoningEfforts?: string[];
}

export interface ModelCatalogResult {
  models: ModelCatalogEntry[];
  /** 目录中标记 isDefault 的模型 ID（存在时才有该字段） */
  defaultModelId?: string;
}

export interface ModelCatalogOptions {
  /** app-server 启动命令，默认 codex app-server；测试可注入 node + stub 脚本 */
  launch?: string[];
  /** 单个 JSON-RPC 响应的硬超时（毫秒），默认 15 秒；超时终止进程 */
  timeoutMs?: number;
  /** 追加注入子进程的环境变量（测试控制 stub 行为用），默认继承当前环境 */
  env?: Record<string, string>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function catalogError(message: string): BoardError {
  return new BoardError('MODEL_CATALOG', message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 只读查询 Codex 宿主模型目录：通过 `codex app-server` 的 stdio JSON-RPC
 * （initialize 握手 → model/list 分页聚合）获取与宿主选择器同源的目录。
 *
 * 边界约束：
 * - 每次查询独立 spawn 进程并在结束后终止，不连接宿主已在运行的 app-server
 *   daemon，也不做执行、投递或任何写操作 —— 这是目录查询，不是执行兜底。
 * - 任何失败（命令缺失、进程退出、协议错误、超时）统一抛 MODEL_CATALOG，
 *   由调用方降级（UI 回退手填模型 ID），不影响其他工具。
 */
export class ModelCatalogService {
  private readonly launch: string[];
  private readonly timeoutMs: number;
  private readonly env: Record<string, string> | undefined;

  constructor(options: ModelCatalogOptions = {}) {
    this.launch = options.launch?.length ? options.launch : ['codex', 'app-server'];
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.env = options.env;
  }

  async listModels(): Promise<ModelCatalogResult> {
    let child: ChildProcess;
    try {
      child = spawn(this.launch[0], this.launch.slice(1), {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: this.env ? { ...process.env, ...this.env } : process.env,
      });
    } catch (err) {
      throw catalogError(`无法启动 app-server（${this.launch.join(' ')}）: ${errorMessage(err)}`);
    }
    // stdin 写入已退出进程会触发 EPIPE 流错误；失败路径由 pending 拒绝统一承接
    child.stdin?.on('error', () => {});

    const pending = new Map<number, PendingRequest>();
    let nextId = 0;
    let buffer = '';
    let exited = false;
    const failAll = (message: string) => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(catalogError(message));
      }
      pending.clear();
    };
    child.on('error', (err) => failAll(`app-server 进程错误: ${err.message}`));
    child.on('exit', () => {
      exited = true;
      failAll('app-server 进程提前退出，未获得模型目录');
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        let message: { id?: unknown; error?: { message?: unknown }; result?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          continue; // 非 JSON 行（诊断输出等）忽略，不中断协议
        }
        // 请求 id 由本方生成且恒为数字；字符串/通知行不关联任何等待中的请求
        const id = typeof message.id === 'number' ? message.id : undefined;
        if (id === undefined) continue; // 通知行与服务端主动消息不关联请求
        const waiter = pending.get(id);
        if (!waiter) continue;
        pending.delete(id);
        clearTimeout(waiter.timer);
        if (message.error) {
          waiter.reject(catalogError(`model/list 协议错误: ${errorMessage(message.error.message ?? message.error)}`));
        } else {
          waiter.resolve(message.result);
        }
      }
    });

    const request = (method: string, params: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        if (exited || !child.stdin?.writable) {
          reject(catalogError('app-server 不可用'));
          return;
        }
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          child.kill('SIGKILL');
          reject(catalogError(`等待 app-server 响应 ${method} 超时（${this.timeoutMs}ms）`));
        }, this.timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    try {
      await request('initialize', { clientInfo: { name: 'tasklane', title: 'TaskLane', version: '0.1.0' } });
      const models: ModelCatalogEntry[] = [];
      let cursor: string | undefined;
      // 页数防御上限：目录异常增长或服务端游标异常时不能无限循环
      for (let page = 0; page < 20; page++) {
        const result = (await request('model/list', cursor ? { cursor } : {})) as
          | { data?: unknown; nextCursor?: string | null }
          | undefined;
        if (Array.isArray(result?.data)) {
          for (const raw of result.data) models.push(mapEntry(raw));
        }
        cursor = result?.nextCursor ?? undefined;
        if (!cursor) break;
        if (page === 19) throw catalogError('模型目录分页超过上限，中止查询');
      }
      const visible = models.filter((m) => m.id);
      const defaultModelId = visible.find((m) => m.isDefault)?.id;
      return { models: visible, ...(defaultModelId ? { defaultModelId } : {}) };
    } finally {
      child.kill('SIGKILL');
    }
  }
}

/**
 * 目录条目字段宽松映射：app-server v2 协议为 camelCase
 * （id/displayName/isDefault/supportedReasoningEfforts），兼容历史 snake_case 形态。
 */
function mapEntry(raw: unknown): ModelCatalogEntry {
  const value = (raw ?? {}) as Record<string, unknown>;
  const id = typeof value.id === 'string' ? value.id : typeof value.slug === 'string' ? value.slug : '';
  const displayName =
    typeof value.displayName === 'string' && value.displayName.trim()
      ? value.displayName.trim()
      : typeof value.display_name === 'string' && value.display_name.trim()
        ? value.display_name.trim()
        : undefined;
  const rawLevels = Array.isArray(value.supportedReasoningEfforts)
    ? value.supportedReasoningEfforts
    : Array.isArray(value.supported_reasoning_levels)
      ? value.supported_reasoning_levels
      : undefined;
  const efforts: string[] = [];
  for (const level of rawLevels ?? []) {
    // 兼容 [{reasoningEffort:'low'}]、[{effort:'low'}] 与纯字符串三种形态
    const effort =
      typeof level === 'string'
        ? level
        : typeof (level as { reasoningEffort?: unknown })?.reasoningEffort === 'string'
          ? (level as { reasoningEffort: string }).reasoningEffort
          : typeof (level as { effort?: unknown })?.effort === 'string'
            ? (level as { effort: string }).effort
            : undefined;
    if (effort && !efforts.includes(effort)) efforts.push(effort);
  }
  return {
    id,
    ...(displayName ? { displayName } : {}),
    ...(value.isDefault === true ? { isDefault: true } : {}),
    ...(efforts.length ? { supportedReasoningEfforts: efforts } : {}),
  };
}
