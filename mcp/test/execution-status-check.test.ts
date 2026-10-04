import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  BoardEngine, GitService, JsonFileBoardStore,
  type ChangeSummary, type ExecutionRecoveryInput, type ExecutionRequest,
  type ExecutionResult, type RepoValidation, type WorkItem,
} from '@tasklane/core';
import { createServer } from '../src/server.js';

const options = { timeout: 10000 };
const requestTool = 'task_execution_recovery_request';
const recoverTool = 'task_execution_recover';
const repo = '/repos/mcp-status';
const hostId = 'mcp-status-host';
const receiverThreadId = 'mcp-status-receiver';
interface Response { task: WorkItem; request: ExecutionRequest; created?: boolean; changed?: boolean }

class StatusGit extends GitService {
  constructor() { super(true); }
  override async identifyRepo(input: string): Promise<RepoValidation> {
    assert.equal(input, repo);
    return { root: repo, repoKey: `${repo}/.git` };
  }
  override async assertWorktreeMatches(workspacePath: string, expectedRepo: string, branch: string): Promise<void> {
    assert.equal(workspacePath, repo);
    assert.equal(expectedRepo, repo);
    assert.equal(branch, 'main');
  }
  override async ensureTaskContext(): Promise<null> { assert.fail('核对协议不创建工作区'); }
  override async resolveRepo(): Promise<null> { assert.fail('核对协议不发现真实仓库'); }
  override async diffSummary(): Promise<ChangeSummary> {
    return { filesChanged: 0, additions: 0, deletions: 0, testStatus: 'unknown', files: [] };
  }
}
async function fixture(t: TestContext) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tl-status-mcp-')), 'board.json');
  const store = new JsonFileBoardStore(file);
  store.mutateBoard('default', (board) => ({ ...board, repo, repoKey: `${repo}/.git`, baseBranch: 'main' }));
  let time = Date.UTC(2026, 9, 4);
  const engine = new BoardEngine(store, new StatusGit(), () => new Date(time));
  const task = await engine.createTask({ title: '状态核对 MCP 契约', status: 'ready' });
  const client = new Client({ name: 'status-check-test', version: '1' });
  const server = createServer(engine);
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result: ExecutionResult = { threadId: 'mcp-status-target', hostId, workspacePath: repo, workspaceOwner: 'user', branch: 'main' };
  return { file, store, engine, task, client, result, iso: () => new Date(time).toISOString(), advance: (ms: number) => { time += ms; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function receipt(request: ExecutionRequest) {
  return { id: request.taskId, boardId: request.boardId, requestId: request.requestId, runId: request.runId };
}
async function call(f: Fixture, name: string, args: object): Promise<Response> {
  const result = await f.client.callTool({ name, arguments: { ...args } }) as CallToolResult;
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const content = result.content[0];
  assert.equal(content?.type, 'text');
  if (content?.type !== 'text') throw new Error('缺少 JSON 响应');
  const response = JSON.parse(content.text) as Response;
  assert.deepEqual(result.structuredContent, response);
  return response;
}
async function rejects(f: Fixture, name: string, args: object, code?: string) {
  const before = readFileSync(f.file, 'utf8');
  const response = await f.client.callTool({ name, arguments: { ...args } }) as CallToolResult;
  assert.equal(response.isError, true, JSON.stringify(response.content));
  if (code) assert.match(JSON.stringify(response.content), new RegExp(`\\[${code}\\]`));
  assert.equal(readFileSync(f.file, 'utf8'), before);
}
async function requested(f: Fixture, running = false) {
  let response = await call(f, 'task_execution_request', {
    id: f.task.id, boardId: 'default', requestId: 'request-status', action: 'start', workspaceMode: 'project', hostId, receiverThreadId,
  });
  if (running) {
    const claim = { ...receipt(response.request), claimId: 'claim-status', hostId, receiverThreadId };
    await call(f, 'task_execution_claim', claim);
    const binding = { ...receipt(response.request), claimId: claim.claimId, ...f.result };
    await call(f, 'task_execution_bind', { ...binding, phase: 'created' });
    await call(f, 'task_execution_bind', { ...binding, phase: 'bound' });
    response = await call(f, 'task_execution_report', { ...receipt(response.request), threadId: f.result.threadId, hostId, reportId: 'running-status', state: 'running' });
  }
  return response;
}
function report(f: Fixture, request: ExecutionRequest, checkId = 'check-status'): ExecutionRecoveryInput {
  const observations: ExecutionRecoveryInput['observations'] = [{ threadId: receiverThreadId, hostId, state: 'idle', observedAt: f.iso() }];
  if (request.result) observations.push({ threadId: request.result.threadId, hostId, state: 'idle', observedAt: f.iso() });
  return { ...receipt(request), checkId, checkerThreadId: receiverThreadId, hostId, outcome: 'resumed', message: '确认真实会话状态并记录核对结果', observations };
}

test('MCP 状态核对 schema：purpose 可选且枚举正确，非法值零写入，省略保持旧恢复语义', options, async (t) => {
  const f = await fixture(t);
  const { tools } = await f.client.listTools();
  const tool = tools.find((entry) => entry.name === requestTool)!;
  assert.ok(tool);
  assert.equal(tool.inputSchema.required?.includes('purpose'), false);
  const properties = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
  assert.deepEqual([...(properties.purpose.enum ?? [])].sort(), ['recovery', 'status']);
  const { request } = await requested(f);
  for (const purpose of ['invalid', '', null, 1]) await rejects(f, requestTool, { ...receipt(request), checkId: 'check-invalid', purpose });
  const legacy = await call(f, requestTool, { ...receipt(request), checkId: 'check-legacy' });
  assert.notEqual(legacy.request.recoveryCheck?.purpose, 'status');
  await rejects(f, requestTool, { ...receipt(request), checkId: 'check-legacy', purpose: 'status' }, 'EXECUTION_CONFLICT');
  await rejects(f, requestTool, { ...receipt(request), checkId: 'check-status', purpose: 'status' }, 'EXECUTION_BUSY');
});

test('MCP 状态核对：running→completed 间审计成功，保留回执和绑定，停止报告被拒绝', options, async (t) => {
  const f = await fixture(t);
  const original = await requested(f, true);
  const checked = await call(f, requestTool, { ...receipt(original.request), checkId: 'check-status', purpose: 'status' });
  assert.equal(checked.request.recoveryCheck?.purpose, 'status');
  assert.equal(checked.request.recoveryCheck?.observedStatus, 'running');
  assert.deepEqual(checked.task.execution, original.task.execution);
  f.advance(1000);
  const completed = await call(f, 'task_execution_report', { ...receipt(original.request), threadId: f.result.threadId, hostId, reportId: 'completed-status', state: 'completed' });
  const input = report(f, completed.request);
  const audit = await call(f, recoverTool, input);
  assert.equal(audit.changed, false);
  assert.equal(audit.request.status, 'completed');
  assert.equal(audit.request.recoveryCheck?.status, 'resumed');
  assert.deepEqual(audit.request.reports, completed.request.reports);
  assert.deepEqual(audit.task.execution, completed.task.execution);
  assert.deepEqual(audit.task.executionBinding, original.task.executionBinding);
  assert.equal(audit.task.status, completed.task.status);
  assert.deepEqual(new JsonFileBoardStore(f.file).getTask(original.task.id), audit.task);
  const beforeReplay = readFileSync(f.file, 'utf8');
  await call(f, recoverTool, input);
  assert.equal(readFileSync(f.file, 'utf8'), beforeReplay);
  await call(f, requestTool, { ...receipt(original.request), checkId: 'check-no-stop', purpose: 'status' });
  await rejects(f, recoverTool, { ...input, checkId: 'check-no-stop', outcome: 'stopped', confirmedStopped: true });
  await rejects(f, requestTool, { ...receipt(original.request), checkId: 'legacy-completed' }, 'EXECUTION_CONFLICT');
});

test('MCP 状态核对：同用途合并，跨用途拒绝，错板/宿主/旧 check/run 守卫仍生效', options, async (t) => {
  const f = await fixture(t);
  const { request } = await requested(f);
  await call(f, requestTool, { ...receipt(request), checkId: 'check-status', purpose: 'status' });
  f.advance(59000);
  const merged = await call(f, requestTool, { ...receipt(request), checkId: 'check-merged', purpose: 'status' });
  assert.equal(merged.created, false);
  assert.equal(merged.request.recoveryCheck?.checkId, 'check-status');
  await rejects(f, requestTool, { ...receipt(request), checkId: 'check-status', purpose: 'recovery' }, 'EXECUTION_CONFLICT');
  await rejects(f, requestTool, { ...receipt(request), checkId: 'check-recovery', purpose: 'recovery' }, 'EXECUTION_BUSY');
  await rejects(f, recoverTool, { ...report(f, request), boardId: 'another-board' }, 'BOARD_MISMATCH');
  await rejects(f, recoverTool, { ...report(f, request), hostId: 'another-host' }, 'EXECUTION_CONFLICT');
  await rejects(f, recoverTool, { ...report(f, request), runId: 'old-run' }, 'EXECUTION_STALE');
  f.advance(2000);
  const replaced = await call(f, requestTool, { ...receipt(request), checkId: 'check-replaced', purpose: 'status' });
  assert.equal(replaced.created, true);
  await rejects(f, recoverTool, report(f, request), 'EXECUTION_STALE');
  const audit = await call(f, recoverTool, { ...report(f, request, 'check-replaced'), outcome: 'busy' });
  assert.equal(audit.request.status, 'pending');
  assert.equal(audit.request.recoveryCheck?.status, 'busy');
  assert.equal(audit.changed, false);
});
