import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BoardEngine, BoardError, GitService, JsonFileBoardStore } from '@tasklane/core';
import * as h from '../src/handlers.js';

function makeEngine(): BoardEngine {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'ck-tools-')), 'board.json');
  return new BoardEngine(new JsonFileBoardStore(file), new GitService(false));
}

function makeMultiEngine(): { engine: BoardEngine; boardB: string } {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'ck-tools-')), 'board.json');
  const store = new JsonFileBoardStore(file);
  const { board } = store.registerBoard({
    repoKey: '/repos/b/.git',
    repo: '/repos/b',
    name: '项目 B',
    baseBranch: 'develop',
  });
  return { engine: new BoardEngine(store, new GitService(false)), boardB: board.id };
}

test('tool 契约：create → assign → move → get 闭环', async () => {
  const engine = makeEngine();

  const created = await h.taskCreate(engine, { title: 'Implement OAuth callback', priority: 'P1' });
  assert.equal(created.task.id, 'TASK-101');
  assert.equal(created.task.priority, 'P1');

  const assigned = await h.taskAssign(engine, { id: 'task-101', assignee: 'agent' });
  assert.equal(assigned.task.execution.state, 'assigned');
  assert.equal(assigned.task.execution.sessionId, undefined);
  assert.equal(assigned.task.executionBinding, undefined);
  assert.equal(assigned.task.worktreePath, undefined);

  const moved = await h.taskMove(engine, { id: 'TASK-101', status: 'doing' });
  assert.equal(moved.task.status, 'doing');
  assert.deepEqual(moved.task.execution, assigned.task.execution);

  const detail = await h.taskGet(engine, { id: 'TASK-101' });
  assert.equal(detail.task.title, 'Implement OAuth callback');
  assert.ok(detail.timeline.length >= 3);
});

test('tool 契约：task_list 过滤与 board_list 计数', async () => {
  const engine = makeEngine();
  await h.taskCreate(engine, { title: 'a' });
  await h.taskCreate(engine, { title: 'b', status: 'doing', priority: 'P0' });
  await h.taskCreate(engine, { title: 'c', status: 'doing' });

  const doing = await h.taskList(engine, { status: 'doing' });
  assert.equal(doing.tasks.length, 2);

  const p0 = await h.taskList(engine, { priority: 'P0' });
  assert.equal(p0.tasks.length, 1);

  const boards = await h.boardList(engine);
  assert.equal(boards.boards[0].counts.doing, 2);
  assert.equal(boards.boards[0].total, 3);
});

test('tool 契约：task_update 拒绝无关联执行写入且整次更新无副作用', async () => {
  const engine = makeEngine();
  const { task } = await h.taskCreate(engine, { title: 'a' });
  for (const execution of [{ state: 'waiting' as const }, { activity: 'Waiting for input' }, {}]) {
    await assert.rejects(
      h.taskUpdate(engine, { id: task.id, title: '不得保存', execution }),
      (err: BoardError) => err.code === 'EXECUTION_REPORT_REQUIRED',
    );
    assert.deepEqual((await h.taskGet(engine, { id: task.id })).task, task);
  }
});

test('tool 契约：非法流转抛 INVALID_TRANSITION', async () => {
  const engine = makeEngine();
  const { task } = await h.taskCreate(engine, { title: 'a' });
  await assert.rejects(
    h.taskMove(engine, { id: task.id, status: 'done' }),
    (err: BoardError) => err.code === 'INVALID_TRANSITION',
  );
});

/* ---------- 多看板契约（multi-repo isolation） ---------- */

test('tool 契约：多看板下 task_create/task_list 省略 boardId 返回 VALIDATION', async () => {
  const { engine } = makeMultiEngine();
  await assert.rejects(
    h.taskCreate(engine, { title: 'a' }),
    (err: BoardError) => err.code === 'VALIDATION' && /boardId/.test(err.message),
  );
  await assert.rejects(
    h.taskList(engine, {}),
    (err: BoardError) => err.code === 'VALIDATION' && /boardId/.test(err.message),
  );
});

