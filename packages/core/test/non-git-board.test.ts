import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
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
 * 非 Git 项目看板：目录身份与 Git 身份分别表达。
 * probeRepo 可切换返回值，模拟"后续初始化 Git / 移除 Git"的能力动态变化。
 */
class ToggleGitService extends GitService {
  /** 目录 → 当前 Git 身份（null = 明确非 Git） */
  readonly probed: string[] = [];
  readonly identified: string[] = [];
  private readonly gitDirs = new Map<string, RepoValidation | null>();

  setDir(dir: string, identity: RepoValidation | null): void {
    this.gitDirs.set(dir, identity);
  }

  constructor() {
    super(true);
  }

  override async probeRepo(dirInput: string): Promise<RepoValidation | null> {
    this.probed.push(dirInput);
    const identity = this.gitDirs.get(dirInput);
    if (identity === undefined) {
      throw new BoardError('GIT_ERROR', `探测失败（未配置桩目录）: ${dirInput}`);
    }
    return identity ? { ...identity } : null;
  }

  override async identifyRepo(repoInput: string): Promise<RepoValidation> {
    this.identified.push(repoInput);
    const identity = this.gitDirs.get(repoInput);
    if (!identity) throw new BoardError('GIT_ERROR', `执行目录不是有效 Git 工作区: ${repoInput}`);
    return { ...identity };
  }

  override async validateRepoForBoard(repoInput: string): Promise<RepoValidation> {
    const identity = await this.probeRepo(repoInput);
    if (!identity) throw new BoardError('VALIDATION', `不是 Git 仓库: ${repoInput}`);
    return identity;
  }

  /** 测试目录统一用真实路径（macOS /var → /private/var），保证桩键与探测键一致 */
  trackDir(dir: string): string {
    const real = realpathSync(dir);
    this.gitDirs.set(dir, this.gitDirs.get(dir) ?? this.gitDirs.get(real) ?? null!);
    return real;
  }
}

function makeFixture() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tasklane-nongit-')), 'board.json');
  const store = new JsonFileBoardStore(file);
  const git = new ToggleGitService();
  let tick = 0;
  const engine = new BoardEngine(store, git, () => new Date(Date.UTC(2026, 9, 5) + tick++ * 1000));
  return { engine, store, git, file };
}

function rejectsCode(code: BoardError['code']) {
  return (err: unknown) => err instanceof BoardError && err.code === code;
}

test('registerBoard：非 Git 目录注册为项目看板；符号链接等价目录重复注册幂等', async () => {
  const fixture = makeFixture();
  const { engine, store } = fixture;
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'tasklane-dir-')));
  const projectDir = path.join(base, 'plain-project');
  mkdirSync(projectDir);
  fixture.git.setDir(projectDir, null);

  const board = await engine.registerBoard({ repo: projectDir });
  assert.equal(board.projectDir, projectDir);
  assert.equal(board.repo, null);
  assert.equal(board.repoKey, null);
  assert.equal(board.name, 'plain-project');

  // 符号链接等价目录：realPath 归一后去重，返回同一看板
  const linkDir = path.join(base, 'link-project');
  symlinkSync(projectDir, linkDir);
  fixture.git.setDir(linkDir, null);
  const dup = await engine.registerBoard({ repo: linkDir, name: '别名注册' });
  assert.equal(dup.id, board.id);
  assert.equal(dup.name, 'plain-project'); // 不改变已有名称
  assert.equal(store.boards.filter((b) => b.projectDir === projectDir).length, 1);

  // project 模式执行：请求 repo 锚定项目目录，不需要 Git
  const task = await engine.createTask({ title: '目录执行', boardId: board.id, status: 'ready' });
  const input: RequestExecutionInput = {
    id: task.id, boardId: board.id, requestId: 'request-ng1', action: 'start', workspaceMode: 'project',
    hostId: 'codex-host-ng', receiverThreadId: 'receiver-ng',
  };
  const result = await engine.requestExecution(input);
  assert.equal(result.request.repo, projectDir);
  await engine.claimExecution({ id: task.id, boardId: board.id, requestId: 'request-ng1', runId: result.request.runId, claimId: 'claim-ng' });
  const bind: BindExecutionInput = {
    id: task.id, boardId: board.id, requestId: 'request-ng1', runId: result.request.runId, claimId: 'claim-ng',
    phase: 'created', threadId: 'native-thread-ng', hostId: 'codex-host-ng',
    workspacePath: projectDir, workspaceOwner: 'user',
  };
  await engine.bindExecution(bind);
  await engine.bindExecution({ ...bind, phase: 'bound' });
  const running = await engine.reportExecution({
    id: task.id, boardId: board.id, requestId: 'request-ng1', runId: result.request.runId,
    threadId: 'native-thread-ng', hostId: 'codex-host-ng', reportId: 'report-ng1', state: 'running',
  });
  assert.equal(running.task.execution.state, 'running');
  assert.equal(running.task.executionBinding!.workspacePath, projectDir);
  assert.deepEqual(fixture.git.identified, []); // 非 Git 项目不调用 Git 身份校验
});

