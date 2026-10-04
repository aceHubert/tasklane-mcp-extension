import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BoardEngine,
  BoardError,
  GitService,
  JsonFileBoardStore,
  type BindExecutionInput,
  type ChangeSummary,
  type ExecutionRequest,
  type RepoValidation,
  type ReportExecutionInput,
  type RequestExecutionInput,
  type WorkItem,
} from '../src/index.js';

/** 仓库和 worktree 都是内存桩；测试不能启动 Git 或创建真实工作区。 */
class StubGitService extends GitService {
  readonly identifyCalls: string[] = [];
  readonly worktreeCalls: { workspacePath: string; repo: string; branch: string }[] = [];
  readonly diffCalls: { workspacePath: string; baseBranch: string }[] = [];
  ensureCalls = 0;
  beforeIdentify?: () => Promise<void>;

  private readonly identities = new Map<string, RepoValidation>([
    ['/repos/a', { root: '/repos/a', repoKey: '/repos/a/.git' }],
    ['/repos/a/subdir', { root: '/repos/a', repoKey: '/repos/a/.git' }],
    ['/worktrees/a', { root: '/repos/a', repoKey: '/repos/a/.git' }],
    ['/worktrees/a/subdir', { root: '/repos/a', repoKey: '/repos/a/.git' }],
    ['/worktrees/alternate-a', { root: '/repos/a', repoKey: '/repos/a/.git' }],
    ['/worktrees/legacy-a', { root: '/repos/a', repoKey: '/repos/a/.git' }],
    ['/repos/b', { root: '/repos/b', repoKey: '/repos/b/.git' }],
    ['/worktrees/b', { root: '/repos/b', repoKey: '/repos/b/.git' }],
  ]);
  private readonly branches = new Map([
    ['/worktrees/a', 'codex/task-a'],
    ['/worktrees/alternate-a', 'codex/task-a'],
    ['/worktrees/legacy-a', 'tasklane/legacy-a'],
    ['/worktrees/b', 'codex/task-b'],
  ]);

  constructor() {
    super(true);
  }

  override async identifyRepo(repoInput: string): Promise<RepoValidation> {
    this.identifyCalls.push(repoInput);
    await this.beforeIdentify?.();
    const identity = this.identities.get(repoInput);
    if (!identity) throw new BoardError('GIT_ERROR', '执行目录不是有效 Git 工作区');
    return { ...identity };
  }

  override async assertWorktreeMatches(workspacePath: string, repo: string, branch: string): Promise<void> {
    this.worktreeCalls.push({ workspacePath, repo, branch });
    if (this.identities.get(workspacePath)?.repoKey !== this.identities.get(repo)?.repoKey ||
      this.branches.get(workspacePath) !== branch) {
      throw new BoardError('GIT_ERROR', '工作区必须是所属仓库的根目录且分支匹配');
    }
  }

  override async ensureTaskContext(): Promise<null> {
    this.ensureCalls++;
    assert.fail('原生执行和普通指派不能创建 Git 上下文');
  }

  override async resolveRepo(): Promise<null> {
    assert.fail('测试不能运行真实 Git 仓库发现');
  }

  override async diffSummary(workspacePath: string, baseBranch: string): Promise<ChangeSummary> {
    this.diffCalls.push({ workspacePath, baseBranch });
    return { filesChanged: 0, additions: 0, deletions: 0, testStatus: 'unknown', files: [] };
  }
}

function makeFixture() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tasklane-native-')), 'board.json');
  const store = new JsonFileBoardStore(file);
  store.mutateBoard('default', (board) => ({
    ...board, repo: '/repos/a', repoKey: '/repos/a/.git', baseBranch: 'main',
  }));
  const git = new StubGitService();
  let tick = 0;
  const engine = new BoardEngine(store, git, () => new Date(Date.UTC(2026, 9, 3) + tick++ * 1000));
  return { engine, store, git, file };
}

type Fixture = ReturnType<typeof makeFixture>;

function requestInput(id: string, overrides: Partial<RequestExecutionInput> = {}): RequestExecutionInput {
  return {
    id, boardId: 'default', requestId: 'request-a', action: 'start', workspaceMode: 'project',
    hostId: 'codex-host-a', receiverThreadId: 'receiver-thread-a', ...overrides,
  };
}

function receipt(request: ExecutionRequest) {
  return { id: request.taskId, boardId: request.boardId, requestId: request.requestId, runId: request.runId };
}

function bindInput(request: ExecutionRequest, overrides: Partial<BindExecutionInput> = {}): BindExecutionInput {
  return {
    ...receipt(request), claimId: 'claim-a', phase: 'created', threadId: 'native-thread-a',
    hostId: request.receiver?.hostId ?? request.hostId!, workspacePath: '/repos/a', workspaceOwner: 'user', ...overrides,
  };
}

function reportInput(request: ExecutionRequest, overrides: Partial<ReportExecutionInput> = {}): ReportExecutionInput {
  return {
    ...receipt(request), threadId: 'native-thread-a', hostId: request.receiver?.hostId ?? request.hostId!,
    reportId: 'report-running-a', state: 'running', ...overrides,
  };
}

async function claimAndBind(engine: BoardEngine, request: ExecutionRequest, overrides: Partial<BindExecutionInput> = {}) {
  const input = bindInput(request, overrides);
  await engine.claimExecution({ ...receipt(request), claimId: input.claimId });
  await engine.bindExecution({ ...input, phase: 'created' });
  return engine.bindExecution({ ...input, phase: 'bound' });
}

async function createRequested(fixture: Fixture, overrides: Partial<RequestExecutionInput> = {}) {
  const task = await fixture.engine.createTask({ title: '原生执行任务', status: 'ready' });
  const input = requestInput(task.id, overrides);
  const result = await fixture.engine.requestExecution(input);
  return { input, ...result };
}

function snapshot(fixture: Fixture, id: string) {
  return { task: fixture.engine.getTask(id), timeline: fixture.store.getSession(id) };
}

function rejectsCode(code: BoardError['code']) {
  return (err: unknown) => err instanceof BoardError && err.code === code;
}

/** 暂停一次只读校验，让另一存储实例在异步间隙写入真实的最新数据。 */
function pauseNextIdentify(git: StubGitService) {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const resumed = new Promise<void>((resolve) => { release = resolve; });
  git.beforeIdentify = async () => {
    git.beforeIdentify = undefined;
    entered();
    await resumed;
  };
  return { started, release };
}

test('request/run 幂等：重放和相同 pending 请求只保留一个服务端 runId', async () => {
  const fixture = makeFixture();
  const { engine, store, file, git } = fixture;
  const { input, task, request, created } = await createRequested(fixture);
  assert.equal(created, true);
  assert.match(request.runId, /^run-/);
  assert.equal(request.taskId, task.id);
  assert.equal(request.boardId, 'default');
  assert.equal(request.repo, '/repos/a');
  assert.equal(request.status, 'pending');
  assert.equal(task.assignee, 'agent');
  assert.equal(task.execution.state, 'starting');
  assert.equal(task.execution.runId, request.runId);
  assert.equal(task.execution.sessionId, undefined);
  assert.equal(task.execution.startedAt, undefined);
  assert.equal(task.executionBinding, undefined);
  const before = snapshot(fixture, task.id);

  const replay = await engine.requestExecution({ ...input, id: task.id.toLowerCase() });
  assert.equal(replay.created, false);
  assert.deepEqual(replay.request, request);
  const reopened = new BoardEngine(new JsonFileBoardStore(file), git);
  const merged = await reopened.requestExecution({ ...input, requestId: 'request-duplicate' });
  assert.equal(merged.created, false);
  assert.equal(merged.request.requestId, request.requestId);
  assert.equal(merged.request.runId, request.runId);
  assert.deepEqual(snapshot(fixture, task.id), before);
  assert.equal(store.getTask(task.id)!.executionRequests!.length, 1);
  assert.equal(store.getSession(task.id)!.events.filter((e) => e.kind === 'execution_requested').length, 1);
  assert.deepEqual(git.identifyCalls, []);
  assert.equal(git.ensureCalls, 0);
});

