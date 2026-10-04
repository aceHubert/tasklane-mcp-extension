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
  type ChangeSummary, type ExecutionRecoveryInput, type ExecutionRequest, type ExecutionResult,
  type RepoValidation, type RequestExecutionInput, type WorkItem,
} from '@tasklane/core';
import { createServer } from '../src/server.js';

const options = { timeout: 15000 };
const requestTool = 'task_execution_recovery_request';
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
  const task = await engine.createTask({ title: '恢复 MCP 契约', status: 'ready' });
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
function report(f: Fixture, request: ExecutionRequest, patch: Partial<ExecutionRecoveryInput> = {}): ExecutionRecoveryInput {
  const latest = f.engine.getTask(request.taskId).executionRequests!.find((entry) => entry.requestId === request.requestId)!;
  const observations: ExecutionRecoveryInput['observations'] = [{ threadId: receiverThreadId, hostId, state: 'idle', observedAt: f.iso() }];
  const target = latest.result ?? f.engine.getTask(request.taskId).executionBinding;
  if (target) observations.push({ threadId: target.threadId, hostId: target.hostId, state: 'idle', observedAt: f.iso() });
  return {
    ...receipt(request), checkId: latest.recoveryCheck?.checkId ?? 'check-a', checkerThreadId: receiverThreadId, hostId,
    outcome: 'stopped', confirmedStopped: true, message: '原生核对旧操作已停止', observations, ...patch,
  };
}
async function requested(f: Fixture, bound = false) {
  let response = await call(f.client, 'task_execution_request', f.input);
  if (bound) {
    const claim = { ...receipt(response.request), claimId: 'claim-a' };
    await call(f.client, 'task_execution_claim', claim);
    response = await call(f.client, 'task_execution_bind', { ...claim, ...f.result, phase: 'created' });
    response = await call(f.client, 'task_execution_bind', { ...claim, ...f.result, phase: 'bound' });
  }
  return response;
}
async function check(f: Fixture, request: ExecutionRequest, checkId = 'check-a') {
  return call(f.client, requestTool, { ...receipt(request), checkId });
}

test('MCP 恢复 schema：双工具注册、关联必填、报告非空与观测枚举，旧 confirmedStopped alone 无效', options, async (t) => {
  const f = await fixture(t);
  const { tools } = await f.client.listTools();
  const checkTool = tools.find((tool) => tool.name === requestTool);
  const recoveryTool = tools.find((tool) => tool.name === recoverTool);
  assert.ok(checkTool);
  assert.ok(recoveryTool);
  for (const tool of [checkTool, recoveryTool]) {
    for (const key of ['id', 'boardId', 'requestId', 'runId', 'checkId']) assert.ok(tool.inputSchema.required?.includes(key), `${tool.name}.${key}`);
  }
  for (const key of ['checkerThreadId', 'hostId', 'outcome', 'message', 'observations']) assert.ok(recoveryTool.inputSchema.required?.includes(key), key);
  assert.equal(recoveryTool.inputSchema.required?.includes('confirmedStopped'), false);
  const properties = recoveryTool.inputSchema.properties as Record<string, { enum?: string[]; type?: string }>;
  assert.deepEqual([...(properties.outcome.enum ?? [])].sort(), ['busy', 'resumed', 'stopped', 'unknown']);
  const { request } = await requested(f);
  const checking = { ...receipt(request), checkId: 'check-a' };
  for (const key of ['id', 'boardId', 'requestId', 'runId', 'checkId']) {
    const missing: Record<string, unknown> = { ...checking };
    delete missing[key];
    await rejects(f, requestTool, missing);
  }
  await rejects(f, requestTool, { ...checking, checkId: '' });
  await check(f, request);
  const input = report(f, request);
  for (const key of ['checkerThreadId', 'hostId', 'outcome', 'message', 'observations']) {
    const missing: Record<string, unknown> = { ...input };
    delete missing[key];
    await rejects(f, recoverTool, missing);
  }
  await rejects(f, recoverTool, { ...receipt(request), expectedStatus: 'pending', expectedUpdatedAt: request.updatedAt, confirmedStopped: true });
  for (const patch of [
    { confirmedStopped: false }, { confirmedStopped: undefined }, { message: '' }, { message: ' ' }, { message: 'x'.repeat(201) },
    { outcome: 'cancelled' }, { observations: [{ ...input.observations[0], state: 'stopped' }] },
    { observations: [{ ...input.observations[0], observedAt: 'invalid' }] },
  ]) await rejects(f, recoverTool, { ...input, ...patch });
});