test('非 Git 项目：worktree 模式被拒绝；分支信息不能伪造', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'tasklane-dir-')));
  const projectDir = path.join(base, 'no-git');
  mkdirSync(projectDir);
  fixture.git.setDir(projectDir, null);
  const board = await engine.registerBoard({ repo: projectDir });
  const task = await engine.createTask({ title: 'worktree 拒绝', boardId: board.id, status: 'ready' });

  await assert.rejects(
    engine.requestExecution({
      id: task.id, boardId: board.id, requestId: 'request-wt', action: 'start', workspaceMode: 'worktree',
    }),
    rejectsCode('VALIDATION'),
  );
  assert.equal(engine.getTask(task.id)!.executionRequests, undefined); // 拒绝不产生请求

  const input: RequestExecutionInput = {
    id: task.id, boardId: board.id, requestId: 'request-ng2', action: 'start', workspaceMode: 'project',
    hostId: 'codex-host-x', receiverThreadId: 'receiver-ng',
  };
  const { request } = await engine.requestExecution(input);
  await engine.claimExecution({ id: task.id, boardId: board.id, requestId: 'request-ng2', runId: request.runId, claimId: 'claim-ng' });
  await engine.bindExecution({
    id: task.id, boardId: board.id, requestId: 'request-ng2', runId: request.runId, claimId: 'claim-ng',
    phase: 'created', threadId: 'native-thread-ng', hostId: 'codex-host-x',
    workspacePath: projectDir, workspaceOwner: 'user', branch: 'fake-branch',
  });
  await assert.rejects(
    engine.bindExecution({
      id: task.id, boardId: board.id, requestId: 'request-ng2', runId: request.runId, claimId: 'claim-ng',
      phase: 'bound', threadId: 'native-thread-ng', hostId: 'codex-host-x',
      workspacePath: projectDir, workspaceOwner: 'user', branch: 'fake-branch',
    }),
    rejectsCode('VALIDATION'),
  );
});

test('非 Git 项目：外部会话工作区必须是项目目录；Review 按项目目录解析', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'tasklane-dir-')));
  const projectDir = path.join(base, 'review-project');
  mkdirSync(projectDir);
  fixture.git.setDir(projectDir, null);
  const board = await engine.registerBoard({ repo: projectDir });
  const task = await engine.createTask({ title: '外部会话验收', boardId: board.id, status: 'ready' });

  // 外部会话：其他目录被拒绝
  const elsewhere = path.join(base, 'elsewhere');
  mkdirSync(elsewhere);
  await assert.rejects(
    engine.bindExternalSession({
      id: task.id, boardId: board.id, provider: 'claude-code', sessionId: 's1',
      workspacePath: elsewhere, workspaceOwner: 'user',
    }),
    rejectsCode('GIT_ERROR'),
  );
  await engine.bindExternalSession({
    id: task.id, boardId: board.id, provider: 'claude-code', sessionId: 's1',
    workspacePath: projectDir, workspaceOwner: 'user',
  });

  // Review：从外部会话记录解析项目目录，不要求 Git
  await engine.moveTask(task.id, 'doing');
  await engine.moveTask(task.id, 'review');
  const review = await engine.requestExecution({
    id: task.id, boardId: board.id, requestId: 'request-rv', action: 'start',
    workspaceMode: 'existing', purpose: 'review',
    hostId: 'codex-host-rv', receiverThreadId: 'receiver-rv',
  });
  assert.equal(review.request.workspacePath, projectDir);
  assert.equal(review.request.repo, projectDir);

  await engine.claimExecution({ id: task.id, boardId: board.id, requestId: 'request-rv', runId: review.request.runId, claimId: 'claim-rv' });
  const bind: BindExecutionInput = {
    id: task.id, boardId: board.id, requestId: 'request-rv', runId: review.request.runId, claimId: 'claim-rv',
    phase: 'created', threadId: 'native-thread-rv', hostId: 'codex-host-rv',
    workspacePath: projectDir, workspaceOwner: 'user',
  };
  await engine.bindExecution(bind);
  await engine.bindExecution({ ...bind, phase: 'bound' });
  const running = await engine.reportExecution({
    id: task.id, boardId: board.id, requestId: 'request-rv', runId: review.request.runId,
    threadId: 'native-thread-rv', hostId: 'codex-host-rv', reportId: 'report-rv1', state: 'running',
  } as ReportExecutionInput);
  assert.equal(running.task.review!.status, 'reviewing');
  assert.equal(running.task.review!.rounds[0].workspacePath, projectDir);
});

