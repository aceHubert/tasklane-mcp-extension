import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BoardEngine, GitService, JsonFileBoardStore, type ExecutionRequest, type RequestExecutionInput, type WorkItem } from '@tasklane/core';
import { createServer } from '../src/server.js';

interface Response { task: WorkItem; request: ExecutionRequest; created?: boolean }

function requestArgs(base: Partial<RequestExecutionInput> & { action: RequestExecutionInput['action'] }, patch: Record<string, unknown> = {}) {
  const { action, ...rest } = { ...base, ...patch };
  return { ...rest, action: 'request' as const, requestAction: action };
}

async function call(client: Client, name: string, args: object): Promise<Response> {
  const response = await client.callTool({ name, arguments: { ...args } }) as CallToolResult;
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  const content = response.content[0];
  assert.equal(content?.type, 'text');
  if (content?.type !== 'text') throw new Error('缺少 JSON 文本结果');
  const parsed = JSON.parse(content.text) as Response;
  assert.deepEqual(response.structuredContent, parsed);
  return parsed;
}

async function rejects(client: Client, name: string, args: object, code: string): Promise<void> {
  const response = await client.callTool({ name, arguments: { ...args } }) as CallToolResult;
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.content), new RegExp(`\\[${code}\\]`));
}

async function fixture(t: TestContext, model?: string) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'tl-blocked-mcp-')));
  const repo = path.join(home, 'repo');
  mkdirSync(repo);
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, timeout: 5000, stdio: 'ignore' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'MCP fixture']);
  git(['config', 'user.email', 'fixture@example.test']);
  writeFileSync(path.join(repo, 'base.txt'), 'fixture\n');
  git(['add', '.']);
  git(['commit', '-qm', 'fixture']);
  const file = path.join(home, 'board.json');
  const engine = new BoardEngine(new JsonFileBoardStore(file), new GitService(false));
  const board = await engine.registerBoard({ repo, baseBranch: 'main' });
  const task = await engine.createTask({ title: '阻塞恢复协议测试', boardId: board.id });
  const client = new Client({ name: 'blocked-contract-test', version: '1' });
  const server = createServer(engine);
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  // 测试仅模拟协议标识，不证明真实 Codex 聊天或 Agent 已运行。
  const input: RequestExecutionInput = { id: task.id, boardId: board.id, requestId: 'request-1', action: 'start', workspaceMode: 'project', hostId: 'fixture-host', receiverThreadId: 'fixture-receiver' };
  const requested = await call(client, 'task_execution', requestArgs(input, { ...(model ? { model } : {}) }));
  const receipt = { id: task.id, boardId: board.id, requestId: input.requestId, runId: requested.request.runId };
  const claim = { ...receipt, claimId: 'claim-1' };
  const result = { threadId: 'fixture-thread', hostId: input.hostId, workspacePath: repo, workspaceOwner: 'user', branch: 'main' };
  await call(client, 'task_execution', { action: 'claim', ...claim });
  return { client, file, input, receipt, claim, result };
}

test('MCP blocked：绑定前保留真实创建结果，继续继承结果且不能重新创建', { timeout: 15000 }, async (t) => {
  const { client, file, input, receipt, claim, result } = await fixture(t, 'fixture-model');
  await call(client, 'task_execution', { action: 'bind', ...claim, ...result, phase: 'created' });
  const blocked = await call(client, 'task_execution', { action: 'delivery', ...claim, status: 'blocked', error: '工作区暂不可读，等待核对' });
  assert.equal(blocked.request.status, 'blocked');
  assert.equal(blocked.task.execution.state, 'blocked');
  assert.equal(blocked.task.execution.startedAt, undefined);
  assert.deepEqual(blocked.request.result, result);
  assert.equal(blocked.task.executionBinding, undefined);
  assert.equal(new JsonFileBoardStore(file).getTask(input.id)?.executionRequests?.[0].result?.threadId, result.threadId);
  const before = readFileSync(file, 'utf8');
  for (const action of ['start', 'retry', 'reply']) {
    await rejects(client, 'task_execution', requestArgs(input, { action, message: '继续', requestId: `bad-${action}` }), 'EXECUTION_BUSY');
  }
  await rejects(client, 'task_execution', requestArgs(input, { action: 'continue', requestId: 'bad-mode', workspaceMode: 'worktree' }), 'EXECUTION_CONFLICT');
  assert.equal(readFileSync(file, 'utf8'), before);
  const next = await call(client, 'task_execution', requestArgs(input, { action: 'continue', requestId: 'continue-2' }));
  assert.equal(next.created, true);
  assert.notEqual(next.request.runId, receipt.runId);
  assert.deepEqual(next.request.result, result);
  assert.equal(next.request.model, 'fixture-model');
  assert.deepEqual(next.request.recoveryOf, { requestId: receipt.requestId, runId: receipt.runId });
  const replay = await call(client, 'task_execution', requestArgs(input, { action: 'continue', requestId: 'continue-2' }));
  assert.equal(replay.created, false);
  assert.deepEqual(replay.request, next.request);
  await rejects(client, 'task_execution', requestArgs(input, { action: 'continue', requestId: 'continue-2', model: 'replacement-model' }), 'VALIDATION');
  const nextClaim = { ...receipt, requestId: next.request.requestId, runId: next.request.runId, claimId: 'claim-2' };
  await call(client, 'task_execution', { action: 'claim', ...nextClaim });
  await rejects(client, 'task_execution', { action: 'bind', ...nextClaim, ...result, threadId: 'replacement-thread', phase: 'created' }, 'EXECUTION_CONFLICT');
  await call(client, 'task_execution', { action: 'bind', ...nextClaim, ...result, phase: 'created' });
  const bound = await call(client, 'task_execution', { action: 'bind', ...nextClaim, ...result, phase: 'bound' });
  assert.equal(bound.task.executionBinding?.threadId, result.threadId);
  const running = await call(client, 'task_execution', { action: 'report', ...receipt, requestId: next.request.requestId, runId: next.request.runId, threadId: result.threadId, hostId: result.hostId, reportId: 'running-2', state: 'running' });
  assert.equal(running.task.execution.state, 'running');
  assert.ok(running.task.execution.startedAt);
});

