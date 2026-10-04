import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BoardEngine, BoardError, GitService, JsonFileBoardStore } from '../src/index.js';

function makeEngine(git = new GitService(false)): { engine: BoardEngine; store: JsonFileBoardStore; file: string } {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'ck-engine-')), 'board.json');
  // 默认禁用 git；需要观察 Git 调用时注入桩，不启动真实进程。
  const store = new JsonFileBoardStore(file);
  const engine = new BoardEngine(store, git);
  return { engine, store, file };
}

test('createTask 默认值：P2 / backlog / human / idle', async () => {
  const { engine } = makeEngine();
  const task = await engine.createTask({ title: 'Implement OAuth callback' });
  assert.equal(task.id, 'TASK-101');
  assert.equal(task.priority, 'P2');
  assert.equal(task.status, 'backlog');
  assert.equal(task.assignee, 'human');
  assert.equal(task.execution.state, 'idle');
});

test('createTask 校验：空标题与非法枚举抛 VALIDATION', async () => {
  const { engine } = makeEngine();
  await assert.rejects(engine.createTask({ title: '   ' }), (err: BoardError) => err.code === 'VALIDATION');
  await assert.rejects(
    engine.createTask({ title: 'x', priority: 'P9' as never }),
    (err: BoardError) => err.code === 'VALIDATION',
  );
});

test('状态流转：前向允许，跨状态跳转拒绝，一步回退允许', async () => {
  const { engine } = makeEngine();
  const t = await engine.createTask({ title: 'a' });

  const ready = await engine.moveTask(t.id, 'ready');
  assert.equal(ready.status, 'ready');

  const doing = await engine.moveTask(t.id, 'doing');
  assert.equal(doing.status, 'doing');

  // doing → done 跳过 review，拒绝
  await assert.rejects(
    engine.moveTask(t.id, 'done'),
    (err: BoardError) => err.code === 'INVALID_TRANSITION',
  );

  const review = await engine.moveTask(t.id, 'review');
  assert.equal(review.status, 'review');
  assert.equal(review.execution.state, 'idle');

  const done = await engine.moveTask(t.id, 'done');
  assert.equal(done.status, 'done');

  // done → review 返工回退允许
  const rework = await engine.moveTask(t.id, 'review');
  assert.equal(rework.status, 'review');
});

test('普通指派只进入 assigned；不创建 session，doing 不自动 running', async () => {
  const { engine } = makeEngine();
  const t = await engine.createTask({ title: 'Fix auth worker' });

  const assigned = await engine.assignTask(t.id, 'agent');
  assert.equal(assigned.assignee, 'agent');
  assert.equal(assigned.execution.state, 'assigned');
  assert.equal(assigned.execution.sessionId, undefined);
  assert.equal(assigned.execution.runId, undefined);
  assert.equal(assigned.executionBinding, undefined);
  assert.equal(assigned.executionRequests, undefined);

  const doing = await engine.moveTask(t.id, 'doing');
  assert.equal(doing.execution.state, 'assigned');
  assert.equal(doing.execution.startedAt, undefined);

  // 尚未执行的指派可回到 idle，但这不表示向宿主发送了停止请求。
  const human = await engine.assignTask(t.id, 'human');
  assert.equal(human.assignee, 'human');
  assert.equal(human.execution.state, 'idle');
  const { timeline } = engine.getTaskWithTimeline(t.id);
  assert.ok(timeline.some((e) => e.kind === 'assigned'));
  assert.ok(!timeline.some((e) => e.kind === 'started' || e.kind === 'stopped'));
});

test('task_update execution 补丁拒绝无关联回执，不改任务或时间线', async () => {
  const { engine } = makeEngine();
  const t = await engine.createTask({ title: 'Write tests' });
  await engine.assignTask(t.id, 'agent');
  await engine.moveTask(t.id, 'doing');
  const before = engine.getTaskWithTimeline(t.id);

  for (const execution of [
    { state: 'running', activity: 'Editing 3 files' },
    { state: 'failed', activity: 'Tests failed: 2 failing' },
    { activity: '无关联摘要' },
    {},
  ] as const) {
    await assert.rejects(
      engine.updateTask({ id: t.id, title: '不得写入', execution }),
      (err: BoardError) => err.code === 'EXECUTION_REPORT_REQUIRED',
    );
  }
  assert.deepEqual(engine.getTaskWithTimeline(t.id), before);
});

