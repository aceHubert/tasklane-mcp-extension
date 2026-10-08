import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BoardEngine, GitService, JsonFileBoardStore, type RequestExecutionInput, type WorkItem } from '@tasklane/core';
import { createServer, type AppsToolDecorations } from '../src/server.js';
import * as h from '../src/handlers.js';

const RESOURCE_URI = 'ui://widget/tasklane/report-card-v0320.html';

// 模拟插件侧 builder（与 extension/src/report-card.mjs 同构）：
// 字段推导本身的边界用例由 ui/test/report-card.test.mjs 直接覆盖。
function stubWidgetDataFor(result: Record<string, unknown>): Record<string, unknown> | null {
  const task = result.task as { id?: string; boardId?: string; executionBinding?: { workspacePath?: string } } | undefined;
  const request = result.request as { repo?: string } | undefined;
  if (!task?.id || !task.boardId || !request) return null;
  const workspace = task.executionBinding?.workspacePath;
  return {
    version: 2,
    widget: 'tasklane-board',
    title: 'TaskLane',
    rendering: 'native-widget',
    mode: 'project',
    boardHome: '/fixture/.tasklane',
    lockedBoardId: task.boardId,
    repoRoot: request.repo ?? workspace,
    projectDir: workspace ?? request.repo,
    taskId: task.id,
    mcpClient: { name: 'apps-report-test', version: '1' },
  };
}

interface ChainResponse {
  task?: WorkItem;
  request?: { runId: string };
  [key: string]: unknown;
}

async function call(client: Client, name: string, args: object): Promise<CallToolResult & { structuredContent?: ChainResponse }> {
  const response = await client.callTool({ name, arguments: { ...args } }) as CallToolResult;
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  const content = response.content[0];
  assert.equal(content?.type, 'text');
  if (content?.type !== 'text') throw new Error('缺少 JSON 文本结果');
  const parsed = JSON.parse(content.text) as ChainResponse;
  // ok() 同源不变式：文本与 structuredContent 在装饰合并后仍保持一致
  assert.deepEqual(response.structuredContent, parsed);
  return response as CallToolResult & { structuredContent?: ChainResponse };
}

async function rejects(client: Client, name: string, args: object, code?: string): Promise<CallToolResult> {
  const response = await client.callTool({ name, arguments: { ...args } }) as CallToolResult;
  assert.equal(response.isError, true);
  if (code) assert.match(JSON.stringify(response.content), new RegExp(`\\[${code}\\]`));
  return response;
}

/**
 * 夹具与 native-execution 契约测试同构：真实 Git 仓库 + 已登记看板 + 任务。
 * apps 以工厂传入，可闭包引用仓库信息模拟插件侧 builder。
 */
async function fixture(
  t: TestContext,
  appsFactory?: (ctx: { repo: string; boardId: string; task: WorkItem }) => AppsToolDecorations,
) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'tl-apps-mcp-')));
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
  const { task } = await h.taskCreate(engine, { title: '报告卡片测试', boardId: board.id });
  const client = new Client({ name: 'apps-report-test', version: '1' });
  const apps = appsFactory?.({ repo, boardId: board.id, task });
  const server = createServer(engine, apps ? { apps } : {});
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const input: RequestExecutionInput = {
    id: task.id, boardId: board.id, requestId: 'request-1', action: 'start', workspaceMode: 'project',
    hostId: 'fixture-host', receiverThreadId: 'fixture-receiver',
  };
  // 标识符仅用于协议模拟；本测试没有原生工具，不证明真实聊天或 Agent 已启动。
  const result = { threadId: 'fixture-thread', hostId: 'fixture-host', workspacePath: repo, workspaceOwner: 'user' as const, branch: 'main' };
  return { client, input, result, repo, task, boardId: board.id };
}

