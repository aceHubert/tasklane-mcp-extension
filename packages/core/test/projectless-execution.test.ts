import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BoardEngine,
  BoardError,
  GitService,
  JsonFileBoardStore,
  type BindExecutionInput,
  type ExecutionRequest,
  type RepoValidation,
  type ReportExecutionInput,
  type RequestExecutionInput,
} from '../src/index.js';

/**
 * 无项目执行（projectless）：default 看板 repo 为空也可启动任务。
 * Git 桩上没有任何仓库身份——projectless 全链路不允许调用 Git 校验。
 */
class NoRepoGitService extends GitService {
  readonly identifyCalls: string[] = [];

  constructor() {
    super(true);
  }

  override async identifyRepo(repoInput: string): Promise<RepoValidation> {
    this.identifyCalls.push(repoInput);
    throw new BoardError('GIT_ERROR', `执行目录不是有效 Git 工作区: ${repoInput}`);
  }

  override async probeRepo(repoInput: string): Promise<RepoValidation | null> {
    this.identifyCalls.push(repoInput);
    return null;
  }
}

function makeFixture() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tasklane-projectless-')), 'board.json');
  const store = new JsonFileBoardStore(file);
  const git = new NoRepoGitService();
  let tick = 0;
  const engine = new BoardEngine(store, git, () => new Date(Date.UTC(2026, 9, 5) + tick++ * 1000));
  return { engine, store, git, file };
}

type Fixture = ReturnType<typeof makeFixture>;

function requestInput(id: string, overrides: Partial<RequestExecutionInput> = {}): RequestExecutionInput {
  return {
    id, boardId: 'default', requestId: 'request-p1', action: 'start', workspaceMode: 'projectless',
    hostId: 'codex-host-p', receiverThreadId: 'receiver-thread-p', ...overrides,
  };
}

function receipt(request: ExecutionRequest) {
  return { id: request.taskId, boardId: request.boardId, requestId: request.requestId, runId: request.runId };
}

function bindInput(request: ExecutionRequest, overrides: Partial<BindExecutionInput> = {}): BindExecutionInput {
  return {
    ...receipt(request), claimId: 'claim-p', phase: 'created', threadId: 'native-thread-p',
    hostId: request.receiver?.hostId ?? request.hostId!, workspacePath: undefined, workspaceOwner: undefined,
    ...overrides,
  } as BindExecutionInput;
}

function reportInput(request: ExecutionRequest, overrides: Partial<ReportExecutionInput> = {}): ReportExecutionInput {
  return {
    ...receipt(request), threadId: 'native-thread-p', hostId: request.receiver?.hostId ?? request.hostId!,
    reportId: 'report-p1', state: 'running', ...overrides,
  };
}

function rejectsCode(code: BoardError['code']) {
  return (err: unknown) => err instanceof BoardError && err.code === code;
}

test('projectless 请求：repo 为空持久化；project/worktree 模式在无项目看板被拒绝', async () => {
  const fixture = makeFixture();
  const { engine, git } = fixture;
  const task = await engine.createTask({ title: '无项目任务', status: 'ready' });

  await assert.rejects(engine.requestExecution(requestInput(task.id, { workspaceMode: 'project' })), rejectsCode('VALIDATION'));
  await assert.rejects(engine.requestExecution(requestInput(task.id, { workspaceMode: 'worktree' })), rejectsCode('VALIDATION'));
  await assert.rejects(engine.requestExecution(requestInput(task.id, { workspaceMode: 'existing' })), rejectsCode('VALIDATION'));

  const result = await engine.requestExecution(requestInput(task.id));
  assert.equal(result.created, true);
  assert.equal(result.request.repo, null);
  assert.equal(result.request.workspaceMode, 'projectless');
  assert.equal(result.task.assignee, 'agent');
  assert.equal(result.task.execution.state, 'starting');
  assert.deepEqual(git.identifyCalls, []);
});

test('projectless 绑定：created/bound 不带工作区；不记录工作区/分支；回执照常', async () => {
  const fixture = makeFixture();
  const { engine, store, git } = fixture;
  const task = await engine.createTask({ title: '无项目绑定', status: 'ready' });
  const { request } = await engine.requestExecution(requestInput(task.id));
  await engine.claimExecution({ ...receipt(request), claimId: 'claim-p' });

  const created = await engine.bindExecution(bindInput(request));
  assert.equal(created.request.status, 'created');
  assert.equal(created.request.result!.workspacePath, undefined);
  assert.equal(created.request.result!.workspaceOwner, undefined);
  assert.deepEqual(git.identifyCalls, []);

  // 无项目执行不记录工作区：携带 workspacePath/branch 的绑定被拒绝
  const workDir = mkdtempSync(path.join(tmpdir(), 'tasklane-ws-'));
  await assert.rejects(
    engine.bindExecution(bindInput(request, { phase: 'bound', workspacePath: workDir, workspaceOwner: 'user' })),
    rejectsCode('VALIDATION'),
  );
  await assert.rejects(
    engine.bindExecution(bindInput(request, { branch: 'fake' })),
    rejectsCode('VALIDATION'),
  );
  assert.equal(store.getTask(task.id)!.executionBinding, undefined);

  // 不带工作区完成 bound 与真实执行回执（running 来自目标聊天）
  await engine.bindExecution(bindInput(request, { phase: 'bound' }));
  const running = await engine.reportExecution(reportInput(request));
  assert.equal(running.request.status, 'running');
  assert.equal(running.task.execution.state, 'running');
  assert.equal(running.task.status, 'doing'); // 首个 running 原子移列
  assert.equal(running.task.executionBinding!.workspacePath, undefined);
  assert.equal(running.task.executionBinding!.provider, 'codex-desktop');
  assert.deepEqual(git.identifyCalls, []); // projectless 绑定不调用 Git 校验

  // 幂等重放相同结果
  const replay = await engine.bindExecution(bindInput(request, { phase: 'bound' }));
  assert.equal(replay.request.status, 'running');
});