test('同 requestId 内容不能更改；另一 pending 请求不相同则 EXECUTION_BUSY', async () => {
  const fixture = makeFixture();
  const { input, task } = await createRequested(fixture);
  const before = snapshot(fixture, task.id);
  const changes: Partial<RequestExecutionInput>[] = [
    { action: 'continue' }, { workspaceMode: 'worktree' }, { hostId: 'codex-host-b' },
    { receiverThreadId: 'receiver-thread-b' }, { message: '不同的完整指令' }, { model: 'custom-model' },
  ];
  for (const change of changes) {
    await assert.rejects(fixture.engine.requestExecution({ ...input, ...change }), rejectsCode('EXECUTION_CONFLICT'));
    await assert.rejects(
      fixture.engine.requestExecution({ ...input, ...change, requestId: 'request-other' }),
      rejectsCode('EXECUTION_BUSY'),
    );
  }
  assert.deepEqual(snapshot(fixture, task.id), before);
});

test('新会话模型归一化后持久化，幂等重放必须保持原模型', async () => {
  const fixture = makeFixture();
  const { input, request, task } = await createRequested(fixture, { model: '  provider/custom-model:latest  ' });
  assert.equal(input.model, '  provider/custom-model:latest  ');
  assert.equal(request.model, 'provider/custom-model:latest');
  const reopened = new BoardEngine(new JsonFileBoardStore(fixture.file), fixture.git);
  assert.equal(reopened.getTask(task.id).executionRequests![0].model, request.model);
  const before = snapshot(fixture, task.id);
  const replay = await reopened.requestExecution({ ...input, model: request.model });
  const merged = await reopened.requestExecution({ ...input, requestId: 'same-model' });
  assert.equal(replay.created, false);
  assert.equal(merged.created, false);
  assert.deepEqual(merged.request, replay.request);
  for (const model of [undefined, 'other-model']) {
    await assert.rejects(reopened.requestExecution({ ...input, model }), rejectsCode('EXECUTION_CONFLICT'));
    await assert.rejects(reopened.requestExecution({ ...input, requestId: 'changed-model', model }), rejectsCode('EXECUTION_BUSY'));
  }
  assert.deepEqual(snapshot(fixture, task.id), before);
  const boundary = await createRequested(fixture, { model: ' m'.padEnd(129, 'm') + ' ' });
  assert.equal(boundary.request.model!.length, 128);
});

test('已绑定会话的回复、继续和重试拒绝模型覆盖，并保留创建时的模型', async () => {
  const fixture = makeFixture();
  const { input, request, task } = await createRequested(fixture, { model: 'custom-model' });
  await claimAndBind(fixture.engine, request);
  await fixture.engine.reportExecution(reportInput(request));
  await fixture.engine.reportExecution(reportInput(request, { reportId: 'completed', state: 'completed' }));
  const before = snapshot(fixture, task.id);
  for (const action of ['reply', 'continue', 'retry'] as const) {
    await assert.rejects(fixture.engine.requestExecution({ ...input, requestId: `model-${action}`, action, message: '继续处理' }), rejectsCode('VALIDATION'));
  }
  assert.deepEqual(snapshot(fixture, task.id), before);
  const continued = await fixture.engine.requestExecution({ ...input, requestId: 'continue-default', action: 'continue', model: undefined });
  assert.equal(continued.request.model, undefined);
  assert.equal(continued.task.executionRequests![0].model, 'custom-model');
  assert.equal(continued.task.executionBinding?.threadId, 'native-thread-a');
});

test('待确认请求在 delivered / uncertain / claimed / created / bound 阶段继续合并，不能重建', async () => {
  const fixture = makeFixture();
  const { input, request } = await createRequested(fixture);
  const engine = fixture.engine;
  const steps = [
    () => engine.markExecutionDelivery({ ...receipt(request), status: 'delivered' }),
    () => engine.markExecutionDelivery({ ...receipt(request), status: 'uncertain', error: '消息结果未知' }),
    () => engine.claimExecution({ ...receipt(request), claimId: 'claim-a' }),
    () => engine.bindExecution(bindInput(request)),
    () => engine.bindExecution(bindInput(request, { phase: 'bound' })),
  ];
  for (const step of steps) {
    const phase = await step();
    const merged = await engine.requestExecution({ ...input, requestId: `duplicate-${phase.request.status}` });
    assert.equal(merged.created, false);
    assert.equal(merged.request.requestId, request.requestId);
    assert.equal(merged.request.runId, request.runId);
    assert.equal(merged.request.status, phase.request.status);
    await assert.rejects(
      engine.requestExecution({ ...input, requestId: 'different-pending', message: '另一轮' }),
      rejectsCode('EXECUTION_BUSY'),
    );
  }
  assert.equal(engine.getTask(request.taskId).executionRequests!.length, 1);
});

test('claim 跨存储实例互斥，同 claim 重放幂等，未知结果不能抢占', async () => {
  const fixture = makeFixture();
  const { request } = await createRequested(fixture);
  await fixture.engine.markExecutionDelivery({ ...receipt(request), status: 'uncertain', error: '超时但可能已送达' });
  const other = new BoardEngine(new JsonFileBoardStore(fixture.file), fixture.git);
  const results = await Promise.allSettled([
    fixture.engine.claimExecution({ ...receipt(request), claimId: 'claim-first' }),
    other.claimExecution({ ...receipt(request), claimId: 'claim-second' }),
  ]);
  const winners = results.filter((r) => r.status === 'fulfilled');
  const losers = results.filter((r) => r.status === 'rejected');
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(winners[0].value.claimed, true);
  assert.ok(losers[0].reason instanceof BoardError);
  assert.equal(losers[0].reason.code, 'EXECUTION_CONFLICT');
  const claimed = fixture.engine.getTask(request.taskId).executionRequests![0];
  const before = snapshot(fixture, request.taskId);
  const replay = await other.claimExecution({ ...receipt(request), claimId: claimed.claimId! });
  assert.equal(replay.claimed, false);
  assert.equal(replay.request.status, 'claimed');
  await assert.rejects(
    other.claimExecution({ ...receipt(request), claimId: 'claim-after-timeout' }),
    rejectsCode('EXECUTION_CONFLICT'),
  );
  assert.deepEqual(snapshot(fixture, request.taskId), before);
  assert.equal(fixture.store.getSession(request.taskId)!.events.filter((e) => e.kind === 'execution_claimed').length, 1);
});