test('MCP blocked：正确认领及非空原因必填，无真实结果继续失败且不写存储', { timeout: 15000 }, async (t) => {
  const { client, file, input, receipt, claim } = await fixture(t);
  const before = readFileSync(file, 'utf8');
  await rejects(client, 'task_execution', { action: 'delivery', ...receipt, status: 'blocked', error: '缺少会话标识' }, 'VALIDATION');
  await rejects(client, 'task_execution', { action: 'delivery', ...claim, claimId: 'wrong-claim', status: 'blocked', error: '缺少会话标识' }, 'EXECUTION_CONFLICT');
  for (const error of [undefined, '', ' ']) await rejects(client, 'task_execution', { action: 'delivery', ...claim, status: 'blocked', error }, 'VALIDATION');
  assert.equal(readFileSync(file, 'utf8'), before);
  const blocked = await call(client, 'task_execution', { action: 'delivery', ...claim, status: 'blocked', error: '创建结果缺少真实会话标识，先核对原操作' });
  assert.equal(blocked.task.execution.state, 'blocked');
  assert.equal(blocked.request.result, undefined);
  const after = readFileSync(file, 'utf8');
  await rejects(client, 'task_execution', requestArgs(input, { action: 'continue', requestId: 'continue-without-result' }), 'EXECUTION_CONFLICT');
  assert.equal(readFileSync(file, 'utf8'), after);
});

test('MCP blocked：绑定后目标回执保留会话，继续复用且旧回执不能覆盖新代次', { timeout: 15000 }, async (t) => {
  const { client, file, input, receipt, claim, result } = await fixture(t);
  await call(client, 'task_execution', { action: 'bind', ...claim, ...result, phase: 'created' });
  await call(client, 'task_execution', { action: 'bind', ...claim, ...result, phase: 'bound' });
  const report = { ...receipt, threadId: result.threadId, hostId: result.hostId, reportId: 'blocked-1', state: 'blocked', activity: '等待依赖恢复' };
  const before = readFileSync(file, 'utf8');
  await rejects(client, 'task_execution', { action: 'report', ...report, threadId: 'wrong-thread' }, 'EXECUTION_CONFLICT');
  for (const activity of [undefined, '', ' ']) await rejects(client, 'task_execution', { action: 'report', ...report, activity }, 'VALIDATION');
  assert.equal(readFileSync(file, 'utf8'), before);
  const blocked = await call(client, 'task_execution', { action: 'report', ...report });
  assert.equal(blocked.task.execution.state, 'blocked');
  assert.equal(blocked.task.executionBinding?.threadId, result.threadId);
  assert.equal(blocked.request.startedAt, undefined);
  assert.deepEqual(await call(client, 'task_execution', { action: 'report', ...report }), blocked);
  const next = await call(client, 'task_execution', requestArgs(input, { action: 'continue', requestId: 'continue-2' }));
  assert.deepEqual(next.request.result, result);
  assert.deepEqual(next.request.recoveryOf, { requestId: receipt.requestId, runId: receipt.runId });
  assert.equal(next.task.executionBinding?.threadId, result.threadId);
  await rejects(client, 'task_execution', { action: 'report', ...report, reportId: 'late-running', state: 'running' }, 'EXECUTION_STALE');
});
