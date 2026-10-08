import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BoardEngine,
  BoardError,
  GitService,
  JsonFileBoardStore,
  type BindExecutionInput,
  type RepoValidation,
  type ReportExecutionInput,
  type RequestExecutionInput,
  type ReviewUpdateInput,
} from '../src/index.js';

/** 仓库和 worktree 都是内存桩；测试不能启动 Git 或创建真实工作区。 */
class StubGitService extends GitService {
  private readonly identities = new Map<string, RepoValidation>([
    ['/repos/a', { root: '/repos/a', repoKey: '/repos/a/.git' }],
    ['/worktrees/a', { root: '/repos/a', repoKey: '/repos/a/.git' }],
    ['/repos/b', { root: '/repos/b', repoKey: '/repos/b/.git' }],
  ]);
  private readonly branches = new Map([
    ['/worktrees/a', 'codex/task-a'],
    ['/repos/a', 'main'],
  ]);

  constructor() {
    super(true);
  }

  override async identifyRepo(repoInput: string): Promise<RepoValidation> {
    const identity = this.identities.get(repoInput);
    if (!identity) throw new BoardError('GIT_ERROR', '执行目录不是有效 Git 工作区');
    return { ...identity };
  }

  override async assertWorktreeMatches(workspacePath: string, repo: string, branch: string): Promise<void> {
    if (this.identities.get(workspacePath)?.repoKey !== this.identities.get(repo)?.repoKey ||
      this.branches.get(workspacePath) !== branch) {
      throw new BoardError('GIT_ERROR', '工作区必须是所属仓库的根目录且分支匹配');
    }
  }

  override async ensureTaskContext(): Promise<null> {
    assert.fail('测试不能创建 Git 上下文');
  }

  override async resolveRepo(): Promise<null> {
    assert.fail('测试不能运行真实 Git 仓库发现');
  }
}

function makeFixture() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tasklane-review-')), 'board.json');
  const store = new JsonFileBoardStore(file);
  store.mutateBoard('default', (board) => ({
    ...board, repo: '/repos/a', repoKey: '/repos/a/.git', baseBranch: 'main',
  }));
  const git = new StubGitService();
  let tick = 0;
  const engine = new BoardEngine(store, git, () => new Date(Date.UTC(2026, 9, 5) + tick++ * 1000));
  return { engine, store, git, file };
}

type Fixture = ReturnType<typeof makeFixture>;

function rejectsCode(code: BoardError['code']) {
  return (err: unknown) => err instanceof BoardError && err.code === code;
}

interface ImplContext {
  taskId: string;
  runId: string;
}

/** 建立带真实实现绑定的任务（running → completed）并推进到 review 列 */
async function taskInReview(
  fixture: Fixture,
  overrides: { workspacePath?: string; workspaceMode?: RequestExecutionInput['workspaceMode'] } = {},
): Promise<ImplContext> {
  const { engine } = fixture;
  const task = await engine.createTask({ title: '实现任务', status: 'ready' });
  const workspacePath = overrides.workspacePath ?? '/repos/a';
  const workspaceMode = overrides.workspaceMode ?? 'project';
  const requested = await engine.requestExecution({
    id: task.id, boardId: 'default', requestId: 'impl-request-1', action: 'start', workspaceMode,
  });
  const request = requested.request;
  const receipt = { id: task.id, boardId: 'default', requestId: request.requestId, runId: request.runId };
  await engine.claimExecution({ ...receipt, claimId: 'impl-claim', hostId: 'codex-host-a', receiverThreadId: 'impl-receiver' });
  const bind: BindExecutionInput = {
    ...receipt, claimId: 'impl-claim', phase: 'created', threadId: 'impl-thread', hostId: 'codex-host-a',
    workspacePath, workspaceOwner: workspaceMode === 'project' ? 'user' : 'codex',
    ...(workspaceMode === 'worktree' ? { branch: 'codex/task-a' } : {}),
  };
  await engine.bindExecution({ ...bind, phase: 'created' });
  await engine.bindExecution({ ...bind, phase: 'bound' });
  await engine.reportExecution({
    ...receipt, threadId: 'impl-thread', hostId: 'codex-host-a', reportId: 'impl-running', state: 'running',
  });
  await engine.reportExecution({
    ...receipt, threadId: 'impl-thread', hostId: 'codex-host-a', reportId: 'impl-completed', state: 'completed',
  });
  await engine.moveTask(task.id, 'review');
  return { taskId: task.id, runId: request.runId };
}

/** 对 review 请求完成 claim → created → bound（认领者即验收线程） */
async function bindReview(
  fixture: Fixture,
  request: { taskId: string; requestId: string; runId: string },
  overrides: Partial<BindExecutionInput> = {},
) {
  const receipt = { id: request.taskId, boardId: 'default', requestId: request.requestId, runId: request.runId };
  const input: BindExecutionInput = {
    ...receipt, claimId: 'review-claim', phase: 'created', threadId: 'review-thread', hostId: 'codex-host-a',
    workspacePath: '/repos/a', workspaceOwner: 'user', ...overrides,
  };
  await fixture.engine.claimExecution({
    ...receipt, claimId: input.claimId, hostId: input.hostId, receiverThreadId: input.threadId,
  });
  await fixture.engine.bindExecution({ ...input, phase: 'created' });
  return fixture.engine.bindExecution({ ...input, phase: 'bound' });
}