test('projectless 任务不参与 Review 流转：review 请求与外部会话记录均被拒绝', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const task = await engine.createTask({ title: '无项目验收', status: 'ready' });
  const { request } = await engine.requestExecution(requestInput(task.id));
  await engine.claimExecution({ ...receipt(request), claimId: 'claim-p' });
  await engine.bindExecution(bindInput(request));
  await engine.bindExecution(bindInput(request, { phase: 'bound' }));
  await engine.reportExecution(reportInput(request));
  await engine.reportExecution(reportInput(request, { reportId: 'report-p2', state: 'completed' }));
  await engine.moveTask(task.id, 'review');

  // 无项目任务不参与 Review 流转：独立验收执行直接拒绝
  await assert.rejects(
    engine.requestExecution(requestInput(task.id, { requestId: 'review-1', purpose: 'review', action: 'start', workspaceMode: 'existing' })),
    rejectsCode('VALIDATION'),
  );
  // 外部会话绑定（工作区记录）同样不支持无项目任务
  const workDir = mkdtempSync(path.join(tmpdir(), 'tasklane-review-ws-'));
  await assert.rejects(
    engine.bindExternalSession({
      id: task.id, boardId: 'default', provider: 'claude-code', sessionId: 's1',
      workspacePath: workDir, workspaceOwner: 'user',
    }),
    rejectsCode('VALIDATION'),
  );

  // 跨 Agent 的 task_review_update 写入同样被拒绝（锁内按看板身份守卫）
  const reviewView = engine.getTask(task.id)!;
  await assert.rejects(
    engine.updateReview({
      id: task.id, boardId: 'default', expectedRevision: reviewView.review?.revision ?? 0,
      status: 'approved', conclusion: '试图误写结论',
    }),
    rejectsCode('VALIDATION'),
  );
  assert.equal(engine.getTask(task.id)!.reviewExecution, undefined);
});

test('projectless 续接：continue/reply/retry 复用原聊天，repo 为空不阻止执行', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const task = await engine.createTask({ title: '无项目续接', status: 'ready' });
  const { request } = await engine.requestExecution(requestInput(task.id));
  await engine.claimExecution({ ...receipt(request), claimId: 'claim-p' });
  await engine.bindExecution(bindInput(request));
  await engine.bindExecution(bindInput(request, { phase: 'bound' }));
  await engine.reportExecution(reportInput(request));
  await engine.reportExecution(reportInput(request, { reportId: 'report-p2', state: 'waiting' }));

  const reply = await engine.requestExecution(requestInput(task.id, {
    requestId: 'request-p2', action: 'reply', workspaceMode: 'projectless', message: '完整回复内容',
  }));
  assert.equal(reply.created, true);
  assert.equal(reply.request.repo, null);
  assert.equal(reply.request.workspaceMode, 'projectless');
  const latest = engine.getTask(task.id);
  assert.equal(latest!.executionBinding!.threadId, 'native-thread-p');
  assert.equal(latest!.execution.state, 'starting');
});

test('存储兼容：projectless 请求（repo=null、缺省工作区）可持久化并重新读取校验', async () => {
  const fixture = makeFixture();
  const { engine, file } = fixture;
  const task = await engine.createTask({ title: '持久化', status: 'ready' });
  const { request } = await engine.requestExecution(requestInput(task.id));
  await engine.claimExecution({ ...receipt(request), claimId: 'claim-p' });
  await engine.bindExecution(bindInput(request));
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.version, 7);
  const persisted = raw.tasks[task.id].executionRequests[0];
  assert.equal(persisted.repo, null);
  assert.ok(!('workspacePath' in persisted.result) && !('workspaceOwner' in persisted.result));

  // 重新打开存储完整读取（校验通过），续接不因缺省工作区失败
  const reopened = new BoardEngine(new JsonFileBoardStore(file), new NoRepoGitService());
  const again = reopened.getTask(task.id)!;
  assert.equal(again.executionRequests![0]!.repo, null);
  assert.equal(again.executionRequests![0]!.result!.workspacePath, undefined);
});