test('MCP 恢复检查与非停止报告：只写审计，pending 合并/60s覆盖，旧 check 报告 stale', options, async (t) => {
  const f = await fixture(t);
  const original = await requested(f);
  const checked = await check(f, original.request);
  assert.equal(checked.created, true);
  assert.deepEqual(checked.request.recoveryCheck, {
    checkId: 'check-a', status: 'pending', requestedAt: f.iso(), observedStatus: 'pending', observedUpdatedAt: original.request.updatedAt,
  });
  assert.equal(checked.request.updatedAt, original.request.updatedAt);
  assert.equal(checked.request.status, 'pending');
  assert.deepEqual(checked.task.execution, original.task.execution);
  const oldReport = report(f, original.request);
  f.advance(59000);
  const before = readFileSync(f.file, 'utf8');
  assert.equal((await check(f, original.request, 'merged-check')).created, false);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  f.advance(2000);
  assert.equal((await check(f, original.request, 'new-check')).created, true);
  await rejects(f, recoverTool, oldReport, 'EXECUTION_STALE');
  for (const outcome of ['busy', 'unknown', 'resumed'] as const) {
    const input = report(f, original.request, { outcome, confirmedStopped: undefined, message: `核对 ${outcome}` });
    const result = await call(f.client, recoverTool, input);
    assert.equal(result.changed, false);
    assert.equal(result.request.status, 'pending');
    assert.equal(result.request.updatedAt, original.request.updatedAt);
    assert.equal(result.request.recovery, undefined);
    assert.equal(result.request.recoveryCheck?.status, outcome);
    assert.equal(result.request.recoveryCheck?.message, input.message);
    assert.deepEqual(result.request.recoveryCheck?.observations, input.observations);
    assert.deepEqual(result.task.execution, original.task.execution);
    assert.equal((await check(f, original.request, `check-after-${outcome}`)).created, true);
  }
});

test('MCP 恢复 CAS/观测/TTL：推进认领和同态新回执拒绝旧检查，结果不完整或活跃不能取消', options, async (t) => {
  for (const race of ['status', 'updatedAt'] as const) await t.test(race, async (t) => {
    const f = await fixture(t);
    const { request } = await requested(f);
    if (race === 'updatedAt') await call(f.client, 'task_execution_delivery', { ...receipt(request), status: 'uncertain', error: '第一次未知' });
    await check(f, request);
    f.advance(1000);
    if (race === 'status') await call(f.client, 'task_execution_claim', { ...receipt(request), claimId: 'claim-a' });
    else await call(f.client, 'task_execution_delivery', { ...receipt(request), status: 'uncertain', error: '新的未知摘要' });
    await rejects(f, recoverTool, report(f, request), 'EXECUTION_CONFLICT');
  });
  const f = await fixture(t);
  const { request } = await requested(f, true);
  await check(f, request);
  const input = report(f, request);
  await rejects(f, recoverTool, { ...input, observations: input.observations.slice(0, 1) });
  for (const state of ['active', 'waiting', 'unknown']) {
    await rejects(f, recoverTool, { ...input, observations: input.observations.map((entry) => entry.threadId === f.result.threadId ? { ...entry, state, priorOperationEnded: true } : entry) });
  }
  f.advance(121000);
  await rejects(f, recoverTool, input);
  f.advance(180000);
  await rejects(f, recoverTool, report(f, request));
});