/** 驱动 request → claim → bind(created/bound) → report 的完整协议链，返回 report 响应 */
async function runChain(client: Client, input: RequestExecutionInput, result: { threadId: string; hostId: string }) {
  const { action, ...rest } = input;
  const requested = await call(client, 'task_execution', { ...rest, action: 'request', requestAction: action });
  const receipt = { id: input.id, boardId: input.boardId, requestId: input.requestId, runId: requested.structuredContent?.request?.runId };
  await call(client, 'task_execution', { action: 'claim', ...receipt, claimId: 'claim-1' });
  await call(client, 'task_execution', { action: 'bind', ...receipt, claimId: 'claim-1', ...result, phase: 'created' });
  await call(client, 'task_execution', { action: 'bind', ...receipt, claimId: 'claim-1', ...result, phase: 'bound' });
  return call(client, 'task_execution', {
    action: 'report', ...receipt, threadId: result.threadId, hostId: result.hostId, reportId: 'report-1', state: 'running', activity: '协议回执',
  });
}

test('apps 装饰：task_execution 工具定义绑定卡片 _meta 最小集，无侧边栏入口', async (t) => {
  const { client } = await fixture(t, () => ({
    resourceUri: RESOURCE_URI,
    widgetDataFor: () => null,
  }));
  const { tools } = await client.listTools();
  const report = tools.find((tool) => tool.name === 'task_execution');
  assert.ok(report, 'task_execution');
  assert.equal(report.title, 'TaskLane 任务报告');
  const meta = (report._meta ?? {}) as {
    ui?: { resourceUri?: string; visibility?: string[] };
    'openai/outputTemplate'?: string;
    'openai/widgetAccessible'?: boolean;
    'openai/toolInvocation/invoking'?: string;
    'openai/toolInvocation/invoked'?: string;
    'openai/ui'?: { entrypoints?: unknown[] };
  };
  assert.equal(meta.ui?.resourceUri, RESOURCE_URI);
  assert.deepEqual(meta.ui?.visibility, ['model', 'app']);
  assert.equal(meta['openai/outputTemplate'], RESOURCE_URI);
  assert.equal(meta['openai/widgetAccessible'], true);
  assert.equal(typeof meta['openai/toolInvocation/invoking'], 'string');
  assert.equal(typeof meta['openai/toolInvocation/invoked'], 'string');
  assert.equal(meta['openai/ui'], undefined);
  // 其它工具不受影响
  const plain = tools.find((tool) => tool.name === 'task_move');
  assert.equal(plain?._meta, undefined);
});

test('apps 装饰：report 成功结果合并 widget 字段，_meta.widgetData 与 structuredContent 同源', async (t) => {
  const { client, input, result, repo, boardId, task } = await fixture(t, () => ({
    resourceUri: RESOURCE_URI,
    widgetDataFor: stubWidgetDataFor,
  }));
  const response = await runChain(client, input, result);
  const data = response.structuredContent!;
  assert.equal(data.widget, 'tasklane-board');
  assert.equal(data.mode, 'project');
  assert.equal(data.boardHome, '/fixture/.tasklane');
  assert.equal(data.lockedBoardId, boardId);
  assert.equal(data.repoRoot, repo);
  assert.equal(data.projectDir, repo); // project 模式绑定工作区即仓库根
  assert.equal(data.taskId, task.id);
  assert.deepEqual(data.mcpClient, { name: 'apps-report-test', version: '1' });
  const meta = response._meta as Record<string, unknown>;
  assert.equal(meta['openai/outputTemplate'], RESOURCE_URI);
  assert.deepEqual(meta.widgetData, data);
});

test('apps 装饰：组装器返回 null 时保持纯结果，无 _meta 与 widget 字段', async (t) => {
  const { client, input, result } = await fixture(t, () => ({
    resourceUri: RESOURCE_URI,
    widgetDataFor: () => null,
  }));
  const response = await runChain(client, input, result);
  assert.equal(response._meta, undefined);
  assert.equal('widget' in (response.structuredContent ?? {}), false);
  assert.equal('taskId' in (response.structuredContent ?? {}), false);
});

test('无 apps 选项：task_execution 工具与结果和现状逐字段一致', async (t) => {
  const { client, input, result } = await fixture(t);
  const { tools } = await client.listTools();
  assert.equal(tools.find((tool) => tool.name === 'task_execution')?._meta, undefined);
  const response = await runChain(client, input, result);
  assert.equal(response._meta, undefined);
  assert.equal('widget' in (response.structuredContent ?? {}), false);
  const data = response.structuredContent!;
  assert.ok(data.task && data.request, '结果仍为 task + request 原结构');
});