function reviewUpdate(id: string, overrides: Partial<ReviewUpdateInput> = {}): ReviewUpdateInput {
  return { id, boardId: 'default', expectedRevision: 0, status: 'changes_requested', conclusion: '请补充测试', ...overrides };
}

test('验收受阻时禁止实现请求：无结论、已结论和待复查均无写入副作用', async (t) => {
  for (const phase of ['pending', 'reviewing', 'changes_requested', 'recheck_pending'] as const) {
    await t.test(phase, async () => {
      const fixture = makeFixture();
      const { engine, file } = fixture;
      const { taskId } = await taskInReview(fixture);
      const first = await engine.requestExecution({
        id: taskId, boardId: 'default', requestId: 'review-blocked', action: 'start',
        workspaceMode: 'existing', purpose: 'review',
      });
      const receipt = { id: taskId, boardId: 'default', requestId: first.request.requestId, runId: first.request.runId };
      if (phase === 'pending') {
        await engine.claimExecution({ ...receipt, claimId: 'review-claim', hostId: 'codex-host-a', receiverThreadId: 'review-thread' });
        await engine.markExecutionDelivery({ ...receipt, status: 'blocked', claimId: 'review-claim', error: '无法开始验收' });
      } else {
        await bindReview(fixture, first.request);
        await engine.reportExecution({ ...receipt, threadId: 'review-thread', hostId: 'codex-host-a', reportId: 'review-running', state: 'running' });
        await engine.reportExecution({ ...receipt, threadId: 'review-thread', hostId: 'codex-host-a', reportId: 'review-blocked', state: 'blocked', activity: '验收工具不可用' });
        if (phase !== 'reviewing') {
          await engine.updateReview(reviewUpdate(taskId, { expectedRevision: engine.getTask(taskId).review!.revision }));
        }
        if (phase === 'recheck_pending') {
          await engine.updateReview(reviewUpdate(taskId, { expectedRevision: engine.getTask(taskId).review!.revision, status: 'recheck_pending' }));
        }
      }
      const before = readFileSync(file, 'utf8');
      for (const action of ['continue', 'reply', 'retry', 'start'] as const) {
        await assert.rejects(engine.requestExecution({
          id: taskId, boardId: 'default', requestId: `impl-${action}-blocked`, action,
          workspaceMode: 'project', message: '继续实现',
        }), (err: unknown) => err instanceof BoardError && err.code === 'EXECUTION_CONFLICT' && /验收受阻/.test(err.message));
        assert.equal(readFileSync(file, 'utf8'), before);
      }
      // 相同请求重放也不能绕过新出现的验收阻塞。
      await assert.rejects(engine.requestExecution({
        id: taskId, boardId: 'default', requestId: 'impl-request-1', action: 'start', workspaceMode: 'project',
      }), rejectsCode('EXECUTION_CONFLICT'));
      assert.equal(readFileSync(file, 'utf8'), before);
    });
  }
});

test('验收真实完成后允许继续修改，历史 blocked 回执不阻止当前已完成验收', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const { taskId } = await taskInReview(fixture);
  const first = await engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'review-recovered', action: 'start', workspaceMode: 'existing', purpose: 'review',
  });
  await bindReview(fixture, first.request);
  const receipt = { id: taskId, boardId: 'default', requestId: first.request.requestId, runId: first.request.runId, threadId: 'review-thread', hostId: 'codex-host-a' };
  await engine.reportExecution({ ...receipt, reportId: 'review-running', state: 'running' });
  await engine.reportExecution({ ...receipt, reportId: 'review-blocked', state: 'blocked', activity: '等待工具恢复' });
  const historicalBlocked = engine.getTask(taskId).executionRequests!.find((request) => request.requestId === first.request.requestId)!;
  await engine.updateReview(reviewUpdate(taskId, { expectedRevision: engine.getTask(taskId).review!.revision }));
  await engine.reportExecution({ ...receipt, reportId: 'review-completed', state: 'completed' });
  // 模拟旧版本留下的历史阻塞请求：当前 runId 已完成，不应扫描并拦截旧代次。
  fixture.store.mutateTask(taskId, (task) => ({ ...task, executionRequests: [
    ...task.executionRequests!, { ...historicalBlocked, requestId: 'historical-blocked', runId: 'historical-blocked-run' },
  ] }));
  const fix = await engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'impl-fix', action: 'continue', workspaceMode: 'project', message: '按结论修改',
  });
  assert.equal(fix.created, true);
  assert.equal(fix.task.reviewExecution?.state, 'completed');
  assert.equal(fix.task.review?.status, 'changes_requested');
  assert.equal(fix.task.executionBinding?.threadId, 'impl-thread');
});