test('MCP 恢复成功 structuredContent：取消不是停止，exact 幂等、旧回执 stale、续接新 run 保留绑定', options, async (t) => {
  const f = await fixture(t);
  const original = await requested(f, true);
  const checking = await check(f, original.request);
  assert.equal(checking.request.status, 'bound');
  const input = report(f, original.request);
  input.observations = input.observations.map((entry) => entry.threadId === input.checkerThreadId ? { ...entry, state: 'active', priorOperationEnded: true } : entry);
  const recovered = await call(f.client, recoverTool, input);
  assert.equal(recovered.changed, true);
  assert.equal(recovered.request.status, 'cancelled');
  assert.equal(recovered.request.recoveryCheck?.status, 'recovered');
  assert.deepEqual(recovered.request.recovery, { at: recovered.request.updatedAt, reason: input.message, confirmedStopped: true, checkId: input.checkId });
  assert.equal(recovered.request.claimId, original.request.claimId);
  assert.deepEqual(recovered.request.result, original.request.result);
  assert.deepEqual(recovered.request.receiver, original.request.receiver);
  assert.deepEqual(recovered.task.executionBinding, original.task.executionBinding);
  assert.equal(recovered.task.execution.state, 'assigned');
  assert.equal(recovered.task.execution.runId, original.request.runId);
  assert.equal(recovered.task.execution.startedAt, undefined);
  const before = readFileSync(f.file, 'utf8');
  const replay = await call(f.client, recoverTool, input);
  assert.equal(replay.changed, false);
  assert.deepEqual(replay.task, recovered.task);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  await rejects(f, recoverTool, { ...input, message: '替换恢复证据' });
  assert.equal(f.store.getSession(original.request.taskId)!.events.some((event) => event.kind === 'stopped'), false);
  const receiptInput = receipt(original.request);
  const late = [
    ['task_execution_claim', { ...receiptInput, claimId: 'claim-a' }],
    ['task_execution_delivery', { ...receiptInput, status: 'delivered' }],
    ['task_execution_bind', { ...receiptInput, claimId: 'claim-a', ...f.result, phase: 'created' }],
    ['task_execution_bind', { ...receiptInput, claimId: 'claim-a', ...f.result, phase: 'bound' }],
    ['task_execution_report', { ...receiptInput, threadId: f.result.threadId, hostId, reportId: 'late-running', state: 'running' }],
  ] as const;
  for (const [name, args] of late) await rejects(f, name, args, 'EXECUTION_STALE');
  const next = await call(f.client, 'task_execution_request', { ...f.input, requestId: 'continue-next', action: 'continue' });
  assert.notEqual(next.request.runId, original.request.runId);
  assert.equal(next.request.status, 'pending');
  assert.deepEqual(next.task.executionBinding, original.task.executionBinding);
  await rejects(f, recoverTool, input, 'EXECUTION_STALE');
  assert.deepEqual(new JsonFileBoardStore(f.file).getTask(original.request.taskId), next.task);
});

test('MCP 恢复终态/错板/归档：检查和报告都拒绝且零写入', options, async (t) => {
  for (const state of ['running', 'waiting', 'completed', 'failed', 'rejected'] as const) await t.test(state, async (t) => {
    const f = await fixture(t);
    const { request } = await requested(f, state !== 'rejected');
    await check(f, request);
    if (state === 'rejected') await call(f.client, 'task_execution_delivery', { ...receipt(request), status: 'rejected', error: '明确拒绝' });
    else {
      const input = { ...receipt(request), threadId: f.result.threadId, hostId };
      await call(f.client, 'task_execution_report', { ...input, reportId: 'running-a', state: 'running' });
      if (state !== 'running') await call(f.client, 'task_execution_report', { ...input, reportId: `report-${state}`, state });
    }
    await rejects(f, requestTool, { ...receipt(request), checkId: 'terminal-check' });
    await rejects(f, recoverTool, report(f, request), 'EXECUTION_CONFLICT');
  });
  const f = await fixture(t);
  const { request } = await requested(f);
  await check(f, request);
  for (const [patch, error] of [
    [{ boardId: 'wrong-board' }, 'BOARD_MISMATCH'], [{ runId: 'run-other' }, 'EXECUTION_STALE'],
  ] as const) {
    await rejects(f, requestTool, { ...receipt(request), checkId: 'check-other', ...patch }, error);
    await rejects(f, recoverTool, { ...report(f, request), ...patch }, error);
  }
  for (const status of ['doing', 'review', 'done'] as const) await f.engine.moveTask(request.taskId, status);
  await f.engine.archiveTask(request.taskId);
  await rejects(f, requestTool, { ...receipt(request), checkId: 'check-after-archive' }, 'TASK_ARCHIVED');
  await rejects(f, recoverTool, report(f, request), 'TASK_ARCHIVED');
});