test('tool 契约：任务携带 boardId 归属；board_list 计数按看板隔离', async () => {
  const { engine, boardB } = makeMultiEngine();
  const created = await h.taskCreate(engine, { title: 'a', boardId: boardB });
  assert.equal(created.task.boardId, boardB);

  const listed = await h.taskList(engine, { boardId: boardB });
  assert.deepEqual(listed.tasks.map((t) => t.id), ['TASK-101']);
  const other = await h.taskList(engine, { boardId: 'default' });
  assert.deepEqual(other.tasks, []);

  const boards = await h.boardList(engine);
  const b = boards.boards.find((x) => x.id === boardB)!;
  assert.equal(b.counts.backlog, 1);
  assert.equal(b.total, 1);
  assert.equal(boards.boards.find((x) => x.id === 'default')!.total, 0);
});

test('tool 契约：不存在的看板 BOARD_NOT_FOUND；错误归属 BOARD_MISMATCH', async () => {
  const { engine, boardB } = makeMultiEngine();
  await assert.rejects(
    h.taskCreate(engine, { title: 'a', boardId: 'ghost' }),
    (err: BoardError) => err.code === 'BOARD_NOT_FOUND',
  );

  const { task } = await h.taskCreate(engine, { title: 'a', boardId: 'default' });
  await assert.rejects(
    h.taskGet(engine, { id: task.id, boardId: boardB }),
    (err: BoardError) => err.code === 'BOARD_MISMATCH',
  );
  await assert.rejects(
    h.taskAssign(engine, { id: task.id, assignee: 'agent', boardId: boardB }),
    (err: BoardError) => err.code === 'BOARD_MISMATCH',
  );
  await assert.rejects(
    h.taskMove(engine, { id: task.id, status: 'ready', boardId: boardB }),
    (err: BoardError) => err.code === 'BOARD_MISMATCH',
  );
  await assert.rejects(
    h.taskUpdate(engine, { id: task.id, title: 'x', boardId: boardB }),
    (err: BoardError) => err.code === 'BOARD_MISMATCH',
  );

  // 省略 boardId：任务 ID 全局唯一，用任务自身归属完成闭环
  const moved = await h.taskMove(engine, { id: task.id, status: 'ready' });
  assert.equal(moved.task.status, 'ready');
});

test('tool 契约：board_create 重复注册幂等返回已有看板', async () => {
  // Git 校验在 git-verify 用真实仓库覆盖；此处用伪 GitService 只验证幂等路径
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'ck-tools-')), 'board.json');
  const store = new JsonFileBoardStore(file);
  const fakeGit = new (class extends GitService {
    override async validateRepoForBoard(repo: string) {
      return { root: repo, repoKey: `${repo}/.git` };
    }
  })(false);
  const engine = new BoardEngine(store, fakeGit);

  const first = await h.boardCreate(engine, { repo: '/repos/a', name: '项目 A', baseBranch: 'main' });
  assert.equal(first.board.repo, '/repos/a');

  const dup = await h.boardCreate(engine, { repo: '/repos/a', name: '改名', baseBranch: 'dev' });
  assert.equal(dup.board.id, first.board.id);
  assert.equal(dup.board.name, '项目 A');
  assert.equal(dup.board.baseBranch, 'main');
});

test('dir_list：列出可见子目录、标记 Git 仓库与基线分支（main 优先，不取当前 HEAD）；坏路径报 VALIDATION', async () => {
  const engine = makeEngine();
  const base = mkdtempSync(path.join(tmpdir(), 'ck-dirs-'));
  const makeRepo = (name: string, head: string, branches: string[]) => {
    const heads = path.join(base, name, '.git', 'refs', 'heads');
    for (const b of branches) {
      const file = path.join(heads, ...b.split('/'));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '0'.repeat(40));
    }
    mkdirSync(path.join(base, name, '.git'), { recursive: true });
    writeFileSync(path.join(base, name, '.git', 'HEAD'), `ref: refs/heads/${head}\n`);
  };
  // 当前检出 feature 但有 main → 基线取 main（不取 HEAD）
  makeRepo('repo-main', 'feature/x', ['feature/x', 'main', 'master']);
  // 只有 master（无 main）→ 取 master
  makeRepo('repo-master', 'master', ['master', 'develop']);
  // main/master 都没有 → 默认 'main'（提交时由 board_create 校验）
  makeRepo('repo-none', 'develop', ['develop']);
  mkdirSync(path.join(base, 'plain'));
  mkdirSync(path.join(base, '.hidden'));
  writeFileSync(path.join(base, 'file.txt'), 'x');

  const res = await h.dirList(engine, { path: base });
  assert.equal(res.path, base);
  assert.equal(res.parent, path.dirname(base));
  assert.equal(typeof res.home, 'string');
  assert.ok(res.home.startsWith('/'));
  const byName = new Map(res.entries.map((e) => [e.name, e]));
  assert.deepEqual([...byName.keys()].sort(), ['plain', 'repo-main', 'repo-master', 'repo-none']);
  assert.equal(byName.get('repo-main')?.isRepo, true);
  assert.equal(byName.get('repo-main')?.baseBranch, 'main');
  assert.equal(byName.get('repo-master')?.baseBranch, 'master');
  assert.equal(byName.get('repo-none')?.baseBranch, 'main');
  assert.equal(byName.get('plain')?.isRepo, false);

  await assert.rejects(() => h.dirList(engine, { path: '/nonexistent-ck-dir-xyz' }), /无法读取目录/);
});

