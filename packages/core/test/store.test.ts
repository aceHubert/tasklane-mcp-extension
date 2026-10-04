import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonFileBoardStore } from '../src/board-store.js';
import { BoardError } from '../src/errors.js';

function tmpStoreFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'ck-store-')), 'board.json');
}

/** 既有任务公共字段（v2：任务必须带 boardId 归属） */
const baseTask = {
  boardId: 'default',
  assignee: 'human' as const,
  execution: { state: 'idle' as const },
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z',
};

test('nextId 从 TASK-101 开始自增', () => {
  const store = new JsonFileBoardStore(tmpStoreFile());
  assert.equal(store.nextId(), 'TASK-101');
  assert.equal(store.nextId(), 'TASK-102');
});

test('putTask / getTask / deleteTask 持久化', () => {
  const file = tmpStoreFile();
  const store = new JsonFileBoardStore(file);
  store.putTask({
    id: 'TASK-101',
    ...baseTask,
    title: 'Implement OAuth callback',
    status: 'backlog',
    priority: 'P1',
  });

  // 重新打开文件验证落盘
  const reopened = new JsonFileBoardStore(file);
  assert.equal(reopened.getTask('TASK-101')?.title, 'Implement OAuth callback');
  assert.equal(reopened.deleteTask('TASK-101'), true);
  assert.equal(reopened.deleteTask('TASK-101'), false);
  assert.equal(reopened.getTask('TASK-101'), undefined);
});

test('listTasks 支持按状态/指派过滤并按 ID 排序', () => {
  const store = new JsonFileBoardStore(tmpStoreFile());
  store.putTask({ ...baseTask, id: 'TASK-102', title: 'b', status: 'doing', priority: 'P1' });
  store.putTask({ ...baseTask, id: 'TASK-101', title: 'a', status: 'backlog', priority: 'P2' });
  store.putTask({ ...baseTask, id: 'TASK-103', title: 'c', status: 'doing', priority: 'P2', assignee: 'agent' });

  assert.deepEqual(
    store.listTasks().map((t) => t.id),
    ['TASK-101', 'TASK-102', 'TASK-103'],
  );
  assert.deepEqual(
    store.listTasks({ status: 'doing' }).map((t) => t.id),
    ['TASK-102', 'TASK-103'],
  );
  assert.deepEqual(
    store.listTasks({ assignee: 'agent' }).map((t) => t.id),
    ['TASK-103'],
  );
});

test('listTasks 按看板过滤，互不混入', () => {
  const store = new JsonFileBoardStore(tmpStoreFile());
  const { board: boardB } = store.registerBoard({
    repoKey: '/repos/b/.git',
    repo: '/repos/b',
    name: '项目 B',
    baseBranch: 'develop',
  });
  store.putTask({ ...baseTask, id: 'TASK-101', title: 'a', status: 'doing', priority: 'P2' });
  store.putTask({ ...baseTask, id: 'TASK-102', boardId: boardB.id, title: 'b', status: 'review', priority: 'P1' });

  assert.deepEqual(
    store.listTasks({ boardId: 'default' }).map((t) => t.id),
    ['TASK-101'],
  );
  assert.deepEqual(
    store.listTasks({ boardId: boardB.id }).map((t) => t.id),
    ['TASK-102'],
  );
  // 过滤叠加：看板 + 状态
  assert.deepEqual(
    store.listTasks({ boardId: boardB.id, status: 'doing' }).map((t) => t.id),
    [],
  );
});

test('appendEvent 记录会话事件并可读取', () => {
  const store = new JsonFileBoardStore(tmpStoreFile());
  store.putTask({ ...baseTask, id: 'TASK-101', title: '事件测试', status: 'backlog', priority: 'P2' });
  store.appendEvent('TASK-101', { at: '2026-10-03T00:00:01.000Z', kind: 'created', detail: 'created' });
  store.appendEvent('TASK-101', { at: '2026-10-03T00:00:02.000Z', kind: 'assigned', detail: 'agent' });
  assert.equal(store.getSession('TASK-101')?.events.length, 2);
  assert.equal(store.getSession('TASK-999'), undefined);
});

