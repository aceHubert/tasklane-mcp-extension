import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BoardEngine, BoardError, GitService, JsonFileBoardStore, type RequestExecutionInput } from '../src/index.js';

function fixture() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tasklane-run-assignee-')), 'board.json');
  const store = new JsonFileBoardStore(file);
  store.mutateBoard('default', (board) => ({ ...board, repo: '/repos/a', repoKey: '/repos/a/.git' }));
  const engine = new BoardEngine(store, new GitService(false));
  return { file, store, engine };
}

function input(id: string, requestId = 'run-request'): RequestExecutionInput {
  return { id, boardId: 'default', requestId, action: 'start', workspaceMode: 'project' };
}

const errorCode = (code: BoardError['code']) => (error: unknown) => error instanceof BoardError && error.code === code;

test('Run 请求和 Agent 标识同事务持久化，新建和人工流转不提前指派', async () => {
  const { file, store, engine } = fixture();
  const task = await engine.createTask({ title: 'Run 标识', status: 'ready' });
  assert.equal(task.assignee, 'human');
  await engine.moveTask(task.id, 'doing');
  assert.equal(engine.getTask(task.id).assignee, 'human');
  const result = await engine.requestExecution(input(task.id));
  assert.equal(result.task.assignee, 'agent');
  assert.equal(result.task.execution.state, 'starting');
  assert.equal(result.task.execution.startedAt, undefined);
  assert.equal(result.task.status, 'doing');
  const reopened = new JsonFileBoardStore(file);
  assert.equal(reopened.getTask(task.id)?.assignee, 'agent');
  assert.equal(reopened.getTask(task.id)?.execution.runId, result.request.runId);
  assert.equal(store.getSession(task.id)?.events.filter((event) => event.kind === 'execution_requested').length, 1);
  assert.equal(store.getSession(task.id)?.events.filter((event) => event.kind === 'assigned' || event.kind === 'started').length, 0);
});

test('无效、错误看板、无仓库、Done 和归档请求不能改变人工标识', async () => {
  const { engine, store, file } = fixture();
  const task = await engine.createTask({ title: '无副作用', status: 'ready' });
  const request = input(task.id);
  for (const [patch, code] of [
    [{ model: ' ' }, 'VALIDATION'],
    [{ boardId: 'other' }, 'BOARD_MISMATCH'],
    [{ action: 'continue' }, 'EXECUTION_CONFLICT'],
  ] as const) {
    const before = readFileSync(file, 'utf8');
    await assert.rejects(engine.requestExecution({ ...request, ...patch }), errorCode(code));
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(engine.getTask(task.id).assignee, 'human');
  }
  store.mutateBoard('default', (board) => ({ ...board, repo: null }));
  await assert.rejects(engine.requestExecution(request), errorCode('VALIDATION'));
  assert.equal(engine.getTask(task.id).assignee, 'human');
  store.mutateBoard('default', (board) => ({ ...board, repo: '/repos/a' }));
  const done = await engine.createTask({ title: '已完成', status: 'done' });
  await assert.rejects(engine.requestExecution(input(done.id)), errorCode('VALIDATION'));
  await engine.archiveTask(done.id);
  await assert.rejects(engine.requestExecution(input(done.id)), errorCode('TASK_ARCHIVED'));
  assert.equal(engine.getTask(done.id).assignee, 'human');
});

test('重放/合并不覆盖后续 MCP 人工指派；新请求才重新标记 Agent', async () => {
  const { engine, store } = fixture();
  const task = await engine.createTask({ title: '幂等标识', status: 'ready' });
  const request = input(task.id);
  const first = await engine.requestExecution(request);
  await engine.assignTask(task.id, 'human');
  const before = engine.getTaskWithTimeline(task.id);
  assert.equal((await engine.requestExecution(request)).created, false);
  assert.equal((await engine.requestExecution({ ...request, requestId: 'same-intent' })).created, false);
  await assert.rejects(engine.requestExecution({ ...request, requestId: 'busy', workspaceMode: 'worktree' }), errorCode('EXECUTION_BUSY'));
  assert.deepEqual(engine.getTaskWithTimeline(task.id), before);
  await engine.markExecutionDelivery({ id: task.id, boardId: task.boardId, requestId: first.request.requestId,
    runId: first.request.runId, status: 'rejected', error: '明确拒绝' });
  const next = await engine.requestExecution({ ...request, requestId: 'explicit-new-request' });
  assert.equal(next.task.assignee, 'agent');
  assert.equal(next.task.execution.state, 'starting');
  assert.equal(store.getSession(task.id)?.events.filter((event) => event.kind === 'execution_requested').length, 2);
});

test('投递拒绝和结果未知保留 Run 请求的 Agent 标识，不伪造 Running', async () => {
  for (const status of ['rejected', 'uncertain'] as const) {
    const { engine } = fixture();
    const task = await engine.createTask({ title: `投递-${status}`, status: 'ready' });
    const result = await engine.requestExecution(input(task.id));
    const delivery = await engine.markExecutionDelivery({ id: task.id, boardId: task.boardId,
      requestId: result.request.requestId, runId: result.request.runId, status, error: '投递异常' });
    assert.equal(delivery.task.assignee, 'agent');
    assert.equal(delivery.task.execution.startedAt, undefined);
    assert.equal(delivery.task.execution.state, status === 'rejected' ? 'assigned' : 'starting');
    assert.equal(delivery.request.status, status);
  }
});

test('两个引擎并发 Run 只保留一个请求，标识和并发编辑一起保留', async () => {
  const { engine, store, file } = fixture();
  const other = new BoardEngine(new JsonFileBoardStore(file), new GitService(false));
  const task = await engine.createTask({ title: '并发', status: 'ready' });
  await other.updateTask({ id: task.id, title: '新标题', priority: 'P0' });
  const requests = await Promise.all([engine.requestExecution(input(task.id)), other.requestExecution(input(task.id, 'another-request'))]);
  assert.equal(requests.filter((result) => result.created).length, 1);
  const latest = store.getTask(task.id)!;
  assert.equal(latest.assignee, 'agent');
  assert.equal(latest.title, '新标题');
  assert.equal(latest.priority, 'P0');
  assert.equal(latest.executionRequests?.length, 1);
  assert.equal(latest.execution.startedAt, undefined);
});