test('dir_list：真实无提交仓库使用当前 master/trunk 分支，伪造 HEAD 不视为有效仓库', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'tl-unborn-dirs-'));
  const configs = new Map<string, string>();
  for (const branch of ['master', 'trunk']) {
    const repo = path.join(base, `repo-${branch}`);
    mkdirSync(repo);
    execFileSync('git', ['init', '-b', branch, repo], {
      stdio: 'ignore',
      timeout: 5000,
    });
    configs.set(repo, readFileSync(path.join(repo, '.git', 'config'), 'utf8'));
  }
  const invalidGit = path.join(base, 'repo-invalid', '.git');
  mkdirSync(invalidGit, { recursive: true });
  writeFileSync(path.join(invalidGit, 'HEAD'), 'ref: refs/heads/trunk\n');

  const { entries } = await h.dirList(makeEngine(), { path: base });
  const byName = new Map(entries.map((entry) => [entry.name, entry.baseBranch]));
  assert.equal(byName.get('repo-master'), 'master');
  assert.equal(byName.get('repo-trunk'), 'trunk');
  assert.equal(byName.get('repo-invalid'), 'main');
  for (const [repo, config] of configs) {
    assert.equal(readFileSync(path.join(repo, '.git', 'config'), 'utf8'), config);
  }
});

/* ---------- 任务归档契约（task archiving） ---------- */

/** 沿合法流转把任务推进到 done */
async function driveToDone(engine: BoardEngine, id: string): Promise<void> {
  await h.taskMove(engine, { id, status: 'ready' });
  await h.taskMove(engine, { id, status: 'doing' });
  await h.taskMove(engine, { id, status: 'review' });
  await h.taskMove(engine, { id, status: 'done' });
}

test('tool 契约：task_archive / task_restore 闭环与幂等', async () => {
  const engine = makeEngine();
  const { task } = await h.taskCreate(engine, { title: 'a' });
  await driveToDone(engine, task.id);

  const first = await h.taskArchive(engine, { id: task.id });
  assert.equal(first.changed, true);
  assert.equal(first.task.status, 'done');
  assert.ok(first.task.archivedAt);

  const again = await h.taskArchive(engine, { id: task.id });
  assert.equal(again.changed, false);

  const restored = await h.taskRestore(engine, { id: task.id });
  assert.equal(restored.changed, true);
  assert.equal(restored.task.archivedAt, undefined);
  const restoreAgain = await h.taskRestore(engine, { id: task.id });
  assert.equal(restoreAgain.changed, false);
});

test('tool 契约：task_archive 非 done 返回 VALIDATION；归档任务修改返回 TASK_ARCHIVED', async () => {
  const engine = makeEngine();
  const { task } = await h.taskCreate(engine, { title: 'a', status: 'doing' });
  await assert.rejects(
    h.taskArchive(engine, { id: task.id }),
    (err: BoardError) => err.code === 'VALIDATION',
  );

  await driveToDone(engine, task.id);
  await h.taskArchive(engine, { id: task.id });
  await assert.rejects(
    h.taskUpdate(engine, { id: task.id, title: 'x' }),
    (err: BoardError) => err.code === 'TASK_ARCHIVED',
  );
  await assert.rejects(
    h.taskMove(engine, { id: task.id, status: 'review' }),
    (err: BoardError) => err.code === 'TASK_ARCHIVED',
  );
  // task_get 仍可读取归档任务及时间线
  const detail = await h.taskGet(engine, { id: task.id });
  assert.ok(detail.task.archivedAt);
  assert.ok(detail.timeline.some((e) => e.kind === 'archived'));
});