test('两个 store 实例共用同一文件：nextId 不撞号、写入不互相覆盖', () => {
  const file = tmpStoreFile();
  const a = new JsonFileBoardStore(file);
  const b = new JsonFileBoardStore(file);

  // 交错取号（模拟两个 MCP 进程同时启动）
  const a1 = a.nextId();
  const b1 = b.nextId();
  assert.equal(a1, 'TASK-101');
  assert.equal(b1, 'TASK-102');

  a.putTask({ ...baseTask, id: a1, title: 't', status: 'backlog', priority: 'P2' });
  b.putTask({ ...baseTask, id: b1, title: 't', status: 'backlog', priority: 'P2' });

  // 两侧都能看到对方的任务（读侧重读磁盘）
  assert.equal(a.getTask(b1)?.id, b1);
  assert.equal(b.listTasks().length, 2);
});

test('mutateTask 基于磁盘最新数据合并；任务不存在抛 TASK_NOT_FOUND', () => {
  const file = tmpStoreFile();
  const a = new JsonFileBoardStore(file);
  const b = new JsonFileBoardStore(file);

  a.putTask({ ...baseTask, id: 'TASK-101', title: 't', status: 'backlog', priority: 'P2' });

  // 实例 b 在 a 持有旧缓存期间改了标题；a 的 mutateTask 不得覆盖回旧值
  b.mutateTask('TASK-101', (t) => ({ ...t, title: 'updated by b' }));
  const merged = a.mutateTask('TASK-101', (t) => ({ ...t, priority: 'P0' as const }));
  assert.equal(merged.title, 'updated by b');
  assert.equal(merged.priority, 'P0');

  assert.throws(
    () => a.mutateTask('TASK-404', (t) => t),
    (err: BoardError) => err.code === 'TASK_NOT_FOUND',
  );
});

/* ---------- v2 迁移与看板注册 ---------- */

function v1File(payload: Record<string, unknown>): string {
  const file = tmpStoreFile();
  writeFileSync(file, JSON.stringify(payload), 'utf8');
  return file;
}

const legacyTask = {
  id: 'TASK-101',
  title: 'legacy task',
  status: 'backlog',
  priority: 'P2',
  assignee: 'human',
  execution: { state: 'idle', sessionId: 'sess-keep' },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

test('v1 单看板旧数据升级：任务归属 default，保留会话与序号，写入备份', () => {
  const file = v1File({
    version: 1,
    boards: [{ id: 'default', name: 'Old Board', repo: '/repos/a', baseBranch: 'main' }],
    tasks: { 'TASK-101': legacyTask },
    sessions: { 'TASK-101': { taskId: 'TASK-101', events: [{ at: 'x', kind: 'created' }] } },
    seq: 101,
  });

  const store = new JsonFileBoardStore(file);
  const task = store.getTask('TASK-101');
  assert.equal(task?.boardId, 'default');
  // 执行记录、sessionId 与序号保留，不重建
  assert.equal(task?.execution.sessionId, 'sess-keep');
  assert.equal(store.getSession('TASK-101')?.events.length, 1);
  assert.equal(store.nextId(), 'TASK-102');

  // 原始 v1 文件备份存在，且重复打开不重复迁移
  const raw = JSON.parse(readFileSync(`${file}.v1.bak`, 'utf8'));
  assert.equal(raw.version, 1);
  const again = new JsonFileBoardStore(file);
  assert.equal(again.getTask('TASK-101')?.boardId, 'default');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 5);
});

test('v1 唯一非默认看板：任务归属该看板', () => {
  const file = v1File({
    version: 1,
    boards: [{ id: 'solo', name: 'Solo', repo: '/repos/s', baseBranch: 'main' }],
    tasks: { 'TASK-101': legacyTask },
    seq: 101,
  });
  const store = new JsonFileBoardStore(file);
  assert.equal(store.getTask('TASK-101')?.boardId, 'solo');
});

test('v1 多看板旧数据：任务缺少归属时报歧义错误，原文件保持可用', () => {
  const file = v1File({
    version: 1,
    boards: [
      { id: 'default', name: 'A', repo: '/repos/a', baseBranch: 'main' },
      { id: 'b', name: 'B', repo: '/repos/b', baseBranch: 'main' },
    ],
    tasks: { 'TASK-101': legacyTask },
    seq: 101,
  });
  assert.throws(
    () => new JsonFileBoardStore(file),
    (err: BoardError) => err.code === 'STORE_ERROR' && /无法自动迁移/.test(err.message),
  );
  // 原文件未被改写
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
});