test('实现请求之后验收才受阻：认领读取磁盘最新状态并拒绝，验收收尾后可认领', async () => {
  const fixture = makeFixture();
  const { engine, file } = fixture;
  const { taskId } = await taskInReview(fixture);
  const first = await engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'review-before-claim', action: 'start', workspaceMode: 'existing', purpose: 'review',
  });
  await bindReview(fixture, first.request);
  const reviewReceipt = { id: taskId, boardId: 'default', requestId: first.request.requestId, runId: first.request.runId, threadId: 'review-thread', hostId: 'codex-host-a' };
  await engine.reportExecution({ ...reviewReceipt, reportId: 'review-running', state: 'running' });
  await engine.updateReview(reviewUpdate(taskId, { expectedRevision: engine.getTask(taskId).review!.revision }));
  const fix = await engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'impl-awaiting-claim', action: 'continue', workspaceMode: 'project',
  });
  const other = new BoardEngine(new JsonFileBoardStore(file), new StubGitService());
  await other.reportExecution({ ...reviewReceipt, reportId: 'review-blocked', state: 'blocked', activity: '验收收尾受阻' });
  const before = readFileSync(file, 'utf8');
  const claim = { id: taskId, boardId: 'default', requestId: fix.request.requestId, runId: fix.request.runId, claimId: 'impl-fix-claim', hostId: 'codex-host-a', receiverThreadId: 'impl-thread' };
  await assert.rejects(engine.claimExecution(claim), rejectsCode('EXECUTION_CONFLICT'));
  assert.equal(readFileSync(file, 'utf8'), before);
  await other.reportExecution({ ...reviewReceipt, reportId: 'review-completed', state: 'completed' });
  assert.equal((await engine.claimExecution(claim)).claimed, true);
});

test('验收状态与请求不一致时任一 blocked 条件均阻止请求和认领', async (t) => {
  for (const blockedField of ['execution', 'request'] as const) {
    await t.test(blockedField, async () => {
      const fixture = makeFixture();
      const { engine, store, file } = fixture;
      const { taskId } = await taskInReview(fixture);
      const first = await engine.requestExecution({
        id: taskId, boardId: 'default', requestId: 'review-inconsistent', action: 'start', workspaceMode: 'existing', purpose: 'review',
      });
      await bindReview(fixture, first.request);
      const receipt = { id: taskId, boardId: 'default', requestId: first.request.requestId, runId: first.request.runId, threadId: 'review-thread', hostId: 'codex-host-a' };
      await engine.reportExecution({ ...receipt, reportId: 'review-running', state: 'running' });
      await engine.updateReview(reviewUpdate(taskId, { expectedRevision: engine.getTask(taskId).review!.revision }));
      await engine.reportExecution({ ...receipt, reportId: 'review-completed', state: 'completed' });
      const fix = await engine.requestExecution({
        id: taskId, boardId: 'default', requestId: 'impl-before-inconsistent', action: 'continue', workspaceMode: 'project',
      });
      // 覆盖旧数据或部分同步导致的两套状态不一致，不能依赖它们总是一起变化。
      store.mutateTask(taskId, (task) => ({ ...task,
        reviewExecution: { ...task.reviewExecution!, state: blockedField === 'execution' ? 'blocked' : 'completed' },
        executionRequests: task.executionRequests!.map((request) => request.runId === first.request.runId
          ? { ...request, status: blockedField === 'request' ? 'blocked' : 'completed',
            ...(blockedField === 'request' ? { deliveryError: '验收状态同步受阻' } : {}) } : request),
      }));
      const before = readFileSync(file, 'utf8');
      await assert.rejects(engine.requestExecution({
        id: taskId, boardId: 'default', requestId: 'impl-after-inconsistent', action: 'continue', workspaceMode: 'project',
      }), rejectsCode('EXECUTION_CONFLICT'));
      await assert.rejects(engine.claimExecution({
        id: taskId, boardId: 'default', requestId: fix.request.requestId, runId: fix.request.runId,
        claimId: 'impl-claim-2', hostId: 'codex-host-a', receiverThreadId: 'impl-thread',
      }), rejectsCode('EXECUTION_CONFLICT'));
      assert.equal(readFileSync(file, 'utf8'), before);
    });
  }
});

