#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BoardEngine, GitService, JsonFileBoardStore, defaultStorePath } from '@tasklane/core';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const storePath = defaultStorePath();
  const store = new JsonFileBoardStore(storePath);
  const git = new GitService(process.env.TASKLANE_GIT !== 'off');
  const engine = new BoardEngine(store, git);

  const server = createServer(engine);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 日志走 stderr，stdout 专用于 JSON-RPC
  console.error(`[tasklane] MCP server ready on stdio (store: ${storePath}, git: ${git.enabled ? 'on' : 'off'})`);
}

main().catch((err) => {
  console.error('[tasklane] fatal:', err);
  process.exit(1);
});
