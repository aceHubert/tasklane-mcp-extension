import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BoardEngine, BoardError, GitService, JsonFileBoardStore,
  type BindExecutionInput, type ChangeSummary, type ExecutionRecoveryInput,
  type ExecutionRequest, type ExecutionResult, type RepoValidation, type RequestExecutionInput,
} from '../src/index.js';

const options = { timeout: 10000 };
const repo = '/repos/recovery-a';
const worktree = '/worktrees/recovery-a';
const hostId = 'recovery-host-a';
const receiverThreadId = 'recovery-receiver-a';
const awaitingStatuses = ['pending', 'delivered', 'claimed', 'created', 'bound', 'uncertain'] as const;

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

  override async ensureTaskContext(): Promise<null> { assert.fail('恢复不能创建 Git 上下文'); }
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
async function check(f: Fixture, request: ExecutionRequest, checkId = 'check-a') {
  return f.engine.requestExecutionRecovery({ ...receipt(request), checkId });
}
function reportInput(f: Fixture, request: ExecutionRequest, patch: Partial<ExecutionRecoveryInput> = {}): ExecutionRecoveryInput {
  const saved = current(f, request);
  const receiver = saved.receiver ?? { threadId: receiverThreadId, hostId };
  const binding = f.engine.getTask(request.taskId).executionBinding;
  const threads = [receiver, saved.result, binding].filter((value): value is { threadId: string; hostId: string } => value !== undefined);
  const unique = threads.filter((thread, index) => threads.findIndex((other) => other.threadId === thread.threadId && other.hostId === thread.hostId) === index);
  return {
    ...receipt(request), checkId: saved.recoveryCheck?.checkId ?? 'check-a', checkerThreadId: receiverThreadId, hostId,
    outcome: 'stopped', confirmedStopped: true, message: '核对全部关联聊天，旧操作已结束',
    observations: unique.map((thread) => ({ ...thread, state: 'idle', observedAt: f.iso() })), ...patch,
  };
}
async function recover(f: Fixture, request: ExecutionRequest) {
  await check(f, request);
  return f.engine.recoverExecution(reportInput(f, request));
}
function bytes(f: Fixture) { return readFileSync(f.file, 'utf8'); }
function code(expected: BoardError['code']) { return (error: unknown) => error instanceof BoardError && error.code === expected; }
async function noWrite(f: Fixture, operation: () => Promise<unknown>, expected?: BoardError['code']) {
  const before = bytes(f);
  await assert.rejects(operation(), expected ? code(expected) : (error: unknown) => error instanceof BoardError);
  assert.equal(bytes(f), before);
}
function withoutCheck(request: ExecutionRequest) {
  const { recoveryCheck, ...rest } = request;
  return rest;
}
async function awaiting(f: Fixture, status: (typeof awaitingStatuses)[number] = 'pending', overrides: Partial<RequestExecutionInput> = {}) {
  const task = await f.engine.createTask({ title: '人工恢复测试', description: '保留完整描述', status: 'ready', priority: 'P1' });
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
  assert.equal(request.status, status);
  return { input, request };
}

test('恢复核对：六种等待态只记录检查，停止证据通过后取消且完整留档，不伪记 stopped', options, async (t) => {
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
    const checked = await check(f, request);
    assert.equal(checked.created, true);
    assert.deepEqual(checked.request.recoveryCheck, {
      checkId: 'check-a', status: 'pending', requestedAt: f.iso(), observedStatus: original.status, observedUpdatedAt: original.updatedAt,
    });
    assert.deepEqual(withoutCheck(checked.request), withoutCheck(original));
    assert.deepEqual(checked.task.execution, before.execution);
    assert.deepEqual(checked.task.executionBinding, before.executionBinding);
    const eventCount = f.store.getSession(request.taskId)!.events.length;
    const input = reportInput(f, request);
    const recovered = await f.engine.recoverExecution(input);
    assert.equal(recovered.changed, true);
    assert.equal(recovered.request.status, 'cancelled');
    assert.deepEqual(recovered.request.recovery, { at: recovered.request.updatedAt, reason: input.message, confirmedStopped: true, checkId: input.checkId });
    assert.equal(recovered.request.recoveryCheck?.status, 'recovered');
    assert.deepEqual(recovered.request.recoveryCheck?.checker, { threadId: input.checkerThreadId, hostId });
    assert.deepEqual(recovered.request.recoveryCheck?.observations, input.observations);
    for (const key of ['claimId', 'receiver', 'result', 'reports', 'model', 'requestedAt'] as const) assert.deepEqual(recovered.request[key], original[key], key);
    for (const key of ['title', 'description', 'priority', 'status', 'assignee', 'repo', 'branch', 'worktreePath', 'executionBinding'] as const) assert.deepEqual(recovered.task[key], before[key], key);
    assert.equal(recovered.task.execution.runId, request.runId);
    assert.equal(recovered.task.execution.state, 'assigned');
    assert.equal(recovered.task.execution.startedAt, undefined);
    assert.equal(f.git.identifyCalls, gitCalls);
    assert.deepEqual(f.store.getSession(request.taskId)!.events.slice(eventCount).map((event) => event.kind), ['execution_recovered']);
    assert.deepEqual(new JsonFileBoardStore(f.file).getTask(request.taskId), recovered.task);
  });
});