test('验收复查绑定后消息明确拒绝恢复 idle，保留待复查状态并复用原验收聊天', async () => {
  const fixture = makeFixture();
  const { engine, file } = fixture;
  const { taskId } = await taskInReview(fixture);
  const first = await engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'review-original', action: 'start', workspaceMode: 'existing', purpose: 'review',
  });
  await bindReview(fixture, first.request);
  const receipt = { id: taskId, boardId: 'default', requestId: first.request.requestId, runId: first.request.runId, threadId: 'review-thread', hostId: 'codex-host-a' };
  await engine.reportExecution({ ...receipt, reportId: 'review-running', state: 'running' });
  await engine.updateReview(reviewUpdate(taskId, { expectedRevision: engine.getTask(taskId).review!.revision }));
  await engine.reportExecution({ ...receipt, reportId: 'review-completed', state: 'completed' });
  await engine.updateReview(reviewUpdate(taskId, { expectedRevision: engine.getTask(taskId).review!.revision, status: 'recheck_pending' }));
  const input: RequestExecutionInput = { id: taskId, boardId: 'default', requestId: 'review-recheck', action: 'continue', workspaceMode: 'existing', purpose: 'review' };
  const recheck = await engine.requestExecution(input);
  await bindReview(fixture, recheck.request);
  const before = engine.getTask(taskId);
  const rejection = { id: taskId, boardId: 'default', requestId: recheck.request.requestId, runId: recheck.request.runId,
    claimId: 'review-claim', status: 'rejected' as const, error: '自动审批拒绝发送复查消息，未投递' };
  const rejected = await engine.markExecutionDelivery(rejection);
  assert.equal(rejected.request.status, 'rejected');
  assert.equal(rejected.task.reviewExecution?.state, 'idle');
  assert.equal(rejected.task.reviewExecution?.startedAt, undefined);
  assert.equal(rejected.task.reviewExecution?.runId, recheck.request.runId);
  assert.deepEqual(rejected.task.review, before.review);
  assert.deepEqual(rejected.task.reviewBinding, before.reviewBinding);
  assert.deepEqual(rejected.task.execution, before.execution);
  assert.deepEqual(rejected.request.result, before.executionRequests!.at(-1)!.result);
  assert.equal(new JsonFileBoardStore(file).getTask(taskId)!.executionRequests!.at(-1)!.status, 'rejected');
  const after = readFileSync(file, 'utf8');
  await engine.markExecutionDelivery(rejection);
  assert.equal(readFileSync(file, 'utf8'), after);
  const next = await engine.requestExecution({ ...input, requestId: 'user-new-review' });
  assert.equal(next.created, true);
  assert.notEqual(next.request.runId, recheck.request.runId);
  assert.deepEqual(next.task.reviewBinding, before.reviewBinding);
  assert.equal(next.task.review?.status, 'recheck_pending');
  assert.equal(next.task.review?.rounds.length, 1);
  await assert.rejects(engine.markExecutionDelivery(rejection), rejectsCode('EXECUTION_STALE'));
});

test('首次验收任意准备阶段分发失败后可以重新发起，并复用已知验收结果', async (t) => {
  for (const phase of ['claimed', 'created', 'bound'] as const) {
    await t.test(phase, async () => {
      const fixture = makeFixture();
      const { engine, file } = fixture;
      const { taskId } = await taskInReview(fixture);
      const input: RequestExecutionInput = { id: taskId, boardId: 'default', requestId: 'review-start', action: 'start', workspaceMode: 'existing', purpose: 'review', model: 'review-model' };
      const first = await engine.requestExecution(input);
      const receipt = { id: taskId, boardId: 'default', requestId: first.request.requestId, runId: first.request.runId };
      await engine.claimExecution({ ...receipt, claimId: 'review-claim', hostId: 'codex-host-a', receiverThreadId: 'review-receiver' });
      const binding = { ...receipt, claimId: 'review-claim', threadId: 'review-thread', hostId: 'codex-host-a', workspacePath: '/repos/a', workspaceOwner: 'user' as const };
      if (phase !== 'claimed') await engine.bindExecution({ ...binding, phase: 'created' });
      if (phase === 'bound') await engine.bindExecution({ ...binding, phase: 'bound' });
      const before = engine.getTask(taskId);
      const rejected = await engine.markExecutionDelivery({ ...receipt, claimId: 'review-claim', status: 'rejected', error: '验收准备分发失败，目标未接手' });
      assert.equal(rejected.task.reviewExecution?.state, 'idle');
      assert.equal(rejected.task.review?.status, 'pending');
      assert.equal(rejected.task.review?.rounds.length, 0);
      assert.deepEqual(rejected.task.reviewBinding, before.reviewBinding);
      assert.deepEqual(rejected.request.result, before.executionRequests!.at(-1)!.result);
      assert.equal(new JsonFileBoardStore(file).getTask(taskId)!.executionRequests!.at(-1)!.status, 'rejected');
      if (rejected.request.result) {
        await assert.rejects(engine.requestExecution({ ...input, requestId: 'changed-model', model: 'other-model' }), rejectsCode('EXECUTION_CONFLICT'));
      }
      const next = await engine.requestExecution({ ...input, requestId: 'user-new-review', model: undefined });
      assert.equal(next.created, true);
      if (rejected.request.result) {
        assert.deepEqual(next.request.result, rejected.request.result);
        assert.deepEqual(next.request.recoveryOf, { requestId: first.request.requestId, runId: first.request.runId });
        assert.equal(next.request.model, 'review-model');
        assert.equal((await engine.requestExecution({ ...input, requestId: 'user-new-review', model: undefined })).created, false);
        assert.equal((await engine.requestExecution({ ...input, requestId: 'same-recovery-intent', model: undefined })).created, false);
      }
      await bindReview(fixture, next.request);
      await engine.reportExecution({ id: taskId, boardId: 'default', requestId: next.request.requestId, runId: next.request.runId,
        threadId: 'review-thread', hostId: 'codex-host-a', reportId: 'review-running', state: 'running' });
      assert.equal(engine.getTask(taskId).review?.rounds.length, 1);
      assert.equal(engine.getTask(taskId).review?.status, 'reviewing');
    });
  }
});