test('未知版本与任务引用不存在看板：明确报错，不静默清空', () => {
  const unknown = v1File({ version: 99, boards: [{ id: 'default', name: 'x' }], tasks: {}, seq: 100 });
  assert.throws(
    () => new JsonFileBoardStore(unknown),
    (err: BoardError) => err.code === 'STORE_ERROR' && /版本/.test(err.message),
  );

  const dangling = v1File({
    version: 2,
    boards: [{ id: 'default', name: 'x' }],
    tasks: { 'TASK-101': { ...legacyTask, boardId: 'ghost' } },
    seq: 100,
  });
  assert.throws(
    () => new JsonFileBoardStore(dangling),
    (err: BoardError) => err.code === 'STORE_ERROR' && /ghost/.test(err.message),
  );
});

test('registerBoard 锁内去重：同 repoKey 幂等返回已有看板，不改名称与基线', () => {
  const file = tmpStoreFile();
  const store = new JsonFileBoardStore(file);
  const first = store.registerBoard({
    repoKey: '/repos/a/.git',
    repo: '/repos/a',
    name: '项目 A',
    baseBranch: 'main',
  });
  assert.equal(first.created, true);

  // 同一仓库（worktree/子目录视角共享 repoKey）重复注册
  const dup = store.registerBoard({
    repoKey: '/repos/a/.git',
    repo: '/repos/a',
    name: '改名尝试',
    baseBranch: 'develop',
  });
  assert.equal(dup.created, false);
  assert.equal(dup.board.id, first.board.id);
  assert.equal(dup.board.name, '项目 A'); // 不改变已有名称
  assert.equal(dup.board.baseBranch, 'main'); // 不改变已有基线
  assert.equal(store.boards.filter((b) => b.repoKey === '/repos/a/.git').length, 1);
});

test('registerBoard 双实例并发：同一仓库只产生一个看板', () => {
  const file = tmpStoreFile();
  const a = new JsonFileBoardStore(file);
  const b = new JsonFileBoardStore(file);
  const [ra, rb] = [
    a.registerBoard({ repoKey: '/repos/c/.git', repo: '/repos/c', name: 'C', baseBranch: 'main' }),
    b.registerBoard({ repoKey: '/repos/c/.git', repo: '/repos/c', name: 'C2', baseBranch: 'main' }),
  ];
  assert.equal(ra.board.id, rb.board.id);
  assert.equal(new JsonFileBoardStore(file).boards.filter((x) => x.repoKey === '/repos/c/.git').length, 1);
});

test('mutateBoard 回填 repoKey；不存在看板抛 BOARD_NOT_FOUND', () => {
  const store = new JsonFileBoardStore(tmpStoreFile());
  const updated = store.mutateBoard('default', (b) => ({ ...b, repoKey: '/repos/a/.git' }));
  assert.equal(updated.repoKey, '/repos/a/.git');
  assert.throws(
    () => store.mutateBoard('ghost', (b) => b),
    (err: BoardError) => err.code === 'BOARD_NOT_FOUND',
  );
});

test('withTaskLock 跨实例互斥：临界区串行执行', async () => {
  const file = tmpStoreFile();
  const a = new JsonFileBoardStore(file);
  const b = new JsonFileBoardStore(file);
  const order: string[] = [];
  const p1 = a.withTaskLock('TASK-101', async () => {
    order.push('a-enter');
    await new Promise((r) => setTimeout(r, 30));
    order.push('a-exit');
  });
  const p2 = b.withTaskLock('TASK-101', async () => {
    order.push('b-enter');
    await new Promise((r) => setTimeout(r, 5));
    order.push('b-exit');
  });
  await Promise.all([p1, p2]);
  // 先进入者先退出，后进入者在其退出后才进入（enter-exit 不交错）
  assert.equal(order.length, 4);
  const firstOwner = order[0].split('-')[0];
  assert.equal(order[0], `${firstOwner}-enter`);
  assert.equal(order[1], `${firstOwner}-exit`);
  const secondOwner = firstOwner === 'a' ? 'b' : 'a';
  assert.equal(order[2], `${secondOwner}-enter`);
  assert.equal(order[3], `${secondOwner}-exit`);
});

/* ---------- v3 迁移与归档存储 ---------- */

function v2File(payload: Record<string, unknown>): string {
  const file = tmpStoreFile();
  writeFileSync(file, JSON.stringify(payload), 'utf8');
  return file;
}

