import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BoardEngine, BoardError, GitService, JsonFileBoardStore,
  type BindExecutionInput, type ChangeSummary,
  type ExecutionRequest, type ExecutionResult, type RepoValidation, type RequestExecutionInput,
} from '../src/index.js';

const options = { timeout: 10000 };
const repo = '/repos/recovery-a';
const worktree = '/worktrees/recovery-a';
const hostId = 'recovery-host-a';
const receiverThreadId = 'recovery-receiver-a';
/** 全部等待宿主回执的状态（含 blocked）均可人工解除。 */
const awaitingStatuses = ['pending', 'delivered', 'claimed', 'created', 'bound', 'uncertain', 'blocked'] as const;

/** 所有线程与 Git 目录均为桩，不调用宿主或创建真实工作区。 */
class RecoveryGit extends GitService {
  identifyCalls = 0;
  worktreeCalls = 0;
  unavailable = false;
  beforeIdentify?: () => Promise<void>;

  constructor() { super(true); }

  override async identifyRepo(input: string): Promise<RepoValidation> {
    this.identifyCalls++;
    await this.beforeIdentify?.();
    if (this.unavailable || ![repo, worktree].includes(input)) throw new BoardError('GIT_ERROR', '模拟工作区暂不可读');
    return { root: repo, repoKey: `${repo}/.git` };
  }

  override async assertWorktreeMatches(workspacePath: string, expectedRepo: string, branch: string): Promise<void> {
    this.worktreeCalls++;
    if (expectedRepo !== repo || (workspacePath === repo ? branch !== 'main' : workspacePath !== worktree || branch !== 'codex/recovery')) {
      throw new BoardError('GIT_ERROR', '模拟工作区或分支不匹配');
    }
  }

  override async ensureTaskContext(): Promise<null> { assert.fail('解除等待不能创建 Git 上下文'); }
  override async resolveRepo(): Promise<null> { assert.fail('测试不能发现真实仓库'); }
  override async diffSummary(): Promise<ChangeSummary> {
    return { filesChanged: 0, additions: 0, deletions: 0, testStatus: 'unknown', files: [] };
  }
}

function fixture() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tl-recovery-core-')), 'board.json');
  const store = new JsonFileBoardStore(file);
  store.mutateBoard('default', (board) => ({ ...board, repo, repoKey: `${repo}/.git`, baseBranch: 'main' }));
  const git = new RecoveryGit();
  let time = Date.UTC(2026, 9, 4);
  const clock = () => new Date(time);
  const engine = new BoardEngine(store, git, clock);
  return {
    file, store, engine, git, iso: () => clock().toISOString(), advance: (ms: number) => { time += ms; },
    other: () => new BoardEngine(new JsonFileBoardStore(file), new RecoveryGit(), clock),
  };
}