test('updateTask 编辑基础字段并校验', async () => {
  const { engine } = makeEngine();
  const t = await engine.createTask({ title: 'old' });
  const updated = await engine.updateTask({ id: t.id, title: 'new title', priority: 'P0', description: 'desc' });
  assert.equal(updated.title, 'new title');
  assert.equal(updated.priority, 'P0');
  assert.equal(updated.description, 'desc');
  await assert.rejects(
    engine.updateTask({ id: t.id, execution: { state: 'exploded' as never } }),
    (err: BoardError) => err.code === 'EXECUTION_REPORT_REQUIRED',
  );
});

test('task id 大小写不敏感；不存在抛 TASK_NOT_FOUND', async () => {
  const { engine } = makeEngine();
  await engine.createTask({ title: 'a' });
  const found = engine.getTask('task-101');
  assert.equal(found.id, 'TASK-101');
  assert.throws(() => engine.getTask('TASK-404'), (err: BoardError) => err.code === 'TASK_NOT_FOUND');
});

test('boardList 返回各状态计数', async () => {
  const { engine } = makeEngine();
  await engine.createTask({ title: 'a' });
  await engine.createTask({ title: 'b', status: 'doing' });
  await engine.createTask({ title: 'c', status: 'doing' });
  const boards = engine.boardList();
  assert.equal(boards.length, 1);
  assert.equal(boards[0].counts.backlog, 1);
  assert.equal(boards[0].counts.doing, 2);
  assert.equal(boards[0].total, 3);
});

/** 普通指派不应触碰 Git 创建流程，即使 Git 能力已开启。 */
class NoTaskContextGitService extends GitService {
  calls = 0;

  constructor() {
    super(true);
  }

  override async ensureTaskContext(): Promise<null> {
    this.calls++;
    assert.fail('普通指派不能创建分支或 worktree');
  }
}

test('并发 assign / move 保留各自字段；指派不创建 Git 上下文', async () => {
  const git = new NoTaskContextGitService();
  const { engine, store } = makeEngine(git);
  store.mutateBoard('default', (board) => ({ ...board, repo: '/repos/a', baseBranch: 'main' }));
  const t = await engine.createTask({ title: 'a', status: 'ready' });

  const [, doing] = await Promise.all([
    engine.assignTask(t.id, 'agent'),
    engine.moveTask(t.id, 'doing'),
  ]);

  const final = engine.getTask(t.id);
  assert.equal(doing.status, 'doing');
  assert.equal(final.status, 'doing');
  assert.equal(final.assignee, 'agent');
  assert.equal(final.execution.state, 'assigned');
  assert.equal(final.execution.sessionId, undefined);
  assert.equal(final.branch, undefined);
  assert.equal(final.worktreePath, undefined);
  assert.equal(git.calls, 0);
});

test('返工 review→doing 只改变业务状态，不创建开始回执', async () => {
  const { engine } = makeEngine();
  const t = await engine.createTask({ title: 'a' });
  await engine.assignTask(t.id, 'agent');
  await engine.moveTask(t.id, 'doing');
  const review = await engine.moveTask(t.id, 'review');
  assert.equal(review.execution.state, 'assigned');

  const rework = await engine.moveTask(t.id, 'doing');
  assert.equal(rework.status, 'doing');
  assert.deepEqual(rework.execution, review.execution);
  assert.equal(rework.execution.startedAt, undefined);

  const { timeline } = engine.getTaskWithTimeline(t.id);
  assert.ok(!timeline.some((e) => e.kind === 'started' || e.kind === 'completed'));
});

