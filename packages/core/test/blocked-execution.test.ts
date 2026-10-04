import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BoardEngine, BoardError, GitService, JsonFileBoardStore,
  type ExecutionRequest, type RepoValidation,
} from '../src/index.js';

/** 独立工作区只使用仓库桩，确保测试不操作用户 Git 目录。 */
class StubGitService extends GitService {
  override async identifyRepo(): Promise<RepoValidation> {
    return { root: '/repos/a', repoKey: '/repos/a/.git' };
  }

  override async assertWorktreeMatches(): Promise<void> {}
}

async function fixture() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tasklane-blocked-')), 'board.json');
  const store = new JsonFileBoardStore(file);
  store.mutateBoard('default', (board) => ({ ...board, repo: '/repos/a', repoKey: '/repos/a/.git' }));
  let tick = 0;
  const engine = new BoardEngine(store, new StubGitService(true), () => new Date(Date.UTC(2026, 9, 4) + tick++ * 1000));
  const task = await engine.createTask({ title: '核验阻塞原因后继续', status: 'ready' });
  const start = {
    id: task.id, boardId: task.boardId, requestId: 'start-a', action: 'start' as const,
    workspaceMode: 'worktree' as const, hostId: 'local', receiverThreadId: 'receiver-a', model: 'model-a',
  };
  const { request } = await engine.requestExecution(start);
  const receipt = { id: task.id, boardId: task.boardId, requestId: request.requestId, runId: request.runId };
  await engine.claimExecution({ ...receipt, claimId: 'claim-a' });
  const binding = {
    ...receipt, claimId: 'claim-a', threadId: 'thread-a', hostId: 'local',
    workspacePath: '/worktrees/a', workspaceOwner: 'codex' as const, branch: 'codex/task-a',
  };
  const delivery = { ...receipt, claimId: 'claim-a', status: 'blocked' as const, error: '无法核验工作区，需确认后继续' };
  const resume = { ...start, requestId: 'continue-a', action: 'continue' as const, model: undefined };
  const snapshot = () => ({ task: engine.getTask(task.id), session: store.getSession(task.id) });
  return { engine, store, file, start, receipt, binding, delivery, resume, snapshot };
}

const rejectsCode = (code: BoardError['code']) => (error: unknown) => error instanceof BoardError && error.code === code;

test('创建前阻塞显式保存原因，禁止重复启动；没有真实结果时继续须先核对原创建', async () => {
  const f = await fixture();
  const blocked = await f.engine.markExecutionDelivery(f.delivery);
  assert.equal(blocked.request.status, 'blocked');
  assert.equal(blocked.request.claimId, 'claim-a');
  assert.equal(blocked.request.result, undefined);
  assert.equal(blocked.task.execution.state, 'blocked');
  assert.equal(blocked.task.execution.activity, f.delivery.error);
  assert.equal(blocked.task.execution.startedAt, undefined);
  const before = f.snapshot();
  await f.engine.markExecutionDelivery(f.delivery);
  assert.deepEqual(f.snapshot(), before);
  await assert.rejects(f.engine.requestExecution({ ...f.start, requestId: 'duplicate-start', message: '再次启动' }), rejectsCode('EXECUTION_BUSY'));
  await assert.rejects(f.engine.requestExecution(f.resume), rejectsCode('EXECUTION_CONFLICT'));
  assert.deepEqual(f.snapshot(), before);
  const check = await f.engine.requestExecutionRecovery({ ...f.receipt, checkId: 'check-a' });
  assert.equal(check.request.recoveryCheck!.observedStatus, 'blocked');
  assert.equal(check.request.status, 'blocked');
  assert.equal(new JsonFileBoardStore(f.file).getTask(f.receipt.id)!.execution.state, 'blocked');
});

test('阻塞投递必须匹配原认领并有原因，不正确输入不改写任务', async () => {
  const f = await fixture();
  const before = f.snapshot();
  for (const change of [{ claimId: undefined }, { error: undefined }, { error: ' ' }]) {
    await assert.rejects(f.engine.markExecutionDelivery({ ...f.delivery, ...change }), rejectsCode('VALIDATION'));
  }
  await assert.rejects(f.engine.markExecutionDelivery({ ...f.delivery, claimId: 'claim-other' }), rejectsCode('EXECUTION_CONFLICT'));
  await assert.rejects(f.engine.markExecutionDelivery({ ...f.delivery, boardId: 'other' }), rejectsCode('BOARD_MISMATCH'));
  assert.deepEqual(f.snapshot(), before);
});

