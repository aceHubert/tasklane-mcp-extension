import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BoardEngine, BoardError, GitService, JsonFileBoardStore,
  type ChangeSummary, type ExecutionRecoveryInput, type ExecutionRequest,
  type ExecutionRequestStatus, type ExecutionResult, type RepoValidation,
} from '../src/index.js';

const options = { timeout: 10000 };
const repo = '/repos/status-check';
const hostId = 'status-check-host';
const receiverThreadId = 'status-check-receiver';
const executionResult: ExecutionResult = {
  threadId: 'status-check-target', hostId, workspacePath: repo, workspaceOwner: 'user', branch: 'main',
};

/** 用模拟工作区验证状态契约，禁止创建或读写真实 Git 工作区。 */
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
  override async ensureTaskContext(): Promise<null> { assert.fail('状态核对不能创建工作区'); }
  override async resolveRepo(): Promise<null> { assert.fail('状态核对不能发现真实仓库'); }
  override async diffSummary(): Promise<ChangeSummary> {
    return { filesChanged: 0, additions: 0, deletions: 0, testStatus: 'unknown', files: [] };
  }
}

function fixture() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tl-status-core-')), 'board.json');
  const store = new JsonFileBoardStore(file);
  store.mutateBoard('default', (board) => ({ ...board, repo, repoKey: `${repo}/.git`, baseBranch: 'main' }));
  let time = Date.UTC(2026, 9, 4);
  const clock = () => new Date(time);
  const engine = new BoardEngine(store, new StatusGit(), clock);
  return { file, store, engine, iso: () => clock().toISOString(), advance: (ms: number) => { time += ms; } };
}
type Fixture = ReturnType<typeof fixture>;
function receipt(request: ExecutionRequest) {
  return { id: request.taskId, boardId: request.boardId, requestId: request.requestId, runId: request.runId };
}
function latest(f: Fixture, request: ExecutionRequest) {
  return f.engine.getTask(request.taskId).executionRequests!.find((entry) => entry.requestId === request.requestId)!;
}
function withoutCheck(request: ExecutionRequest) {
  const { recoveryCheck, ...rest } = request;
  return rest;
}
function report(f: Fixture, request: ExecutionRequest, outcome: ExecutionRecoveryInput['outcome'] = 'unknown'): ExecutionRecoveryInput {
  const current = latest(f, request);
  const observations: ExecutionRecoveryInput['observations'] = [{ threadId: receiverThreadId, hostId, state: 'idle', observedAt: f.iso() }];
  if (current.result) observations.push({ threadId: current.result.threadId, hostId, state: 'idle', observedAt: f.iso() });
  return {
    ...receipt(request), checkId: current.recoveryCheck!.checkId, checkerThreadId: receiverThreadId,
    hostId, outcome, message: `真实状态核对：${outcome}`, observations,
  };
}
async function noWrite(f: Fixture, operation: () => Promise<unknown>, code?: BoardError['code']) {
  const before = readFileSync(f.file, 'utf8');
  await assert.rejects(operation(), (error: unknown) => error instanceof BoardError && (code === undefined || error.code === code));
  assert.equal(readFileSync(f.file, 'utf8'), before);
}
async function requestAt(f: Fixture, status: ExecutionRequestStatus) {
  const task = await f.engine.createTask({ title: '确认真实会话状态', description: '保留并发任务正文', status: 'ready', priority: 'P1' });
  let { request } = await f.engine.requestExecution({
    id: task.id, boardId: 'default', requestId: 'request-status', action: 'start', workspaceMode: 'project', hostId, receiverThreadId,
  });
  if (status === 'pending') return request;
  if (status === 'delivered' || status === 'uncertain' || status === 'rejected') {
    return (await f.engine.markExecutionDelivery({ ...receipt(request), status, error: '模拟投递结果' })).request;
  }
  ({ request } = await f.engine.claimExecution({ ...receipt(request), claimId: 'claim-status', hostId, receiverThreadId }));
  if (status === 'claimed') return request;
  if (status === 'blocked') return (await f.engine.markExecutionDelivery({ ...receipt(request), claimId: 'claim-status', status, error: '模拟阻塞原因' })).request;
  ({ request } = await f.engine.bindExecution({ ...receipt(request), claimId: 'claim-status', ...executionResult, phase: 'created' }));
  if (status === 'created') return request;
  ({ request } = await f.engine.bindExecution({ ...receipt(request), claimId: 'claim-status', ...executionResult, phase: 'bound' }));
  if (status === 'bound') return request;
  ({ request } = await f.engine.reportExecution({ ...receipt(request), threadId: executionResult.threadId, hostId, reportId: 'report-running', state: 'running' }));
  if (status === 'running') return request;
  assert.ok(status === 'waiting' || status === 'completed' || status === 'failed');
  return (await f.engine.reportExecution({ ...receipt(request), threadId: executionResult.threadId, hostId, reportId: `report-${status}`, state: status })).request;
}