test('两阶段 bind：先保存真实 created 结果，重启后只能按相同结果 bound', async () => {
  const fixture = makeFixture();
  const { engine, store, file, git } = fixture;
  const { request } = await createRequested(fixture);
  const input = bindInput(request);
  await assert.rejects(engine.bindExecution(input), rejectsCode('EXECUTION_CONFLICT'));
  await engine.claimExecution({ ...receipt(request), claimId: input.claimId });
  await assert.rejects(engine.bindExecution({ ...input, phase: 'bound' }), rejectsCode('EXECUTION_CONFLICT'));
  await assert.rejects(engine.bindExecution({ ...input, claimId: 'claim-other' }), rejectsCode('EXECUTION_CONFLICT'));

  const created = await engine.bindExecution(input);
  assert.equal(created.request.status, 'created');
  assert.deepEqual(created.request.result, {
    threadId: input.threadId, hostId: input.hostId, workspacePath: input.workspacePath, workspaceOwner: 'user',
  });
  assert.equal(created.task.executionBinding, undefined);
  assert.equal(created.task.execution.state, 'starting');
  assert.equal(created.task.execution.startedAt, undefined);
  assert.deepEqual(git.identifyCalls, []);
  const before = snapshot(fixture, request.taskId);
  const reopenedStore = new JsonFileBoardStore(file);
  const reopened = new BoardEngine(reopenedStore, git);
  const replay = await reopened.bindExecution(input);
  assert.deepEqual(replay.request, created.request);
  assert.deepEqual(git.identifyCalls, []);
  assert.deepEqual(snapshot(fixture, request.taskId), before);
  await assert.rejects(reopened.bindExecution({ ...input, threadId: 'native-thread-other' }), rejectsCode('EXECUTION_CONFLICT'));
  await assert.rejects(reopened.bindExecution({ ...input, phase: 'bound', branch: 'changed-result' }), rejectsCode('EXECUTION_CONFLICT'));

  const bound = await reopened.bindExecution({ ...input, phase: 'bound' });
  assert.equal(bound.request.status, 'bound');
  assert.equal(bound.task.executionBinding!.provider, 'codex-desktop');
  assert.equal(bound.task.executionBinding!.threadId, input.threadId);
  assert.equal(bound.task.executionBinding!.workspaceOwner, 'user');
  assert.ok(bound.task.executionBinding!.boundAt);
  assert.equal(bound.task.execution.state, 'starting');
  assert.equal(bound.task.execution.startedAt, undefined);
  const boundSnapshot = snapshot(fixture, request.taskId);
  await reopened.bindExecution({ ...input, phase: 'bound' });
  await reopened.bindExecution(input);
  assert.deepEqual(snapshot(fixture, request.taskId), boundSnapshot);
  const events = store.getSession(request.taskId)!.events;
  assert.equal(events.filter((e) => e.kind === 'execution_created').length, 1);
  assert.equal(events.filter((e) => e.kind === 'execution_bound').length, 1);
  assert.ok(!events.some((e) => e.kind === 'started'));
});

test('只有关联 report 才 running；完成须先开始，回执幂等且业务状态独立', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const { request } = await createRequested(fixture);
  await assert.rejects(engine.reportExecution(reportInput(request)), rejectsCode('EXECUTION_CONFLICT'));
  await engine.markExecutionDelivery({ ...receipt(request), status: 'delivered' });
  await engine.claimExecution({ ...receipt(request), claimId: 'claim-a' });
  await engine.bindExecution(bindInput(request));
  await assert.rejects(engine.reportExecution(reportInput(request)), rejectsCode('EXECUTION_CONFLICT'));
  await engine.bindExecution(bindInput(request, { phase: 'bound' }));
  await assert.rejects(
    engine.reportExecution(reportInput(request, { reportId: 'premature-completion', state: 'completed' })),
    rejectsCode('EXECUTION_CONFLICT'),
  );
  await engine.assignTask(request.taskId, 'agent');
  const doing = await engine.moveTask(request.taskId, 'doing');
  assert.equal(doing.execution.state, 'starting');
  assert.equal(doing.execution.startedAt, undefined);
  await assert.rejects(
    engine.updateTask({ id: request.taskId, execution: { state: 'running' } }),
    rejectsCode('EXECUTION_REPORT_REQUIRED'),
  );

  const input = reportInput(request, { activity: 'Editing native workspace' });
  const running = await engine.reportExecution(input);
  assert.equal(running.request.status, 'running');
  assert.equal(running.task.execution.state, 'running');
  assert.equal(running.task.execution.activity, input.activity);
  assert.ok(running.request.startedAt);
  assert.equal(running.task.execution.startedAt, running.request.startedAt);
  assert.equal(running.task.status, 'doing');
  const before = snapshot(fixture, request.taskId);
  await engine.reportExecution(input);
  await assert.rejects(engine.reportExecution({ ...input, activity: 'different report' }), rejectsCode('EXECUTION_CONFLICT'));
  await assert.rejects(engine.reportExecution({ ...input, state: 'waiting' }), rejectsCode('EXECUTION_CONFLICT'));
  assert.deepEqual(snapshot(fixture, request.taskId), before);

  const waiting = await engine.reportExecution(reportInput(request, { reportId: 'report-waiting', state: 'waiting' }));
  assert.equal(waiting.task.execution.state, 'waiting');
  const resumed = await engine.reportExecution(reportInput(request, { reportId: 'report-resumed' }));
  assert.equal(resumed.request.startedAt, running.request.startedAt);
  const completed = await engine.reportExecution(reportInput(request, { reportId: 'report-completed', state: 'completed' }));
  assert.equal(completed.task.execution.state, 'completed');
  assert.equal(completed.task.status, 'doing');
  assert.equal(completed.task.execution.startedAt, running.request.startedAt);
  assert.equal(fixture.store.getSession(request.taskId)!.events.filter((e) => e.kind === 'started').length, 2);
});

test('completed / failed 终态回执不回退；同一终态回执重放不重复事件', async (t) => {
  for (const state of ['completed', 'failed'] as const) {
    await t.test(state, async () => {
      const fixture = makeFixture();
      const { input, request } = await createRequested(fixture);
      await claimAndBind(fixture.engine, request);
      await fixture.engine.reportExecution(reportInput(request));
      const terminal = reportInput(request, { reportId: `report-${state}`, state, activity: '本轮已结束' });
      await fixture.engine.reportExecution(terminal);
      const before = snapshot(fixture, request.taskId);
      await fixture.engine.reportExecution(terminal);
      const replay = await fixture.engine.requestExecution(input);
      assert.equal(replay.created, false);
      assert.equal(replay.request.status, state);
      for (const lateState of ['running', 'waiting', 'completed', 'failed'] as const) {
        await assert.rejects(
          fixture.engine.reportExecution(reportInput(request, { reportId: `late-${lateState}`, state: lateState })),
          rejectsCode('EXECUTION_STALE'),
        );
      }
      await assert.rejects(
        fixture.engine.bindExecution(bindInput(request, { phase: 'bound' })), rejectsCode('EXECUTION_STALE'),
      );
      assert.deepEqual(snapshot(fixture, request.taskId), before);
    });
  }
});

test('真实绑定校验拒绝错误宿主 / 线程 / 创建中标识，拒绝时不写入', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const { input, request } = await createRequested(fixture);
  await engine.claimExecution({ ...receipt(request), claimId: 'claim-a' });
  const before = snapshot(fixture, request.taskId);
  await assert.rejects(engine.bindExecution(bindInput(request, { hostId: 'codex-host-b' })), rejectsCode('EXECUTION_CONFLICT'));
  for (const threadId of ['sess-internal', 'pending-thread', 'creating-thread', 'placeholder-thread', '']) {
    await assert.rejects(engine.bindExecution(bindInput(request, { threadId })), rejectsCode('VALIDATION'));
  }
  assert.deepEqual(snapshot(fixture, request.taskId), before);
  await engine.bindExecution(bindInput(request));
  await engine.bindExecution(bindInput(request, { phase: 'bound' }));
  const boundSnapshot = snapshot(fixture, request.taskId);
  await assert.rejects(
    engine.reportExecution(reportInput(request, { hostId: 'codex-host-b' })), rejectsCode('EXECUTION_CONFLICT'),
  );
  await assert.rejects(
    engine.reportExecution(reportInput(request, { threadId: 'native-thread-b' })), rejectsCode('EXECUTION_CONFLICT'),
  );
  assert.deepEqual(snapshot(fixture, request.taskId), boundSnapshot);
  await engine.reportExecution(reportInput(request));
  await engine.reportExecution(reportInput(request, { reportId: 'waiting-before-reply', state: 'waiting' }));
  const waitingSnapshot = snapshot(fixture, request.taskId);
  await assert.rejects(
    engine.requestExecution({ ...input, requestId: 'foreign-host', action: 'continue', hostId: 'codex-host-b' }),
    rejectsCode('EXECUTION_CONFLICT'),
  );
  assert.deepEqual(snapshot(fixture, request.taskId), waitingSnapshot);
});