const v2Task = {
  id: 'TASK-101',
  boardId: 'default',
  title: 'v2 task',
  status: 'done',
  priority: 'P2',
  assignee: 'human',
  execution: { state: 'idle' },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

test('v2 → v4 升级：默认未归档，写入 .v2.bak 备份，重复打开不重复迁移', () => {
  const file = v2File({
    version: 2,
    boards: [{ id: 'default', name: 'Board', repo: '/repos/a', baseBranch: 'main' }],
    tasks: { 'TASK-101': v2Task },
    sessions: {},
    seq: 101,
  });

  const store = new JsonFileBoardStore(file);
  assert.equal(store.getTask('TASK-101')?.archivedAt, undefined); // 旧任务默认未归档
  assert.equal(store.nextId(), 'TASK-102'); // 序号保留

  const raw = JSON.parse(readFileSync(`${file}.v2.bak`, 'utf8'));
  assert.equal(raw.version, 2); // 原始 v2 文件备份
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 5);

  // 重复打开：已是 v3，不再产生新备份或迁移
  const again = new JsonFileBoardStore(file);
  assert.equal(again.getTask('TASK-101')?.title, 'v2 task');
});

test('v2 已带合法 archivedAt：升级后原样保留', () => {
  const file = v2File({
    version: 2,
    boards: [{ id: 'default', name: 'Board' }],
    tasks: { 'TASK-101': { ...v2Task, archivedAt: '2026-10-01T00:00:00.000Z' } },
    seq: 101,
  });
  const store = new JsonFileBoardStore(file);
  assert.equal(store.getTask('TASK-101')?.archivedAt, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(
    store.listTasks({ archive: 'archived' }).map((t) => t.id),
    ['TASK-101'],
  );
});

test('archivedAt 损坏字段（非字符串 / 空字符串）：明确报错，原文件不被改写', () => {
  for (const bad of [123, '', '   ']) {
    const file = v2File({
      version: 3,
      boards: [{ id: 'default', name: 'Board' }],
      tasks: { 'TASK-101': { ...v2Task, archivedAt: bad } },
      seq: 101,
    });
    assert.throws(
      () => new JsonFileBoardStore(file),
      (err: BoardError) => err.code === 'STORE_ERROR' && /archivedAt/.test(err.message),
    );
    // 原文件保持原样（校验失败不落盘）
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).tasks['TASK-101'].archivedAt, bad);
  }
});

test('listTasks archive 过滤：active/archived/all 与其他筛选叠加；undefined 默认 active', () => {
  const store = new JsonFileBoardStore(tmpStoreFile());
  store.putTask({ ...baseTask, id: 'TASK-101', title: 'a', status: 'done', priority: 'P1' });
  store.putTask({ ...baseTask, id: 'TASK-102', title: 'b', status: 'done', priority: 'P2', archivedAt: '2026-10-01T00:00:00.000Z' });
  store.putTask({ ...baseTask, id: 'TASK-103', title: 'c', status: 'backlog', priority: 'P1' });

  // 存储默认只读取热任务，完整读取必须显式选择 all。
  assert.deepEqual(
    store.listTasks().map((t) => t.id),
    ['TASK-101', 'TASK-103'],
  );
  assert.deepEqual(
    store.listTasks({ archive: 'active' }).map((t) => t.id),
    ['TASK-101', 'TASK-103'],
  );
  assert.deepEqual(
    store.listTasks({ archive: 'archived' }).map((t) => t.id),
    ['TASK-102'],
  );
  assert.deepEqual(
    store.listTasks({ archive: 'all' }).map((t) => t.id),
    ['TASK-101', 'TASK-102', 'TASK-103'],
  );
  // 归档范围 + 状态叠加
  assert.deepEqual(
    store.listTasks({ archive: 'archived', status: 'done' }).map((t) => t.id),
    ['TASK-102'],
  );
  assert.deepEqual(
    store.listTasks({ archive: 'active', status: 'done' }).map((t) => t.id),
    ['TASK-101'],
  );
});