type Fixture = ReturnType<typeof fixture>;
function receipt(request: ExecutionRequest) {
  return { id: request.taskId, boardId: request.boardId, requestId: request.requestId, runId: request.runId };
}
function releaseInput(request: ExecutionRequest, reason = '人工确认旧会话已结束') {
  return { ...receipt(request), reason };
}
function current(f: Fixture, request: ExecutionRequest): ExecutionRequest {
  return f.engine.getTask(request.taskId).executionRequests!.find((entry) => entry.requestId === request.requestId)!;
}
function resultFor(request: ExecutionRequest): ExecutionResult {
  return request.result ?? {
    threadId: 'recovery-target-a', hostId, workspacePath: request.workspaceMode === 'project' ? repo : worktree,
    workspaceOwner: request.workspaceMode === 'project' ? 'user' : 'codex',
    branch: request.workspaceMode === 'project' ? 'main' : 'codex/recovery',
  };
}
function bindInput(request: ExecutionRequest, claimId = 'claim-a', phase: BindExecutionInput['phase'] = 'created'): BindExecutionInput {
  return { ...receipt(request), ...resultFor(request), claimId, phase };
}
function bytes(f: Fixture) { return readFileSync(f.file, 'utf8'); }
function code(expected: BoardError['code']) { return (error: unknown) => error instanceof BoardError && error.code === expected; }
async function noWrite(f: Fixture, operation: () => Promise<unknown>, expected?: BoardError['code']) {
  const before = bytes(f);
  await assert.rejects(operation(), expected ? code(expected) : (error: unknown) => error instanceof BoardError);
  assert.equal(bytes(f), before);
}
async function awaiting(f: Fixture, status: (typeof awaitingStatuses)[number] = 'pending', overrides: Partial<RequestExecutionInput> = {}) {
  const task = await f.engine.createTask({ title: '人工解除测试', description: '保留完整描述', status: 'ready', priority: 'P1' });
  const input: RequestExecutionInput = {
    id: task.id, boardId: 'default', requestId: 'request-a', action: 'start', workspaceMode: 'project', hostId, receiverThreadId, ...overrides,
  };
  let { request } = await f.engine.requestExecution(input);
  if (status === 'delivered' || status === 'uncertain') {
    ({ request } = await f.engine.markExecutionDelivery({ ...receipt(request), status, ...(status === 'uncertain' ? { error: '投递结果未知' } : {}) }));
  }
  if (status === 'claimed' || status === 'created' || status === 'bound') {
    ({ request } = await f.engine.claimExecution({ ...receipt(request), claimId: 'claim-a', hostId, receiverThreadId }));
  }
  if (status === 'created' || status === 'bound') ({ request } = await f.engine.bindExecution(bindInput(request)));
  if (status === 'bound') ({ request } = await f.engine.bindExecution(bindInput(request, 'claim-a', 'bound')));
  if (status === 'blocked') {
    ({ request } = await f.engine.claimExecution({ ...receipt(request), claimId: 'claim-a', hostId, receiverThreadId }));
    ({ request } = await f.engine.markExecutionDelivery({ ...receipt(request), status: 'blocked', error: '宿主阻塞原因', claimId: 'claim-a' }));
  }
  assert.equal(request.status, status);
  return { input, request };
}

test('人工解除：七种等待态均可解除，取消请求并复位执行，完整留档不触发 Git', options, async (t) => {
  for (const status of awaitingStatuses) await t.test(status, async () => {
    const f = fixture();
    const { request } = await awaiting(f, status);
    if (status === 'bound') f.store.mutateTask(request.taskId, (task) => {
      // 遗留审计记录不得因解除等待被清空。
      task.execution.startedAt = request.requestedAt;
      task.executionRequests![0].reports = [{ reportId: 'legacy-audit', state: 'waiting', activity: '旧审计摘要' }];
      return task;
    });
    const before = f.engine.getTask(request.taskId);
    const original = current(f, request);
    const gitCalls = f.git.identifyCalls;
    const input = releaseInput(request);
    const released = await f.engine.releaseExecution(input);
    assert.equal(released.changed, true);
    assert.equal(released.request.status, 'cancelled');
    assert.deepEqual(released.request.recovery, { at: released.request.updatedAt, reason: input.reason, confirmedStopped: true, releasedBy: 'user' });
    for (const key of ['claimId', 'receiver', 'result', 'reports', 'model', 'requestedAt'] as const) assert.deepEqual(released.request[key], original[key], key);
    for (const key of ['title', 'description', 'priority', 'status', 'assignee', 'repo', 'branch', 'worktreePath', 'executionBinding'] as const) assert.deepEqual(released.task[key], before[key], key);
    assert.equal(released.task.execution.runId, request.runId);
    assert.equal(released.task.execution.state, 'assigned');
    assert.equal(released.task.execution.startedAt, undefined);
    assert.equal(f.git.identifyCalls, gitCalls);
    assert.equal(f.store.getSession(request.taskId)!.events.at(-1)?.kind, 'execution_recovered');
    assert.deepEqual(new JsonFileBoardStore(f.file).getTask(request.taskId), released.task);
  });
});