test('五个原生 API 都拒绝错误看板，不串板或修改执行记录', async () => {
  const fixture = makeFixture();
  const { engine, store } = fixture;
  const { input, request } = await createRequested(fixture);
  await claimAndBind(engine, request);
  const { board } = store.registerBoard({ repoKey: '/repos/b/.git', repo: '/repos/b', name: 'B', baseBranch: 'main' });
  const before = snapshot(fixture, request.taskId);
  const wrong = { ...receipt(request), boardId: board.id };
  const calls = [
    () => engine.requestExecution({ ...input, boardId: board.id, requestId: 'wrong-board' }),
    () => engine.markExecutionDelivery({ ...wrong, status: 'delivered' }),
    () => engine.claimExecution({ ...wrong, claimId: 'claim-a' }),
    () => engine.bindExecution({ ...bindInput(request), ...wrong, phase: 'bound' }),
    () => engine.reportExecution({ ...reportInput(request), ...wrong }),
  ];
  for (const call of calls) await assert.rejects(call(), rejectsCode('BOARD_MISMATCH'));
  assert.deepEqual(snapshot(fixture, request.taskId), before);
  assert.deepEqual(engine.listTasks({ boardId: board.id }), []);
});

test('五个原生 API 都拒绝归档任务；旧快照不能绕过事务内守卫', async () => {
  const fixture = makeFixture();
  const { engine, store } = fixture;
  const { input, request } = await createRequested(fixture);
  await claimAndBind(engine, request);
  await engine.reportExecution(reportInput(request));
  await engine.reportExecution(reportInput(request, { reportId: 'archive-completed', state: 'completed' }));
  assert.equal(engine.getTask(request.taskId).status, 'doing');
  await engine.moveTask(request.taskId, 'review');
  await engine.moveTask(request.taskId, 'done');
  const stale = store.getTask(request.taskId)!;
  await engine.archiveTask(request.taskId);
  const before = snapshot(fixture, request.taskId);
  const originalGetTask = store.getTask.bind(store);
  store.getTask = (id) => id === request.taskId ? structuredClone(stale) : originalGetTask(id);
  try {
    const calls = [
      () => engine.requestExecution({ ...input, requestId: 'archived-request' }),
      () => engine.markExecutionDelivery({ ...receipt(request), status: 'delivered' }),
      () => engine.claimExecution({ ...receipt(request), claimId: 'claim-a' }),
      () => engine.bindExecution(bindInput(request, { phase: 'bound' })),
      () => engine.reportExecution(reportInput(request, { reportId: 'archived-report' })),
    ];
    for (const call of calls) await assert.rejects(call(), rejectsCode('TASK_ARCHIVED'));
  } finally {
    store.getTask = originalGetTask;
  }
  assert.deepEqual(snapshot(fixture, request.taskId), before);
});

test('完整 reply 持久化并创建新 run；历史请求重放和旧 run 回执不能覆盖本轮', async () => {
  const fixture = makeFixture();
  const { engine, file } = fixture;
  const { input, request } = await createRequested(fixture);
  const bound = await claimAndBind(engine, request);
  await engine.reportExecution(reportInput(request));
  await engine.reportExecution(reportInput(request, { reportId: 'completed-first-run', state: 'completed' }));
  await assert.rejects(engine.requestExecution({ ...input, requestId: 'start-again' }), rejectsCode('EXECUTION_CONFLICT'));
  const message = `  第一段完整指令\n${'保留上下文\n'.repeat(400)}最后一段，不得截成活动摘要。  `;
  const replyInput = { ...input, requestId: 'reply-request', action: 'reply' as const, message };
  const reply = await engine.requestExecution(replyInput);
  assert.equal(reply.created, true);
  assert.notEqual(reply.request.runId, request.runId);
  assert.equal(reply.request.message, message);
  assert.equal(reply.task.execution.state, 'starting');
  assert.equal(reply.task.execution.startedAt, undefined);
  assert.deepEqual(reply.task.executionBinding, bound.task.executionBinding);
  const persisted = new JsonFileBoardStore(file).getTask(request.taskId)!;
  assert.equal(persisted.executionRequests!.find((r) => r.requestId === reply.request.requestId)!.message, message);
  const before = snapshot(fixture, request.taskId);
  const historical = await engine.requestExecution(input);
  assert.equal(historical.created, false);
  assert.equal(historical.request.status, 'completed');
  assert.equal(historical.task.execution.runId, reply.request.runId);
  const replay = await engine.requestExecution(replyInput);
  assert.equal(replay.created, false);
  assert.equal(replay.request.runId, reply.request.runId);
  const oldCalls = [
    () => engine.markExecutionDelivery({ ...receipt(request), status: 'delivered' }),
    () => engine.claimExecution({ ...receipt(request), claimId: 'claim-a' }),
    () => engine.bindExecution(bindInput(request, { phase: 'bound' })),
    () => engine.reportExecution(reportInput(request)),
    () => engine.reportExecution(reportInput(reply.request, { runId: request.runId })),
  ];
  for (const call of oldCalls) await assert.rejects(call(), rejectsCode('EXECUTION_STALE'));
  assert.deepEqual(snapshot(fixture, request.taskId), before);
  // 原聊天已绑定也不能跳过本轮 claim / created / bound。
  await assert.rejects(engine.reportExecution(reportInput(reply.request)), rejectsCode('EXECUTION_CONFLICT'));
  await claimAndBind(engine, reply.request, { claimId: 'claim-reply' });
  const runningReply = await engine.reportExecution(reportInput(reply.request, { reportId: 'reply-running' }));
  assert.equal(runningReply.task.execution.state, 'running');
  assert.equal(runningReply.task.executionBinding!.threadId, bound.task.executionBinding!.threadId);
  assert.equal(runningReply.request.message, message);
  assert.equal(runningReply.task.executionRequests!.length, 2);
});

test('continue / retry 复用原线程工作区并分配新 run；running 时不得并发请求', async (t) => {
  for (const action of ['continue', 'retry'] as const) {
    await t.test(action, async () => {
      const fixture = makeFixture();
      const { input, request } = await createRequested(fixture, { workspaceMode: 'worktree' });
      const workspace = { workspacePath: '/worktrees/a', workspaceOwner: 'codex' as const, branch: 'codex/task-a' };
      const bound = await claimAndBind(fixture.engine, request, workspace);
      await fixture.engine.reportExecution(reportInput(request));
      const runningSnapshot = snapshot(fixture, request.taskId);
      await assert.rejects(
        fixture.engine.requestExecution({ ...input, action, requestId: `busy-${action}` }), rejectsCode('EXECUTION_BUSY'),
      );
      assert.deepEqual(snapshot(fixture, request.taskId), runningSnapshot);
      await fixture.engine.reportExecution(reportInput(request, {
        reportId: `before-${action}`, state: action === 'continue' ? 'waiting' : 'failed',
      }));
      const before = snapshot(fixture, request.taskId);
      await assert.rejects(
        fixture.engine.requestExecution({ ...input, action, requestId: 'changed-mode', workspaceMode: 'project' }),
        rejectsCode('EXECUTION_CONFLICT'),
      );
      assert.deepEqual(snapshot(fixture, request.taskId), before);
      const next = await fixture.engine.requestExecution({ ...input, action, requestId: `next-${action}` });
      assert.equal(next.created, true);
      assert.notEqual(next.request.runId, request.runId);
      await claimAndBind(fixture.engine, next.request, { ...workspace, claimId: `claim-${action}` });
      const updated = fixture.engine.getTask(request.taskId);
      assert.deepEqual(updated.executionBinding, bound.task.executionBinding);
      assert.equal(updated.worktreePath, workspace.workspacePath);
      assert.equal(updated.branch, workspace.branch);
      assert.equal(updated.execution.state, 'starting');
      assert.equal(fixture.git.ensureCalls, 0);
    });
  }
});

