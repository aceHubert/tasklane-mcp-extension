import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  BoardEngine, BoardError, GitService, JsonFileBoardStore,
  type ChangeSummary, type ExecutionRequest, type ExecutionResult,
  type RepoValidation, type RequestExecutionInput, type WorkItem,
} from '@tasklane/core';
import { createServer } from '../src/server.js';

const options = { timeout: 15000 };
const executionTool = 'task_execution';
const recoverTool = 'task_execution_recover';
const repo = '/repos/mcp-recovery';
const hostId = 'mcp-recovery-host';
const receiverThreadId = 'mcp-recovery-receiver';

interface ExecutionResponse {
  task: WorkItem;
  request: ExecutionRequest;
  created?: boolean;
  changed?: boolean;
}

class RecoveryGit extends GitService {
  constructor() { super(true); }
  override async identifyRepo(input: string): Promise<RepoValidation> {
    if (input !== repo) throw new BoardError('GIT_ERROR', '仅接受模拟目录');
    return { root: repo, repoKey: `${repo}/.git` };
  }
  override async assertWorktreeMatches(workspacePath: string, expectedRepo: string, branch: string): Promise<void> {
    assert.equal(workspacePath, repo);
    assert.equal(expectedRepo, repo);
    assert.equal(branch, 'main');
  }
  override async ensureTaskContext(): Promise<null> { assert.fail('协议测试不能创建工作区'); }
  override async resolveRepo(): Promise<null> { assert.fail('协议测试不能发现真实仓库'); }
  override async diffSummary(): Promise<ChangeSummary> {
    return { filesChanged: 0, additions: 0, deletions: 0, testStatus: 'unknown', files: [] };
  }
}