test('人工解除守卫：错板/请求/run、归档拒绝，非等待态与非法原因零写入', options, async (t) => {
  const f = fixture();
  const { request } = await awaiting(f);
  for (const [patch, error] of [
    [{ boardId: 'another-board' }, 'BOARD_MISMATCH'], [{ requestId: 'missing-request' }, 'EXECUTION_STALE'], [{ runId: 'run-other' }, 'EXECUTION_STALE'],
  ] as const) await noWrite(f, () => f.engine.releaseExecution({ ...releaseInput(request), ...patch }), error);
  for (const reason of ['', ' ', 'x'.repeat(201)]) await noWrite(f, () => f.engine.releaseExecution({ ...releaseInput(request), reason }), 'VALIDATION');
  for (const status of ['doing', 'review', 'done'] as const) await f.engine.moveTask(request.taskId, status);
  await f.engine.archiveTask(request.taskId);
  await noWrite(f, () => f.engine.releaseExecution(releaseInput(request)), 'TASK_ARCHIVED');
  for (const status of ['running', 'waiting', 'completed', 'failed', 'rejected'] as const) await t.test(status, async () => {
    const f = fixture();
    const { request } = await awaiting(f, status === 'rejected' ? 'pending' : 'bound');
    if (status === 'rejected') await f.engine.markExecutionDelivery({ ...receipt(request), status, error: '明确拒绝' });
    else {
      const report = { ...receipt(request), ...resultFor(request) };
      await f.engine.reportExecution({ ...report, reportId: 'running-a', state: 'running' });
      if (status !== 'running') await f.engine.reportExecution({ ...report, reportId: `report-${status}`, state: status });
    }
    await noWrite(f, () => f.engine.releaseExecution(releaseInput(request)), 'EXECUTION_CONFLICT');
    assert.equal(current(f, request).status, status);
  });
});

test('解除幂等：重复解除零写入，两实例并发只一方生效，原请求重放不重启', options, async () => {
  const f = fixture();
  const { input, request } = await awaiting(f);
  const released = await Promise.all([f.engine.releaseExecution(releaseInput(request)), f.other().releaseExecution(releaseInput(request))]);
  assert.equal(released.filter((entry) => entry.changed).length, 1);
  assert.deepEqual(released[0].request, released[1].request);
  const before = bytes(f);
  assert.equal((await f.other().releaseExecution(releaseInput(request))).changed, false);
  assert.equal(bytes(f), before);
  const replay = await f.engine.requestExecution(input);
  assert.equal(replay.created, false);
  assert.equal(replay.request.status, 'cancelled');
  assert.equal(bytes(f), before);
  assert.equal(f.store.getSession(request.taskId)!.events.filter((event) => event.kind === 'execution_recovered').length, 1);
  const next = await f.engine.requestExecution({ ...input, requestId: 'request-new' });
  assert.equal(next.request.status, 'pending');
  assert.notEqual(next.request.runId, request.runId);
  assert.equal(next.request.result, undefined);
  assert.equal(next.request.recoveryOf, undefined);
  await noWrite(f, () => f.engine.releaseExecution(releaseInput(request)), 'EXECUTION_STALE');
});

test('解除后旧 claim/bind/report/delivery 在新 run 前后均 stale，不能污染取消记录', options, async (t) => {
  for (const status of ['pending', 'bound'] as const) await t.test(status, async () => {
    const f = fixture();
    const { input, request } = await awaiting(f, status);
    await f.engine.releaseExecution(releaseInput(request));
    const operations = [
      () => f.engine.claimExecution({ ...receipt(request), claimId: 'claim-a' }),
      () => f.engine.bindExecution(bindInput(request)), () => f.engine.bindExecution(bindInput(request, 'claim-a', 'bound')),
      ...(['delivered', 'uncertain', 'rejected'] as const).map((deliveryStatus) => () => f.engine.markExecutionDelivery({ ...receipt(request), status: deliveryStatus, error: '迟到结果', ...(deliveryStatus === 'rejected' ? { claimId: 'claim-a' } : {}) })),
      ...(['running', 'waiting', 'failed', 'completed'] as const).map((state) => () => f.engine.reportExecution({ ...receipt(request), hostId, threadId: resultFor(request).threadId, reportId: `late-${state}`, state })),
    ];
    for (const turn of [0, 1]) {
      if (turn === 1) await f.engine.requestExecution({ ...input, requestId: 'request-next', action: status === 'bound' ? 'continue' : 'start' });
      for (const operation of operations) await noWrite(f, operation, 'EXECUTION_STALE');
    }
  });
});

