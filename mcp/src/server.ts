import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import { BoardEngine, ModelCatalogService } from '@tasklane/core';
import { registerAllTools } from './register.js';

/**
 * 扩展 serverInfo 的可选项。宿主嵌入（Codex 插件）时通过它注入
 * Extensions 协议的 `serverInfo.icons`（侧边栏导航 fallback）与 instructions；
 * catalog 可注入测试替身的模型目录服务，默认走 codex app-server。
 */
export interface CreateServerOptions {
  serverInfo?: Partial<Implementation>;
  instructions?: string;
  catalog?: ModelCatalogService;
}

export function createServer(engine: BoardEngine, options: CreateServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'tasklane', version: '0.1.0', ...options.serverInfo },
    options.instructions ? { instructions: options.instructions } : undefined,
  );
  registerAllTools(server, engine, options.catalog ?? new ModelCatalogService());
  return server;
}