test('恢复核对：60 秒内 pending 复用，超过 60 秒新检查覆盖旧检查并使旧报告 stale', options, async () => {
  const f = fixture();
  const { request } = await awaiting(f);
  const first = await check(f, request);
  const oldReport = reportInput(f, request);
  f.advance(59000);
  const before = bytes(f);
  const merged = await check(f, request, 'check-second');
  assert.equal(merged.created, false);
  assert.deepEqual(merged.request.recoveryCheck, first.request.recoveryCheck);
  assert.equal(bytes(f), before);
  f.advance(2000);
  const next = await check(f, request, 'check-second');
  assert.equal(next.created, true);
  assert.equal(next.request.recoveryCheck?.checkId, 'check-second');
  assert.equal(next.request.recoveryCheck?.requestedAt, f.iso());
  assert.deepEqual(withoutCheck(next.request), withoutCheck(request));
  await noWrite(f, () => f.engine.recoverExecution({ ...oldReport, observations: oldReport.observations.map((entry) => ({ ...entry, observedAt: f.iso() })) }), 'EXECUTION_STALE');
  assert.equal((await f.engine.recoverExecution(reportInput(f, request))).changed, true);
});

test('恢复核对：busy/unknown/resumed 只审计，不解除等待，不改变请求时间、认领、执行或结果', options, async (t) => {
  for (const outcome of ['busy', 'unknown', 'resumed'] as const) await t.test(outcome, async () => {
    const f = fixture();
    const { request } = await awaiting(f, 'created');
    await check(f, request);
    const before = f.engine.getTask(request.taskId);
    const input = reportInput(f, request, { outcome, confirmedStopped: undefined, message: `核对结果 ${outcome}` });
    const reported = await f.engine.recoverExecution(input);
    assert.equal(reported.changed, false);
    assert.deepEqual(withoutCheck(reported.request), withoutCheck(before.executionRequests![0]));
    assert.deepEqual(reported.task.execution, before.execution);
    assert.deepEqual(reported.task.executionBinding, before.executionBinding);
    assert.equal(reported.request.recoveryCheck?.status, outcome);
    assert.equal(reported.request.recoveryCheck?.checkedAt, f.iso());
    assert.equal(reported.request.recoveryCheck?.message, input.message);
    assert.deepEqual(reported.request.recoveryCheck?.checker, { threadId: receiverThreadId, hostId });
    assert.deepEqual(reported.request.recoveryCheck?.observations, input.observations);
    assert.equal(reported.request.recovery, undefined);
    const next = await check(f, request, 'check-next');
    assert.equal(next.created, true);
    assert.equal(next.request.recoveryCheck?.status, 'pending');
  });
});

test('恢复核对：确认 alone 无效，缺失/错误线程与不新鲜观测、超时检查、非法消息均零写入', options, async () => {
  const f = fixture();
  const { request } = await awaiting(f, 'created');
  await noWrite(f, () => f.engine.recoverExecution(reportInput(f, request)), 'EXECUTION_STALE');
  await check(f, request);
  const input = reportInput(f, request);
  for (const patch of [
    { confirmedStopped: false as never }, { confirmedStopped: undefined },
    { message: '' }, { message: ' ' }, { message: 'x'.repeat(201) },
    { observations: [] }, { observations: input.observations.slice(0, 1) }, { observations: input.observations.slice(1) },
    { observations: input.observations.map((entry) => ({ ...entry, hostId: 'wrong-host' })) },
    { observations: input.observations.map((entry) => ({ ...entry, observedAt: 'not-an-iso-date' })) },
  ]) await noWrite(f, () => f.engine.recoverExecution({ ...input, ...patch }));
  f.advance(121000);
  await noWrite(f, () => f.engine.recoverExecution(input));
  f.advance(180000);
  await noWrite(f, () => f.engine.recoverExecution(reportInput(f, request)));
});