test('解除 created：锁定 start/模式/模型，服务端继承结果，认领匹配 result host，禁止替换线程并重新核验 Git', options, async (t) => {
  for (const workspaceMode of ['project', 'worktree'] as const) await t.test(workspaceMode, async () => {
    const f = fixture();
    const { input, request } = await awaiting(f, 'created', { workspaceMode, model: 'provider/recovery-model', hostId: undefined, receiverThreadId: undefined });
    await f.engine.releaseExecution(releaseInput(request));
    const nextInput = { ...input, requestId: 'request-next' };
    for (const patch of [
      { model: undefined }, { model: 'different-model' }, { workspaceMode: workspaceMode === 'project' ? 'worktree' as const : 'project' as const },
      { action: 'continue' as const, model: undefined },
    ]) await noWrite(f, () => f.engine.requestExecution({ ...nextInput, ...patch }), 'EXECUTION_CONFLICT');
    const inherited = await f.engine.requestExecution(nextInput);
    assert.equal(inherited.request.status, 'pending');
    assert.notEqual(inherited.request.runId, request.runId);
    assert.deepEqual(inherited.request.result, request.result);
    assert.deepEqual(inherited.request.recoveryOf, { requestId: request.requestId, runId: request.runId });
    for (const key of ['claimId', 'receiver', 'reports', 'recovery'] as const) assert.equal(inherited.request[key], undefined, key);
    assert.equal(inherited.task.executionBinding, undefined);
    assert.equal(f.git.identifyCalls, 0);
    await noWrite(f, () => f.engine.claimExecution({ ...receipt(inherited.request), claimId: 'claim-next', hostId: 'wrong-host', receiverThreadId: 'next-receiver' }), 'EXECUTION_CONFLICT');
    const claimed = await f.engine.claimExecution({ ...receipt(inherited.request), claimId: 'claim-next', hostId, receiverThreadId: 'next-receiver' });
    const original = bindInput(claimed.request, 'claim-next');
    for (const phase of ['created', 'bound'] as const) await noWrite(f, () => f.engine.bindExecution({ ...original, phase, threadId: 'replacement-thread' }), 'EXECUTION_CONFLICT');
    await f.engine.bindExecution(original);
    const bound = await f.engine.bindExecution({ ...original, phase: 'bound' });
    assert.equal(bound.request.status, 'bound');
    assert.equal(f.git.identifyCalls, 2);
    assert.equal(f.git.worktreeCalls, 1);
    assert.equal(bound.task.executionBinding?.threadId, request.result!.threadId);
    assert.equal(bound.task.execution.startedAt, undefined);
    assert.deepEqual(new JsonFileBoardStore(f.file).getTask(request.taskId), bound.task);
  });
});

test('解除后 Git 失败保留结果，再次解除继承最近取消轮次，不丢原线程/默认模型', options, async () => {
  const f = fixture();
  const { input, request } = await awaiting(f, 'created');
  await f.engine.releaseExecution(releaseInput(request));
  const second = await f.engine.requestExecution({ ...input, requestId: 'request-second' });
  await f.engine.claimExecution({ ...receipt(second.request), claimId: 'claim-second' });
  f.git.unavailable = true;
  await noWrite(f, () => f.engine.bindExecution(bindInput(second.request, 'claim-second', 'bound')), 'GIT_ERROR');
  assert.deepEqual(current(f, second.request).result, request.result);
  assert.equal(f.engine.getTask(request.taskId).executionBinding, undefined);
  await f.engine.releaseExecution(releaseInput(second.request));
  await noWrite(f, () => f.engine.requestExecution({ ...input, requestId: 'changed-model', model: 'new-model' }), 'EXECUTION_CONFLICT');
  const third = await f.engine.requestExecution({ ...input, requestId: 'request-third' });
  assert.deepEqual(third.request.result, request.result);
  assert.deepEqual(third.request.recoveryOf, { requestId: second.request.requestId, runId: second.request.runId });
  assert.equal(third.request.model, undefined);
  assert.notEqual(third.request.runId, second.request.runId);
  await f.engine.claimExecution({ ...receipt(third.request), claimId: 'claim-third' });
  f.git.unavailable = false;
  const bound = await f.engine.bindExecution(bindInput(third.request, 'claim-third', 'bound'));
  assert.equal(bound.task.executionBinding?.threadId, request.result!.threadId);
  assert.equal(current(f, request).status, 'cancelled');
  assert.equal(current(f, second.request).status, 'cancelled');
  assert.deepEqual(new JsonFileBoardStore(f.file).getTask(request.taskId), bound.task);
});