test('tool 契约：task_list archive 参数与 board_list archivedCount', async () => {
  const engine = makeEngine();
  const a = await h.taskCreate(engine, { title: 'a' });
  await driveToDone(engine, a.task.id);
  await h.taskCreate(engine, { title: 'b', status: 'backlog' });
  await h.taskArchive(engine, { id: a.task.id });

  const active = await h.taskList(engine, {});
  assert.deepEqual(active.tasks.map((t) => t.id), ['TASK-102']);
  const archived = await h.taskList(engine, { archive: 'archived' });
  assert.deepEqual(archived.tasks.map((t) => t.id), ['TASK-101']);
  const all = await h.taskList(engine, { archive: 'all' });
  assert.equal(all.tasks.length, 2);
  // 归档范围 + 状态叠加
  const archivedDone = await h.taskList(engine, { archive: 'archived', status: 'done' });
  assert.equal(archivedDone.tasks.length, 1);

  const boards = await h.boardList(engine);
  assert.equal(boards.boards[0].counts.done, 0);
  assert.equal(boards.boards[0].total, 1);
  assert.equal(boards.boards[0].archivedCount, 1);
});

test('tool 契约：task_archive_done 只作用于指定看板，空集合返回 0', async () => {
  const { engine, boardB } = makeMultiEngine();
  const d1 = await h.taskCreate(engine, { title: 'd1', boardId: 'default' });
  await driveToDone(engine, d1.task.id);
  const d2 = await h.taskCreate(engine, { title: 'd2', boardId: 'default' });
  await driveToDone(engine, d2.task.id);
  const other = await h.taskCreate(engine, { title: 'other', boardId: boardB, status: 'done' });

  const res = await h.taskArchiveDone(engine, { boardId: 'default' });
  assert.equal(res.archivedCount, 2);
  assert.deepEqual(res.archivedIds, ['TASK-101', 'TASK-102']);

  // 重复请求：幂等数量 0
  const again = await h.taskArchiveDone(engine, { boardId: 'default' });
  assert.equal(again.archivedCount, 0);

  // 其他看板不动
  const otherBoard = await h.taskList(engine, { boardId: boardB, archive: 'all', status: 'done' });
  assert.equal(otherBoard.tasks[0].archivedAt, undefined);

  // 不存在的看板
  await assert.rejects(
    h.taskArchiveDone(engine, { boardId: 'ghost' }),
    (err: BoardError) => err.code === 'BOARD_NOT_FOUND',
  );
});

test('tool 契约：归档/恢复的归属校验 BOARD_MISMATCH', async () => {
  const { engine, boardB } = makeMultiEngine();
  const { task } = await h.taskCreate(engine, { title: 'a', boardId: 'default' });
  await driveToDone(engine, task.id);

  await assert.rejects(
    h.taskArchive(engine, { id: task.id, boardId: boardB }),
    (err: BoardError) => err.code === 'BOARD_MISMATCH',
  );
  // 正确归属成功；恢复时错误归属同样拒绝
  await h.taskArchive(engine, { id: task.id, boardId: 'default' });
  await assert.rejects(
    h.taskRestore(engine, { id: task.id, boardId: boardB }),
    (err: BoardError) => err.code === 'BOARD_MISMATCH',
  );
  // 省略 boardId：任务自身归属
  const ok = await h.taskRestore(engine, { id: task.id });
  assert.equal(ok.changed, true);
});

test('tool 契约：task_delete 仅 backlog 可删且级联清理', async () => {
  const engine = makeEngine();
  const { task } = await h.taskCreate(engine, { title: '删除契约' });
  const result = await h.taskDelete(engine, { id: task.id });
  assert.deepEqual(result, { id: task.id, deleted: true });
  await assert.rejects(h.taskGet(engine, { id: task.id }), (err: BoardError) => err.code === 'TASK_NOT_FOUND');

  const other = await h.taskCreate(engine, { title: '流转后不可删' });
  await h.taskMove(engine, { id: other.task.id, status: 'ready' });
  await assert.rejects(
    h.taskDelete(engine, { id: other.task.id }),
    (err: BoardError) => err.code === 'VALIDATION' && /backlog/.test(err.message),
  );
});