test('moveToArchive：任务与事件一起移入冷存储；任务不存在抛 TASK_NOT_FOUND', () => {
  const file = tmpStoreFile();
  const store = new JsonFileBoardStore(file);
  store.putTask({ ...baseTask, id: 'TASK-101', title: 'a', status: 'done', priority: 'P2' });

  const at = '2026-10-03T00:00:00.000Z';
  const { task, events } = store.moveToArchive('TASK-101', (cur) => ({
    task: { ...cur, archivedAt: at, updatedAt: at },
    events: [{ at, kind: 'archived', detail: 'archived from done' }],
  }));
  assert.equal(task.archivedAt, at);
  assert.equal(events.length, 1);
  assert.equal(store.getSession('TASK-101')?.events.at(-1)?.kind, 'archived');

  // 重开文件：任务修改与事件都已落盘（原子提交）
  const reopened = new JsonFileBoardStore(file);
  assert.equal(reopened.getTask('TASK-101')?.archivedAt, at);
  assert.equal(reopened.getSession('TASK-101')?.events.at(-1)?.kind, 'archived');

  // 幂等跳过：events 为空时不追加
  const idle = store.moveToArchive('TASK-101', (cur) => ({ task: cur, events: [] }));
  assert.equal(idle.events.length, 0);
  assert.equal(store.getSession('TASK-101')?.events.length, 1);

  assert.throws(
    () => store.moveToArchive('TASK-404', (cur) => ({ task: cur, events: [] })),
    (err: BoardError) => err.code === 'TASK_NOT_FOUND',
  );
});

test('moveTasksToArchive：锁内选取目标、单次提交；未命中时零写入', () => {
  const file = tmpStoreFile();
  const a = new JsonFileBoardStore(file);
  const b = new JsonFileBoardStore(file);
  a.putTask({ ...baseTask, id: 'TASK-101', title: 'a', status: 'done', priority: 'P2' });
  a.putTask({ ...baseTask, id: 'TASK-102', title: 'b', status: 'review', priority: 'P2' });
  a.putTask({ ...baseTask, id: 'TASK-103', title: 'c', status: 'done', priority: 'P2', archivedAt: '2026-10-01T00:00:00.000Z' });

  const at = '2026-10-03T00:00:00.000Z';
  const changed = a.moveTasksToArchive('default', (t) =>
    t.boardId === 'default' && t.status === 'done' && !t.archivedAt
      ? {
          task: { ...t, archivedAt: at, updatedAt: at },
          events: [{ at, kind: 'archived', detail: 'batch' }],
        }
      : null,
  );
  // 只选中未归档 done（101）；review（102）与已归档（103）不动
  assert.deepEqual(changed.map((t) => t.id), ['TASK-101']);
  assert.equal(a.getTask('TASK-102')?.archivedAt, undefined);
  assert.equal(a.getTask('TASK-103')?.archivedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(a.getSession('TASK-101')?.events.at(-1)?.kind, 'archived');

  // 另一实例视角：全部修改已提交
  assert.equal(b.getTask('TASK-101')?.archivedAt, at);

  // 未命中任何目标：返回空且不写入（mtime/内容不变）
  const before = readFileSync(file, 'utf8');
  const none = a.moveTasksToArchive('default', () => null);
  assert.equal(none.length, 0);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('旧版本程序面对 v3 文件：版本未知明确报错（升级前需停旧服务）', () => {
  // 模拟 v2 代码（只认 1/2）读取 v3 文件的行为：未知版本即拒绝
  const file = v2File({
    version: 3,
    boards: [{ id: 'default', name: 'Board' }],
    tasks: {},
    seq: 100,
  });
  const store = new JsonFileBoardStore(file); // 新代码可读
  assert.equal(store.boards.length, 1);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), version: 99 }), 'utf8');
  assert.throws(
    () => new JsonFileBoardStore(file),
    (err: BoardError) => err.code === 'STORE_ERROR' && /版本/.test(err.message),
  );
});


test('v3 → v5 迁移保留归档、Git、旧运行和时间线且不制造真实绑定', () => {
  const file = tmpStoreFile();
  const task = { ...v2Task, archivedAt: '2026-10-01T00:00:00.000Z', branch: 'keep', worktreePath: '/repos/a/.worktrees/old', execution: { state: 'running', sessionId: 'sess-old' } };
  const original = JSON.stringify({ version: 3, boards: [{ id: 'default', name: 'Board' }], tasks: { 'TASK-101': task }, sessions: { 'TASK-101': { taskId: 'TASK-101', events: [{ at: 'x', kind: 'started' }] } }, seq: 101 });
  writeFileSync(file, original);
  const store = new JsonFileBoardStore(file);
  assert.equal(readFileSync(`${file}.v3.bak`, 'utf8'), original);
  assert.deepEqual(store.getTask('TASK-101'), task);
  assert.equal(store.getTask('TASK-101')?.executionBinding, undefined);
  assert.equal(store.nextId(), 'TASK-102');
  assert.equal(store.getSession('TASK-101')?.events.length, 1);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 5);
  new JsonFileBoardStore(file);
  assert.equal(readFileSync(`${file}.v3.bak`, 'utf8'), original);
});

