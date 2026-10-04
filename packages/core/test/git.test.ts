import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BoardEngine, BoardError, GitService, JsonFileBoardStore } from '../src/index.js';
import type { Board, WorkItem } from '../src/index.js';

/** 临时真实 Git 仓库（含一次提交）；路径为 mkdtemp 原样（断言用 realpath 对齐） */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ck-git-'));
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir }).toString().trim();
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(path.join(dir, 'base.txt'), 'hello\n');
  g(['add', '.']);
  g(['commit', '-qm', 'init']);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd }).toString().trim();
}

/** 未完成首次提交的真实仓库；用户身份仅写入临时仓库配置。 */
function makeUnbornRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'tasklane-unborn-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'TaskLane 测试']);
  return repo;
}

test('首次提交前可识别仓库身份并登记当前分支，Git 关闭时仍校验登记', async (t) => {
  const repo = makeUnbornRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const subdir = path.join(repo, 'src');
  mkdirSync(subdir);
  const expected = { root: realpathSync(repo), repoKey: path.join(realpathSync(repo), '.git') };
  for (const enabled of [true, false]) {
    const svc = new GitService(enabled);
    assert.deepEqual(await svc.identifyRepo(subdir), expected);
    assert.deepEqual(await svc.validateRepoForBoard(subdir, 'main'), expected);
    await assert.rejects(
      svc.validateRepoForBoard(repo, 'other'),
      (err: BoardError) => err.code === 'VALIDATION' && /必须是当前分支/.test(err.message),
    );
    await assert.rejects(
      svc.validateRepoForBoard(repo, 'invalid..branch'),
      (err: BoardError) => err.code === 'VALIDATION' && /名称无效/.test(err.message),
    );
  }
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
  assert.deepEqual(await new GitService().validateRepoForBoard(repo, 'trunk'), expected);
  await assert.rejects(
    new GitService().validateRepoForBoard(repo, 'main'),
    (err: BoardError) => err.code === 'VALIDATION' && /必须是当前分支/.test(err.message),
  );
});

test('首次提交前工作区操作明确失败且不改写 refs 或创建工作区，Git 关闭时返回 null', async (t) => {
  const repo = makeUnbornRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const svc = new GitService();
  const task = { id: 'TASK-1', title: 'task' } as WorkItem;
  const board = { repo, baseBranch: 'main' } as Board;
  const beforeRefs = git(repo, ['for-each-ref']);
  const beforeWorktrees = git(repo, ['worktree', 'list', '--porcelain']);
  await assert.rejects(
    svc.ensureTaskContext(task, board),
    (err: BoardError) => err.code === 'GIT_ERROR' && /先由用户完成首次提交/.test(err.message),
  );
  assert.equal(git(repo, ['for-each-ref']), beforeRefs);
  assert.equal(git(repo, ['worktree', 'list', '--porcelain']), beforeWorktrees);
  assert.equal(existsSync(path.join(repo, '.worktrees')), false);
  assert.equal(await new GitService(false).ensureTaskContext(task, board), null);
});

test('已有提交时仍校验基线，失败先于创建或复用工作区', async (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const svc = new GitService();
  await svc.validateRepoForBoard(repo, 'main');
  await assert.rejects(
    svc.validateRepoForBoard(repo, 'missing'),
    (err: BoardError) => err.code === 'VALIDATION' && /基线分支不存在/.test(err.message),
  );
  const task = { id: 'TASK-1', title: 'task' } as WorkItem;
  const beforeRefs = git(repo, ['for-each-ref']);
  await assert.rejects(
    svc.ensureTaskContext(task, { repo, baseBranch: 'missing' } as Board),
    (err: BoardError) => err.code === 'GIT_ERROR' && /基线分支不存在/.test(err.message),
  );
  assert.equal(git(repo, ['for-each-ref']), beforeRefs);
  assert.equal(existsSync(path.join(repo, '.worktrees')), false);
  const context = await svc.ensureTaskContext(task, { repo, baseBranch: 'main' } as Board);
  assert.ok(context);
  await assert.rejects(
    svc.ensureTaskContext({ ...task, ...context }, { repo, baseBranch: 'missing' } as Board),
    (err: BoardError) => err.code === 'GIT_ERROR' && /基线分支不存在/.test(err.message),
  );
});

