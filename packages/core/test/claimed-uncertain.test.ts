import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BoardEngine, BoardError, GitService, JsonFileBoardStore, type RepoValidation } from '../src/index.js';

/** 只核对内存仓库身份，不创建真实 Git 工作区。 */
class StubGitService extends GitService {
  override async identifyRepo(): Promise<RepoValidation> {
    return { root: '/repos/a', repoKey: '/repos/a/.git' };
  }
}

async function fixture() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tasklane-claimed-uncertain-')), 'board.json');
  const store = new JsonFileBoardStore(file);
  store.mutateBoard('default', (board) => ({ ...board, repo: '/repos/a', repoKey: '/repos/a/.git' }));
  let tick = 0;
  const engine = new BoardEngine(store, new StubGitService(true), () => new Date(Date.UTC(2026, 9, 4) + tick++ * 1000));
  const task = await engine.createTask({ title: '核对创建结果', status: 'ready' });
  const { request } = await engine.requestExecution({
    id: task.id, boardId: task.boardId, requestId: 'request-a', action: 'start', workspaceMode: 'project',
    hostId: 'local', receiverThreadId: 'receiver-a',
  });
  const receipt = { id: task.id, boardId: task.boardId, requestId: request.requestId, runId: request.runId };
  await engine.claimExecution({ ...receipt, claimId: 'claim-a' });
  const snapshot = () => ({ task: engine.getTask(task.id), session: store.getSession(task.id) });
  const binding = {
    ...receipt, claimId: 'claim-a', threadId: 'thread-a', hostId: 'local',
    workspacePath: '/repos/a', workspaceOwner: 'user' as const,
  };
  return { engine, store, file, receipt, snapshot, binding };
}

test('正确认领者可记录创建结果未知，保留认领和运行代次并显示原因', async () => {
  const { engine, store, file, receipt } = await fixture();
  const delivery = { ...receipt, claimId: 'claim-a', status: 'uncertain' as const, error: '工作区已创建，但未获得真实聊天标识' };
  const result = await engine.markExecutionDelivery(delivery);
  assert.equal(result.request.status, 'uncertain');
  assert.equal(result.request.claimId, 'claim-a');
  assert.equal(result.request.runId, receipt.runId);
  assert.deepEqual(result.request.receiver, { hostId: 'local', threadId: 'receiver-a' });
  assert.equal(result.request.deliveryError, delivery.error);
  assert.equal(result.request.result, undefined);
  assert.equal(result.task.execution.state, 'starting');
  assert.equal(result.task.execution.activity, delivery.error);
  assert.equal(result.task.execution.startedAt, undefined);
  assert.equal(result.task.executionBinding, undefined);
  assert.equal(store.getSession(receipt.id)!.events.filter((event) => event.kind === 'execution_uncertain').length, 1);
  assert.equal(new JsonFileBoardStore(file).getTask(receipt.id)!.executionRequests![0].deliveryError, delivery.error);
});

test('创建结果未知回执重放幂等，同认领可更新原因，无认领和错误认领不能覆写', async () => {
  const { engine, receipt, snapshot } = await fixture();
  const delivery = { ...receipt, claimId: 'claim-a', status: 'uncertain' as const, error: '等待真实聊天标识' };
  await engine.markExecutionDelivery(delivery);
  const before = snapshot();
  await engine.markExecutionDelivery(delivery);
  await engine.markExecutionDelivery({ ...delivery, claimId: undefined, error: '面板迟到错误' });
  await assert.rejects(engine.markExecutionDelivery({ ...delivery, claimId: 'wrong-claim', error: '无关认领' }),
    (error: unknown) => error instanceof BoardError && error.code === 'EXECUTION_CONFLICT');
  assert.deepEqual(snapshot(), before);
  const changed = await engine.markExecutionDelivery({ ...delivery, error: '已核对工作区，聊天标识仍待确认' });
  assert.equal(changed.task.execution.activity, '已核对工作区，聊天标识仍待确认');
  assert.equal(changed.request.status, 'uncertain');
});

test('无认领的面板回执不能覆盖 claimed，正确认领无摘要也能显示待确认提示', async () => {
  const { engine, receipt, snapshot } = await fixture();
  const before = snapshot();
  await engine.markExecutionDelivery({ ...receipt, status: 'uncertain', error: '面板超时' });
  assert.deepEqual(snapshot(), before);
  const result = await engine.markExecutionDelivery({ ...receipt, claimId: 'claim-a', status: 'uncertain' });
  assert.equal(result.request.status, 'uncertain');
  assert.match(result.task.execution.activity!, /原生创建结果待确认/);
});