test('普通 assign 不停止真实运行或创建 Git，并保留 legacy session / 仓库 / 分支字段', async () => {
  const fixture = makeFixture();
  const { engine, store, git } = fixture;
  const task = await engine.createTask({ title: '旧工作区', status: 'ready' });
  const legacy = {
    repo: '/repos/a', baseBranch: 'legacy-base', branch: 'tasklane/legacy-a', worktreePath: '/worktrees/legacy-a',
  };
  store.mutateTask(task.id, (current) => ({
    ...current, ...legacy,
    execution: { state: 'running', sessionId: 'sess-legacy', startedAt: '2026-10-01T00:00:00.000Z', activity: '旧记录' },
  }));
  const requested = await engine.requestExecution(requestInput(task.id, { workspaceMode: 'existing' }));
  assert.equal(requested.task.execution.sessionId, 'sess-legacy');
  assert.equal(requested.task.execution.startedAt, undefined);
  await claimAndBind(engine, requested.request, {
    workspacePath: legacy.worktreePath, workspaceOwner: 'tasklane', branch: legacy.branch,
  });
  const running = await engine.reportExecution(reportInput(requested.request));
  const gitCallsBeforeAssign = git.identifyCalls.length;
  const human = await engine.assignTask(task.id, 'human');
  const agent = await engine.assignTask(task.id, 'agent');
  const repeat = await engine.assignTask(task.id, 'agent');
  assert.equal(human.assignee, 'human');
  assert.equal(agent.assignee, 'agent');
  for (const current of [human, agent, repeat]) {
    assert.deepEqual(current.execution, running.task.execution);
    assert.deepEqual(current.executionBinding, running.task.executionBinding);
    assert.deepEqual(current.executionRequests, running.task.executionRequests);
    assert.equal(current.execution.sessionId, 'sess-legacy');
    for (const field of ['repo', 'baseBranch', 'branch', 'worktreePath'] as const) {
      assert.equal(current[field], legacy[field]);
    }
  }
  assert.equal(git.identifyCalls.length, gitCallsBeforeAssign);
  assert.equal(git.ensureCalls, 0);
  assert.equal(engine.getTask(task.id).status, 'doing');
  const review = await engine.moveTask(task.id, 'review');
  assert.deepEqual(review.execution, running.task.execution);
  assert.deepEqual(git.diffCalls, [{ workspacePath: legacy.worktreePath, baseBranch: legacy.baseBranch }]);
  const done = await engine.moveTask(task.id, 'done');
  assert.deepEqual(done.execution, running.task.execution);
  assert.equal(done.execution.state, 'running');
  const events = store.getSession(task.id)!.events;
  assert.ok(!events.some((e) => e.kind === 'stopped' || e.kind === 'completed'));
  assert.equal(events.filter((e) => e.kind === 'started').length, 1);
});

test('已确认 delivered 不被认领前的迟到超时 uncertain 降级（F2 回归）', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const { request } = await createRequested(fixture);
  // 先收到确认投递，再收到迟到的超时回执（认领前窗口）
  const delivered = await engine.markExecutionDelivery({ ...receipt(request), status: 'delivered' });
  assert.equal(delivered.request.status, 'delivered');

  const late = await engine.markExecutionDelivery({ ...receipt(request), status: 'uncertain', error: 'late timeout' });
  assert.equal(late.request.status, 'delivered'); // 不降级
  assert.equal(late.request.deliveryError, undefined); // 不写入迟到错误
  assert.equal(late.task.execution.state, 'starting'); // 执行态不受影响

  // 快照（任务 + 时间线）与降级前完全一致：无新事件、无字段变化
  const before = snapshot(fixture, request.taskId);
  await engine.markExecutionDelivery({ ...receipt(request), status: 'uncertain', error: '再次迟到' });
  await engine.markExecutionDelivery({ ...receipt(request), status: 'delivered' }); // 幂等
  assert.deepEqual(snapshot(fixture, request.taskId), before);

  // 反向顺序仍是升级：uncertain → delivered 可以解除未知并清错误
  const other = await createRequested(fixture, { requestId: 'request-b' });
  await engine.markExecutionDelivery({ ...receipt(other.request), status: 'uncertain', error: '传输超时' });
  const upgraded = await engine.markExecutionDelivery({ ...receipt(other.request), status: 'delivered' });
  assert.equal(upgraded.request.status, 'delivered');
  assert.equal(upgraded.request.deliveryError, undefined);
});

test('delivery 超时保留 uncertain；认领后迟到 delivery 不倒退任何已确认阶段', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const { request } = await createRequested(fixture);
  const uncertain = await engine.markExecutionDelivery({ ...receipt(request), status: 'uncertain', error: '传输超时' });
  assert.equal(uncertain.request.status, 'uncertain');
  assert.equal(uncertain.request.deliveryError, '传输超时');
  assert.equal(uncertain.task.execution.state, 'starting');
  const delivered = { ...receipt(request), status: 'delivered' as const };
  await engine.markExecutionDelivery(delivered);
  const deliverySnapshot = snapshot(fixture, request.taskId);
  await engine.markExecutionDelivery(delivered);
  assert.deepEqual(snapshot(fixture, request.taskId), deliverySnapshot);
  assert.equal(engine.getTask(request.taskId).executionRequests![0].deliveryError, undefined);
  const steps = [
    () => engine.claimExecution({ ...receipt(request), claimId: 'claim-a' }),
    () => engine.bindExecution(bindInput(request)),
    () => engine.bindExecution(bindInput(request, { phase: 'bound' })),
    () => engine.reportExecution(reportInput(request)),
    () => engine.reportExecution(reportInput(request, { reportId: 'waiting-delivery', state: 'waiting' })),
    () => engine.reportExecution(reportInput(request, { reportId: 'completed-delivery', state: 'completed' })),
  ];
  for (const step of steps) {
    await step();
    const before = snapshot(fixture, request.taskId);
    await engine.markExecutionDelivery(delivered);
    await engine.markExecutionDelivery({ ...receipt(request), status: 'uncertain', error: '迟到错误不覆盖真实回执' });
    assert.deepEqual(snapshot(fixture, request.taskId), before);
  }
});

test('bind 只读 Git 间隙内的并发 metadata / 指派 / 状态修改不丢失', async () => {
  const fixture = makeFixture();
  const { engine, git, file } = fixture;
  const { request } = await createRequested(fixture);
  await engine.claimExecution({ ...receipt(request), claimId: 'claim-a' });
  await engine.bindExecution(bindInput(request));
  const other = new BoardEngine(new JsonFileBoardStore(file), new StubGitService());
  for (const turn of [1, 2]) {
    const gate = pauseNextIdentify(git);
    const pending = engine.bindExecution(bindInput(request, { phase: 'bound' }));
    await gate.started;
    try {
      await other.updateTask({ id: request.taskId, title: `最新标题-${turn}`, description: `完整描述-${turn}`, priority: 'P0' });
      await other.assignTask(request.taskId, turn === 1 ? 'agent' : 'human');
      if (turn === 1) await other.moveTask(request.taskId, 'doing');
    } finally {
      gate.release();
    }
    const result = await pending;
    assert.equal(result.task.title, `最新标题-${turn}`);
    assert.equal(result.task.description, `完整描述-${turn}`);
    assert.equal(result.task.priority, 'P0');
    assert.equal(result.task.assignee, turn === 1 ? 'agent' : 'human');
    assert.equal(result.task.status, 'doing');
    assert.equal(result.task.execution.state, 'starting');
    assert.equal(result.request.status, 'bound');
    assert.equal(result.request.claimId, 'claim-a');
    assert.equal(result.request.result!.threadId, 'native-thread-a');
    assert.deepEqual(new JsonFileBoardStore(file).getTask(request.taskId), result.task);
  }
});