test('恢复核对：非 checker active/waiting/unknown 拒绝，checker active 必须确认 priorOperationEnded', options, async (t) => {
  for (const state of ['active', 'waiting', 'unknown'] as const) await t.test(state, async () => {
    const f = fixture();
    const { request } = await awaiting(f, 'created');
    await check(f, request);
    const input = reportInput(f, request);
    await noWrite(f, () => f.engine.recoverExecution({ ...input, observations: input.observations.map((entry) => entry.threadId === request.result!.threadId ? { ...entry, state, priorOperationEnded: true } : entry) }));
    await noWrite(f, () => f.engine.recoverExecution({ ...input, observations: input.observations.map((entry) => entry.threadId === receiverThreadId ? { ...entry, state } : entry) }));
  });
  const f = fixture();
  const { request } = await awaiting(f, 'created');
  await check(f, request);
  const input = reportInput(f, request);
  const observations = input.observations.map((entry) => entry.threadId === receiverThreadId ? { ...entry, state: 'active' as const, priorOperationEnded: true } : entry);
  assert.equal((await f.engine.recoverExecution({ ...input, observations })).changed, true);
});

test('恢复核对：未记录 receiver 时观测 checker，存在 binding 时仍须观测目标聊天', options, async () => {
  const f = fixture();
  const { request } = await awaiting(f, 'pending', { hostId: undefined, receiverThreadId: undefined });
  await check(f, request);
  const input = reportInput(f, request, { checkerThreadId: 'actual-checker' });
  await noWrite(f, () => f.engine.recoverExecution(input));
  const recovered = await f.engine.recoverExecution({ ...input, observations: [{ threadId: 'actual-checker', hostId, state: 'idle', observedAt: f.iso() }] });
  assert.equal(recovered.changed, true);
  const boundFixture = fixture();
  const { input: start, request: boundRequest } = await awaiting(boundFixture, 'bound');
  await recover(boundFixture, boundRequest);
  const next = await boundFixture.engine.requestExecution({ ...start, requestId: 'continue-next', action: 'continue' });
  assert.equal(next.request.result, undefined);
  await check(boundFixture, next.request);
  const bindingReport = reportInput(boundFixture, next.request);
  await noWrite(boundFixture, () => boundFixture.engine.recoverExecution({ ...bindingReport, observations: bindingReport.observations.filter((entry) => entry.threadId !== boundRequest.result!.threadId) }));
  assert.equal((await boundFixture.engine.recoverExecution(bindingReport)).changed, true);
});

test('恢复 CAS：状态推进与同状态 updatedAt 变化拒绝旧检查，metadata 修改不参与 request CAS', options, async (t) => {  for (const race of ['status', 'updatedAt'] as const) await t.test(race, async () => {
    const f = fixture();
    const { request } = await awaiting(f, race === 'status' ? 'pending' : 'uncertain');
    await check(f, request);
    f.advance(1000);
    const other = f.other();
    if (race === 'status') await other.claimExecution({ ...receipt(request), claimId: 'concurrent-claim' });
    else await other.markExecutionDelivery({ ...receipt(request), status: 'uncertain', error: '新投递未知摘要' });
    await noWrite(f, () => f.engine.recoverExecution(reportInput(f, request)), 'EXECUTION_CONFLICT');
    assert.equal(current(f, request).recoveryCheck?.status, 'pending');
    f.advance(61000);
    await check(f, request, 'check-current');
    assert.equal((await f.engine.recoverExecution(reportInput(f, request))).changed, true);
  });
});