test('创建后的阻塞保留真实会话、工作区和模型；继续开启新代次复用结果并幂等', async () => {
  const f = await fixture();
  const created = await f.engine.bindExecution({ ...f.binding, phase: 'created' });
  const blocked = await f.engine.markExecutionDelivery(f.delivery);
  assert.deepEqual(blocked.request.result, created.request.result);
  assert.equal(blocked.task.executionBinding, undefined);
  assert.equal(blocked.task.execution.state, 'blocked');
  const resumed = await f.engine.requestExecution(f.resume);
  assert.equal(resumed.created, true);
  assert.notEqual(resumed.request.runId, f.receipt.runId);
  assert.equal(resumed.request.model, 'model-a');
  assert.equal(resumed.request.workspaceMode, 'worktree');
  assert.deepEqual(resumed.request.result, blocked.request.result);
  assert.deepEqual(resumed.request.recoveryOf, { requestId: f.receipt.requestId, runId: f.receipt.runId });
  assert.equal(resumed.task.executionRequests![0].status, 'blocked');
  assert.equal(resumed.task.execution.state, 'starting');
  const before = f.snapshot();
  const replay = await f.engine.requestExecution(f.resume);
  const merged = await f.engine.requestExecution({ ...f.resume, requestId: 'continue-duplicate' });
  assert.equal(replay.created, false);
  assert.equal(merged.created, false);
  assert.deepEqual(f.snapshot(), before);
  await assert.rejects(f.engine.markExecutionDelivery(f.delivery), rejectsCode('EXECUTION_STALE'));
  const nextReceipt = { ...f.receipt, requestId: resumed.request.requestId, runId: resumed.request.runId };
  await f.engine.claimExecution({ ...nextReceipt, claimId: 'claim-next' });
  const nextBinding = { ...f.binding, ...nextReceipt, claimId: 'claim-next' };
  await assert.rejects(f.engine.bindExecution({ ...nextBinding, phase: 'created', threadId: 'other-thread' }), rejectsCode('EXECUTION_CONFLICT'));
  await f.engine.bindExecution({ ...nextBinding, phase: 'created' });
  await assert.rejects(f.engine.reportExecution({ ...nextReceipt, threadId: 'thread-a', hostId: 'local', reportId: 'premature', state: 'running' }), rejectsCode('EXECUTION_CONFLICT'));
  await f.engine.bindExecution({ ...nextBinding, phase: 'bound' });
  const running = await f.engine.reportExecution({ ...nextReceipt, threadId: 'thread-a', hostId: 'local', reportId: 'verified-running', state: 'running', activity: '已核对旧聊天、工作区及阻塞原因' });
  assert.equal(running.task.execution.state, 'running');
  assert.equal(running.task.executionBinding!.threadId, 'thread-a');
  assert.equal(running.task.worktreePath, '/worktrees/a');
  assert.equal(new JsonFileBoardStore(f.file).getTask(f.receipt.id)!.executionRequests!.length, 2);
});

test('阻塞继续拒绝切换工作区、模型和宿主，不允许通过reply/retry绕过', async () => {
  const f = await fixture();
  await f.engine.bindExecution({ ...f.binding, phase: 'created' });
  await f.engine.markExecutionDelivery(f.delivery);
  const before = f.snapshot();
  await assert.rejects(f.engine.requestExecution({ ...f.resume, workspaceMode: 'project' }), rejectsCode('EXECUTION_CONFLICT'));
  await assert.rejects(f.engine.requestExecution({ ...f.resume, model: 'model-b' }), rejectsCode('VALIDATION'));
  await assert.rejects(f.engine.requestExecution({ ...f.resume, hostId: 'other-host' }), rejectsCode('EXECUTION_CONFLICT'));
  for (const action of ['reply', 'retry'] as const) {
    await assert.rejects(f.engine.requestExecution({ ...f.resume, action, message: '继续' }), rejectsCode('EXECUTION_BUSY'));
  }
  assert.deepEqual(f.snapshot(), before);
});