test('完整 Review 闭环：独立会话/同工作区，多轮结论留存，任务保留在 review 列', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const { taskId } = await taskInReview(fixture);

  // 进入 review 列即惰性 pending，不自动创建 Reviewer、不自动选择工作区
  let task = engine.getTask(taskId);
  assert.equal(task.review?.status, 'pending');
  assert.equal(task.reviewBinding, undefined);
  assert.equal(task.reviewExecution, undefined);

  // 首次 Review 请求：服务端解析实现工作区并锁定到请求，可指定模型
  const first = await engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'review-request-1', action: 'start', workspaceMode: 'existing',
    purpose: 'review', model: 'gpt-review',
  });
  assert.equal(first.request.purpose, 'review');
  assert.equal(first.request.workspacePath, '/repos/a');
  assert.equal(first.request.model, 'gpt-review');
  assert.equal(engine.getTask(taskId).reviewExecution?.state, 'starting');
  // 实现执行状态不被 review 请求覆盖
  assert.equal(engine.getTask(taskId).execution.state, 'completed');
  assert.equal(engine.getTask(taskId).execution.runId !== first.request.runId, true);

  // review 绑定：不同线程 + 同一实现工作区
  const bound = await bindReview(fixture, first.request);
  assert.equal(bound.task.reviewBinding?.threadId, 'review-thread');
  assert.equal(bound.task.reviewBinding?.workspacePath, '/repos/a');
  assert.equal(bound.task.executionBinding?.threadId, 'impl-thread');

  // 真实 running 回执：开 Round #1 + reviewing；重复 running 不重复开轮
  const reviewReceipt = { id: taskId, boardId: 'default', requestId: first.request.requestId, runId: first.request.runId };
  const running = await engine.reportExecution({
    ...reviewReceipt, threadId: 'review-thread', hostId: 'codex-host-a', reportId: 'review-running-1', state: 'running',
  });
  assert.equal(running.task.reviewExecution?.state, 'running');
  assert.equal(running.task.review?.status, 'reviewing');
  assert.equal(running.task.review?.rounds.length, 1);
  assert.equal(running.task.review?.rounds[0].number, 1);
  assert.equal(running.task.execution.state, 'completed'); // implementation 状态不被覆盖
  await engine.reportExecution({
    ...reviewReceipt, threadId: 'review-thread', hostId: 'codex-host-a', reportId: 'review-running-2', state: 'running',
    activity: '复查进行中',
  });
  assert.equal(engine.getTask(taskId).review?.rounds.length, 1);

  // reviewer 结论：关闭 Round #1
  const revisionAfterRunning = engine.getTask(taskId).review!.revision;
  const changes = await engine.updateReview(reviewUpdate(taskId, {
    expectedRevision: revisionAfterRunning, status: 'changes_requested', conclusion: '缺少边界测试',
    actor: { type: 'agent', provider: 'codex-desktop', sessionId: 'review-thread' },
  }));
  assert.equal(changes.task.review?.status, 'changes_requested');
  assert.equal(changes.task.review?.rounds[0].status, 'changes_requested');
  assert.equal(changes.task.review?.rounds[0].conclusion, '缺少边界测试');
  assert.equal(changes.task.review?.rounds[0].completedAt !== undefined, true);
  assert.equal(changes.task.review?.activeRoundId, undefined);
  assert.equal(changes.task.status, 'review'); // 返工不移动看板列
  // Reviewer 执行完成：结论已记录，验收请求进入终态
  await engine.reportExecution({
    ...reviewReceipt, threadId: 'review-thread', hostId: 'codex-host-a', reportId: 'review-completed-1', state: 'completed',
  });

  // 继续修改：复用实现会话；真实 running 回执把 Review 推进到 fixing
  const fix = await engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'impl-request-2', action: 'continue', workspaceMode: 'project',
    message: '根据 Review Round #1 的结论继续修改当前任务。',
  });
  const fixReceipt = { id: taskId, boardId: 'default', requestId: fix.request.requestId, runId: fix.request.runId };
  await engine.claimExecution({ ...fixReceipt, claimId: 'impl-claim-2', hostId: 'codex-host-a', receiverThreadId: 'impl-thread' });
  await engine.bindExecution({
    ...fixReceipt, claimId: 'impl-claim-2', phase: 'created', threadId: 'impl-thread', hostId: 'codex-host-a',
    workspacePath: '/repos/a', workspaceOwner: 'user',
  });
  await engine.bindExecution({
    ...fixReceipt, claimId: 'impl-claim-2', phase: 'bound', threadId: 'impl-thread', hostId: 'codex-host-a',
    workspacePath: '/repos/a', workspaceOwner: 'user',
  });
  const fixing = await engine.reportExecution({
    ...fixReceipt, threadId: 'impl-thread', hostId: 'codex-host-a', reportId: 'impl-running-2', state: 'running',
  });
  assert.equal(fixing.task.review?.status, 'fixing');
  assert.equal(fixing.task.status, 'review');

  // execution completed 不自动推断满足 Review 修复要求
  await engine.reportExecution({
    ...fixReceipt, threadId: 'impl-thread', hostId: 'codex-host-a', reportId: 'impl-completed-2', state: 'completed',
  });
  assert.equal(engine.getTask(taskId).review?.status, 'fixing');
  await engine.updateReview(reviewUpdate(taskId, {
    expectedRevision: engine.getTask(taskId).review!.revision, status: 'recheck_pending',
    actor: { type: 'agent', provider: 'codex-desktop', sessionId: 'impl-thread' },
  }));
  assert.equal(engine.getTask(taskId).review?.status, 'recheck_pending');

  // 复查：continue 复用 reviewBinding，禁止传模型
  await assert.rejects(engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'review-request-2-bad', action: 'continue', workspaceMode: 'existing',
    purpose: 'review', model: 'other-model',
  }), rejectsCode('VALIDATION'));
  const recheck = await engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'review-request-2', action: 'continue', workspaceMode: 'existing',
    purpose: 'review', message: '继续验收当前 TaskLane 修改。',
  });
  assert.equal(recheck.request.workspacePath, '/repos/a');
  await bindReview(fixture, recheck.request);
  const recheckRunning = await engine.reportExecution({
    id: taskId, boardId: 'default', requestId: recheck.request.requestId, runId: recheck.request.runId,
    threadId: 'review-thread', hostId: 'codex-host-a', reportId: 'review-running-3', state: 'running',
  });
  // Round #2 创建，Round #1 结论留存
  assert.equal(recheckRunning.task.review?.rounds.length, 2);
  assert.equal(recheckRunning.task.review?.rounds[1].number, 2);
  assert.equal(recheckRunning.task.review?.rounds[0].conclusion, '缺少边界测试');

  // review completed ≠ approved
  await engine.reportExecution({
    id: taskId, boardId: 'default', requestId: recheck.request.requestId, runId: recheck.request.runId,
    threadId: 'review-thread', hostId: 'codex-host-a', reportId: 'review-completed', state: 'completed',
  });
  assert.equal(engine.getTask(taskId).review?.status, 'reviewing');

  // approved 须非空结论；approved 不自动移动 Done
  await assert.rejects(engine.updateReview(reviewUpdate(taskId, {
    expectedRevision: engine.getTask(taskId).review!.revision, status: 'approved', conclusion: '  ',
  })), rejectsCode('VALIDATION'));
  const approved = await engine.updateReview(reviewUpdate(taskId, {
    expectedRevision: engine.getTask(taskId).review!.revision, status: 'approved', conclusion: '修改已满足要求',
  }));
  assert.equal(approved.task.review?.status, 'approved');
  assert.equal(approved.task.status, 'review');
  assert.equal(approved.task.review?.rounds[1].conclusion, '修改已满足要求');

  // 时间线记录 review 事件
  const kinds = engine.getTaskWithTimeline(taskId).timeline.map((event) => event.kind);
  assert.equal(kinds.includes('review_round'), true);
  assert.equal(kinds.includes('review_updated'), true);
});

