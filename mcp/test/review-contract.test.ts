import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BoardEngine, BoardError, GitService, JsonFileBoardStore, type RepoValidation } from '@tasklane/core';
import { createServer } from '../src/server.js';
import * as h from '../src/handlers.js';

/** 内存桩 Git：仅供 Review 工作区解析与绑定核验，不启动真实 Git */
class StubGitService extends GitService {
  private readonly identities = new Map<string, RepoValidation>([
    ['/repos/a', { root: '/repos/a', repoKey: '/repos/a/.git' }],
  ]);

  constructor() {
    super(true);
  }

  override async identifyRepo(repoInput: string): Promise<RepoValidation> {
    const identity = this.identities.get(repoInput);
    if (!identity) throw new BoardError('GIT_ERROR', '执行目录不是有效 Git 工作区');
    return { ...identity };
  }

  override async assertWorktreeMatches(): Promise<void> {}
}

function makeFixture() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'ck-review-')), 'board.json');
  const store = new JsonFileBoardStore(file);
  store.mutateBoard('default', (board) => ({ ...board, repo: '/repos/a', repoKey: '/repos/a/.git', baseBranch: 'main' }));
  const engine = new BoardEngine(store, new StubGitService());
  return { engine, store };
}

test('工具注册：review 工具与 purpose 参数进入 MCP 契约', async (t) => {
  const { engine } = makeFixture();
  const server = createServer(engine);
  const client = new Client({ name: 'review-contract-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  assert.ok(!names.includes('task_review_update'), 'review 已并入 task_update action=review');
  assert.ok(names.includes('task_execution'));
  const requestTool = tools.find((tool) => tool.name === 'task_execution')!;
  const schema = requestTool.inputSchema as { properties: Record<string, unknown> };
  assert.ok(schema.properties.purpose, 'task_execution 应声明 purpose 参数（request 分支）');
});

test('handler 契约：task_review_update CAS 与 task_execution_external_bind 守卫', async () => {
  const { engine } = makeFixture();
  const created = await h.taskCreate(engine, { title: '契约任务' });
  const id = created.task.id;

  // 非 review 列任务不能更新 Review
  await assert.rejects(
    h.taskUpdate(engine, { action: 'review', id, boardId: 'default', expectedRevision: 0, status: 'approved', conclusion: 'x' }),
    (err: BoardError) => err.code === 'VALIDATION',
  );

  await h.taskMove(engine, { id, status: 'ready' });
  await h.taskMove(engine, { id, status: 'doing' });
  await h.taskMove(engine, { id, status: 'review' });
  const detail = await h.taskGet(engine, { id });
  assert.equal(detail.task.review?.status, 'pending');
  assert.equal(detail.task.review?.revision, 0);

  // CAS：错误 revision 拒绝
  await assert.rejects(
    h.taskUpdate(engine, { action: 'review', id, boardId: 'default', expectedRevision: 7, status: 'recheck_pending' }),
    (err: BoardError) => err.code === 'REVIEW_STALE',
  );

  // 外部会话：provider 不能冒充 codex-desktop；正常记录幂等
  await assert.rejects(
    h.taskExecution(engine, { action: 'external_bind',
      id, boardId: 'default', provider: 'codex-desktop', sessionId: 'thread-1',
      workspacePath: '/repos/a', workspaceOwner: 'user',
    }),
    (err: BoardError) => err.code === 'VALIDATION',
  );
  const external = await h.taskExecution(engine, { action: 'external_bind',
    id, boardId: 'default', provider: 'claude-code', sessionId: 'conv opaque-1',
    workspacePath: '/repos/a', workspaceOwner: 'user',
  });
  assert.equal(external.task.externalExecutionSession?.provider, 'claude-code');
  assert.equal(external.task.executionBinding, undefined);
});

test('MCP 契约：验收受阻时所有实现请求返回冲突且不改变任务及时间线', async (t) => {
  const { engine } = makeFixture();
  const { task } = await h.taskCreate(engine, { title: '验收受阻任务' });
  await h.taskMove(engine, { id: task.id, status: 'ready' });
  await h.taskMove(engine, { id: task.id, status: 'doing' });
  await h.taskMove(engine, { id: task.id, status: 'review' });
  await h.taskExecution(engine, { action: 'external_bind', id: task.id, boardId: 'default',
    provider: 'claude-code', sessionId: 'implementation', workspacePath: '/repos/a', workspaceOwner: 'user' });
  const first = await engine.requestExecution({ id: task.id, boardId: 'default', requestId: 'review-blocked',
    action: 'start', workspaceMode: 'existing', purpose: 'review' });
  const receipt = { id: task.id, boardId: 'default', requestId: first.request.requestId, runId: first.request.runId };
  await engine.claimExecution({ ...receipt, claimId: 'review-claim', hostId: 'local', receiverThreadId: 'review-receiver' });
  await engine.markExecutionDelivery({ ...receipt, status: 'blocked', claimId: 'review-claim', error: '验收工具不可用' });
  const before = engine.getTaskWithTimeline(task.id);

  const server = createServer(engine);
  const client = new Client({ name: 'review-blocked-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  for (const requestAction of ['start', 'reply', 'continue', 'retry'] as const) {
    const result = await client.callTool({ name: 'task_execution', arguments: {
      action: 'request', id: task.id, boardId: 'default', requestId: `impl-${requestAction}`,
      requestAction, workspaceMode: 'project', purpose: 'implementation', message: '继续修改',
    } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /EXECUTION_CONFLICT/);
    assert.match(JSON.stringify(result.content), /验收受阻/);
    assert.deepEqual(engine.getTaskWithTimeline(task.id), before);
  }
});

test('MCP 契约：原认领者记录已绑定续接消息拒绝后可向原聊天重新发起', async (t) => {
  const { engine } = makeFixture();
  const task = await engine.createTask({ title: '消息审核拒绝恢复', status: 'ready' });
  const first = await engine.requestExecution({ id: task.id, boardId: 'default', requestId: 'first', action: 'start', workspaceMode: 'project', hostId: 'local', receiverThreadId: 'receiver' });
  const receipt = { id: task.id, boardId: 'default', requestId: first.request.requestId, runId: first.request.runId };
  await engine.claimExecution({ ...receipt, claimId: 'first-claim' });
  const binding = { ...receipt, claimId: 'first-claim', threadId: 'target', hostId: 'local', workspacePath: '/repos/a', workspaceOwner: 'user' as const };
  await engine.bindExecution({ ...binding, phase: 'created' });
  await engine.bindExecution({ ...binding, phase: 'bound' });
  await engine.reportExecution({ ...receipt, threadId: 'target', hostId: 'local', reportId: 'running', state: 'running' });
  await engine.reportExecution({ ...receipt, threadId: 'target', hostId: 'local', reportId: 'completed', state: 'completed' });
  const next = await engine.requestExecution({ id: task.id, boardId: 'default', requestId: 'next', action: 'continue', workspaceMode: 'project', hostId: 'local', receiverThreadId: 'receiver' });
  const nextReceipt = { ...receipt, requestId: next.request.requestId, runId: next.request.runId };
  await engine.claimExecution({ ...nextReceipt, claimId: 'next-claim' });
  await engine.bindExecution({ ...binding, ...nextReceipt, claimId: 'next-claim', phase: 'created' });
  await engine.bindExecution({ ...binding, ...nextReceipt, claimId: 'next-claim', phase: 'bound' });

  const server = createServer(engine);
  const client = new Client({ name: 'send-rejection-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const rejected = await client.callTool({ name: 'task_execution', arguments: {
    action: 'delivery', ...nextReceipt, claimId: 'next-claim', status: 'rejected', error: '自动审核明确拒绝 send_message，未投递',
  } });
  assert.notEqual(rejected.isError, true);
  assert.equal(engine.getTask(task.id).execution.state, 'assigned');
  assert.equal(engine.getTask(task.id).executionRequests!.at(-1)!.status, 'rejected');
  assert.equal(engine.getTask(task.id).executionRequests!.at(-1)!.result?.threadId, 'target');
  const retry = await client.callTool({ name: 'task_execution', arguments: {
    action: 'request', id: task.id, boardId: 'default', requestId: 'user-new', requestAction: 'continue', workspaceMode: 'project',
  } });
  assert.notEqual(retry.isError, true);
  assert.equal(engine.getTask(task.id).executionBinding?.threadId, 'target');
  assert.notEqual(engine.getTask(task.id).execution.runId, next.request.runId);
});

test('MCP 契约：首次任务创建后准备失败恢复启动入口，新请求保留结果', async (t) => {
  const { engine } = makeFixture();
  const task = await engine.createTask({ title: '统一分发失败恢复', status: 'ready' });
  const first = await engine.requestExecution({ id: task.id, boardId: 'default', requestId: 'first-start', action: 'start', workspaceMode: 'project', model: 'kept-model' });
  const receipt = { id: task.id, boardId: 'default', requestId: first.request.requestId, runId: first.request.runId };
  await engine.claimExecution({ ...receipt, claimId: 'claim', hostId: 'local', receiverThreadId: 'receiver' });
  await engine.bindExecution({ ...receipt, claimId: 'claim', phase: 'created', threadId: 'created-target', hostId: 'local', workspacePath: '/repos/a', workspaceOwner: 'user' });
  const server = createServer(engine);
  const client = new Client({ name: 'dispatch-failure-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const failure = await client.callTool({ name: 'task_execution', arguments: {
    action: 'delivery', ...receipt, claimId: 'claim', status: 'rejected', error: '项目准备或绑定明确失败，任务未分发',
  } });
  assert.notEqual(failure.isError, true);
  assert.equal(engine.getTask(task.id).execution.state, 'assigned');
  const retry = await client.callTool({ name: 'task_execution', arguments: {
    action: 'request', id: task.id, boardId: 'default', requestId: 'new-start', requestAction: 'start', workspaceMode: 'project',
  } });
  assert.notEqual(retry.isError, true);
  const current = engine.getTask(task.id).executionRequests!.at(-1)!;
  assert.equal(current.result?.threadId, 'created-target');
  assert.equal(current.model, 'kept-model');
  assert.deepEqual(current.recoveryOf, { requestId: first.request.requestId, runId: first.request.runId });
  const preclaimFailure = await client.callTool({ name: 'task_execution', arguments: {
    action: 'delivery', id: task.id, boardId: 'default', requestId: current.requestId, runId: current.runId,
    status: 'rejected', error: '恢复分发在面板发送前失败，尚未认领',
  } });
  assert.notEqual(preclaimFailure.isError, true);
  assert.equal(engine.getTask(task.id).execution.state, 'assigned');
  assert.equal(engine.getTask(task.id).executionRequests!.at(-1)!.result?.threadId, 'created-target');
});