test('Git 能力动态刷新：初始化 Git 采纳身份保留 boardId；与其他看板同仓库记冲突', async () => {
  const fixture = makeFixture();
  const { engine, store } = fixture;
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'tasklane-dir-')));
  const projectDir = path.join(base, 'becomes-git');
  mkdirSync(projectDir);
  const identity: RepoValidation = { root: projectDir, repoKey: path.join(projectDir, '.git') };
  fixture.git.setDir(projectDir, null);
  const board = await engine.registerBoard({ repo: projectDir });
  const task = await engine.createTask({ title: '能力刷新', boardId: board.id });
  assert.equal(store.getBoard(board.id)!.repoKey, null);

  // 后续初始化 Git：下次刷新采纳仓库身份，boardId、任务与项目目录保持不变
  fixture.git.setDir(projectDir, identity);
  await engine.refreshBoardGitCapabilities();
  const refreshed = store.getBoard(board.id)!;
  assert.equal(refreshed.repoKey, identity.repoKey);
  assert.equal(refreshed.repo, projectDir);
  assert.equal(refreshed.projectDir, projectDir);
  assert.equal(refreshed.id, board.id);
  assert.equal(engine.getTask(task.id)!.boardId, board.id);

  // 另一非 Git 看板目录也初始化成同一仓库：身份冲突显式报告，不自动合并
  const otherDir = path.join(base, 'conflict-dir');
  mkdirSync(otherDir);
  fixture.git.setDir(otherDir, null);
  const other = await engine.registerBoard({ repo: otherDir });
  fixture.git.setDir(otherDir, identity);
  await engine.refreshBoardGitCapabilities();
  const conflicted = store.getBoard(other.id)!;
  assert.equal(conflicted.repoKey, null); // 不采纳
  assert.equal(conflicted.repo, null);
  assert.ok(conflicted.repoConflict?.includes(board.id));
  // 原看板不受影响
  assert.equal(store.getBoard(board.id)!.repoKey, identity.repoKey);

  // Git 被移除：下次刷新撤销能力，目录仍可用于目录执行
  fixture.git.setDir(projectDir, null);
  await engine.refreshBoardGitCapabilities();
  const demoted = store.getBoard(board.id)!;
  assert.equal(demoted.repoKey, null);
  assert.equal(demoted.repo, null);
  assert.equal(demoted.projectDir, projectDir);
  assert.equal(demoted.repoConflict, null);
});

test('resolveProjectBoard：非 Git 目录打开项目模式注册非 Git 看板，重复打开幂等', async () => {
  const fixture = makeFixture();
  const { engine } = fixture;
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'tasklane-dir-')));
  const projectDir = path.join(base, 'open-project');
  mkdirSync(projectDir);
  fixture.git.setDir(projectDir, null);

  const board = await engine.resolveProjectBoard({ repo: projectDir });
  assert.equal(board.projectDir, projectDir);
  assert.equal(board.repo, null);
  const again = await engine.resolveProjectBoard({ repo: projectDir });
  assert.equal(again.id, board.id);
});

test('能力刷新探测失败：目录不可访问记录冲突说明，不撤销已有能力', async () => {
  const fixture = makeFixture();
  const { engine, store } = fixture;
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'tasklane-dir-')));
  const projectDir = path.join(base, 'probe-fail');
  mkdirSync(projectDir);
  const identity: RepoValidation = { root: projectDir, repoKey: path.join(projectDir, '.git') };
  fixture.git.setDir(projectDir, identity);
  const board = await engine.registerBoard({ repo: projectDir });
  assert.equal(store.getBoard(board.id)!.repoKey, identity.repoKey);

  // 探测抛错（目录丢失/权限失败/Git 损坏）：显式报告，不静默撤销 Git 能力
  fixture.git.setDir(projectDir, null);
  fixture.git.probed.length = 0;
  // setDir(null) 表示"明确非 Git"；用未配置目录模拟探测错误
  const missingDir = path.join(base, 'gone');
  store.mutateBoard(board.id, (b) => ({ ...b, projectDir: missingDir, repo: missingDir }));
  await engine.refreshBoardGitCapabilities();
  const broken = store.getBoard(board.id)!;
  assert.equal(broken.repoKey, identity.repoKey); // 保留，不因瞬态错误撤销
  assert.ok(broken.repoConflict?.includes('探测失败'));
});
