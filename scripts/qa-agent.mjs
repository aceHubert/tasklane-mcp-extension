#!/usr/bin/env node
/**
 * 浏览器业务演示客户端：通过 ws://127.0.0.1:7433/mcp 调用业务工具，不启动或模拟 Agent。
 * 用法: node scripts/qa-agent.mjs <tool> '<json-args>'
 * 例:   node scripts/qa-agent.mjs task_update '{"action":"update","id":"TASK-101","title":"演示标题"}'
 * 不提供 native 工具或 execution 回执；执行能力应由实际接收 Agent 单独验证。
 */
import WebSocket from 'ws';

const [tool, argsJson] = process.argv.slice(2);
if (!tool) {
  console.error('usage: qa-agent.mjs <tool> [json-args]');
  process.exit(1);
}
let args;
try {
  args = argsJson ? JSON.parse(argsJson) : {};
} catch (err) {
  console.error('参数不是有效 JSON:', err.message);
  process.exit(1);
}
const businessTools = new Set([
  'board_list', 'board_create', 'dir_list', 'task_list', 'task_get',
  'task_create', 'task_update', 'task_move',
  'task_archive', 'task_restore', 'task_archive_done',
]);
if (!businessTools.has(tool) || !args || typeof args !== 'object' || Array.isArray(args) ||
  (tool === 'task_update' && Object.hasOwn(args, 'execution')) ||
  (tool === 'task_update' && args.action === 'review')) {
  console.error('该脚本仅用于业务演示，不接受原生执行工具或 execution 状态写入。');
  process.exit(1);
}

// TASKLANE_TOKEN 设置时（bridge token 模式）附带 ?token=
const token = process.env.TASKLANE_TOKEN;
const ws = new WebSocket(`ws://127.0.0.1:7433/mcp${token ? `?token=${encodeURIComponent(token)}` : ''}`);
ws.on('open', () => {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  const text = msg.result?.content?.[0]?.text ?? JSON.stringify(msg.error ?? msg);
  console.log(`[demo→mcp] ${tool}(${JSON.stringify(args)}) →`, text.slice(0, 300));
  ws.close();
  process.exit(msg.error || msg.result?.isError ? 1 : 0);
});
ws.on('error', (err) => {
  console.error('ws error:', err.message);
  process.exit(1);
});
setTimeout(() => {
  console.error('timeout');
  process.exit(1);
}, 8000);