test('恢复核对：错板/请求/run/归档守卫；running/waiting/terminal 无法恢复', options, async (t) => {
  const f = fixture();
  const { request } = await awaiting(f);
  await check(f, request);
  for (const [patch, error] of [
    [{ boardId: 'another-board' }, 'BOARD_MISMATCH'], [{ requestId: 'missing-request' }, 'EXECUTION_STALE'], [{ runId: 'run-other' }, 'EXECUTION_STALE'],
  ] as const) {
    await noWrite(f, () => f.engine.requestExecutionRecovery({ ...receipt(request), checkId: 'check-other', ...patch }), error);
    await noWrite(f, () => f.engine.recoverExecution({ ...reportInput(f, request), ...patch }), error);
  }
  for (const status of ['doing', 'review', 'done'] as const) await f.engine.moveTask(request.taskId, status);
  await f.engine.archiveTask(request.taskId);
  await noWrite(f, () => check(f, request), 'TASK_ARCHIVED');
  await noWrite(f, () => f.engine.recoverExecution(reportInput(f, request)), 'TASK_ARCHIVED');
  for (const status of ['running', 'waiting', 'completed', 'failed', 'rejected'] as const) await t.test(status, async () => {
    const f = fixture();
    const { request } = await awaiting(f, status === 'rejected' ? 'pending' : 'bound');
    await check(f, request);
    if (status === 'rejected') await f.engine.markExecutionDelivery({ ...receipt(request), status, error: '明确拒绝' });
    else {
      const report = { ...receipt(request), ...resultFor(request) };
      await f.engine.reportExecution({ ...report, reportId: 'running-a', state: 'running' });
      if (status !== 'running') await f.engine.reportExecution({ ...report, reportId: `report-${status}`, state: status });
    }
    await noWrite(f, () => check(f, request, 'terminal-check'));
    await noWrite(f, () => f.engine.recoverExecution(reportInput(f, request)), 'EXECUTION_CONFLICT');
    assert.equal(current(f, request).status, status);
  });
});

test('恢复幂等：同 cancelled run exact 报告只写一次，改变报告拒绝，旧 request 重放不重启，新请求新 run', options, async () => {
  const f = fixture();
  const { input, request } = await awaiting(f);
  await check(f, request);
  const report = reportInput(f, request);
  const recovered = await Promise.all([f.engine.recoverExecution(report), f.other().recoverExecution(report)]);
  assert.equal(recovered.filter((entry) => entry.changed).length, 1);
  assert.deepEqual(recovered[0].request, recovered[1].request);
  const before = bytes(f);
  assert.equal((await f.other().recoverExecution(report)).changed, false);
  const replay = await f.engine.requestExecution(input);
  assert.equal(replay.created, false);
  assert.equal(replay.request.status, 'cancelled');
  assert.equal(bytes(f), before);
  for (const patch of [
    { message: '不同证据' }, { checkerThreadId: 'other-checker' }, { outcome: 'unknown' as const },
    { observations: report.observations.map((entry) => ({ ...entry, state: 'active' as const, priorOperationEnded: true })) },
  ]) await noWrite(f, () => f.engine.recoverExecution({ ...report, ...patch }));
  assert.equal(f.store.getSession(request.taskId)!.events.filter((event) => event.kind === 'execution_recovered').length, 1);
  const next = await f.engine.requestExecution({ ...input, requestId: 'request-new' });
  assert.equal(next.request.status, 'pending');
  assert.notEqual(next.request.runId, request.runId);
  assert.equal(next.request.result, undefined);
  assert.equal(next.request.recoveryOf, undefined);
  assert.equal(next.task.execution.startedAt, undefined);
  await noWrite(f, () => f.engine.recoverExecution(report), 'EXECUTION_STALE');
});

