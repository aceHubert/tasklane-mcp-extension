import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BoardEngine, GitService, JsonFileBoardStore, type ExecutionRequest, type RequestExecutionInput, type WorkItem } from '@tasklane/core';
import { createServer } from '../src/server.js';
import * as h from '../src/handlers.js';

interface ExecutionResponse {
  task: WorkItem;
  request: ExecutionRequest;
  created?: boolean;
  claimed?: boolean;
}

function requestArgs(base: Partial<RequestExecutionInput> & { action: RequestExecutionInput['action'] }, patch: Record<string, unknown> = {}) {
  const { action, ...rest } = { ...base, ...patch };
  return { ...rest, action: 'request' as const, requestAction: action };
}

async function call(client: Client, name: string, args: object): Promise<ExecutionResponse> {
  const response = await client.callTool({ name, arguments: { ...args } }) as CallToolResult;
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  const content = response.content[0];
  assert.equal(content?.type, 'text');
  if (content?.type !== 'text') throw new Error('缺少 JSON 文本结果');
  const parsed = JSON.parse(content.text) as ExecutionResponse;
  assert.deepEqual(response.structuredContent, parsed);
  return parsed;
}

async function rejects(client: Client, name: string, args: object, code?: string): Promise<void> {
  const response = await client.callTool({ name, arguments: { ...args } }) as CallToolResult;
  assert.equal(response.isError, true);
  if (code) assert.match(JSON.stringify(response.content), new RegExp(`\\[${code}\\]`));
}

async function fixture(t: TestContext) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'tl-native-mcp-')));
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
  const store = new JsonFileBoardStore(file);
  const engine = new BoardEngine(store, new GitService(false));
  const { board } = await h.boardCreate(engine, { repo, baseBranch: 'main' });
  const { task } = await h.taskCreate(engine, { title: '原生协议测试', boardId: board.id });
  const client = new Client({ name: 'native-contract-test', version: '1' });
  const server = createServer(engine);
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const input: RequestExecutionInput = {
    id: task.id, boardId: board.id, requestId: 'request-1', action: 'start', workspaceMode: 'project',
    hostId: 'fixture-host', receiverThreadId: 'fixture-receiver',
  };
  // 标识符仅用于协议模拟；本测试没有原生工具，不证明真实聊天或 Agent 已启动。
  const result = { threadId: 'fixture-thread', hostId: input.hostId!, workspacePath: repo, workspaceOwner: 'user' as const, branch: 'main' };
  return { client, engine, store, file, input, result };
}

test('MCP 原生契约：task_execution 单工具六 action 分支、必填关联，无效参数不写存储', { timeout: 15000 }, async (t) => {
  const { client, file, input, result } = await fixture(t);
  const { tools } = await client.listTools();
  const before = readFileSync(file, 'utf8');
  assert.equal(tools.some((tool) => tool.name === 'task_execution_request'), false, '六合一后不再注册独立请求工具');
  const tool = tools.find((candidate) => candidate.name === 'task_execution');
  assert.ok(tool, 'task_execution');
  const schema = tool.inputSchema as { properties: Record<string, unknown>; required?: string[] };
  // 扁平 schema：全部六个分支字段合并公示，action 为判别键
  for (const key of ['action', 'requestAction', 'status', 'claimId', 'phase', 'provider', 'sessionId', 'reportId', 'state', 'purpose']) {
    assert.ok(schema.properties[key], key);
  }
  for (const key of ['action', 'id', 'boardId']) assert.ok(schema.required?.includes(key), key);
  const { boardId: omittedBoard, ...withoutBoard } = input;
  await rejects(client, 'task_execution', requestArgs(withoutBoard));
  await rejects(client, 'task_execution', requestArgs(input, { requestId: '' }));
  await rejects(client, 'task_execution', requestArgs(input, { hostId: 'sess-internal' }), 'VALIDATION');
  const requested = await call(client, 'task_execution', requestArgs(input));
  const receipt = { id: input.id, boardId: input.boardId, requestId: input.requestId, runId: requested.request.runId };
  const claimed = await call(client, 'task_execution', { action: 'claim', ...receipt, claimId: 'claim-1' });
  assert.equal(claimed.claimed, true);
  const afterClaim = readFileSync(file, 'utf8');
  await rejects(client, 'task_execution', { action: 'bind', ...receipt, phase: 'created', ...result });
  await rejects(client, 'task_execution', { action: 'bind', ...receipt, claimId: 'claim-1', phase: 'created', result });
  await rejects(client, 'task_execution', { action: 'bind', ...receipt, claimId: 'claim-1', phase: 'invalid', ...result });
  await rejects(client, 'task_execution', { action: 'bind', ...receipt, claimId: 'claim-1', phase: 'created', ...result, threadId: 'creating-thread' }, 'VALIDATION');
  assert.equal(readFileSync(file, 'utf8'), afterClaim);
  assert.notEqual(afterClaim, before);
});