test('v4 新原生字段损坏明确拒绝，原文件不改写', () => {
  const binding = { provider: 'codex-desktop', threadId: 'thread', hostId: 'host', workspacePath: '/repos/a', workspaceOwner: 'user', boundAt: '2026-10-03T00:00:00.000Z' };
  for (const patch of [ { executionRequests: {} }, { executionBinding: { ...binding, threadId: 'sess-fake' } }, { executionBinding: { ...binding, hostId: 'creating-1' } }, { executionBinding: { ...binding, workspacePath: 'relative' } }, { executionBinding: { ...binding, boundAt: '2026-02-30T00:00:00.000Z' } }, { execution: { state: 'idle', runId: '' } } ]) {
    const file = tmpStoreFile();
    const raw = JSON.stringify({ version: 4, boards: [{ id: 'default', name: 'Board' }], tasks: { 'TASK-101': { ...v2Task, ...patch } }, seq: 101 });
    writeFileSync(file, raw);
    assert.throws(() => new JsonFileBoardStore(file), (err: BoardError) => err.code === 'STORE_ERROR');
    assert.equal(readFileSync(file, 'utf8'), raw);
  }
});

test('v4 模型字段校验保留有效 ID，拒绝空白、非法 ID 和后续动作覆盖', () => {
  const request = {
    requestId: 'request-model', runId: 'run-model', taskId: 'TASK-101', boardId: 'default',
    action: 'start', workspaceMode: 'project', hostId: 'native-host', receiverThreadId: 'native-receiver',
    repo: '/repos/a', status: 'pending', requestedAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z',
  };
  const invalid = ['', '  ', ' model ', 'model\n', 'model name', 'x'.repeat(129), '-model', 'model;command', 42];
  for (const patch of [...invalid.map((model) => ({ model })), { action: 'continue', model: 'valid-model' }]) {
    const file = tmpStoreFile();
    const raw = JSON.stringify({ version: 4, boards: [{ id: 'default', name: 'Board' }], tasks: { 'TASK-101': { ...v2Task, executionRequests: [{ ...request, ...patch }] } }, seq: 101 });
    writeFileSync(file, raw);
    assert.throws(() => new JsonFileBoardStore(file), (err: BoardError) => err.code === 'STORE_ERROR');
    assert.equal(readFileSync(file, 'utf8'), raw);
  }
  const file = tmpStoreFile();
  const model = 'provider/custom-model:latest';
  writeFileSync(file, JSON.stringify({ version: 4, boards: [{ id: 'default', name: 'Board' }], tasks: { 'TASK-101': { ...v2Task, executionRequests: [{ ...request, model }] } }, seq: 101 }));
  assert.equal(new JsonFileBoardStore(file).getTask('TASK-101')?.executionRequests?.[0].model, model);
});

test('事务发现旧版本时在已持有文件锁内迁移，不发生嵌套死锁', () => {
  const file = tmpStoreFile();
  const store = new JsonFileBoardStore(file);
  writeFileSync(file, JSON.stringify({ version: 3, boards: [{ id: 'default', name: 'Board' }], tasks: { 'TASK-101': v2Task }, seq: 101 }));
  store.mutateTask('TASK-101', (task) => ({ ...task, title: 'updated' }));
  assert.equal(store.getTask('TASK-101')?.title, 'updated');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 5);
});

test('迁移备份原子发布：上次中断留下截断临时文件不阻止重跑', () => {
  const file = tmpStoreFile();
  const original = JSON.stringify({ version: 4, boards: [{ id: 'default', name: 'Board' }], tasks: { 'TASK-101': v2Task }, seq: 101 });
  writeFileSync(file, original);
  const interruptedBackup = `${file}.v4.bak.123-deadbeef.tmp`;
  writeFileSync(interruptedBackup, original.slice(0, 17));

  const store = new JsonFileBoardStore(file);
  assert.equal(store.getTask('TASK-101')?.id, 'TASK-101');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 5);
  assert.equal(readFileSync(`${file}.v4.bak`, 'utf8'), original);
  assert.equal(readFileSync(interruptedBackup, 'utf8'), original.slice(0, 17));
  new JsonFileBoardStore(file);
  assert.equal(readFileSync(`${file}.v4.bak`, 'utf8'), original);
});