test('状态核对：全部非取消请求阶段均可审计，保持任务、运行、绑定及执行状态', options, async (t) => {
  for (const status of ['pending', 'delivered', 'claimed', 'created', 'bound', 'uncertain', 'blocked', 'running', 'waiting', 'completed', 'failed', 'rejected'] as const) {
    await t.test(status, async () => {
      const f = fixture();
      const request = latest(f, await requestAt(f, status));
      const before = f.engine.getTask(request.taskId);
      const checked = await f.engine.requestExecutionRecovery({ ...receipt(request), checkId: 'check-status', purpose: 'status' });
      assert.equal(checked.created, true);
      assert.equal(checked.request.recoveryCheck?.purpose, 'status');
      assert.equal(checked.request.recoveryCheck?.observedStatus, status);
      for (const outcome of ['busy', 'unknown', 'resumed'] as const) {
        if (outcome !== 'busy') await f.engine.requestExecutionRecovery({ ...receipt(request), checkId: `check-${outcome}`, purpose: 'status' });
        const input = report(f, request, outcome);
        const response = await f.engine.recoverExecution(input);
        assert.equal(response.changed, false);
        assert.equal(response.request.recoveryCheck?.status, outcome);
        assert.equal(response.request.recoveryCheck?.message, input.message);
        assert.deepEqual(withoutCheck(response.request), withoutCheck(request));
        assert.deepEqual(response.task.execution, before.execution);
        assert.deepEqual(response.task.executionBinding, before.executionBinding);
        assert.equal(response.task.status, before.status);
        assert.equal(response.task.title, before.title);
        assert.deepEqual(new JsonFileBoardStore(f.file).getTask(request.taskId), response.task);
      }
      await f.engine.requestExecutionRecovery({ ...receipt(request), checkId: 'check-no-stop', purpose: 'status' });
      await noWrite(f, () => f.engine.recoverExecution({ ...report(f, request, 'stopped'), confirmedStopped: true }));
    });
  }
});

test('状态核对：同 run 的 running→completed 新回执不阻止审计，也不回退状态或覆盖并发编辑', options, async () => {
  const f = fixture();
  const request = await requestAt(f, 'running');
  await f.engine.requestExecutionRecovery({ ...receipt(request), checkId: 'check-status', purpose: 'status' });
  f.advance(1000);
  await f.engine.updateTask({ id: request.taskId, title: '核对期间最新标题', priority: 'P0' });
  const completed = await f.engine.reportExecution({ ...receipt(request), threadId: executionResult.threadId, hostId, reportId: 'report-completed', state: 'completed' });
  const result = await f.engine.recoverExecution(report(f, request, 'resumed'));
  assert.equal(result.changed, false);
  assert.equal(result.request.status, 'completed');
  assert.deepEqual(withoutCheck(result.request), withoutCheck(completed.request));
  assert.deepEqual(result.task.execution, completed.task.execution);
  assert.equal(result.task.title, '核对期间最新标题');
  assert.equal(result.task.priority, 'P0');
  assert.equal(result.request.recoveryCheck?.observedStatus, 'running');
  const beforeReplay = readFileSync(f.file, 'utf8');
  await f.engine.recoverExecution(report(f, request, 'resumed'));
  assert.equal(readFileSync(f.file, 'utf8'), beforeReplay);
});

test('状态核对：purpose 参与检查幂等，60 秒内不同用途不能覆盖在途检查', options, async () => {
  const f = fixture();
  const request = await requestAt(f, 'pending');
  const first = await f.engine.requestExecutionRecovery({ ...receipt(request), checkId: 'check-status', purpose: 'status' });
  f.advance(59000);
  assert.equal((await f.engine.requestExecutionRecovery({ ...receipt(request), checkId: 'check-merged', purpose: 'status' })).created, false);
  assert.deepEqual(latest(f, request).recoveryCheck, first.request.recoveryCheck);
  await noWrite(f, () => f.engine.requestExecutionRecovery({ ...receipt(request), checkId: 'check-status', purpose: 'recovery' }), 'EXECUTION_CONFLICT');
  await noWrite(f, () => f.engine.requestExecutionRecovery({ ...receipt(request), checkId: 'check-recovery', purpose: 'recovery' }), 'EXECUTION_BUSY');
  f.advance(2000);
  const recovery = await f.engine.requestExecutionRecovery({ ...receipt(request), checkId: 'check-recovery' });
  assert.equal(recovery.created, true);
  assert.notEqual(recovery.request.recoveryCheck?.purpose, 'status');
  await noWrite(f, () => f.engine.requestExecutionRecovery({ ...receipt(request), checkId: 'check-recovery', purpose: 'status' }), 'EXECUTION_CONFLICT');
});