test('改派和重新指派不停止执行，并保留 legacy session 与 Git 字段', async () => {
  const { engine, store } = makeEngine();
  const t = await engine.createTask({ title: 'a' });
  store.mutateTask(t.id, (task) => ({
    ...task,
    repo: '/repos/a',
    baseBranch: 'main',
    branch: 'tasklane/legacy',
    worktreePath: '/worktrees/legacy',
    execution: { ...task.execution, state: 'running', sessionId: 'sess-legacy', activity: '旧执行待核实' },
  }));
  const first = await engine.assignTask(t.id, 'agent');
  const human = await engine.assignTask(t.id, 'human');
  const again = await engine.assignTask(t.id, 'agent');

  for (const task of [first, human, again]) {
    assert.deepEqual(task.execution, first.execution);
    assert.equal(task.execution.state, 'running');
    assert.equal(task.execution.sessionId, 'sess-legacy');
    assert.equal(task.repo, '/repos/a');
    assert.equal(task.baseBranch, 'main');
    assert.equal(task.branch, 'tasklane/legacy');
    assert.equal(task.worktreePath, '/worktrees/legacy');
  }
  const { timeline } = engine.getTaskWithTimeline(t.id);
  assert.ok(!timeline.some((e) => e.kind === 'stopped' || e.kind === 'started'));
});

test('moveTask 流转校验基于磁盘最新状态：跨进程旧快照不得绕过', async () => {
  const { engine, store } = makeEngine();
  const t = await engine.createTask({ title: 'a' });
  await engine.moveTask(t.id, 'ready');
  await engine.moveTask(t.id, 'doing');
  await engine.moveTask(t.id, 'review');
  await engine.moveTask(t.id, 'done');
  assert.equal(store.getTask(t.id)!.status, 'done');

  // 模拟另一进程持旧快照：getTask 返回 review（旧），磁盘实际已是 done。
  // 事务外用旧状态校验（review → doing 允许）后无条件写入，会得到非法的
  // done → doing；修复后事务内按磁盘最新状态拒绝，且磁盘不被写入。
  const stale = structuredClone(store.getTask(t.id)!);
  stale.status = 'review';
  const origGetTask = store.getTask.bind(store);
  store.getTask = (id: string) => (id === t.id ? structuredClone(stale) : origGetTask(id));
  try {
    await assert.rejects(
      engine.moveTask(t.id, 'doing'),
      (err: BoardError) => err.code === 'INVALID_TRANSITION',
    );
  } finally {
    store.getTask = origGetTask;
  }
  assert.equal(store.getTask(t.id)!.status, 'done');
});

/* ---------- 多看板归属（multi-repo isolation） ---------- */

/** 不依赖 git 的假看板注册：直接经存储层写入（引擎 registerBoard 的 Git 校验在 git-verify 覆盖） */
function addBoard(
  store: JsonFileBoardStore,
  input: { repoKey: string; repo: string; name: string; baseBranch: string },
): string {
  const { board } = store.registerBoard(input);
  return board.id;
}

test('多看板下创建/列表省略 boardId 报 VALIDATION，不悄悄操作第一个看板', async () => {
  const { engine, store } = makeEngine();
  const boardB = addBoard(store, { repoKey: '/repos/b/.git', repo: '/repos/b', name: 'B', baseBranch: 'main' });

  await assert.rejects(
    engine.createTask({ title: 'a' }),
    (err: BoardError) => err.code === 'VALIDATION' && /boardId/.test(err.message),
  );
  assert.throws(
    () => engine.listTasks(),
    (err: BoardError) => err.code === 'VALIDATION',
  );

  // 显式指定后正常
  const t = await engine.createTask({ title: 'a', boardId: boardB });
  assert.equal(t.boardId, boardB);
  assert.equal(engine.listTasks({ boardId: boardB }).length, 1);
  assert.equal(engine.listTasks({ boardId: 'default' }).length, 0);
});

test('单看板省略 boardId 自动解析；不存在的看板返回 BOARD_NOT_FOUND', async () => {
  const { engine } = makeEngine();
  const t = await engine.createTask({ title: 'a' }); // 唯一 default 看板
  assert.equal(t.boardId, 'default');

  await assert.rejects(
    engine.createTask({ title: 'b', boardId: 'ghost' }),
    (err: BoardError) => err.code === 'BOARD_NOT_FOUND',
  );
  assert.throws(
    () => engine.listTasks({ boardId: 'ghost' }),
    (err: BoardError) => err.code === 'BOARD_NOT_FOUND',
  );
});

