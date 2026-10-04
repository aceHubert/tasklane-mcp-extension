#!/usr/bin/env node
/**
 * 薄桥：浏览器 UI ←WebSocket(JSON-RPC)→ MCP server(stdio)，并静态托管 ui/dist。
 * 只做转发，不做业务 —— 业务永远只存在于 MCP contract 之后。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIST = path.resolve(__dirname, '../../ui/dist');
const MCP_ENTRY = path.resolve(__dirname, '../../mcp/dist/src/index.js');
const PORT = Number(process.env.PORT || 7433);
/** 设置后 WebSocket 升级必须携带匹配的 ?token=，供 stricter 部署使用 */
const AUTH_TOKEN = process.env.TASKLANE_TOKEN || '';

let mcpReady = false;
let internalId = 0;
const pending = new Map(); // internalId -> { ws, origId }

/* ---------- MCP 子进程（stdio JSON-RPC） ---------- */
const child = spawn(process.execPath, [MCP_ENTRY], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
});
// 子进程启动失败 / bridge 先退出后的 stdin 写失败（EPIPE）只记日志：
// 不加监听时它们会变成未捕获异常，把整条链路再打崩一次
child.on('error', (err) => {
  console.error('[bridge] MCP server error:', err instanceof Error ? err.message : err);
});
child.stdin.on('error', (err) => {
  console.error('[bridge] MCP stdin write failed:', err instanceof Error ? err.message : err);
});
child.on('exit', (code) => {
  console.error(`[bridge] MCP server exited (${code}), shutting down`);
  process.exit(1);
});

function sendToMcp(msg) {
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

const mcpReader = createInterface({ input: child.stdout });
mcpReader.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error('[bridge] unparseable MCP stdout:', line.slice(0, 120));
    return;
  }
  // stdout 可能是任意 JSON（含 null/数组），先验结构再取字段
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return;
  const entry = msg.id !== undefined ? pending.get(msg.id) : undefined;
  if (entry) {
    pending.delete(msg.id);
    if (entry.ws.readyState === entry.ws.OPEN) {
      entry.ws.send(JSON.stringify({ jsonrpc: '2.0', id: entry.origId, result: msg.result, error: msg.error }));
    }
  }
});

// 启动握手
sendToMcp({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'tasklane-bridge', version: '0.1.0' },
  },
});
mcpReader.once('line', (line) => {
  // initialize 响应（id:0）到达即视为就绪
  try {
    const msg = JSON.parse(line);
    if (msg && typeof msg === 'object' && msg.id === 0) {
      sendToMcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
      mcpReady = true;
      console.error('[bridge] MCP server initialized');
    }
  } catch {
    /* ignore */
  }
});

/* ---------- HTTP：静态 UI + 健康检查 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mcp: mcpReady ? 'ready' : 'starting' }));
    return;
  }
  // 连接配置：token 模式下 UI 需要拿到 token 才能建立 WebSocket（仅同源可读，无 CORS 头）
  if (urlPath === '/api/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, token: AUTH_TOKEN || null }));
    return;
  }
  let filePath;
  try {
    filePath = decodeURIComponent(urlPath);
  } catch {
    // 畸形百分号编码（如 /%）会抛 URIError：返回 400，绝不能让请求处理崩溃退出进程
    res.writeHead(400).end('bad url encoding');
    return;
  }
  if (filePath === '/') filePath = '/index.html';
  const file = path.join(UI_DIST, filePath);
  // 必须是普通文件：目录（如 /assets）会让 createReadStream 异步抛 EISDIR，
  // 未处理的流 error 会打崩进程 —— existsSync 对目录同样返回 true，挡不住
  let st;
  try {
    st = statSync(file);
  } catch {
    st = undefined;
  }
  if (!file.startsWith(UI_DIST) || !st?.isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  // index.html 每次协商缓存（no-cache 带 ETag 语义由 304 之外的完整响应兜底），
  // 避免 webview 拿旧 HTML 继续引用已替换的 hashed bundle；assets 文件名带 hash 可长期缓存
  const immutable = filePath.startsWith('/assets/');
  const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' };
  if (immutable) headers['cache-control'] = 'public, max-age=31536000, immutable';
  else headers['cache-control'] = 'no-cache';
  res.writeHead(200, headers);
  // TOCTOU（校验通过后文件被删除）等流错误兜底：返回 404 或切断响应，不打崩进程
  createReadStream(file)
    .on('error', (err) => {
      console.error('[bridge] static read failed:', file, err instanceof Error ? err.message : err);
      if (res.headersSent) res.destroy();
      else res.writeHead(404).end('not found');
    })
    .pipe(res);
});

/* ---------- WebSocket：/mcp（仅本机 UI 使用，校验 Host/Origin/可选 token） ---------- */
const wss = new WebSocketServer({ noServer: true });

const LOOPBACK_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  // 开发代理/其他本机前端来源（逗号分隔），如 http://localhost:5176
  ...(process.env.TASKLANE_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
]);

function rejectUpgrade(socket, reason) {
  console.error(`[bridge] rejected websocket upgrade: ${reason}`);
  socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    return rejectUpgrade(socket, 'bad url');
  }
  if (url.pathname !== '/mcp') {
    return rejectUpgrade(socket, `path ${url.pathname}`);
  }
  // 防 DNS rebinding：Host 必须是本桥监听的回环地址
  const host = String(req.headers.host || '').toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    return rejectUpgrade(socket, `host ${host}`);
  }
  // 浏览器发起的 WS 必带 Origin：只允许静态托管的同源 UI
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return rejectUpgrade(socket, `origin ${origin}`);
  }
  // 可选令牌：设置 TASKLANE_TOKEN 后要求 ?token= 匹配
  if (AUTH_TOKEN && url.searchParams.get('token') !== AUTH_TOKEN) {
    return rejectUpgrade(socket, 'bad or missing token');
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function rpcError(id, message) {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message } });
}

function isRequestId(id) {
  return typeof id === 'string' || typeof id === 'number';
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(rpcError(null, 'parse error: bad json'));
      return;
    }
    // 合法 JSON 但不是 JSON-RPC 请求对象（null / 数组 / 字符串 / 数字）一律拒绝，不得抛异常
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      ws.send(rpcError(null, 'invalid request: not a JSON-RPC object'));
      return;
    }
    if (typeof msg.method !== 'string') {
      ws.send(rpcError(isRequestId(msg.id) ? msg.id : null, 'invalid request: method must be a string'));
      return;
    }
    if (msg.method !== 'tools/call') {
      ws.send(rpcError(isRequestId(msg.id) ? msg.id : null, `unsupported method: ${msg.method}`));
      return;
    }
    if (!isRequestId(msg.id)) {
      ws.send(rpcError(null, 'invalid request: tools/call requires a string|number id'));
      return;
    }
    if (msg.params === null || typeof msg.params !== 'object' || Array.isArray(msg.params)) {
      ws.send(rpcError(msg.id, 'invalid request: params must be an object'));
      return;
    }
    if (!mcpReady) {
      ws.send(rpcError(msg.id, 'mcp not ready'));
      return;
    }
    const id = ++internalId;
    pending.set(id, { ws, origId: msg.id });
    sendToMcp({ jsonrpc: '2.0', id, method: 'tools/call', params: msg.params });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[bridge] UI  →  http://127.0.0.1:${PORT}`);
  console.error(`[bridge] MCP →  ws://127.0.0.1:${PORT}/mcp  (store: ${process.env.TASKLANE_HOME || '~/.tasklane'})`);
  if (AUTH_TOKEN) console.error('[bridge] token auth enabled (TASKLANE_TOKEN)');
});