test('Review 会话禁止复用实现聊天（created 与 bound 双阶段拦截）', async () => {
  const fixture = makeFixture();
  const { taskId } = await taskInReview(fixture);
  const first = await fixture.engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'review-request-1', action: 'start', workspaceMode: 'existing', purpose: 'review',
  });
  const receipt = { id: taskId, boardId: 'default', requestId: first.request.requestId, runId: first.request.runId };
  await fixture.engine.claimExecution({ ...receipt, claimId: 'review-claim', hostId: 'codex-host-a', receiverThreadId: 'impl-thread' });
  await assert.rejects(fixture.engine.bindExecution({
    ...receipt, claimId: 'review-claim', phase: 'created', threadId: 'impl-thread', hostId: 'codex-host-a',
    workspacePath: '/repos/a', workspaceOwner: 'user',
  }), rejectsCode('EXECUTION_CONFLICT'));
});

test('Review 工作区守卫：无来源 REQUIRED、来源冲突 CONFLICT', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  // 无任何实现工作区来源：board.repo 不是猜测来源
  const bare = await engine.createTask({ title: '无工作区任务', status: 'review' });
  await assert.rejects(engine.requestExecution({
    id: bare.id, boardId: 'default', requestId: 'review-no-ws', action: 'start', workspaceMode: 'existing', purpose: 'review',
  }), rejectsCode('REVIEW_WORKSPACE_REQUIRED'));

  // executionBinding 与 externalExecutionSession 指向不同目录 → 冲突
  const { taskId } = await taskInReview(fixture, { workspacePath: '/worktrees/a', workspaceMode: 'worktree' });
  await engine.bindExternalSession({
    id: taskId, boardId: 'default', provider: 'claude-code', sessionId: 'conv-123',
    workspacePath: '/repos/a', workspaceOwner: 'user',
  });
  await assert.rejects(engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'review-conflict', action: 'start', workspaceMode: 'existing', purpose: 'review',
  }), rejectsCode('REVIEW_WORKSPACE_CONFLICT'));
});