test('恢复后旧 claim/bind/report/delivery 在新 run 前后均 stale，不能污染取消记录', options, async (t) => {
  for (const status of ['pending', 'bound'] as const) await t.test(status, async () => {
    const f = fixture();
    const { input, request } = await awaiting(f, status);
    await recover(f, request);
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

test('恢复 created：锁定 start/模式/模型，服务端继承结果，认领匹配 result host，禁止替换线程并重新核验 Git', options, async (t) => {
  for (const workspaceMode of ['project', 'worktree'] as const) await t.test(workspaceMode, async () => {
    const f = fixture();
    const { input, request } = await awaiting(f, 'created', { workspaceMode, model: 'provider/recovery-model', hostId: undefined, receiverThreadId: undefined });
    await recover(f, request);
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
    for (const key of ['claimId', 'receiver', 'reports', 'recovery', 'recoveryCheck'] as const) assert.equal(inherited.request[key], undefined, key);
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

test('恢复后 Git 失败保留结果，再次核对恢复继承最近取消轮次，不丢原线程/默认模型', options, async () => {
  const f = fixture();
  const { input, request } = await awaiting(f, 'created');
  await recover(f, request);
  const second = await f.engine.requestExecution({ ...input, requestId: 'request-second' });
  await f.engine.claimExecution({ ...receipt(second.request), claimId: 'claim-second' });
  f.git.unavailable = true;
  await noWrite(f, () => f.engine.bindExecution(bindInput(second.request, 'claim-second', 'bound')), 'GIT_ERROR');
  assert.deepEqual(current(f, second.request).result, request.result);
  assert.equal(f.engine.getTask(request.taskId).executionBinding, undefined);
  await recover(f, second.request);
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

test('恢复 bound：request CAS 不覆盖并发 metadata/指派/阶段，续接保留原 binding/工作区字段', options, async () => {
  const f = fixture();
  const { input, request } = await awaiting(f, 'bound', { workspaceMode: 'worktree', model: 'preserved-model' });
  await check(f, request);
  const binding = f.engine.getTask(request.taskId).executionBinding;
  const other = f.other();
  f.advance(1000);
  await other.updateTask({ id: request.taskId, title: '并发最新标题', description: '并发完整描述', priority: 'P0' });
  await other.assignTask(request.taskId, 'human');
  await other.moveTask(request.taskId, 'doing');
  assert.equal(current(f, request).updatedAt, request.updatedAt);
  const recovered = await f.engine.recoverExecution(reportInput(f, request));
  assert.equal(recovered.task.title, '并发最新标题');
  assert.equal(recovered.task.description, '并发完整描述');
  assert.equal(recovered.task.priority, 'P0');
  assert.equal(recovered.task.status, 'doing');
  assert.equal(recovered.task.assignee, 'human');
  assert.equal(recovered.task.execution.state, 'idle');
  assert.deepEqual(recovered.task.executionBinding, binding);
  assert.equal(recovered.task.worktreePath, worktree);
  assert.equal(recovered.task.branch, 'codex/recovery');
  const next = await f.engine.requestExecution({ ...input, requestId: 'continue-next', action: 'continue', model: undefined });
  assert.deepEqual(next.task.executionBinding, binding);
  assert.equal(next.task.worktreePath, recovered.task.worktreePath);
  assert.equal(next.task.branch, recovered.task.branch);
  await f.engine.claimExecution({ ...receipt(next.request), claimId: 'claim-next' });
  await f.engine.bindExecution(bindInput(next.request, 'claim-next'));
  const bound = await f.engine.bindExecution(bindInput(next.request, 'claim-next', 'bound'));
  assert.deepEqual(bound.task.executionBinding, binding);
  assert.equal(current(f, request).model, 'preserved-model');
});

test('恢复与异步 bind 竞争：旧绑定锁内 stale，保留结果及另一实例编辑', options, async () => {
  const f = fixture();
  const { request } = await awaiting(f, 'created');
  await check(f, request);
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
    await other.recoverExecution(reportInput(f, request));
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

test('执行状态变更清除已出结果的核对消息：真实回执到达后 recoveryCheck 移除，pending 检查不受影响', options, async () => {
  const f = fixture();
  const { request } = await awaiting(f, 'bound');
  await check(f, request);
  const input = reportInput(f, request, { outcome: 'unknown', confirmedStopped: undefined, message: '无法确认宿主状态，保留等待' });
  const checked = await f.engine.recoverExecution(input);
  assert.equal(checked.request.recoveryCheck?.status, 'unknown');
  assert.equal(checked.request.recoveryCheck?.message, input.message);
  // 本轮真实执行回执到达（bound → running → completed）：过期核对消息随状态变更清除
  const report = { ...receipt(request), ...resultFor(request) };
  const running = await f.engine.reportExecution({ ...report, reportId: 'report-running', state: 'running' });
  assert.equal(running.request.recoveryCheck, undefined);
  const completed = await f.engine.reportExecution({ ...report, reportId: 'report-completed', state: 'completed' });
  assert.equal(completed.request.recoveryCheck, undefined);
  assert.equal(completed.request.status, 'completed');
  assert.equal(completed.task.execution.state, 'completed');
  // 存储重载一致：加载规范化不再回填已清除的核对消息
  assert.deepEqual(new JsonFileBoardStore(f.file).getTask(request.taskId), completed.task);
});