test('任务归属隔离：boardList 各自计数；过滤后不串板', async () => {
  const { engine, store } = makeEngine();
  const boardB = addBoard(store, { repoKey: '/repos/b/.git', repo: '/repos/b', name: 'B', baseBranch: 'main' });

  const a1 = await engine.createTask({ title: 'a1', boardId: 'default', status: 'doing' });
  await engine.createTask({ title: 'a2', boardId: 'default', status: 'doing' });
  await engine.createTask({ title: 'b1', boardId: boardB, status: 'review' });

  const boards = engine.boardList();
  assert.equal(boards.length, 2);
  const def = boards.find((b) => b.id === 'default')!;
  const bbd = boards.find((b) => b.id === boardB)!;
  assert.equal(def.counts.doing, 2);
  assert.equal(def.total, 2);
  assert.equal(bbd.counts.review, 1);
  assert.equal(bbd.counts.doing, 0);
  assert.equal(bbd.total, 1);

  // 状态过滤 + 看板过滤叠加仍保持归属
  const doing = engine.listTasks({ boardId: boardB, status: 'doing' });
  assert.deepEqual(doing.map((t) => t.id), []);
  const doingDefault = engine.listTasks({ boardId: 'default', status: 'doing' });
  assert.deepEqual(doingDefault.map((t) => t.id), [a1.id, 'TASK-102']);
});

test('跨看板写操作校验：错误归属返回 BOARD_MISMATCH，不回退', async () => {
  const { engine, store } = makeEngine();
  const boardB = addBoard(store, { repoKey: '/repos/b/.git', repo: '/repos/b', name: 'B', baseBranch: 'main' });
  const t = await engine.createTask({ title: 'a', boardId: 'default' });

  // get / update / move / assign 均校验归属
  assert.throws(
    () => engine.getTask(t.id, boardB),
    (err: BoardError) => err.code === 'BOARD_MISMATCH',
  );
  await assert.rejects(
    engine.updateTask({ id: t.id, boardId: boardB, title: 'x' }),
    (err: BoardError) => err.code === 'BOARD_MISMATCH',
  );
  await assert.rejects(
    engine.moveTask(t.id, 'ready', boardB),
    (err: BoardError) => err.code === 'BOARD_MISMATCH',
  );
  await assert.rejects(
    engine.assignTask(t.id, 'agent', boardB),
    (err: BoardError) => err.code === 'BOARD_MISMATCH',
  );

  // 省略 boardId：任务 ID 全局唯一，用任务自身归属
  assert.equal(engine.getTask(t.id).boardId, 'default');
  const moved = await engine.moveTask(t.id, 'ready');
  assert.equal(moved.status, 'ready');

  // 正确归属的校验通过
  const ok = await engine.updateTask({ id: t.id, boardId: 'default', title: 'renamed' });
  assert.equal(ok.title, 'renamed');
});

test('任务 ID 全局唯一：跨看板取号不撞号', async () => {
  const { engine, store } = makeEngine();
  const boardB = addBoard(store, { repoKey: '/repos/b/.git', repo: '/repos/b', name: 'B', baseBranch: 'main' });
  const a = await engine.createTask({ title: 'a', boardId: 'default' });
  const b = await engine.createTask({ title: 'b', boardId: boardB });
  assert.notEqual(a.id, b.id);
});

/* ---------- 任务归档（task archiving） ---------- */

/** 便捷：把任务沿合法流转推进到 done */
async function driveToDone(engine: BoardEngine, id: string): Promise<void> {
  await engine.moveTask(id, 'ready');
  await engine.moveTask(id, 'doing');
  await engine.moveTask(id, 'review');
  await engine.moveTask(id, 'done');
}

test('归档 done 任务：设置 archivedAt 保持 done，时间线记录 archived', async () => {
  const { engine } = makeEngine();
  const t = await engine.createTask({ title: 'a' });
  await driveToDone(engine, t.id);

  const { task, changed } = await engine.archiveTask(t.id);
  assert.equal(changed, true);
  assert.equal(task.status, 'done'); // 归档不改业务状态
  assert.ok(task.archivedAt);

  const { timeline } = engine.getTaskWithTimeline(t.id);
  assert.ok(timeline.some((e) => e.kind === 'archived'));
  // 内容与执行字段保留
  assert.equal(task.title, 'a');
});

