#!/usr/bin/env node
/**
 * bridge 安全面验收：
 * B1-B6 WebSocket 消息层：畸形 JSON-RPC（null/数组/缺 id/非法 method）返回错误而非崩溃
 * B7 恶意 Origin 升级被拒（浏览器跨站攻击面）
 * B8 非回环 Host 升级被拒（防 DNS rebinding）
 * T1-T3 token 模式：无 token 拒绝、/api/config 下发 token、带 token 可连接
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 7499;
const TOKEN_PORT = 7498;
const TOKEN = 'verify-secret';
const bridge = spawn(process.execPath, ['packages/bridge/bridge.mjs'], {
  env: { ...process.env, PORT, TASKLANE_HOME: '/tmp/ck-bridge-verify' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const results = [];
const check = (label, cond) => { results.push([label, cond]); console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200); // 等 MCP initialize

try {
  // 无 Origin 的本机客户端（qa-agent 场景）可正常连接
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/mcp`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  check('B1 无 Origin 本机连接被接受', true);

  // 合法 JSON 但非 JSON-RPC 对象：返回错误响应，连接与进程存活
  const errResp = new Promise((res) => ws.on('message', (d) => res(JSON.parse(d.toString()))));
  ws.send('null');
  check('B2 null 消息返回错误而非崩溃', (await errResp).error?.message?.includes('invalid request'));

  for (const [label, payload, expectInclude] of [
    ['B3 数组消息', '[1,2]', 'invalid request'],
    ['B4 缺 id', JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: {} }), 'requires a string|number id'],
    ['B5 非法 method', JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize' }), 'unsupported method'],
  ]) {
    const resp = new Promise((res) => {
      const h = (d) => { const m = JSON.parse(d.toString()); if (m.id === 9 || m.error) { ws.off('message', h); res(m); } };
      ws.on('message', h);
    });
    ws.send(payload);
    check(label, ((await resp).error?.message ?? '').includes(expectInclude));
  }

  // 畸形消息之后，正常 tools/call 依然工作（bridge 未崩溃）
  const callResp = new Promise((res) => {
    const h = (d) => { const m = JSON.parse(d.toString()); if (m.id === 42) { ws.off('message', h); res(m); } };
    ws.on('message', h);
  });
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'board_list', arguments: {} } }));
  check('B6 畸形消息后 tools/call 仍正常', (await callResp).result?.content?.[0]?.text?.includes('boards'));
  ws.close();

  const tryOpen = (headers, url = `ws://127.0.0.1:${PORT}/mcp`) =>
    new Promise((res) => {
      const w = new WebSocket(url, { headers });
      w.on('open', () => { res('opened'); w.close(); });
      w.on('error', () => res('rejected'));
    });
  check('B7 恶意 Origin 升级被拒', (await tryOpen({ Origin: 'http://evil.example' })) === 'rejected');
  check('B8 非回环 Host 升级被拒（防 DNS rebinding）', (await tryOpen({ Host: `evil.example:${PORT}` })) === 'rejected');

  // 畸形百分号编码（/%）令 decodeURIComponent 抛 URIError：必须返回 400 且进程存活
  const bad = await fetch(`http://127.0.0.1:${PORT}/%`);
  check('B9 畸形路径返回 400 而非进程退出', bad.status === 400);
  const health = await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.json());
  check('B10 畸形路径后 bridge 仍存活', health.ok === true && health.mcp === 'ready');

  // 静态目录路径（ui/dist/assets 真实存在）：曾被当文件 createReadStream，
  // 异步 EISDIR 未处理直接打崩进程；修复后返回 404 且进程存活
  const dirReq = await fetch(`http://127.0.0.1:${PORT}/assets`);
  check('B11 目录路径返回 404 而非流错误崩溃', dirReq.status === 404);
  const health2 = await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.json());
  check('B12 目录路径后 bridge 仍存活', health2.ok === true && health2.mcp === 'ready');

  /* ---------- token 模式（第二个 bridge 实例） ---------- */
  const tokenBridge = spawn(process.execPath, ['packages/bridge/bridge.mjs'], {
    env: { ...process.env, PORT: TOKEN_PORT, TASKLANE_HOME: '/tmp/ck-bridge-verify2', TASKLANE_TOKEN: TOKEN },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await sleep(1200);
    check('T1 token 模式下无 token 连接被拒', (await tryOpen({}, `ws://127.0.0.1:${TOKEN_PORT}/mcp`)) === 'rejected');

    const config = await fetch(`http://127.0.0.1:${TOKEN_PORT}/api/config`).then((r) => r.json());
    check('T2 /api/config 下发 token（同源）', config.token === TOKEN);

    const ws2 = new WebSocket(`ws://127.0.0.1:${TOKEN_PORT}/mcp?token=${encodeURIComponent(TOKEN)}`);
    await new Promise((res, rej) => { ws2.on('open', res); ws2.on('error', rej); });
    const callResp2 = new Promise((res) => ws2.once('message', (d) => res(JSON.parse(d.toString()))));
    ws2.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'board_list', arguments: {} } }));
    const ok2 = await callResp2;
    check('T3 带 token 连接且 tools/call 正常', ok2.result?.content?.[0]?.text?.includes('boards'));
    ws2.close();
  } finally {
    tokenBridge.kill();
  }
} finally {
  bridge.kill();
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? '\nBRIDGE VERIFY PASSED' : `\nBRIDGE VERIFY FAILED (${failed.length})`);
process.exit(failed.length === 0 ? 0 : 1);
