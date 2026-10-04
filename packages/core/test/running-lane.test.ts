import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BoardEngine, BoardError, GitService, JsonFileBoardStore,
  type ExecutionRequest, type RepoValidation, type ReportExecutionInput, type TaskStatus,
} from '../src/index.js';

/** 测试只写临时看板，仓库核验使用桩，不操作真实 Git 工作区。 */
class StubGitService extends GitService {
  override async identifyRepo(): Promise<RepoValidation> {
    return { root: '/repos/a', repoKey: '/repos/a/.git' };
  }

  override async assertWorktreeMatches(): Promise<void> {}
}

async function fixture(status: TaskStatus = 'ready') {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tasklane-running-lane-')), 'board.json');
  const store = new JsonFileBoardStore(file);
  store.mutateBoard('default', (board) => ({ ...board, repo: '/repos/a', repoKey: '/repos/a/.git' }));
  let tick = 0;
  const engine = new BoardEngine(store, new StubGitService(true), () => new Date(Date.UTC(2026, 9, 4) + tick++ * 1000));
  const task = await engine.createTask({ title: '真实启动后同步执行中列', status });
  const start = {
    id: task.id, boardId: task.boardId, requestId: 'start-a', action: 'start' as const,
    workspaceMode: 'worktree' as const, hostId: 'local', receiverThreadId: 'receiver-a',
  };
  const { request } = await engine.requestExecution(start);
  const snapshot = () => ({ task: engine.getTask(task.id), session: store.getSession(task.id) });
  return { engine, store, file, start, request, snapshot };
}

function receipt(request: ExecutionRequest) {
  return { id: request.taskId, boardId: request.boardId, requestId: request.requestId, runId: request.runId };
}

function binding(request: ExecutionRequest, claimId = 'claim-a') {
  return {
    ...receipt(request), claimId, threadId: 'thread-a', hostId: 'local',
    workspacePath: '/worktrees/a', workspaceOwner: 'codex' as const, branch: 'codex/task-a',
  };
}

function report(request: ExecutionRequest, overrides: Partial<ReportExecutionInput> = {}): ReportExecutionInput {
  return {
    ...receipt(request), threadId: 'thread-a', hostId: 'local', reportId: 'running-a', state: 'running', ...overrides,
  };
}

async function claimAndBind(engine: BoardEngine, request: ExecutionRequest, claimId = 'claim-a') {
  await engine.claimExecution({ ...receipt(request), claimId });
  await engine.bindExecution({ ...binding(request, claimId), phase: 'created' });
  await engine.bindExecution({ ...binding(request, claimId), phase: 'bound' });
}

const rejectsCode = (code: BoardError['code']) => (error: unknown) => error instanceof BoardError && error.code === code;

test('有效首次 running 同步 Ready→Doing、看板计数与持久化，并记录同时间的开始及流转事件', async () => {
  const f = await fixture();
  await claimAndBind(f.engine, f.request);
  const result = await f.engine.reportExecution(report(f.request));
  assert.equal(result.task.status, 'doing');
  assert.equal(result.task.execution.state, 'running');
  assert.equal(result.task.execution.startedAt, result.request.startedAt);
  assert.equal(f.engine.listTasks({ status: 'ready', boardId: 'default' }).length, 0);
  assert.equal(f.engine.listTasks({ status: 'doing', boardId: 'default' })[0].id, f.start.id);
  assert.equal(f.engine.boardList()[0].counts.ready, 0);
  assert.equal(f.engine.boardList()[0].counts.doing, 1);
  const events = f.store.getSession(f.start.id)!.events;
  const started = events.filter((event) => event.kind === 'started');
  const moved = events.filter((event) => event.kind === 'moved');
  assert.equal(started.length, 1);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].detail, 'ready → doing');
  assert.equal(moved[0].at, started[0].at);
  assert.equal(moved[0].at, result.request.startedAt);
  const reopened = new JsonFileBoardStore(f.file);
  assert.equal(reopened.getTask(f.start.id)!.status, 'doing');
  assert.deepEqual(reopened.getSession(f.start.id), f.store.getSession(f.start.id));
});

test('请求、投递、认领、创建和绑定均不提前移动 Ready 任务', async () => {
  const f = await fixture();
  const assertReady = () => {
    assert.equal(f.engine.getTask(f.start.id).status, 'ready');
    assert.equal(f.engine.getTask(f.start.id).execution.startedAt, undefined);
    assert.equal(f.store.getSession(f.start.id)!.events.filter((event) => event.kind === 'moved').length, 0);
  };
  assertReady();
  await f.engine.markExecutionDelivery({ ...receipt(f.request), status: 'delivered' });
  assertReady();
  await f.engine.claimExecution({ ...receipt(f.request), claimId: 'claim-a' });
  assertReady();
  await f.engine.bindExecution({ ...binding(f.request), phase: 'created' });
  assertReady();
  await f.engine.bindExecution({ ...binding(f.request), phase: 'bound' });
  assertReady();
});

test('waiting、blocked、failed 回执不移动 Ready；无 startedAt 的 completed 回执拒绝且不移动', async (t) => {
  for (const state of ['waiting', 'blocked', 'failed'] as const) {
    await t.test(state, async () => {
      const f = await fixture();
      await claimAndBind(f.engine, f.request);
      const result = await f.engine.reportExecution(report(f.request, { state, activity: '等待核验依赖' }));
      assert.equal(result.task.status, 'ready');
      assert.equal(result.task.execution.startedAt, undefined);
      assert.equal(f.store.getSession(f.start.id)!.events.filter((event) => event.kind === 'moved').length, 0);
    });
  }
  const f = await fixture();
  await claimAndBind(f.engine, f.request);
  const before = f.snapshot();
  await assert.rejects(f.engine.reportExecution(report(f.request, { state: 'completed' })), rejectsCode('EXECUTION_CONFLICT'));
  assert.deepEqual(f.snapshot(), before);
});