test('bind 校验期间任务被归档或工作区被改绑，事务内拒绝旧快照', async (t) => {
  for (const change of ['archive', 'workspace'] as const) {
    await t.test(change, async () => {
      const fixture = makeFixture();
      const { engine, store, git, file } = fixture;
      const { request } = await createRequested(fixture);
      await engine.claimExecution({ ...receipt(request), claimId: 'claim-a' });
      const created = await engine.bindExecution(bindInput(request));
      const gate = pauseNextIdentify(git);
      const pending = engine.bindExecution(bindInput(request, { phase: 'bound' }));
      const rejected = assert.rejects(pending, rejectsCode(change === 'archive' ? 'TASK_ARCHIVED' : 'EXECUTION_CONFLICT'));
      await gate.started;
      const otherStore = new JsonFileBoardStore(file);
      const other = new BoardEngine(otherStore, new StubGitService());
      try {
        if (change === 'archive') {
          await other.moveTask(request.taskId, 'doing');
          await other.moveTask(request.taskId, 'review');
          await other.moveTask(request.taskId, 'done');
          await other.archiveTask(request.taskId);
        } else {
          otherStore.mutateTask(request.taskId, (task) => ({ ...task, branch: 'tasklane/concurrent', worktreePath: '/worktrees/alternate-a' }));
        }
      } finally {
        gate.release();
      }
      await rejected;
      const latest = store.getTask(request.taskId)!;
      assert.equal(latest.executionBinding, undefined);
      assert.equal(latest.executionRequests![0].status, 'created');
      assert.deepEqual(latest.executionRequests![0].result, created.request.result);
      if (change === 'archive') assert.ok(latest.archivedAt);
      else assert.equal(latest.branch, 'tasklane/concurrent');
    });
  }
});

test('workspace 校验拒绝相对路径、异仓库、子目录和错误 worktree owner / 分支', async (t) => {
  const cases: {
    name: string;
    mode: RequestExecutionInput['workspaceMode'];
    result: Partial<BindExecutionInput>;
    code: BoardError['code'];
  }[] = [
    { name: '相对目录', mode: 'project', result: { workspacePath: 'repos/a' }, code: 'VALIDATION' },
    { name: '非 Git 目录', mode: 'project', result: { workspacePath: '/not-a-workspace' }, code: 'GIT_ERROR' },
    { name: '其他仓库', mode: 'project', result: { workspacePath: '/repos/b' }, code: 'GIT_ERROR' },
    { name: '主仓库子目录', mode: 'project', result: { workspacePath: '/repos/a/subdir' }, code: 'GIT_ERROR' },
    { name: 'project 不能使用 worktree', mode: 'project', result: { workspacePath: '/worktrees/a' }, code: 'GIT_ERROR' },
    { name: 'project owner 必须 user', mode: 'project', result: { workspaceOwner: 'codex' }, code: 'GIT_ERROR' },
    { name: 'worktree 不能使用主仓库', mode: 'worktree', result: { workspacePath: '/repos/a', workspaceOwner: 'codex', branch: 'codex/task-a' }, code: 'GIT_ERROR' },
    { name: '新 worktree 不能归 user', mode: 'worktree', result: { workspacePath: '/worktrees/a', workspaceOwner: 'user', branch: 'codex/task-a' }, code: 'GIT_ERROR' },
    { name: '新 worktree 不能归 tasklane', mode: 'worktree', result: { workspacePath: '/worktrees/a', workspaceOwner: 'tasklane', branch: 'codex/task-a' }, code: 'GIT_ERROR' },
    { name: 'worktree 必须有分支', mode: 'worktree', result: { workspacePath: '/worktrees/a', workspaceOwner: 'codex' }, code: 'GIT_ERROR' },
    { name: 'worktree 分支错误', mode: 'worktree', result: { workspacePath: '/worktrees/a', workspaceOwner: 'codex', branch: 'codex/wrong' }, code: 'GIT_ERROR' },
    { name: 'worktree 必须是根目录', mode: 'worktree', result: { workspacePath: '/worktrees/a/subdir', workspaceOwner: 'codex', branch: 'codex/task-a' }, code: 'GIT_ERROR' },
    { name: 'worktree 不能来自别的仓库', mode: 'worktree', result: { workspacePath: '/worktrees/b', workspaceOwner: 'codex', branch: 'codex/task-b' }, code: 'GIT_ERROR' },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = makeFixture();
      const { request } = await createRequested(fixture, { workspaceMode: scenario.mode });
      await fixture.engine.claimExecution({ ...receipt(request), claimId: 'claim-a' });
      const input = bindInput(request, scenario.result);
      if (scenario.code === 'VALIDATION') await assert.rejects(fixture.engine.bindExecution(input), rejectsCode('VALIDATION'));
      else await fixture.engine.bindExecution(input);
      const before = snapshot(fixture, request.taskId);
      await assert.rejects(fixture.engine.bindExecution({ ...input, phase: 'bound' }), rejectsCode(scenario.code));
      assert.deepEqual(snapshot(fixture, request.taskId), before);
      assert.equal(fixture.store.getTask(request.taskId)!.executionBinding, undefined);
      assert.equal(fixture.git.ensureCalls, 0);
    });
  }
});

test('existing 必须原样复用旧 worktree / owner / 分支；绑定仓库改变也拒绝', async () => {
  const fixture = makeFixture();
  const { engine, store } = fixture;
  const task = await engine.createTask({ title: '旧工作区复用' });
  await assert.rejects(
    engine.requestExecution(requestInput(task.id, { workspaceMode: 'existing' })), rejectsCode('VALIDATION'),
  );
  store.mutateTask(task.id, (current) => ({ ...current, branch: 'tasklane/legacy-a', worktreePath: '/worktrees/legacy-a' }));
  for (const workspaceMode of ['project', 'worktree'] as const) {
    await assert.rejects(engine.requestExecution(requestInput(task.id, { workspaceMode })), rejectsCode('EXECUTION_CONFLICT'));
  }
  const { request } = await engine.requestExecution(requestInput(task.id, { workspaceMode: 'existing' }));
  await engine.claimExecution({ ...receipt(request), claimId: 'claim-a' });
  const input = bindInput(request, { workspacePath: '/worktrees/legacy-a', workspaceOwner: 'tasklane', branch: 'tasklane/legacy-a' });
  const changes: Partial<BindExecutionInput>[] = [
    { workspacePath: '/worktrees/alternate-a', branch: 'codex/task-a' },
    { workspacePath: '/repos/a' }, { workspaceOwner: 'codex' }, { workspaceOwner: 'user' },
    { branch: 'tasklane/wrong' }, { branch: undefined },
  ];
  for (const change of changes) {
    const unsafe = await engine.createTask({ title: '不可绑定的旧工作区结果' });
    store.mutateTask(unsafe.id, (current) => ({ ...current, branch: 'tasklane/legacy-a', worktreePath: '/worktrees/legacy-a' }));
    const attempt = await engine.requestExecution(requestInput(unsafe.id, { workspaceMode: 'existing' }));
    await engine.claimExecution({ ...receipt(attempt.request), claimId: 'claim-a' });
    const unsafeInput = bindInput(attempt.request, { ...input, ...receipt(attempt.request), ...change });
    await engine.bindExecution(unsafeInput);
    const before = snapshot(fixture, unsafe.id);
    await assert.rejects(engine.bindExecution({ ...unsafeInput, phase: 'bound' }), rejectsCode('GIT_ERROR'));
    assert.deepEqual(snapshot(fixture, unsafe.id), before);
    assert.equal(store.getTask(unsafe.id)!.executionBinding, undefined);
  }
  const created = await engine.bindExecution(input);
  store.mutateBoard('default', (board) => ({ ...board, repo: '/repos/b', repoKey: '/repos/b/.git' }));
  await assert.rejects(engine.bindExecution({ ...input, phase: 'bound' }), rejectsCode('EXECUTION_CONFLICT'));
  assert.equal(store.getTask(task.id)!.executionBinding, undefined);
  assert.deepEqual(store.getTask(task.id)!.executionRequests![0].result, created.request.result);
});