test('绑定后由真实目标报告阻塞，保留绑定且不伪造startedAt；继续复用同一聊天', async () => {
  const f = await fixture();
  await f.engine.bindExecution({ ...f.binding, phase: 'created' });
  await f.engine.bindExecution({ ...f.binding, phase: 'bound' });
  const report = { ...f.receipt, threadId: 'thread-a', hostId: 'local', reportId: 'blocked-a', state: 'blocked' as const, activity: '缺少任务所需权限' };
  await assert.rejects(f.engine.reportExecution({ ...report, activity: ' ' }), rejectsCode('VALIDATION'));
  await assert.rejects(f.engine.reportExecution({ ...report, threadId: 'other-thread' }), rejectsCode('EXECUTION_CONFLICT'));
  const blocked = await f.engine.reportExecution(report);
  assert.equal(blocked.request.status, 'blocked');
  assert.equal(blocked.task.execution.state, 'blocked');
  assert.equal(blocked.task.executionBinding!.threadId, 'thread-a');
  assert.equal(blocked.task.execution.startedAt, undefined);
  const before = f.snapshot();
  await f.engine.reportExecution(report);
  await f.engine.markExecutionDelivery({ ...f.delivery, error: '面板迟到错误' });
  assert.deepEqual(f.snapshot(), before);
  const resumed = await f.engine.requestExecution(f.resume);
  const next = { ...f.receipt, requestId: resumed.request.requestId, runId: resumed.request.runId };
  await f.engine.claimExecution({ ...next, claimId: 'next-claim' });
  await f.engine.markExecutionDelivery({ ...next, claimId: 'next-claim', status: 'blocked', error: '核验未完成' });
  // 旧任务的绑定不等于新代次已核验，必须先完成本轮 bound。
  await assert.rejects(f.engine.reportExecution({ ...next, threadId: 'thread-a', hostId: 'local', reportId: 'premature', state: 'running' }), rejectsCode('EXECUTION_CONFLICT'));
  await f.engine.bindExecution({ ...f.binding, ...next, claimId: 'next-claim', phase: 'bound' });
  const running = await f.engine.reportExecution({ ...next, threadId: 'thread-a', hostId: 'local', reportId: 'resumed', state: 'running' });
  assert.equal(running.task.execution.state, 'running');
});

test('正确目标同代次解除运行阻塞，保留开始时间；完成和失败后迟到阻塞不得覆盖', async (t) => {
  for (const terminal of ['completed', 'failed'] as const) {
    await t.test(terminal, async () => {
      const f = await fixture();
      await f.engine.bindExecution({ ...f.binding, phase: 'created' });
      await f.engine.bindExecution({ ...f.binding, phase: 'bound' });
      const report = { ...f.receipt, threadId: 'thread-a', hostId: 'local' };
      const running = await f.engine.reportExecution({ ...report, reportId: 'running-a', state: 'running' });
      await f.engine.reportExecution({ ...report, reportId: 'blocked-a', state: 'blocked', activity: '等待依赖修复' });
      const resumed = await f.engine.reportExecution({ ...report, reportId: 'running-b', state: 'running', activity: '依赖已核对修复' });
      assert.equal(resumed.request.startedAt, running.request.startedAt);
      await f.engine.reportExecution({ ...report, reportId: terminal, state: terminal });
      const before = f.snapshot();
      await f.engine.markExecutionDelivery(f.delivery);
      await assert.rejects(f.engine.reportExecution({ ...report, reportId: 'late-blocked', state: 'blocked', activity: '迟到阻塞' }), rejectsCode('EXECUTION_STALE'));
      assert.deepEqual(f.snapshot(), before);
    });
  }
});