test('有效 running 保留 Backlog、Doing、Review、Done 原有列', async (t) => {
  for (const status of ['backlog', 'doing', 'review', 'done'] as const) {
    await t.test(status, async () => {
      // Done 不能发起新请求；已有执行在用户手动完成任务后回执仍不回退任务列。
      const f = await fixture(status === 'done' ? 'review' : status);
      await claimAndBind(f.engine, f.request);
      if (status === 'done') await f.engine.moveTask(f.start.id, 'done', 'default');
      const movedBefore = f.store.getSession(f.start.id)!.events.filter((event) => event.kind === 'moved').length;
      const result = await f.engine.reportExecution(report(f.request));
      assert.equal(result.task.execution.state, 'running');
      assert.equal(result.task.status, status);
      assert.equal(f.store.getSession(f.start.id)!.events.filter((event) => event.kind === 'moved').length, movedBefore);
    });
  }
});

test('重复 running 回执幂等，后续同 run 回执不覆盖手动移回 Ready 的任务', async () => {
  const f = await fixture();
  await claimAndBind(f.engine, f.request);
  const first = await f.engine.reportExecution(report(f.request));
  const beforeReplay = f.snapshot();
  await f.engine.reportExecution(report(f.request));
  assert.deepEqual(f.snapshot(), beforeReplay);
  await f.engine.moveTask(f.start.id, 'ready', 'default');
  const beforeSecond = f.snapshot();
  await f.engine.reportExecution(report(f.request));
  assert.deepEqual(f.snapshot(), beforeSecond);
  const next = await f.engine.reportExecution(report(f.request, { reportId: 'running-b', activity: '继续执行当前步骤' }));
  assert.equal(next.task.status, 'ready');
  assert.equal(next.request.startedAt, first.request.startedAt);
  assert.equal(f.store.getSession(f.start.id)!.events.filter((event) => event.kind === 'moved').length, 2);
});

test('已启动后 blocked 和 completed 不改变用户手动选择的 Ready 列', async () => {
  const f = await fixture();
  await claimAndBind(f.engine, f.request);
  await f.engine.reportExecution(report(f.request));
  await f.engine.moveTask(f.start.id, 'ready', 'default');
  const movedBefore = f.store.getSession(f.start.id)!.events.filter((event) => event.kind === 'moved').length;
  for (const state of ['blocked', 'completed'] as const) {
    const result = await f.engine.reportExecution(report(f.request, { reportId: state, state, activity: '保留任务阶段' }));
    assert.equal(result.task.status, 'ready');
  }
  assert.equal(f.store.getSession(f.start.id)!.events.filter((event) => event.kind === 'moved').length, movedBefore);
});

test('首次 running 前的错误身份、看板和运行代次回执均拒绝且不移动任务', async () => {
  const f = await fixture();
  await claimAndBind(f.engine, f.request);
  const before = f.snapshot();
  const cases: { change: Partial<ReportExecutionInput>; code: BoardError['code'] }[] = [
    { change: { threadId: 'thread-other' }, code: 'EXECUTION_CONFLICT' },
    { change: { hostId: 'other-host' }, code: 'EXECUTION_CONFLICT' },
    { change: { boardId: 'other-board' }, code: 'BOARD_MISMATCH' },
    { change: { runId: 'run-old' }, code: 'EXECUTION_STALE' },
    { change: { requestId: 'request-old' }, code: 'EXECUTION_STALE' },
  ];
  for (const { change, code } of cases) {
    await assert.rejects(f.engine.reportExecution(report(f.request, change)), rejectsCode(code));
    assert.deepEqual(f.snapshot(), before);
  }
});

test('blocked 继续复用原工作区，新 run 首次 running 可以移 Ready→Doing，旧 run 不能移动', async () => {
  const f = await fixture();
  await claimAndBind(f.engine, f.request);
  await f.engine.reportExecution(report(f.request));
  await f.engine.reportExecution(report(f.request, { reportId: 'blocked-a', state: 'blocked', activity: '依赖缺失' }));
  await f.engine.moveTask(f.start.id, 'ready', 'default');
  const resumed = await f.engine.requestExecution({ ...f.start, requestId: 'continue-a', action: 'continue' });
  assert.notEqual(resumed.request.runId, f.request.runId);
  assert.equal(resumed.task.status, 'ready');
  await claimAndBind(f.engine, resumed.request, 'claim-next');
  assert.equal(f.engine.getTask(f.start.id).status, 'ready');
  const before = f.snapshot();
  await assert.rejects(f.engine.reportExecution(report(f.request, { reportId: 'late-old-running' })), rejectsCode('EXECUTION_STALE'));
  assert.deepEqual(f.snapshot(), before);
  const running = await f.engine.reportExecution(report(resumed.request, { reportId: 'resumed-running' }));
  assert.equal(running.task.status, 'doing');
  assert.equal(running.task.execution.state, 'running');
  assert.notEqual(running.request.startedAt, f.engine.getTask(f.start.id).executionRequests![0].startedAt);
  const moves = f.store.getSession(f.start.id)!.events.filter((event) => event.kind === 'moved');
  assert.deepEqual(moves.map((event) => event.detail), ['ready → doing', 'doing → ready', 'ready → doing']);
});