test('无先验路由的请求由真实接收者认领，重放幂等并完成绑定和执行回执', async () => {
  const fixture = makeFixture();
  const { engine, store, file, git } = fixture;
  const { input, request } = await createRequested(fixture, { hostId: undefined, receiverThreadId: undefined, model: 'custom-model' });
  assert.equal(request.hostId, undefined);
  assert.equal(request.receiverThreadId, undefined);
  assert.equal(request.receiver, undefined);
  const claimed = await engine.claimExecution({ ...receipt(request), claimId: 'claim-a', hostId: 'codex-host-a', receiverThreadId: 'receiver-thread-a' });
  assert.deepEqual(claimed.request.receiver, { hostId: 'codex-host-a', threadId: 'receiver-thread-a' });
  assert.equal(claimed.request.hostId, undefined);
  const before = snapshot(fixture, request.taskId);
  const replay = await engine.requestExecution(input);
  const merged = await engine.requestExecution({ ...input, requestId: 'same-no-route' });
  assert.equal(replay.created, false);
  assert.equal(merged.created, false);
  assert.deepEqual(merged.request, claimed.request);
  assert.deepEqual(snapshot(fixture, request.taskId), before);
  const reopened = new BoardEngine(new JsonFileBoardStore(file), git);
  assert.deepEqual(reopened.getTask(request.taskId).executionRequests![0].receiver, claimed.request.receiver);
  assert.equal(reopened.getTask(request.taskId).executionRequests![0].model, 'custom-model');
  const binding = bindInput(claimed.request);
  await reopened.bindExecution(binding);
  const bound = await reopened.bindExecution({ ...binding, phase: 'bound' });
  assert.equal(bound.task.execution.startedAt, undefined);
  const running = await reopened.reportExecution(reportInput(claimed.request));
  assert.ok(running.task.execution.startedAt);
  const completed = await reopened.reportExecution(reportInput(claimed.request, { reportId: 'complete-no-route', state: 'completed' }));
  assert.equal(completed.task.execution.state, 'completed');
  assert.equal(store.getSession(request.taskId)!.events.filter((event) => event.kind === 'started').length, 1);
  // 后续请求仍可省略初始路由，但接收者必须与原绑定宿主一致。
  const next = await reopened.requestExecution({ ...input, requestId: 'continue-no-route', action: 'continue', model: undefined });
  await assert.rejects(reopened.claimExecution({ ...receipt(next.request), claimId: 'claim-next', hostId: 'other-host', receiverThreadId: 'other-receiver' }), rejectsCode('EXECUTION_CONFLICT'));
  const nextClaimed = await reopened.claimExecution({ ...receipt(next.request), claimId: 'claim-next', hostId: 'codex-host-a', receiverThreadId: 'receiver-next' });
  assert.equal(nextClaimed.request.receiver?.threadId, 'receiver-next');
});

test('认领必须核对真实接收者且标识成对，原路由和同一认领不可替换', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const { request } = await createRequested(fixture, { hostId: undefined, receiverThreadId: undefined });
  const claim = { ...receipt(request), claimId: 'claim-a' };
  const before = snapshot(fixture, request.taskId);
  for (const route of [
    {}, { hostId: 'codex-host-a' }, { receiverThreadId: 'receiver-thread-a' },
    { hostId: 'sess-fake', receiverThreadId: 'receiver-thread-a' },
    { hostId: 'codex-host-a', receiverThreadId: 'pending-fake' },
  ]) await assert.rejects(engine.claimExecution({ ...claim, ...route }), rejectsCode('VALIDATION'));
  assert.deepEqual(snapshot(fixture, request.taskId), before);
  const actual = { ...claim, hostId: 'codex-host-a', receiverThreadId: 'receiver-thread-a' };
  assert.equal((await engine.claimExecution(actual)).claimed, true);
  assert.equal((await engine.claimExecution(actual)).claimed, false);
  for (const change of [{ hostId: 'codex-host-b' }, { receiverThreadId: 'receiver-thread-b' }, { claimId: 'claim-b' }]) {
    await assert.rejects(engine.claimExecution({ ...actual, ...change }), rejectsCode('EXECUTION_CONFLICT'));
  }
  const routed = await createRequested(fixture, { requestId: 'routed' });
  const oldClaim = { ...receipt(routed.request), claimId: 'claim-old' };
  for (const route of [
    { hostId: 'codex-host-b', receiverThreadId: 'receiver-thread-a' },
    { hostId: 'codex-host-a', receiverThreadId: 'receiver-thread-b' },
  ]) await assert.rejects(engine.claimExecution({ ...oldClaim, ...route }), rejectsCode('EXECUTION_CONFLICT'));
  assert.deepEqual((await engine.claimExecution(oldClaim)).request.receiver, { hostId: 'codex-host-a', threadId: 'receiver-thread-a' });
  const partial = await createRequested(fixture, { requestId: 'partial', receiverThreadId: undefined });
  await assert.rejects(engine.claimExecution({ ...receipt(partial.request), claimId: 'claim-partial' }), rejectsCode('VALIDATION'));
  assert.equal((await engine.claimExecution({ ...receipt(partial.request), claimId: 'claim-partial', hostId: 'codex-host-a', receiverThreadId: 'receiver-actual' })).claimed, true);
});

test('明确投递拒绝解除待确认，仅用户的新请求启动新代次，拒绝不伪造执行失败', async () => {
  const fixture = makeFixture();
  const { engine, store, file } = fixture;
  const { input, request } = await createRequested(fixture, { hostId: undefined, receiverThreadId: undefined });
  await engine.assignTask(request.taskId, 'agent');
  const delivery = { ...receipt(request), status: 'rejected' as const, error: '宿主明确拒绝消息' };
  const before = snapshot(fixture, request.taskId);
  for (const error of [undefined, '', '  ', 'x'.repeat(201)]) {
    await assert.rejects(engine.markExecutionDelivery({ ...delivery, error }), rejectsCode('VALIDATION'));
  }
  assert.deepEqual(snapshot(fixture, request.taskId), before);
  const rejected = await engine.markExecutionDelivery(delivery);
  assert.equal(rejected.request.status, 'rejected');
  assert.equal(rejected.task.execution.state, 'assigned');
  assert.equal(rejected.task.execution.activity, delivery.error);
  assert.equal(rejected.task.execution.startedAt, undefined);
  assert.equal(rejected.request.result, undefined);
  const rejectedSnapshot = snapshot(fixture, request.taskId);
  await engine.markExecutionDelivery(delivery);
  await engine.markExecutionDelivery({ ...receipt(request), status: 'delivered' });
  await engine.markExecutionDelivery({ ...receipt(request), status: 'uncertain', error: '迟到超时' });
  assert.deepEqual(snapshot(fixture, request.taskId), rejectedSnapshot);
  assert.equal((await engine.requestExecution(input)).created, false);
  await assert.rejects(engine.claimExecution({ ...receipt(request), claimId: 'claim-a', hostId: 'codex-host-a', receiverThreadId: 'receiver-thread-a' }), rejectsCode('EXECUTION_STALE'));
  assert.equal(new JsonFileBoardStore(file).getTask(request.taskId)!.executionRequests![0].status, 'rejected');
  const next = await engine.requestExecution({ ...input, requestId: 'explicit-new-attempt' });
  assert.equal(next.created, true);
  assert.notEqual(next.request.runId, request.runId);
  await assert.rejects(engine.markExecutionDelivery(delivery), rejectsCode('EXECUTION_STALE'));
  const events = store.getSession(request.taskId)!.events;
  assert.equal(events.filter((event) => event.kind === 'execution_rejected').length, 1);
  assert.equal(events.filter((event) => event.kind === 'started' || event.kind === 'failed').length, 0);
});