test('已绑定聊天的普通继续在本轮绑定前阻塞，下一轮仍可沿用原真实绑定', async () => {
  const f = await fixture();
  await f.engine.bindExecution({ ...f.binding, phase: 'created' });
  await f.engine.bindExecution({ ...f.binding, phase: 'bound' });
  const report = { ...f.receipt, threadId: 'thread-a', hostId: 'local' };
  await f.engine.reportExecution({ ...report, reportId: 'running-a', state: 'running' });
  await f.engine.reportExecution({ ...report, reportId: 'complete-a', state: 'completed' });
  const firstContinue = await f.engine.requestExecution(f.resume);
  assert.equal(firstContinue.request.result, undefined);
  const firstReceipt = { ...f.receipt, requestId: firstContinue.request.requestId, runId: firstContinue.request.runId };
  await f.engine.claimExecution({ ...firstReceipt, claimId: 'first-continue' });
  await f.engine.markExecutionDelivery({ ...firstReceipt, claimId: 'first-continue', status: 'blocked', error: '原聊天暂时繁忙' });
  const next = await f.engine.requestExecution({ ...f.resume, requestId: 'second-continue' });
  assert.deepEqual(next.request.recoveryOf, { requestId: firstReceipt.requestId, runId: firstReceipt.runId });
  assert.equal(next.request.result!.threadId, 'thread-a');
  assert.equal(next.request.result!.workspacePath, '/worktrees/a');
  assert.equal(next.task.executionBinding!.threadId, 'thread-a');
  assert.equal(new JsonFileBoardStore(f.file).getTask(f.receipt.id)!.executionRequests!.length, 3);
  await assert.rejects(f.engine.markExecutionDelivery({ ...firstReceipt, claimId: 'first-continue', status: 'blocked', error: '旧回执' }), rejectsCode('EXECUTION_STALE'));
});

test('归档守卫拒绝阻塞回执与继续，不改变旧运行结果', async () => {
  const f = await fixture();
  await f.engine.bindExecution({ ...f.binding, phase: 'created' });
  await f.engine.markExecutionDelivery(f.delivery);
  f.store.mutateTask(f.receipt.id, (task) => ({ ...task, status: 'done' }));
  await f.engine.archiveTask(f.receipt.id);
  const before = f.snapshot();
  await assert.rejects(f.engine.markExecutionDelivery(f.delivery), rejectsCode('TASK_ARCHIVED'));
  await assert.rejects(f.engine.requestExecution(f.resume), rejectsCode('TASK_ARCHIVED'));
  assert.deepEqual(f.snapshot(), before);
});

test('异步创建的客户端临时标识不能记录为真实聊天或接收身份', async () => {
  const f = await fixture();
  const before = f.snapshot();
  for (const temporaryId of ['client-new-thread:01a1060f-test', 'clientThreadId-test']) {
    await assert.rejects(f.engine.bindExecution({ ...f.binding, phase: 'created', threadId: temporaryId }), rejectsCode('VALIDATION'));
    await assert.rejects(f.engine.requestExecution({ ...f.start, requestId: 'temporary-receiver', receiverThreadId: temporaryId }), rejectsCode('VALIDATION'));
  }
  assert.deepEqual(f.snapshot(), before);
  await f.engine.bindExecution({ ...f.binding, phase: 'created' });
  const original = readFileSync(f.file, 'utf8');
  const data = JSON.parse(original) as { tasks: Record<string, { executionRequests: ExecutionRequest[] }> };
  data.tasks[f.receipt.id].executionRequests[0].result!.threadId = 'client-new-thread:temporary';
  writeFileSync(f.file, JSON.stringify(data));
  assert.throws(() => new JsonFileBoardStore(f.file).getTask(f.receipt.id), rejectsCode('STORE_ERROR'));
  writeFileSync(f.file, original);
});

test('存储重读拒绝没有认领或原因的blocked和被篡改的继续来源', async () => {
  const f = await fixture();
  await f.engine.bindExecution({ ...f.binding, phase: 'created' });
  await f.engine.markExecutionDelivery(f.delivery);
  await f.engine.requestExecution(f.resume);
  const original = readFileSync(f.file, 'utf8');
  type TestData = { tasks: Record<string, { executionRequests: ExecutionRequest[] }> };
  const alterations: ((data: TestData) => void)[] = [
    (data) => { delete data.tasks[f.receipt.id].executionRequests[0].claimId; },
    (data) => { delete data.tasks[f.receipt.id].executionRequests[0].deliveryError; },
    (data) => { data.tasks[f.receipt.id].executionRequests[1].model = 'changed-model'; },
    (data) => { data.tasks[f.receipt.id].executionRequests[1].result!.threadId = 'changed-thread'; },
  ];
  for (const alter of alterations) {
    const data = JSON.parse(original) as TestData;
    alter(data);
    writeFileSync(f.file, JSON.stringify(data));
    assert.throws(() => new JsonFileBoardStore(f.file).getTask(f.receipt.id), rejectsCode('STORE_ERROR'));
  }
  writeFileSync(f.file, original);
  assert.equal(new JsonFileBoardStore(f.file).getTask(f.receipt.id)!.executionRequests!.length, 2);
});