test('分支命名：ASCII 标题拼入 slug，纯中文标题只保留任务 ID', async (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const svc = new GitService(true);
  const board = { repo, baseBranch: 'main' } as Board;

  const ascii = await svc.ensureTaskContext({ id: 'TASK-3', title: 'Fix login flow' } as WorkItem, board);
  assert.equal(ascii?.branch, 'tasklane/TASK-3-fix-login-flow');

  // 纯中文标题清洗后为空，不能落入 -task 兜底后缀与 TASK 前缀重复
  const chinese = await svc.ensureTaskContext({ id: 'TASK-4', title: '测试' } as WorkItem, board);
  assert.equal(chinese?.branch, 'tasklane/TASK-4');
});

test('空仓库可管理任务，首次提交前后普通指派都不创建工作区', async (t) => {
  const repo = makeUnbornRepo();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'tasklane-unborn-board-'));
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });
  const engine = new BoardEngine(new JsonFileBoardStore(path.join(dataDir, 'board.json')));
  const board = await engine.resolveProjectBoard({ repo });
  assert.equal((await engine.registerBoard({ repo })).id, board.id);
  assert.equal((await engine.resolveProjectBoard({ repo, baseBranch: 'missing' })).id, board.id);
  const task = await engine.createTask({ boardId: board.id, title: 'first task' });
  assert.equal((await engine.moveTask(task.id, 'ready', board.id)).status, 'ready');
  const assigned = await engine.assignTask(task.id, 'agent', board.id);
  assert.equal(assigned.execution.state, 'assigned');
  assert.equal(assigned.execution.activity, undefined);
  assert.equal(assigned.branch, undefined);
  assert.equal(assigned.worktreePath, undefined);
  assert.equal(git(repo, ['for-each-ref']), '');
  assert.equal(existsSync(path.join(repo, '.worktrees')), false);

  // 只在临时仓库模拟用户首次提交；重新指派实时检查 Git，无需迁移看板数据。
  writeFileSync(path.join(repo, 'base.txt'), 'hello\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-qm', '首次提交']);
  assert.equal((await engine.resolveProjectBoard({ repo })).id, board.id);
  const recovered = await engine.assignTask(task.id, 'agent', board.id);
  assert.equal(recovered.boardId, board.id);
  assert.equal(recovered.execution.sessionId, assigned.execution.sessionId);
  assert.equal(recovered.worktreePath, undefined);
  assert.equal(recovered.branch, undefined);
  assert.equal(existsSync(path.join(repo, '.worktrees')), false);
});

test('登记后仓库路径失效，普通指派仍可用但不触发 Git', async (t) => {
  const repo = makeRepo();
  const movedRepo = `${repo}-moved`;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'tasklane-missing-board-'));
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(movedRepo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });
  const engine = new BoardEngine(new JsonFileBoardStore(path.join(dataDir, 'board.json')));
  const board = await engine.resolveProjectBoard({ repo });
  const task = await engine.createTask({ boardId: board.id, title: 'missing repository task' });
  renameSync(repo, movedRepo);
  const assigned = await engine.assignTask(task.id, 'agent', board.id);
  assert.equal(assigned.execution.state, 'assigned');
  assert.equal(assigned.execution.activity, undefined);
  assert.equal(assigned.branch, undefined);
  assert.equal(assigned.worktreePath, undefined);
  assert.equal(existsSync(path.join(movedRepo, '.worktrees')), false);
});