test('状态核对：错板、旧检查、跨宿主、新 run、归档和已取消守卫均保持零写入', options, async () => {
  const f = fixture();
  const request = await requestAt(f, 'completed');
  await f.engine.requestExecutionRecovery({ ...receipt(request), checkId: 'check-status', purpose: 'status' });
  const input = report(f, request);
  await noWrite(f, () => f.engine.recoverExecution({ ...input, boardId: 'wrong-board' }), 'BOARD_MISMATCH');
  await noWrite(f, () => f.engine.recoverExecution({ ...input, hostId: 'wrong-host' }), 'EXECUTION_CONFLICT');
  f.advance(61000);
  await f.engine.requestExecutionRecovery({ ...receipt(request), checkId: 'check-new', purpose: 'status' });
  await noWrite(f, () => f.engine.recoverExecution(input), 'EXECUTION_STALE');
  const next = await f.engine.requestExecution({ ...receipt(request), requestId: 'request-next', action: 'continue', workspaceMode: 'project' });
  assert.notEqual(next.request.runId, request.runId);
  await noWrite(f, () => f.engine.recoverExecution({ ...input, checkId: 'check-new' }), 'EXECUTION_STALE');
  await noWrite(f, () => f.engine.requestExecutionRecovery({ ...receipt(request), checkId: 'check-old-run', purpose: 'status' }), 'EXECUTION_STALE');

  const archived = fixture();
  const archivedRequest = await requestAt(archived, 'completed');
  await archived.engine.requestExecutionRecovery({ ...receipt(archivedRequest), checkId: 'check-archive', purpose: 'status' });
  for (const status of ['review', 'done'] as const) await archived.engine.moveTask(archivedRequest.taskId, status);
  await archived.engine.archiveTask(archivedRequest.taskId);
  await noWrite(archived, () => archived.engine.requestExecutionRecovery({ ...receipt(archivedRequest), checkId: 'after-archive', purpose: 'status' }), 'TASK_ARCHIVED');
  await noWrite(archived, () => archived.engine.recoverExecution(report(archived, archivedRequest)), 'TASK_ARCHIVED');

  const cancelled = fixture();
  const cancelledRequest = await requestAt(cancelled, 'pending');
  await cancelled.engine.requestExecutionRecovery({ ...receipt(cancelledRequest), checkId: 'check-recovery' });
  await cancelled.engine.recoverExecution({ ...report(cancelled, cancelledRequest, 'stopped'), confirmedStopped: true });
  await noWrite(cancelled, () => cancelled.engine.requestExecutionRecovery({ ...receipt(cancelledRequest), checkId: 'check-cancelled', purpose: 'status' }));
});

test('状态核对存储：允许 running 等 observedStatus，拒绝非法 purpose 和 status recovered', options, async () => {
  const f = fixture();
  const request = await requestAt(f, 'running');
  await f.engine.requestExecutionRecovery({ ...receipt(request), checkId: 'check-status', purpose: 'status' });
  const original = readFileSync(f.file, 'utf8');
  const restored = new JsonFileBoardStore(f.file).getTask(request.taskId);
  assert.ok(restored);
  assert.equal(restored.executionRequests![0].recoveryCheck?.observedStatus, 'running');
  for (const patch of [{ purpose: 'invalid' }, { purpose: 42 }, { status: 'recovered' }]) {
    const payload = JSON.parse(original);
    Object.assign(payload.tasks[request.taskId].executionRequests[0].recoveryCheck, patch);
    writeFileSync(f.file, JSON.stringify(payload), 'utf8');
    assert.throws(() => new JsonFileBoardStore(f.file).getTask(request.taskId), (error: unknown) => error instanceof BoardError && error.code === 'STORE_ERROR');
  }
  writeFileSync(f.file, original, 'utf8');
});