test('未知结果得到确认后沿用原认领绑定并开始执行，不创建新请求', async () => {
  const { engine, receipt, binding } = await fixture();
  await engine.markExecutionDelivery({ ...receipt, claimId: 'claim-a', status: 'uncertain', error: '等待宿主创建结果' });
  await engine.bindExecution({ ...binding, phase: 'created' });
  const bound = await engine.bindExecution({ ...binding, phase: 'bound' });
  assert.equal(bound.request.status, 'bound');
  const running = await engine.reportExecution({
    ...receipt, threadId: binding.threadId, hostId: binding.hostId, reportId: 'running', state: 'running', activity: '已开始只读核验',
  });
  assert.equal(running.request.status, 'running');
  assert.equal(running.request.claimId, 'claim-a');
  assert.equal(running.task.executionRequests!.length, 1);
  assert.equal(running.task.execution.activity, '已开始只读核验');
  assert.equal(running.task.executionBinding!.threadId, binding.threadId);
});

test('已创建结果的绑定失败保存聊天标识与原因，幂等重放后可恢复绑定', async () => {
  const { engine, store, file, receipt, binding, snapshot } = await fixture();
  const created = await engine.bindExecution({ ...binding, phase: 'created' });
  const delivery = { ...receipt, claimId: 'claim-a', status: 'uncertain' as const, error: '工作区暂不可读，绑定未确认' };
  const uncertain = await engine.markExecutionDelivery(delivery);
  assert.equal(uncertain.request.status, 'created');
  assert.deepEqual(uncertain.request.result, created.request.result);
  assert.equal(uncertain.request.result!.threadId, binding.threadId);
  assert.equal(uncertain.request.deliveryError, delivery.error);
  assert.equal(uncertain.task.execution.activity, delivery.error);
  assert.equal(uncertain.task.execution.state, 'starting');
  assert.equal(uncertain.task.execution.startedAt, undefined);
  assert.equal(uncertain.task.executionBinding, undefined);
  const before = snapshot();
  await engine.markExecutionDelivery(delivery);
  await engine.markExecutionDelivery({ ...delivery, claimId: undefined, error: '面板迟到错误' });
  await assert.rejects(engine.markExecutionDelivery({ ...delivery, claimId: 'wrong-claim' }),
    (error: unknown) => error instanceof BoardError && error.code === 'EXECUTION_CONFLICT');
  assert.deepEqual(snapshot(), before);
  assert.equal(store.getSession(receipt.id)!.events.filter((event) => event.kind === 'execution_uncertain').length, 1);
  const persisted = new JsonFileBoardStore(file).getTask(receipt.id)!.executionRequests![0];
  assert.deepEqual(persisted.result, created.request.result);
  assert.equal(persisted.deliveryError, delivery.error);
  const bound = await engine.bindExecution({ ...binding, phase: 'bound' });
  assert.equal(bound.request.status, 'bound');
  assert.equal(bound.task.executionBinding!.threadId, binding.threadId);
  assert.equal(bound.task.executionRequests!.length, 1);
});

test('正确认领的迟到未知回执不能回退 bound、运行和终态', async (t) => {
  for (const stage of ['bound', 'running', 'waiting', 'completed', 'failed', 'rejected'] as const) {
    await t.test(stage, async () => {
      const { engine, receipt, binding, snapshot } = await fixture();
      if (stage === 'rejected') {
        await engine.markExecutionDelivery({ ...receipt, claimId: 'claim-a', status: 'rejected', error: '宿主明确拒绝创建' });
      } else {
        await engine.bindExecution({ ...binding, phase: 'created' });
        await engine.bindExecution({ ...binding, phase: 'bound' });
        if (['running', 'waiting', 'completed', 'failed'].includes(stage)) {
          await engine.reportExecution({ ...receipt, threadId: binding.threadId, hostId: binding.hostId, reportId: 'running', state: 'running' });
        }
        if (stage === 'waiting' || stage === 'completed' || stage === 'failed') {
          await engine.reportExecution({ ...receipt, threadId: binding.threadId, hostId: binding.hostId, reportId: stage, state: stage });
        }
      }
      const before = snapshot();
      await engine.markExecutionDelivery({ ...receipt, claimId: 'claim-a', status: 'uncertain', error: '迟到的未知结果' });
      assert.deepEqual(snapshot(), before);
      await assert.rejects(engine.markExecutionDelivery({ ...receipt, claimId: 'wrong-claim', status: 'uncertain', error: '无关认领' }),
        (error: unknown) => error instanceof BoardError && error.code === 'EXECUTION_CONFLICT');
      assert.deepEqual(snapshot(), before);
    });
  }
});