test('MCP 原生契约：请求/认领/两阶段绑定/回执幂等，终态与旧代次守卫', { timeout: 15000 }, async (t) => {
  const { client, store, file, input, result } = await fixture(t);
  const requested = await call(client, 'task_execution', requestArgs(input));
  assert.equal(requested.created, true);
  assert.equal(requested.request.status, 'pending');
  assert.equal(requested.task.assignee, 'agent');
  assert.equal(requested.task.execution.state, 'starting');
  assert.equal(requested.task.execution.sessionId, undefined);
  const replay = await call(client, 'task_execution', requestArgs(input));
  const merged = await call(client, 'task_execution', requestArgs(input, { requestId: 'same-intent' }));
  assert.equal(replay.created, false);
  assert.equal(merged.created, false);
  assert.deepEqual(merged.request, replay.request);
  await rejects(client, 'task_execution', requestArgs(input, { message: '改变内容' }), 'EXECUTION_CONFLICT');
  const receipt = { id: input.id, boardId: input.boardId, requestId: input.requestId, runId: requested.request.runId };
  const delivery = await call(client, 'task_execution', { action: 'delivery', ...receipt, status: 'uncertain', error: '模拟传输超时' });
  assert.equal(delivery.request.status, 'uncertain');
  assert.equal(delivery.task.execution.state, 'starting');
  const claim = { ...receipt, claimId: 'claim-1' };
  assert.equal((await call(client, 'task_execution', { action: 'claim', ...claim })).claimed, true);
  assert.equal((await call(client, 'task_execution', { action: 'claim', ...claim })).claimed, false);
  await rejects(client, 'task_execution', { action: 'claim', ...claim, claimId: 'claim-2' }, 'EXECUTION_CONFLICT');
  await rejects(client, 'task_execution', { action: 'bind', ...claim, ...result, phase: 'bound' }, 'EXECUTION_CONFLICT');
  const created = await call(client, 'task_execution', { action: 'bind', ...claim, ...result, phase: 'created' });
  assert.equal(created.request.status, 'created');
  assert.equal(created.task.executionBinding, undefined);
  assert.deepEqual(new JsonFileBoardStore(file).getTask(input.id)?.executionRequests?.[0].result, result);
  await rejects(client, 'task_execution', { action: 'bind', ...claim, ...result, threadId: 'replacement-thread', phase: 'bound' }, 'EXECUTION_CONFLICT');
  const bound = await call(client, 'task_execution', { action: 'bind', ...claim, ...result, phase: 'bound' });
  assert.equal(bound.request.status, 'bound');
  assert.equal(bound.task.execution.state, 'starting');
  assert.equal(bound.task.executionBinding?.provider, 'codex-desktop');
  const report = { ...receipt, threadId: result.threadId, hostId: result.hostId };
  await rejects(client, 'task_execution', { action: 'report', ...report, threadId: 'wrong-thread', reportId: 'bad-thread', state: 'running' }, 'EXECUTION_CONFLICT');
  await rejects(client, 'task_execution', { action: 'report', ...report, reportId: 'early-completed', state: 'completed' }, 'EXECUTION_CONFLICT');
  const runningInput = { ...report, reportId: 'running-1', state: 'running', activity: '协议模拟' };
  const running = await call(client, 'task_execution', { action: 'report', ...runningInput });
  assert.ok(running.request.startedAt);
  const runAgain = await call(client, 'task_execution', { action: 'report', ...runningInput });
  assert.deepEqual(runAgain, running);
  await rejects(client, 'task_execution', { action: 'report', ...runningInput, activity: '改变回执' }, 'EXECUTION_CONFLICT');
  await rejects(client, 'task_execution', requestArgs(input, { requestId: 'busy', action: 'continue' }), 'EXECUTION_BUSY');
  const late = await call(client, 'task_execution', { action: 'delivery', ...receipt, status: 'uncertain' });
  assert.equal(late.request.status, 'running');
  const completed = await call(client, 'task_execution', { action: 'report', ...report, reportId: 'completed-1', state: 'completed' });
  assert.equal(completed.task.status, 'backlog');
  const terminalReplay = await call(client, 'task_execution', requestArgs(input));
  assert.equal(terminalReplay.created, false);
  assert.equal(terminalReplay.task.execution.state, 'completed');
  await rejects(client, 'task_execution', { action: 'report', ...report, reportId: 'late-running', state: 'running' }, 'EXECUTION_STALE');
  await rejects(client, 'task_execution', requestArgs(input, { requestId: 'empty-reply', action: 'reply', message: ' ' }), 'VALIDATION');
  await rejects(client, 'task_execution', requestArgs(input, { requestId: 'oversize', action: 'reply', message: 'x'.repeat(20001) }));
  const message = '完整回复\n'.repeat(100);
  const reply = await call(client, 'task_execution', requestArgs(input, { requestId: 'reply-2', action: 'reply', message }));
  assert.equal(reply.request.message, message);
  assert.notEqual(reply.request.runId, receipt.runId);
  assert.equal(reply.task.executionBinding?.threadId, result.threadId);
  await rejects(client, 'task_execution', { action: 'report', ...report, reportId: 'completed-1', state: 'completed' }, 'EXECUTION_STALE');
  assert.equal(store.getTask(input.id)?.executionRequests?.length, 2);
});