test('接收 Agent 在无创建结果时可明确拒绝，迟到面板拒绝和已有创建结果不可回退', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const { request } = await createRequested(fixture, { hostId: undefined, receiverThreadId: undefined });
  const claim = { ...receipt(request), claimId: 'claim-a', hostId: 'codex-host-a', receiverThreadId: 'receiver-thread-a' };
  const claimed = await engine.claimExecution(claim);
  const reject = { ...receipt(request), status: 'rejected' as const, error: '缺少原生线程工具' };
  const before = snapshot(fixture, request.taskId);
  await engine.markExecutionDelivery(reject);
  await assert.rejects(engine.markExecutionDelivery({ ...reject, claimId: 'claim-wrong' }), rejectsCode('EXECUTION_CONFLICT'));
  assert.deepEqual(snapshot(fixture, request.taskId), before);
  const rejected = await engine.markExecutionDelivery({ ...reject, claimId: claim.claimId });
  assert.equal(rejected.request.status, 'rejected');
  assert.equal(rejected.task.assignee, 'agent');
  assert.equal(rejected.task.execution.state, 'assigned');
  await assert.rejects(engine.claimExecution(claim), rejectsCode('EXECUTION_STALE'));
  const other = await createRequested(fixture, { requestId: 'created-result' });
  const binding = bindInput(other.request);
  await engine.claimExecution({ ...receipt(other.request), claimId: binding.claimId });
  await engine.bindExecution(binding);
  for (const phase of ['created', 'bound', 'running'] as const) {
    if (phase === 'bound') await engine.bindExecution({ ...binding, phase });
    if (phase === 'running') await engine.reportExecution(reportInput(other.request));
    const state = snapshot(fixture, other.request.taskId);
    const lateReject = { ...receipt(other.request), status: 'rejected' as const, error: '迟到拒绝' };
    await engine.markExecutionDelivery(lateReject);
    await assert.rejects(engine.markExecutionDelivery({ ...lateReject, claimId: binding.claimId }), rejectsCode('EXECUTION_CONFLICT'));
    assert.deepEqual(snapshot(fixture, other.request.taskId), state);
  }
  assert.equal(claimed.request.receiver?.hostId, 'codex-host-a');
});

test('未知投递和未知创建继续阻塞新请求，重复认领不能以超时抢占', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const { input, request } = await createRequested(fixture, { hostId: undefined, receiverThreadId: undefined });
  await engine.markExecutionDelivery({ ...receipt(request), status: 'uncertain', error: 'SDK 响应未知' });
  await assert.rejects(engine.requestExecution({ ...input, requestId: 'unsafe-retry', message: '另一次创建' }), rejectsCode('EXECUTION_BUSY'));
  const claimed = await engine.claimExecution({ ...receipt(request), claimId: 'claim-a', hostId: 'codex-host-a', receiverThreadId: 'receiver-thread-a' });
  const before = snapshot(fixture, request.taskId);
  await engine.markExecutionDelivery({ ...receipt(request), status: 'uncertain', error: '原生创建结果未知' });
  assert.deepEqual(snapshot(fixture, request.taskId), before);
  assert.equal((await engine.requestExecution({ ...input, requestId: 'same-intent' })).created, false);
  await assert.rejects(engine.claimExecution({ ...receipt(request), claimId: 'claim-timeout', hostId: 'codex-host-a', receiverThreadId: 'receiver-thread-a' }), rejectsCode('EXECUTION_CONFLICT'));
  assert.equal(claimed.request.status, 'claimed');
});

test('旧 v4 已认领请求可沿用原宿主恢复，无已核对宿主的损坏认领不能绑定', async () => {
  const fixture = makeFixture();
  const { store, engine, git, file } = fixture;
  const { request } = await createRequested(fixture, { model: 'legacy-model' });
  await engine.claimExecution({ ...receipt(request), claimId: 'claim-a' });
  store.mutateTask(request.taskId, (task) => {
    delete task.executionRequests![0].receiver;
    return task;
  });
  const reopened = new BoardEngine(new JsonFileBoardStore(file), git);
  assert.equal(reopened.getTask(request.taskId).executionRequests![0].receiver, undefined);
  assert.equal(reopened.getTask(request.taskId).executionRequests![0].model, 'legacy-model');
  await reopened.bindExecution(bindInput(request));
  await reopened.bindExecution(bindInput(request, { phase: 'bound' }));
  await reopened.reportExecution(reportInput(request));
  const noRoute = await createRequested(fixture, { requestId: 'no-route-corrupt', hostId: undefined, receiverThreadId: undefined });
  await engine.claimExecution({ ...receipt(noRoute.request), claimId: 'claim-a', hostId: 'codex-host-a', receiverThreadId: 'receiver-thread-a' });
  store.mutateTask(noRoute.request.taskId, (task) => {
    delete task.executionRequests![0].receiver;
    return task;
  });
  const before = snapshot(fixture, noRoute.request.taskId);
  await assert.rejects(reopened.bindExecution(bindInput(noRoute.request, { hostId: 'codex-host-a' })), rejectsCode('EXECUTION_CONFLICT'));
  assert.deepEqual(snapshot(fixture, noRoute.request.taskId), before);
});

test('v4 重读校验新接收者和拒绝记录，拒绝未知状态及损坏映射', async () => {
  const fixture = makeFixture();
  const { request } = await createRequested(fixture, { hostId: undefined, receiverThreadId: undefined, model: 'preserved-model' });
  await fixture.engine.claimExecution({ ...receipt(request), claimId: 'claim-a', hostId: 'codex-host-a', receiverThreadId: 'receiver-thread-a' });
  const raw = readFileSync(fixture.file, 'utf8');
  const original = JSON.parse(raw) as { tasks: Record<string, WorkItem> };
  const cases = [
    { status: 'unknown' },
    { receiver: { hostId: 'codex-host-a' } },
    { receiver: { hostId: 'sess-fake', threadId: 'receiver-thread-a' } },
    { receiver: { hostId: 'codex-host-a', threadId: 'pending-fake' } },
    { claimId: undefined },
    { hostId: 'codex-host-b' },
    { receiverThreadId: 'receiver-thread-b' },
    { status: 'rejected', deliveryError: '' },
    { status: 'rejected', deliveryError: '明确拒绝', result: { threadId: 'native-thread-a', hostId: 'codex-host-a', workspacePath: '/repos/a', workspaceOwner: 'user' } },
  ];
  for (const change of cases) {
    const data = structuredClone(original);
    Object.assign(data.tasks[request.taskId].executionRequests![0], change);
    writeFileSync(fixture.file, JSON.stringify(data));
    assert.throws(() => new JsonFileBoardStore(fixture.file).getTask(request.taskId), rejectsCode('STORE_ERROR'));
  }
  writeFileSync(fixture.file, raw);
  const reloaded = new JsonFileBoardStore(fixture.file).getTask(request.taskId)!;
  assert.equal(reloaded.executionRequests![0].model, 'preserved-model');
  assert.deepEqual(reloaded.executionRequests![0].receiver, { hostId: 'codex-host-a', threadId: 'receiver-thread-a' });
});

test('请求参数校验拒绝未绑定后续动作、无效标识及超长回复，不产生请求', async () => {
  const fixture = makeFixture();
  const { engine, store } = fixture;
  const task = await engine.createTask({ title: '输入校验' });
  const input = requestInput(task.id);
  const before = snapshot(fixture, task.id);
  for (const action of ['reply', 'continue', 'retry'] as const) {
    await assert.rejects(engine.requestExecution({ ...input, action, message: '完整回复' }), rejectsCode('EXECUTION_CONFLICT'));
  }
  const invalid: Partial<RequestExecutionInput>[] = [
    { requestId: '' }, { requestId: 'contains whitespace' }, { requestId: 'r'.repeat(201) },
    { hostId: 'sess-fake-host' }, { receiverThreadId: 'pending-receiver' },
    { boardId: '' }, { action: 'stop' as never }, { workspaceMode: 'temporary' as never },
    { action: 'reply', message: ' \n ' }, { message: 'x'.repeat(20_001) },
    { model: '' }, { model: '   ' }, { model: 'm'.repeat(129) }, { model: 'model name' },
    { model: '-invalid-prefix' }, { model: 'model\nname' }, { model: 'model;command' }, { model: 42 as never },
  ];
  for (const change of invalid) await assert.rejects(engine.requestExecution({ ...input, ...change }), rejectsCode('VALIDATION'));
  assert.deepEqual(snapshot(fixture, task.id), before);
  store.mutateBoard('default', (board) => ({ ...board, repo: null }));
  await assert.rejects(engine.requestExecution(input), rejectsCode('VALIDATION'));
  assert.equal(engine.getTask(task.id).executionRequests, undefined);
});