test('解除 bound：不覆盖并发 metadata/指派/阶段，续接保留原 binding/工作区字段', options, async () => {
  const f = fixture();
  const { input, request } = await awaiting(f, 'bound', { workspaceMode: 'worktree', model: 'preserved-model' });
  const binding = f.engine.getTask(request.taskId).executionBinding;
  const other = f.other();
  f.advance(1000);
  await other.updateTask({ id: request.taskId, title: '并发最新标题', description: '并发完整描述', priority: 'P0' });
  await other.assignTask(request.taskId, 'human');
  await other.moveTask(request.taskId, 'doing');
  assert.equal(current(f, request).updatedAt, request.updatedAt);
  const released = await f.engine.releaseExecution(releaseInput(request));
  assert.equal(released.task.title, '并发最新标题');
  assert.equal(released.task.description, '并发完整描述');
  assert.equal(released.task.priority, 'P0');
  assert.equal(released.task.status, 'doing');
  assert.equal(released.task.assignee, 'human');
  assert.equal(released.task.execution.state, 'idle');
  assert.deepEqual(released.task.executionBinding, binding);
  assert.equal(released.task.worktreePath, worktree);
  assert.equal(released.task.branch, 'codex/recovery');
  const next = await f.engine.requestExecution({ ...input, requestId: 'continue-next', action: 'continue', model: undefined });
  assert.deepEqual(next.task.executionBinding, binding);
  assert.equal(next.task.worktreePath, released.task.worktreePath);
  assert.equal(next.task.branch, released.task.branch);
  await f.engine.claimExecution({ ...receipt(next.request), claimId: 'claim-next' });
  await f.engine.bindExecution(bindInput(next.request, 'claim-next'));
  const bound = await f.engine.bindExecution(bindInput(next.request, 'claim-next', 'bound'));
  assert.deepEqual(bound.task.executionBinding, binding);
  assert.equal(current(f, request).model, 'preserved-model');
});

test('解除与异步 bind 竞争：旧绑定锁内 stale，保留结果及另一实例编辑', options, async () => {
  const f = fixture();
  const { request } = await awaiting(f, 'created');
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const resumed = new Promise<void>((resolve) => { release = resolve; });
  f.git.beforeIdentify = async () => { f.git.beforeIdentify = undefined; enter(); await resumed; };
  const pendingBind = f.engine.bindExecution(bindInput(request, 'claim-a', 'bound'));
  const rejected = assert.rejects(pendingBind, code('EXECUTION_STALE'));
  await entered;
  try {
    const other = f.other();
    await other.updateTask({ id: request.taskId, title: '核验间隙的新标题', description: '不能被旧快照覆盖', priority: 'P0' });
    await other.assignTask(request.taskId, 'human');
    await other.releaseExecution(releaseInput(request));
  } finally { release(); }
  await rejected;
  const latest = f.engine.getTask(request.taskId);
  assert.equal(latest.title, '核验间隙的新标题');
  assert.equal(latest.description, '不能被旧快照覆盖');
  assert.equal(latest.priority, 'P0');
  assert.equal(latest.assignee, 'human');
  assert.equal(latest.execution.state, 'idle');
  assert.equal(latest.executionBinding, undefined);
  assert.equal(current(f, request).status, 'cancelled');
  assert.deepEqual(current(f, request).result, request.result);
  assert.deepEqual(new JsonFileBoardStore(f.file).getTask(request.taskId), latest);
});

test('无项目执行请求解除后复位为 projectless 初始态，等待重新发起', options, async () => {
  // 独立夹具：default 看板保持未绑定仓库，才允许 projectless 执行
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tl-recovery-core-')), 'board.json');
  const engine = new BoardEngine(new JsonFileBoardStore(file), new RecoveryGit());
  const task = await engine.createTask({ title: '无项目解除', status: 'ready' });
  const { request } = await engine.requestExecution({
    id: task.id, boardId: 'default', requestId: 'request-pl', action: 'start', workspaceMode: 'projectless',
  });
  const released = await engine.releaseExecution(releaseInput(request));
  assert.equal(released.request.status, 'cancelled');
  assert.equal(released.task.execution.state, 'assigned');
  const next = await engine.requestExecution({
    id: task.id, boardId: 'default', requestId: 'request-pl-next', action: 'start', workspaceMode: 'projectless',
  });
  assert.equal(next.request.status, 'pending');
  assert.equal(next.request.result, undefined);
});