test('仓库身份校验仍拒绝相对路径、不存在路径、文件和裸仓库', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tasklane-invalid-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'file.txt');
  writeFileSync(file, 'x');
  const bare = path.join(dir, 'bare.git');
  git(dir, ['init', '--bare', '-q', bare]);
  const svc = new GitService();
  for (const repo of ['relative', path.join(dir, 'missing'), file, bare]) {
    await assert.rejects(svc.identifyRepo(repo), (err: BoardError) => err.code === 'VALIDATION');
  }
});

test('继承的 GIT_DIR/GIT_WORK_TREE 不改写仓库路由', async () => {
  const repoA = makeRepo();
  const repoB = makeRepo();
  // 模拟宿主带着仓库 A 的 Git 上下文启动（含 hook 注入的 -c 参数）：
  // 子进程不得据此把 B 的操作路由到 A
  process.env.GIT_DIR = path.join(repoA, '.git');
  process.env.GIT_WORK_TREE = repoA;
  process.env.GIT_CONFIG_PARAMETERS = `'core.worktree=${repoA}'`;
  try {
    const svc = new GitService(true);
    const v = await svc.identifyRepo(repoB);
    assert.equal(v.root, realpathSync(repoB));
    assert.equal(await svc.resolveRepo(repoB), realpathSync(repoB));
  } finally {
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
    delete process.env.GIT_CONFIG_PARAMETERS;
  }
});

test('worktree 移除后原路径的普通目录不被当成独立 worktree', async () => {
  const repo = makeRepo();
  const svc = new GitService(true);
  const wtPath = path.join(repo, '.worktrees', 'TASK-1');
  git(repo, ['worktree', 'add', '-b', 'tasklane/TASK-1-task', wtPath]);

  // 复用真实 worktree：仓库身份与分支匹配，通过
  const task = { id: 'TASK-1', title: 'task', branch: 'tasklane/TASK-1-task', worktreePath: wtPath } as WorkItem;
  const board = { repo, baseBranch: 'main' } as Board;
  const ctx = await svc.ensureTaskContext(task, board);
  assert.equal(ctx?.worktreePath, wtPath);

  // 移除 worktree 后在原路径重建普通目录：属于主仓库的子目录，
  // 不得被误认成独立 worktree（否则与主仓库共享索引）
  git(repo, ['worktree', 'remove', '--force', wtPath]);
  mkdirSync(wtPath, { recursive: true });
  writeFileSync(path.join(wtPath, 'plain.txt'), 'x\n');
  await assert.rejects(
    svc.ensureTaskContext(task, board),
    (err: BoardError) => err.code === 'GIT_ERROR' && /独立 worktree 根/.test(err.message),
  );
});

test('中文未跟踪文件计入 diff 摘要（core.quotePath 默认转义）', async () => {
  const repo = makeRepo();
  const wtPath = path.join(repo, '.worktrees', 'TASK-2');
  git(repo, ['worktree', 'add', '-b', 'tasklane/TASK-2-task', wtPath]);
  mkdirSync(path.join(wtPath, 'docs'));
  writeFileSync(path.join(wtPath, 'docs', '说明文档.md'), '第一行\n第二行\n');

  const svc = new GitService(true);
  const summary = await svc.diffSummary(wtPath, 'main');
  // 转义前的实现把 "docs/\346\226\207..." 当字面路径传 diff，文件被静默漏统计
  const f = summary.files.find((x) => x.name === 'docs/说明文档.md');
  assert.ok(f, `摘要缺少中文文件: ${JSON.stringify(summary.files)}`);
  assert.equal(f!.added, 2);
  assert.equal(summary.filesChanged, 1);
});

test('断连 Git 抛 BoardError 而非裸异常（identifyRepo 校验路径）', async () => {
  const svc = new GitService(true);
  const dir = mkdtempSync(path.join(tmpdir(), 'ck-nogit-'));
  await assert.rejects(
    svc.identifyRepo(dir),
    (err: BoardError) => err.code === 'VALIDATION' && /不是 Git 仓库/.test(err.message),
  );
  rmSync(dir, { recursive: true, force: true });
});