test('仅允许归档 done 任务：其他状态拒绝', async () => {
  const { engine } = makeEngine();
  const t = await engine.createTask({ title: 'a', status: 'doing' });
  await assert.rejects(
    engine.archiveTask(t.id),
    (err: BoardError) => err.code === 'VALIDATION' && /done/.test(err.message),
  );
  assert.equal(engine.getTask(t.id)?.archivedAt, undefined);
});

test('重复归档 / 重复恢复幂等：changed=false，不重复事件、不更新时间', async () => {
  const { engine } = makeEngine();
  const t = await engine.createTask({ title: 'a' });
  await driveToDone(engine, t.id);

  const first = await engine.archiveTask(t.id);
  const archivedEvents = engine.getTaskWithTimeline(t.id).timeline.filter((e) => e.kind === 'archived');
  const updatedAt = first.task.updatedAt;

  const again = await engine.archiveTask(t.id);
  assert.equal(again.changed, false);
  assert.equal(again.task.updatedAt, updatedAt); // 不重复更新时间
  assert.equal(
    engine.getTaskWithTimeline(t.id).timeline.filter((e) => e.kind === 'archived').length,
    archivedEvents.length, // 不重复计数
  );

  const restored = await engine.restoreTask(t.id);
  assert.equal(restored.changed, true);
  assert.equal(restored.task.archivedAt, undefined);
  assert.equal(restored.task.status, 'done');

  const restoreAgain = await engine.restoreTask(t.id);
  assert.equal(restoreAgain.changed, false);
  const restoredEvents = engine.getTaskWithTimeline(t.id).timeline.filter((e) => e.kind === 'restored');
  assert.equal(restoredEvents.length, 1);
});

test('默认列表与计数排除归档任务；归档列表与 task_get 可读，恢复后回到 Done', async () => {
  const { engine } = makeEngine();
  const a = await engine.createTask({ title: 'a' });
  await driveToDone(engine, a.id);
  await engine.createTask({ title: 'b', status: 'backlog' });

  await engine.archiveTask(a.id);

  // 默认（active）：归档任务移出
  assert.deepEqual(
    engine.listTasks().map((t) => t.id),
    ['TASK-102'],
  );
  // counts/total 排除归档；archivedCount 单独返回
  const [board] = engine.boardList();
  assert.equal(board.counts.done, 0);
  assert.equal(board.total, 1);
  assert.equal(board.archivedCount, 1);
  // 归档列表 / 全量查询 / 详情可读
  assert.deepEqual(engine.listTasks({ archive: 'archived' }).map((t) => t.id), [a.id]);
  assert.equal(engine.listTasks({ archive: 'all' }).length, 2);
  assert.equal(engine.getTask(a.id)?.archivedAt, engine.getTaskWithTimeline(a.id).task.archivedAt);

  // 恢复：回到 Done，计数还原
  await engine.restoreTask(a.id);
  const [board2] = engine.boardList();
  assert.equal(board2.counts.done, 1);
  assert.equal(board2.total, 2);
  assert.equal(board2.archivedCount, 0);
  assert.deepEqual(engine.listTasks({ status: 'done' }).map((t) => t.id), [a.id]);
});

test('归档任务的常规修改被拒绝：update / move / assign 返回 TASK_ARCHIVED', async () => {
  const { engine } = makeEngine();
  const t = await engine.createTask({ title: 'a' });
  await driveToDone(engine, t.id);
  await engine.archiveTask(t.id);

  await assert.rejects(
    engine.updateTask({ id: t.id, title: 'x' }),
    (err: BoardError) => err.code === 'TASK_ARCHIVED',
  );
  await assert.rejects(
    engine.updateTask({ id: t.id, execution: { state: 'running' } }),
    (err: BoardError) => err.code === 'TASK_ARCHIVED',
  );
  await assert.rejects(
    engine.moveTask(t.id, 'review'),
    (err: BoardError) => err.code === 'TASK_ARCHIVED',
  );
  await assert.rejects(
    engine.assignTask(t.id, 'human'),
    (err: BoardError) => err.code === 'TASK_ARCHIVED',
  );
  await assert.rejects(
    engine.assignTask(t.id, 'agent'),
    (err: BoardError) => err.code === 'TASK_ARCHIVED',
  );

  // 恢复后修改恢复可用
  await engine.restoreTask(t.id);
  const moved = await engine.moveTask(t.id, 'review');
  assert.equal(moved.status, 'review');
});