test('Review continue 工作区漂移被拒绝：实现上下文改变后不能沿用旧 reviewBinding', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const { taskId } = await taskInReview(fixture, { workspacePath: '/worktrees/a', workspaceMode: 'worktree' });
  const first = await engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'review-request-1', action: 'start', workspaceMode: 'existing', purpose: 'review',
  });
  await bindReview(fixture, first.request, { workspacePath: '/worktrees/a', workspaceOwner: 'codex', branch: 'codex/task-a' });
  await engine.reportExecution({
    id: taskId, boardId: 'default', requestId: first.request.requestId, runId: first.request.runId,
    threadId: 'review-thread', hostId: 'codex-host-a', reportId: 'review-running', state: 'running',
  });
  await engine.updateReview(reviewUpdate(taskId, {
    expectedRevision: engine.getTask(taskId).review!.revision, status: 'changes_requested', conclusion: '问题',
  }));
  await engine.updateReview(reviewUpdate(taskId, {
    expectedRevision: engine.getTask(taskId).review!.revision, status: 'recheck_pending',
  }));
  // 模拟人为迁移实现上下文：实现绑定与旧工作区清空，只剩指向主仓库的外部会话
  fixture.store.mutateTask(taskId, (task) => {
    delete task.executionBinding;
    delete task.worktreePath;
    task.externalExecutionSession = {
      provider: 'claude-code', sessionId: 'conv-456', workspacePath: '/repos/a', workspaceOwner: 'user',
      boundAt: task.updatedAt, updatedAt: task.updatedAt,
    };
    return task;
  });
  await assert.rejects(engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'review-request-2', action: 'continue', workspaceMode: 'existing', purpose: 'review',
  }), rejectsCode('REVIEW_WORKSPACE_CONFLICT'));
});

test('task_review_update CAS：相同 expectedRevision 只允许一次成功', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const { taskId } = await taskInReview(fixture);
  const first = await engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'review-request-1', action: 'start', workspaceMode: 'existing', purpose: 'review',
  });
  await bindReview(fixture, first.request);
  await engine.reportExecution({
    id: taskId, boardId: 'default', requestId: first.request.requestId, runId: first.request.runId,
    threadId: 'review-thread', hostId: 'codex-host-a', reportId: 'review-running', state: 'running',
  });
  const revision = engine.getTask(taskId).review!.revision;
  await engine.updateReview(reviewUpdate(taskId, { expectedRevision: revision, status: 'changes_requested', conclusion: 'A 的结论' }));
  // B 基于旧 revision 提交 approved → REVIEW_STALE，不覆盖 A
  await assert.rejects(engine.updateReview(reviewUpdate(taskId, {
    expectedRevision: revision, status: 'approved', conclusion: 'B 的结论',
  })), rejectsCode('REVIEW_STALE'));
  const review = engine.getTask(taskId).review!;
  assert.equal(review.status, 'changes_requested');
  assert.equal(review.rounds[0]?.conclusion, 'A 的结论');
});

test('reviewing / fixing 显式更新不得绕过真实 running 回执；非法流转被拒', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const { taskId } = await taskInReview(fixture);
  // 未启动验收会话时不能直接置 reviewing
  await assert.rejects(engine.updateReview(reviewUpdate(taskId, { status: 'reviewing' })), rejectsCode('EXECUTION_CONFLICT'));
  // approved 只能从 reviewing 进入
  await assert.rejects(engine.updateReview(reviewUpdate(taskId, { status: 'approved', conclusion: 'x' })), rejectsCode('EXECUTION_CONFLICT'));
  // fixing 只能从 changes_requested 进入
  await assert.rejects(engine.updateReview(reviewUpdate(taskId, { status: 'fixing' })), rejectsCode('EXECUTION_CONFLICT'));
  // 非 review 列任务不能更新 Review 状态
  const doing = await engine.createTask({ title: '实现中任务', status: 'doing' });
  await assert.rejects(engine.updateReview(reviewUpdate(doing.id, { status: 'recheck_pending' })), rejectsCode('VALIDATION'));
});

test('review 请求守卫：非法动作 / worktree 模式 / 已有绑定再 start / 非 review 列', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const { taskId } = await taskInReview(fixture);
  await assert.rejects(engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'review-reply', action: 'reply', workspaceMode: 'existing', purpose: 'review', message: 'hi',
  }), rejectsCode('VALIDATION'));
  await assert.rejects(engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'review-worktree', action: 'start', workspaceMode: 'worktree', purpose: 'review',
  }), rejectsCode('VALIDATION'));
  const first = await engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'review-request-1', action: 'start', workspaceMode: 'existing', purpose: 'review',
  });
  await bindReview(fixture, first.request);
  // 已有 reviewBinding 后再 start 拒绝
  await assert.rejects(engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'review-request-again', action: 'start', workspaceMode: 'existing', purpose: 'review',
  }), rejectsCode('EXECUTION_CONFLICT'));
  // 回到 doing 后不能继续验收
  await engine.moveTask(taskId, 'doing');
  await assert.rejects(engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'review-doing', action: 'continue', workspaceMode: 'existing', purpose: 'review',
  }), rejectsCode('VALIDATION'));
});