test('apps 装饰：错误回执不附卡片，fail() 结果原样', async (t) => {
  const { client, input, result } = await fixture(t, () => ({
    resourceUri: RESOURCE_URI,
    widgetDataFor: () => ({ widget: 'tasklane-board', mode: 'project' }),
  }));
  const { action, ...rest } = input;
  const requested = await call(client, 'task_execution', { ...rest, action: 'request', requestAction: action });
  const receipt = { id: input.id, boardId: input.boardId, requestId: input.requestId, runId: requested.structuredContent?.request?.runId };
  const response = await rejects(client, 'task_execution', {
    action: 'report', ...receipt, threadId: 'wrong-thread', hostId: result.hostId, reportId: 'bad-1', state: 'running',
  }, 'EXECUTION_CONFLICT');
  assert.equal(response._meta, undefined);
  const text = response.content[0];
  assert.ok(text.type === 'text' && !text.text.includes('tasklane-board'));
});

test('apps 装饰：组装器抛异常不把已持久化的成功回执变成错误，降级为纯结果', async (t) => {
  // 验收缺陷回归：回执成功落盘后装饰抛错，曾使工具返回 isError 与磁盘状态不一致。
  const { client, input, result, repo, task } = await fixture(t, () => ({
    resourceUri: RESOURCE_URI,
    widgetDataFor: () => {
      throw new Error('decorate failure');
    },
  }));
  // 首次 running 回执只把 Ready 任务移到 Doing：夹具任务先就位 ready
  await call(client, 'task_move', { id: task.id, boardId: input.boardId, status: 'ready' });
  const response = await runChain(client, input, result);
  assert.equal(response.isError, undefined, '已成功的回执不得因装饰失败返回错误');
  assert.equal(response._meta, undefined);
  assert.equal('widget' in (response.structuredContent ?? {}), false);
  assert.ok(response.structuredContent?.task && response.structuredContent?.request, '纯结果结构保留');

  // 幂等重放同一 reportId：仍成功且时间线事件数不变（getSession 每次读盘最新）
  const store = new JsonFileBoardStore(path.join(path.dirname(repo), 'board.json'));
  const eventsBefore = store.getSession(task.id)?.events.length;
  const replay = await client.callTool({
    name: 'task_execution',
    arguments: {
      action: 'report',
      id: input.id, boardId: input.boardId, requestId: input.requestId,
      runId: response.structuredContent?.request?.runId,
      threadId: result.threadId, hostId: result.hostId, reportId: 'report-1', state: 'running', activity: '协议回执',
    },
  }) as CallToolResult;
  assert.equal(replay.isError, undefined);
  assert.equal(store.getSession(task.id)?.events.length, eventsBefore, '重放不追加时间线事件');

  // 独立只读视角核验磁盘状态与回执一致：running 已写入并把 Ready 移到 Doing
  const persisted = store.getTask(task.id);
  assert.equal(persisted?.execution.state, 'running');
  assert.equal(persisted?.status, 'doing');
});

test('apps 装饰：组装器返回不可序列化数据（BigInt）时同样降级为纯结果', async (t) => {
  // 验收缺陷回归：回调本身不抛错，但合并结果 JSON.stringify 抛错（BigInt 无法序列化），
  // 曾使已持久化的成功回执返回 "Do not know how to serialize a BigInt"。
  const { client, input, result, repo, task } = await fixture(t, () => ({
    resourceUri: RESOURCE_URI,
    widgetDataFor: () => ({ widget: 'tasklane-board', extra: 1n }),
  }));
  await call(client, 'task_move', { id: task.id, boardId: input.boardId, status: 'ready' });
  const response = await runChain(client, input, result);
  assert.equal(response.isError, undefined, '序列化失败不得使已持久化回执返回错误');
  assert.equal(response._meta, undefined);
  assert.equal('widget' in (response.structuredContent ?? {}), false);
  assert.equal('extra' in (response.structuredContent ?? {}), false);
  const persisted = new JsonFileBoardStore(path.join(path.dirname(repo), 'board.json')).getTask(task.id);
  assert.equal(persisted?.execution.state, 'running');
  assert.equal(persisted?.status, 'doing');
});