test('归档守卫在事务内基于磁盘最新状态执行：跨进程旧快照不得绕过', async () => {
  const { engine, store } = makeEngine();
  const t = await engine.createTask({ title: 'a' });
  await driveToDone(engine, t.id);

  // 模拟另一进程持旧快照（未归档）调用 update：fn 内重读磁盘最新数据后拒绝
  const stale = structuredClone(store.getTask(t.id)!);
  const origGetTask = store.getTask.bind(store);
  store.getTask = (id: string) => (id === t.id ? structuredClone(stale) : origGetTask(id));
  try {
    await engine.archiveTask(t.id);
    await assert.rejects(
      engine.updateTask({ id: t.id, title: 'x' }),
      (err: BoardError) => err.code === 'TASK_ARCHIVED',
    );
  } finally {
    store.getTask = origGetTask;
  }
  assert.equal(store.getTask(t.id)!.title, 'a'); // 未被写入
});

test('archiveDoneTasks：只归档指定看板未归档 done；空集合返回 0；其他看板不动', async () => {
  const { engine, store } = makeEngine();
  const boardB = addBoard(store, { repoKey: '/repos/b/.git', repo: '/repos/b', name: 'B', baseBranch: 'main' });

  const d1 = await engine.createTask({ title: 'd1', boardId: 'default' });
  await driveToDone(engine, d1.id);
  const d2 = await engine.createTask({ title: 'd2', boardId: 'default' });
  await driveToDone(engine, d2.id);
  await engine.createTask({ title: 'wip', status: 'doing', boardId: 'default' });
  const other = await engine.createTask({ title: 'other', boardId: boardB, status: 'done' });

  const res = await engine.archiveDoneTasks('default');
  assert.equal(res.archivedCount, 2);
  assert.deepEqual(res.archivedIds, [d1.id, d2.id].sort());

  // 空集合：成功且数量为 0
  const empty = await engine.archiveDoneTasks('default');
  assert.equal(empty.archivedCount, 0);
  assert.deepEqual(empty.archivedIds, []);

  // 其他看板不动；非 done 不动
  assert.equal(engine.getTask(other.id)?.archivedAt, undefined);
  assert.equal(engine.listTasks({ boardId: 'default', status: 'doing' }).length, 1);

  // 幂等重复请求：不重复副作用
  const [board] = engine.boardList();
  assert.equal(board.archivedCount, 2);
});

test('archiveDoneTasks：并发回退到 review 的任务不被归档（事务内选取）', async () => {
  const { engine } = makeEngine();
  const t = await engine.createTask({ title: 'a' });
  await driveToDone(engine, t.id);

  // 批量前并发回退 done → review：批量在锁内看到 review，跳过
  await engine.moveTask(t.id, 'review');
  const res = await engine.archiveDoneTasks('default');
  assert.equal(res.archivedCount, 0);
  assert.equal(engine.getTask(t.id)?.archivedAt, undefined);
  assert.equal(engine.getTask(t.id)?.status, 'review');

  // 反向：批量先归档，随后 move 基于 latest 拒绝
  await engine.moveTask(t.id, 'done');
  await engine.archiveDoneTasks('default');
  await assert.rejects(
    engine.moveTask(t.id, 'review'),
    (err: BoardError) => err.code === 'TASK_ARCHIVED',
  );
});