test('MCP 原生契约：全部 action 分支守卫错误看板和归档，不写存储', { timeout: 15000 }, async (t) => {
  const { client, engine, file, input, result } = await fixture(t);
  const requested = await call(client, 'task_execution', requestArgs(input));
  const receipt = { id: input.id, boardId: input.boardId, requestId: input.requestId, runId: requested.request.runId };
  for (const status of ['ready', 'doing', 'review', 'done'] as const) await h.taskMove(engine, { id: input.id, status });
  await h.taskArchive(engine, { id: input.id });
  const operations: [string, object][] = [
    ['task_execution', requestArgs(input)],
    ['task_execution', { action: 'delivery', ...receipt, status: 'delivered' }],
    ['task_execution', { action: 'claim', ...receipt, claimId: 'claim-1' }],
    ['task_execution', { action: 'bind', ...receipt, claimId: 'claim-1', phase: 'created', ...result }],
    ['task_execution', { action: 'report', ...receipt, threadId: result.threadId, hostId: result.hostId, reportId: 'report-1', state: 'running' }],
  ];
  const before = readFileSync(file, 'utf8');
  for (const [name, args] of operations) {
    await rejects(client, name, { ...args, boardId: 'default' }, 'BOARD_MISMATCH');
    await rejects(client, name, args, 'TASK_ARCHIVED');
  }
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('MCP 无先验路由：schema 可省略提示，真实接收者认领后完成目标执行', { timeout: 15000 }, async (t) => {
  const { client, file, input, result } = await fixture(t);
  const { hostId, receiverThreadId, ...withoutRoute } = input;
  const { tools } = await client.listTools();
  const schema = tools.find((tool) => tool.name === 'task_execution')!.inputSchema as { properties: Record<string, unknown>; required?: string[] };
  assert.ok(schema.properties.hostId && schema.properties.receiverThreadId, '路由提示字段已公示');
  assert.equal(schema.required?.includes('hostId'), false);
  assert.equal(schema.required?.includes('receiverThreadId'), false);
  const requested = await call(client, 'task_execution', requestArgs(withoutRoute));
  const receipt = { id: input.id, boardId: input.boardId, requestId: input.requestId, runId: requested.request.runId };
  const before = readFileSync(file, 'utf8');
  await rejects(client, 'task_execution', { action: 'claim', ...receipt, claimId: 'claim-1' }, 'VALIDATION');
  await rejects(client, 'task_execution', { action: 'claim', ...receipt, claimId: 'claim-1', hostId }, 'VALIDATION');
  await rejects(client, 'task_execution', { action: 'claim', ...receipt, claimId: 'claim-1', receiverThreadId }, 'VALIDATION');
  assert.equal(readFileSync(file, 'utf8'), before);
  const claim = { ...receipt, claimId: 'claim-1', hostId, receiverThreadId };
  const claimed = await call(client, 'task_execution', { action: 'claim', ...claim });
  assert.deepEqual(claimed.request.receiver, { hostId, threadId: receiverThreadId });
  assert.equal(claimed.request.hostId, undefined);
  assert.equal((await call(client, 'task_execution', requestArgs(withoutRoute))).created, false);
  assert.equal((await call(client, 'task_execution', { action: 'claim', ...claim })).claimed, false);
  await rejects(client, 'task_execution', { action: 'claim', ...claim, receiverThreadId: 'other-receiver' }, 'EXECUTION_CONFLICT');
  const bind = { ...receipt, claimId: 'claim-1', ...result };
  await call(client, 'task_execution', { action: 'bind', ...bind, phase: 'created' });
  const bound = await call(client, 'task_execution', { action: 'bind', ...bind, phase: 'bound' });
  assert.equal(bound.task.execution.startedAt, undefined);
  const report = { ...receipt, hostId: result.hostId, threadId: result.threadId };
  const running = await call(client, 'task_execution', { action: 'report', ...report, reportId: 'run', state: 'running' });
  assert.ok(running.task.execution.startedAt);
  const completed = await call(client, 'task_execution', { action: 'report', ...report, reportId: 'complete', state: 'completed' });
  assert.equal(completed.task.execution.state, 'completed');
  assert.deepEqual(new JsonFileBoardStore(file).getTask(input.id)!.executionRequests![0].receiver, claimed.request.receiver);
});

test('MCP 明确拒绝：拒绝参数校验、接收 Agent 拒绝与用户新尝试', { timeout: 15000 }, async (t) => {
  const { client, input, file } = await fixture(t);
  const { hostId, receiverThreadId, ...withoutRoute } = input;
  const requested = await call(client, 'task_execution', requestArgs(withoutRoute));
  const receipt = { id: input.id, boardId: input.boardId, requestId: input.requestId, runId: requested.request.runId };
  const rejection = { ...receipt, status: 'rejected', error: '宿主明确拒绝' };
  const before = readFileSync(file, 'utf8');
  for (const error of [undefined, '', ' ', 'x'.repeat(201)]) await rejects(client, 'task_execution', { action: 'delivery', ...rejection, error });
  assert.equal(readFileSync(file, 'utf8'), before);
  const rejected = await call(client, 'task_execution', { action: 'delivery', ...rejection });
  assert.equal(rejected.request.status, 'rejected');
  assert.equal(rejected.task.assignee, 'agent');
  assert.equal(rejected.task.execution.state, 'assigned');
  assert.equal(rejected.task.execution.startedAt, undefined);
  await rejects(client, 'task_execution', { action: 'claim', ...receipt, claimId: 'claim-1', hostId, receiverThreadId }, 'EXECUTION_STALE');
  assert.equal((await call(client, 'task_execution', { action: 'delivery', ...receipt, status: 'delivered' })).request.status, 'rejected');
  const next = await call(client, 'task_execution', requestArgs(withoutRoute, { requestId: 'explicit-next' }));
  assert.equal(next.created, true);
  const nextReceipt = { ...receipt, requestId: next.request.requestId, runId: next.request.runId };
  await call(client, 'task_execution', { action: 'claim', ...nextReceipt, claimId: 'claim-next', hostId, receiverThreadId });
  const afterClaim = readFileSync(file, 'utf8');
  assert.equal((await call(client, 'task_execution', { action: 'delivery', ...nextReceipt, status: 'rejected', error: '迟到面板拒绝' })).request.status, 'claimed');
  await rejects(client, 'task_execution', { action: 'delivery', ...nextReceipt, status: 'rejected', error: '错误认领', claimId: 'claim-wrong' }, 'EXECUTION_CONFLICT');
  assert.equal(readFileSync(file, 'utf8'), afterClaim);
  const actorRejected = await call(client, 'task_execution', { action: 'delivery', ...nextReceipt, status: 'rejected', error: '缺少所需原生能力', claimId: 'claim-next' });
  assert.equal(actorRejected.request.status, 'rejected');
  assert.equal(actorRejected.task.assignee, 'agent');
  assert.equal(actorRejected.task.execution.state, 'assigned');
  assert.equal(new JsonFileBoardStore(file).getTask(input.id)!.executionRequests![1].status, 'rejected');
});

test('MCP 真实 Git 核验失败仍保留 created 标识，重放不创建或替换且不能真正绑定', { timeout: 15000 }, async (t) => {
  for (const problem of ['不可读目录', '错误分支'] as const) {
    await t.test(problem, async (child) => {
      const { client, file, input, result } = await fixture(child);
      const requested = await call(client, 'task_execution', requestArgs(input, { model: 'preserved-model' }));
      const receipt = { id: input.id, boardId: input.boardId, requestId: input.requestId, runId: requested.request.runId };
      await call(client, 'task_execution', { action: 'claim', ...receipt, claimId: 'claim-1' });
      const actual = problem === '不可读目录'
        ? { ...result, workspacePath: path.join(result.workspacePath, 'unavailable-workspace') }
        : { ...result, branch: 'incorrect-branch' };
      const binding = { ...receipt, claimId: 'claim-1', ...actual };
      const created = await call(client, 'task_execution', { action: 'bind', ...binding, phase: 'created' });
      assert.equal(created.request.status, 'created');
      assert.deepEqual(created.request.result, actual);
      assert.equal(created.task.executionBinding, undefined);
      assert.equal(created.task.branch, undefined);
      assert.equal(created.task.worktreePath, undefined);
      assert.equal(created.task.execution.startedAt, undefined);
      const before = readFileSync(file, 'utf8');
      await rejects(client, 'task_execution', { action: 'bind', ...binding, phase: 'bound' }, problem === '不可读目录' ? 'VALIDATION' : 'GIT_ERROR');
      await rejects(client, 'task_execution', { action: 'bind', ...binding, phase: 'created', threadId: 'replacement-thread' }, 'EXECUTION_CONFLICT');
      assert.equal(readFileSync(file, 'utf8'), before);
      assert.deepEqual((await call(client, 'task_execution', { action: 'bind', ...binding, phase: 'created' })).request.result, actual);
      const replay = await call(client, 'task_execution', requestArgs(input, { requestId: 'same-intent', model: 'preserved-model' }));
      assert.equal(replay.created, false);
      assert.deepEqual(replay.request.result, actual);
      assert.equal(replay.request.model, 'preserved-model');
      await rejects(client, 'task_execution', { action: 'report', ...receipt, threadId: actual.threadId, hostId: actual.hostId, reportId: 'premature-run', state: 'running' }, 'EXECUTION_CONFLICT');
      const persisted = new JsonFileBoardStore(file).getTask(input.id)!;
      assert.deepEqual(persisted.executionRequests![0].result, actual);
      assert.equal(persisted.executionBinding, undefined);
      assert.equal(persisted.execution.state, 'starting');
    });
  }
});

test('MCP 模型契约：start 接受归一化模型，非法值和后续动作覆盖不写存储', { timeout: 15000 }, async (t) => {
  const { client, file, input } = await fixture(t);
  const { tools } = await client.listTools();
  const schema = tools.find((tool) => tool.name === 'task_execution')!.inputSchema as { properties: Record<string, unknown>; required?: string[] };
  assert.ok(schema.properties.model);
  assert.equal(schema.required?.includes('model'), false);
  const before = readFileSync(file, 'utf8');
  for (const model of ['', '   ', 'x'.repeat(129), 'model name', '-model', 'model;command', 42]) {
    await rejects(client, 'task_execution', requestArgs(input, { model }));
  }
  for (const action of ['reply', 'continue', 'retry']) {
    await rejects(client, 'task_execution', requestArgs(input, { action, message: '继续处理', model: 'custom-model' }), 'VALIDATION');
  }
  assert.equal(readFileSync(file, 'utf8'), before);
  const requested = await call(client, 'task_execution', requestArgs(input, { model: '  provider/custom-model:latest  ' }));
  assert.equal(requested.request.model, 'provider/custom-model:latest');
  assert.equal(new JsonFileBoardStore(file).getTask(input.id)?.executionRequests?.[0].model, requested.request.model);
  const after = readFileSync(file, 'utf8');
  const replay = await call(client, 'task_execution', requestArgs(input, { model: requested.request.model }));
  assert.equal(replay.created, false);
  await rejects(client, 'task_execution', requestArgs(input, { model: 'other-model' }), 'EXECUTION_CONFLICT');
  await rejects(client, 'task_execution', requestArgs(input, { requestId: 'other-model', model: 'other-model' }), 'EXECUTION_BUSY');
  assert.equal(readFileSync(file, 'utf8'), after);
});