test('外部会话记录：opaque sessionId、仓库校验、force 覆盖与活跃执行守卫', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const { taskId } = await taskInReview(fixture);
  // provider 冒充 codex-desktop 拒绝
  await assert.rejects(engine.bindExternalSession({
    id: taskId, boardId: 'default', provider: 'codex-desktop', sessionId: 'thread-1',
    workspacePath: '/repos/a', workspaceOwner: 'user',
  }), rejectsCode('VALIDATION'));
  // 其他仓库工作区拒绝
  await assert.rejects(engine.bindExternalSession({
    id: taskId, boardId: 'default', provider: 'claude-code', sessionId: 'conv-1',
    workspacePath: '/repos/b', workspaceOwner: 'user',
  }), rejectsCode('GIT_ERROR'));
  // 正常记录：不写 threadId、不推断 running（implementation 已完成保持 completed）
  const bound = await engine.bindExternalSession({
    id: taskId, boardId: 'default', provider: 'claude-code', sessionId: 'sess-内部标识-1',
    workspacePath: '/repos/a', workspaceOwner: 'user',
  });
  assert.equal(bound.task.externalExecutionSession?.sessionId, 'sess-内部标识-1');
  assert.equal(bound.task.executionBinding?.threadId, 'impl-thread');
  assert.equal(bound.task.execution.state, 'completed');
  // 内容变化（新增 branch）无 force → 冲突
  await assert.rejects(engine.bindExternalSession({
    id: taskId, boardId: 'default', provider: 'claude-code', sessionId: 'sess-内部标识-1',
    workspacePath: '/repos/a', workspaceOwner: 'user', branch: 'main',
  }), rejectsCode('EXECUTION_CONFLICT'));
  // 换 provider/session 且无 force → 冲突
  await assert.rejects(engine.bindExternalSession({
    id: taskId, boardId: 'default', provider: 'cursor-agent', sessionId: 'conv-9',
    workspacePath: '/repos/a', workspaceOwner: 'user',
  }), rejectsCode('EXECUTION_CONFLICT'));
  // 存在待确认请求时 force 替换仍被拒
  await engine.requestExecution({
    id: taskId, boardId: 'default', requestId: 'impl-request-2', action: 'continue', workspaceMode: 'project',
  });
  await assert.rejects(engine.bindExternalSession({
    id: taskId, boardId: 'default', provider: 'cursor-agent', sessionId: 'conv-9',
    workspacePath: '/repos/a', workspaceOwner: 'user', force: true,
  }), rejectsCode('EXECUTION_CONFLICT'));
});

test('v5 → v7 迁移：热数据补 purpose，归档 v1 重写为 v3，备份保留原始字节', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'tasklane-mig-'));
  const file = path.join(home, 'board.json');
  const at = '2026-10-05T00:00:00.000Z';
  const v5 = {
    version: 5,
    boards: [{ id: 'default', name: 'Default Board', repo: '/repos/a', baseBranch: 'main', repoKey: '/repos/a/.git' }],
    tasks: {
      'TASK-1': {
        id: 'TASK-1', boardId: 'default', title: '旧实现任务', status: 'review', priority: 'P2', assignee: 'agent',
        execution: { state: 'running', runId: 'run-1' },
        executionRequests: [{
          requestId: 'request-1', runId: 'run-1', taskId: 'TASK-1', boardId: 'default',
          action: 'start', workspaceMode: 'project', repo: '/repos/a', status: 'running',
          requestedAt: at, updatedAt: at,
        }],
        createdAt: at, updatedAt: at,
      },
    },
    sessions: {},
    seq: 100,
    archivedCounts: { default: 1 },
  };
  writeFileSync(file, JSON.stringify(v5));
  mkdirSync(path.join(home, 'archive'), { recursive: true });
  const cold = path.join(home, 'archive', 'default.json');
  writeFileSync(cold, JSON.stringify({
    version: 1, boardId: 'default',
    tasks: {
      'TASK-9': {
        id: 'TASK-9', boardId: 'default', title: '已归档', status: 'done', priority: 'P2', assignee: 'human',
        archivedAt: at, execution: { state: 'completed' },
        executionRequests: [{
          requestId: 'request-9', runId: 'run-9', taskId: 'TASK-9', boardId: 'default',
          action: 'start', workspaceMode: 'project', repo: '/repos/a', status: 'completed',
          requestedAt: at, updatedAt: at,
        }],
        createdAt: at, updatedAt: at,
      },
    },
    sessions: {},
  }));
  const store = new JsonFileBoardStore(file);
  const engine = new BoardEngine(store, new GitService(false));
  const hot = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(hot.version, 7);
  // v7 回填项目目录身份：Git 看板 projectDir 等于主仓库根
  assert.equal(hot.boards[0].projectDir, '/repos/a');
  assert.equal(hot.tasks['TASK-1'].executionRequests[0]?.purpose, 'implementation');
  // 旧 review 列任务不自动假设已验收：磁盘无 review 字段，读取惰性 pending
  assert.equal(hot.tasks['TASK-1'].review, undefined);
  assert.equal(engine.getTask('TASK-1').review?.status, 'pending');
  const coldData = JSON.parse(readFileSync(cold, 'utf8'));
  assert.equal(coldData.version, 3);
  assert.equal(coldData.tasks['TASK-9'].executionRequests[0]?.purpose, 'implementation');
  // 备份保留 v5 原始内容，可回滚
  const backup = JSON.parse(readFileSync(`${file}.v5.bak`, 'utf8'));
  assert.deepEqual(backup, v5);
});