test('归档任务的归属校验：错误看板 BOARD_MISMATCH；不存在看板 BOARD_NOT_FOUND', async () => {
  const { engine, store } = makeEngine();
  const boardB = addBoard(store, { repoKey: '/repos/b/.git', repo: '/repos/b', name: 'B', baseBranch: 'main' });
  const t = await engine.createTask({ title: 'a', boardId: 'default' });
  await driveToDone(engine, t.id);

  await assert.rejects(
    engine.archiveTask(t.id, boardB),
    (err: BoardError) => err.code === 'BOARD_MISMATCH',
  );
  await assert.rejects(
    engine.restoreTask(t.id, boardB),
    (err: BoardError) => err.code === 'BOARD_MISMATCH',
  );
  await assert.rejects(
    engine.archiveDoneTasks('ghost'),
    (err: BoardError) => err.code === 'BOARD_NOT_FOUND',
  );
});

test('归档保留执行信息与 Git 绑定字段；恢复后不变', async () => {
  const { engine } = makeEngine();
  const t = await engine.createTask({ title: 'a' });
  await engine.assignTask(t.id, 'agent');
  await engine.moveTask(t.id, 'doing');
  await engine.moveTask(t.id, 'review');
  const done = await engine.moveTask(t.id, 'done');

  await engine.archiveTask(t.id);
  const archived = engine.getTask(t.id)!;
  assert.equal(archived.execution.sessionId, done.execution.sessionId);
  assert.equal(archived.branch, done.branch);
  assert.equal(archived.worktreePath, done.worktreePath);
  assert.equal(archived.execution.state, done.execution.state);

  await engine.restoreTask(t.id);
  const restored = engine.getTask(t.id)!;
  assert.equal(restored.execution.sessionId, done.execution.sessionId);
  assert.equal(restored.branch, done.branch);
  assert.equal(restored.worktreePath, done.worktreePath);
});

test('deleteTask：仅 backlog 可删，任务与时间线级联清理', async () => {
  const { engine, store } = makeEngine();
  const a = await engine.createTask({ title: '待删除' });
  // 指派产生时间线事件，执行态 assigned 仍属于可删除范围
  await engine.assignTask(a.id, 'agent');
  assert.ok(store.getSession(a.id));
  assert.equal(await engine.deleteTask(a.id), a.id);
  assert.equal(store.getTask(a.id), undefined);
  assert.equal(store.getSession(a.id), undefined, '会话/时间线应随任务级联清理');
  assert.equal(engine.listTasks({}).length, 0);

  const b = await engine.createTask({ title: '流转后不可删' });
  await engine.moveTask(b.id, 'ready');
  await assert.rejects(
    engine.deleteTask(b.id),
    (err: BoardError) => err.code === 'VALIDATION' && /backlog/.test(err.message),
  );
  await assert.rejects(
    engine.deleteTask(b.id, 'board-other'),
    (err: BoardError) => err.code === 'BOARD_NOT_FOUND',
  );
  await assert.rejects(
    engine.deleteTask('TASK-999'),
    (err: BoardError) => err.code === 'TASK_NOT_FOUND',
  );
});

test('deleteTask：已绑定或执行已推进的任务拒绝', async () => {
  const { engine, store } = makeEngine();
  // 原生执行请求要求看板绑定仓库；注册一个带固定路径的看板
  const { board } = store.registerBoard({ repoKey: '/repos/del/.git', repo: '/repos/del', name: '删除守卫', baseBranch: 'main' });
  const t = await engine.createTask({ title: '执行链保护', boardId: board.id });
  await engine.requestExecution({ id: t.id, boardId: board.id, requestId: 'req-del-1', action: 'start', workspaceMode: 'project' });
  await assert.rejects(
    engine.deleteTask(t.id),
    (err: BoardError) => err.code === 'VALIDATION' && /执行已推进/.test(err.message),
  );

  const b = await engine.createTask({ title: '绑定保护', boardId: board.id });
  store.mutateTask(b.id, (task) => ({
    ...task,
    executionBinding: {
      threadId: 'th-1', hostId: 'host-1', workspacePath: '/w', workspaceOwner: 'user' as const,
      provider: 'codex-desktop' as const, boundAt: new Date().toISOString(),
    },
  }));
  await assert.rejects(
    engine.deleteTask(b.id),
    (err: BoardError) => err.code === 'VALIDATION' && /绑定/.test(err.message),
  );
});