async function fixture(t: TestContext) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tl-recovery-mcp-')), 'board.json');
  const store = new JsonFileBoardStore(file);
  store.mutateBoard('default', (board) => ({ ...board, repo, repoKey: `${repo}/.git`, baseBranch: 'main' }));
  let time = Date.UTC(2026, 9, 4);
  const engine = new BoardEngine(store, new RecoveryGit(), () => new Date(time));
  const task = await engine.createTask({ title: '解除 MCP 契约', status: 'ready' });
  const client = new Client({ name: 'recovery-contract-test', version: '1' });
  const server = createServer(engine);
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const input: RequestExecutionInput = {
    id: task.id, boardId: 'default', requestId: 'request-a', action: 'start', workspaceMode: 'project', hostId, receiverThreadId,
  };
  // 所有标识仅作协议模拟，不证明真实宿主已启动或停止。
  const result: ExecutionResult = { threadId: 'mcp-recovery-target', hostId, workspacePath: repo, workspaceOwner: 'user', branch: 'main' };
  return { file, store, engine, client, input, result, iso: () => new Date(time).toISOString(), advance: (ms: number) => { time += ms; } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function receipt(request: ExecutionRequest) {
  return { id: request.taskId, boardId: request.boardId, requestId: request.requestId, runId: request.runId };
}
async function call(client: Client, name: string, args: object): Promise<ExecutionResponse> {
  const response = await client.callTool({ name, arguments: { ...args } }) as CallToolResult;
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  const content = response.content[0];
  assert.equal(content?.type, 'text');
  if (content?.type !== 'text') throw new Error('缺少 JSON 文本');
  const parsed = JSON.parse(content.text) as ExecutionResponse;
  assert.deepEqual(response.structuredContent, parsed);
  return parsed;
}
async function rejects(f: Fixture, name: string, args: object, code?: string) {
  const before = readFileSync(f.file, 'utf8');
  const response = await f.client.callTool({ name, arguments: { ...args } }) as CallToolResult;
  assert.equal(response.isError, true, JSON.stringify(response.content));
  if (code) assert.match(JSON.stringify(response.content), new RegExp(`\\[${code}\\]`));
  assert.equal(readFileSync(f.file, 'utf8'), before);
}
async function requested(f: Fixture, bound = false) {
  const { action, ...rest } = f.input;
  let response = await call(f.client, executionTool, { ...rest, action: 'request', requestAction: action });
  if (bound) {
    const claim = { ...receipt(response.request), claimId: 'claim-a' };
    await call(f.client, executionTool, { action: 'claim', ...claim });
    response = await call(f.client, executionTool, { action: 'bind', ...claim, ...f.result, phase: 'created' });
    response = await call(f.client, executionTool, { action: 'bind', ...claim, ...f.result, phase: 'bound' });
  }
  return response;
}

test('MCP 解除 schema：app-only 工具注册、关联字段必填、原因非空长度受限，非法输入零写入', options, async (t) => {
  const f = await fixture(t);
  const { tools } = await f.client.listTools();
  const recover = tools.find((tool) => tool.name === recoverTool);
  assert.ok(recover);
  assert.deepEqual(recover._meta?.ui, { visibility: ['app'] });
  const schema = recover.inputSchema as { required?: string[]; properties?: Record<string, { type?: string; minLength?: number; maxLength?: number }> };
  for (const key of ['id', 'boardId', 'requestId', 'runId', 'reason']) assert.ok(schema.required?.includes(key), key);
  assert.equal(schema.properties?.reason?.maxLength, 200);
  assert.equal(tools.some((tool) => tool.name === 'task_execution_recovery_request'), false);
  const { request } = await requested(f);
  const release = { ...receipt(request), reason: '人工确认旧会话已结束' };
  for (const key of ['id', 'boardId', 'requestId', 'runId', 'reason']) {
    const missing: Record<string, unknown> = { ...release };
    delete missing[key];
    await rejects(f, recoverTool, missing);
  }
  // zod schema 层 trim+min/max 拒绝空串、空白串与超长（协议错误无业务码）
  for (const reason of ['', ' ', 'x'.repeat(201)]) await rejects(f, recoverTool, { ...release, reason });
});

test('MCP 解除成功 structuredContent：取消不是停止，幂等零写入、旧操作 stale、续接新 run 保留绑定', options, async (t) => {
  const f = await fixture(t);
  const original = await requested(f, true);
  const release = { ...receipt(original.request), reason: '人工确认旧会话已结束' };
  const recovered = await call(f.client, recoverTool, release);
  assert.equal(recovered.changed, true);
  assert.equal(recovered.request.status, 'cancelled');
  assert.deepEqual(recovered.request.recovery, { at: recovered.request.updatedAt, reason: release.reason, confirmedStopped: true, releasedBy: 'user' });
  assert.equal(recovered.request.claimId, original.request.claimId);
  assert.deepEqual(recovered.request.result, original.request.result);
  assert.deepEqual(recovered.request.receiver, original.request.receiver);
  assert.deepEqual(recovered.task.executionBinding, original.task.executionBinding);
  assert.equal(recovered.task.execution.state, 'assigned');
  assert.equal(recovered.task.execution.runId, original.request.runId);
  assert.equal(recovered.task.execution.startedAt, undefined);
  const before = readFileSync(f.file, 'utf8');
  const replay = await call(f.client, recoverTool, release);
  assert.equal(replay.changed, false);
  assert.deepEqual(replay.task, recovered.task);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(f.store.getSession(original.request.taskId)!.events.some((event) => event.kind === 'stopped'), false);
  const receiptInput = receipt(original.request);
  const late = [
    { action: 'claim', ...receiptInput, claimId: 'claim-a' },
    { action: 'delivery', ...receiptInput, status: 'delivered' },
    { action: 'bind', ...receiptInput, claimId: 'claim-a', ...f.result, phase: 'created' },
    { action: 'bind', ...receiptInput, claimId: 'claim-a', ...f.result, phase: 'bound' },
    { action: 'report', ...receiptInput, threadId: f.result.threadId, hostId, reportId: 'late-running', state: 'running' },
  ] as const;
  for (const args of late) await rejects(f, executionTool, args, 'EXECUTION_STALE');
  const { action, ...rest } = f.input;
  const next = await call(f.client, executionTool, { ...rest, requestId: 'continue-next', action: 'request', requestAction: 'continue' });
  assert.notEqual(next.request.runId, original.request.runId);
  assert.equal(next.request.status, 'pending');
  assert.deepEqual(next.task.executionBinding, original.task.executionBinding);
  assert.deepEqual(new JsonFileBoardStore(f.file).getTask(original.request.taskId), next.task);
});

test('MCP 解除终态/错板/归档守卫：全部拒绝且零写入', options, async (t) => {
  for (const state of ['running', 'waiting', 'completed', 'failed', 'rejected'] as const) await t.test(state, async (t) => {
    const f = await fixture(t);
    const { request } = await requested(f, state !== 'rejected');
    if (state === 'rejected') await call(f.client, executionTool, { action: 'delivery', ...receipt(request), status: 'rejected', error: '明确拒绝' });
    else {
      const input = { action: 'report', ...receipt(request), threadId: f.result.threadId, hostId };
      await call(f.client, executionTool, { ...input, reportId: 'running-a', state: 'running' });
      if (state !== 'running') await call(f.client, executionTool, { ...input, reportId: `report-${state}`, state });
    }
    await rejects(f, recoverTool, { ...receipt(request), reason: '终态不能解除' }, 'EXECUTION_CONFLICT');
  });
  const f = await fixture(t);
  const { request } = await requested(f);
  for (const [patch, error] of [
    [{ boardId: 'wrong-board' }, 'BOARD_MISMATCH'], [{ runId: 'run-other' }, 'EXECUTION_STALE'], [{ requestId: 'missing' }, 'EXECUTION_STALE'],
  ] as const) await rejects(f, recoverTool, { ...receipt(request), reason: '守卫', ...patch }, error);
  for (const status of ['doing', 'review', 'done'] as const) await f.engine.moveTask(request.taskId, status);
  await f.engine.archiveTask(request.taskId);
  await rejects(f, recoverTool, { ...receipt(request), reason: '归档后解除' }, 'TASK_ARCHIVED');
});
