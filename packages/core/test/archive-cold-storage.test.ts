import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BoardEngine, BoardError, GitService, JsonFileBoardStore, type SessionRecord, type WorkItem } from '../src/index.js';

// golden 来自拆分前 v4 实现；本测试文件在独立进程固定时区以比较完整导出结果。
process.env.TZ = 'UTC';
const golden = JSON.parse(readFileSync(new URL('../../test/fixtures/archive-export-golden.json', import.meta.url), 'utf8'));
const at = '2026-10-04T12:00:00.000Z';
const code = (expected: BoardError['code']) => (error: unknown) => error instanceof BoardError && error.code === expected;
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const write = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data));

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'tasklane-cold-test-'));
  const file = path.join(home, 'board.json');
  const cold = path.join(home, 'archive', 'default.json');
  write(file, structuredClone(golden.input));
  const store = new JsonFileBoardStore(file);
  const engine = new BoardEngine(store, new GitService(false), () => new Date(at));
  return { home, file, cold, store, engine };
}

test('v4 归档迁移备份原始字节、拆分任务时间线，重开不覆盖备份或重复记录', () => {
  const { file, cold, store, engine } = fixture();
  assert.equal(read(file).version, 7);
  assert.equal(read(cold).version, 3);
  assert.deepEqual(read(`${file}.v4.bak`), golden.input);
  assert.equal(readFileSync(`${file}.v4.bak`, 'utf8'), JSON.stringify(golden.input));
  assert.deepEqual(Object.keys(read(file).tasks).sort(), ['TASK-1', 'TASK-3']);
  assert.deepEqual(Object.keys(read(cold).tasks), ['TASK-2']);
  assert.equal(read(file).sessions['TASK-2'], undefined);
  assert.deepEqual(read(cold).sessions['TASK-2'], golden.input.sessions['TASK-2']);
  assert.deepEqual(store.archivedCounts, { default: 1 });
  assert.equal(engine.boardList()[0].archivedCount, 1);
  const backup = readFileSync(`${file}.v4.bak`, 'utf8');
  const reopened = new JsonFileBoardStore(file);
  assert.equal(reopened.listTasks({ archive: 'all' }).length, 3);
  assert.equal(readFileSync(`${file}.v4.bak`, 'utf8'), backup);
  assert.deepEqual(reopened.getSession('TASK-2'), golden.input.sessions['TASK-2']);
});

test('迁移在已有部分冷文件时可重跑，原始任务和时间线不丢失不重复', () => {
  const { file, cold } = fixture();
  // 注入冷文件已提交、主文件仍为 v4 的迁移中间态。
  write(file, golden.input);
  const store = new JsonFileBoardStore(file);
  assert.equal(read(file).version, 7);
  assert.equal(store.listTasks({ archive: 'all' }).length, 3);
  assert.deepEqual(Object.keys(read(cold).tasks), ['TASK-2']);
  assert.deepEqual(store.getSession('TASK-2'), golden.input.sessions['TASK-2']);
});

test('已有 v4 备份与迁移源不一致时明确拒绝，保留源、备份和冷文件原样', () => {
  const { file, cold } = fixture();
  const source = structuredClone(golden.input);
  source.tasks['TASK-1'].title = '备份之后另有修改';
  write(file, source);
  const before = [file, `${file}.v4.bak`, cold].map(p => readFileSync(p, 'utf8'));
  assert.throws(() => new JsonFileBoardStore(file), code('STORE_ERROR'));
  assert.deepEqual([file, `${file}.v4.bak`, cold].map(p => readFileSync(p, 'utf8')), before);
});

test('归档计数非零却丢失冷文件时冷查询显式报错，热看板和活跃列表仍可用', () => {
  const { cold, engine } = fixture();
  // 只在临时目录移动文件，保留原始内容以模拟外部文件丢失。
  renameSync(cold, `${cold}.missing`);
  assert.equal(engine.boardList()[0].archivedCount, 1);
  assert.equal(engine.listTasks({ archive: 'active' }).length, 2);
  assert.equal(engine.getTask('TASK-1').title, '活跃任务');
  for (const operation of [
    () => engine.listTasks({ archive: 'archived' }),
    () => engine.listTasks({ archive: 'all' }),
    () => engine.getTask('TASK-2'),
  ]) assert.throws(operation, code('STORE_ERROR'));
});

test('boardList 使用同一次热快照，外部提交不会混合新计数与旧活跃任务', t => {
  const { file, store, engine } = fixture();
  const original = store.getActiveSnapshot.bind(store);
  let reads = 0;
  t.mock.method(store, 'getActiveSnapshot', () => {
    reads += 1;
    const snapshot = original();
    // 模拟另一个进程在本次读取结束后提交归档；本次结果必须保持同一代。
    const data = read(file);
    delete data.tasks['TASK-3'];
    data.archivedCounts.default = 2;
    write(file, data);
    return snapshot;
  });
  const first = engine.boardList()[0];
  assert.equal(reads, 1);
  assert.equal(first.total, 2);
  assert.equal(first.archivedCount, 1);
  const second = engine.boardList()[0];
  assert.equal(reads, 2);
  assert.equal(second.total, 1);
  assert.equal(second.archivedCount, 2);
});

test('单条、批量归档与恢复移动任务和时间线，计数及幂等语义一致', async () => {
  const { file, cold, engine, store } = fixture();
  const before = engine.getTaskWithTimeline('TASK-2');
  assert.equal(before.timeline[0].kind, 'archived');
  const restored = await engine.restoreTask('TASK-2');
  assert.equal(restored.changed, true);
  assert.equal(restored.task.status, 'done');
  assert.equal(restored.task.archivedAt, undefined);
  assert.equal(engine.boardList()[0].archivedCount, 0);
  assert.equal(read(cold).tasks['TASK-2'], undefined);
  assert.equal(read(cold).sessions['TASK-2'], undefined);
  assert.equal(read(file).sessions['TASK-2'].events.at(-1).kind, 'restored');
  assert.equal((await engine.restoreTask('TASK-2')).changed, false);
  const batch = await engine.archiveDoneTasks('default');
  assert.deepEqual(batch.archivedIds, ['TASK-2', 'TASK-3']);
  assert.equal(batch.archivedCount, 2);
  assert.equal(engine.boardList()[0].archivedCount, 2);
  assert.equal(engine.boardList()[0].total, 1);
  assert.deepEqual(store.archivedCounts, { default: 2 });
  assert.equal((await engine.archiveTask('TASK-2')).changed, false);
  assert.equal((await engine.archiveDoneTasks('default')).archivedCount, 0);
  assert.equal(read(file).tasks['TASK-2'], undefined);
  assert.equal(read(file).sessions['TASK-2'], undefined);
  assert.deepEqual(engine.getTaskWithTimeline('TASK-2').timeline.map(e => e.kind), ['archived', 'restored', 'archived']);
  await engine.restoreTask('TASK-3');
  assert.equal((await engine.archiveTask('TASK-3')).changed, true);
  assert.equal(engine.boardList()[0].archivedCount, 2);
  assert.throws(() => engine.getTask('TASK-999999'), code('TASK_NOT_FOUND'));
  await assert.rejects(engine.archiveTask('TASK-1'), code('VALIDATION'));
});

function injectDuplicate(file: string, cold: string, task: WorkItem, session: SessionRecord) {
  const data = read(cold);
  data.tasks[task.id] = { ...task, title: '冷文件旧副本', archivedAt: at };
  data.sessions[task.id] = session;
  write(cold, data);
  assert.ok(read(file).tasks[task.id]);
}

test('归档冷文件写入后崩溃：主文件优先，重试覆盖冷副本且事件只追加一次', async () => {
  const { file, cold, engine } = fixture();
  const task = engine.getTask('TASK-3');
  injectDuplicate(file, cold, task, { taskId: task.id, events: [{ kind: 'archived', at }] });
  assert.equal(engine.getTask(task.id).title, task.title);
  assert.deepEqual(engine.getTaskWithTimeline(task.id).timeline, []);
  assert.equal(engine.listTasks({ archive: 'all' }).length, 3);
  assert.deepEqual(engine.listTasks({ archive: 'archived' }).map(t => t.id), ['TASK-2']);
  assert.equal((await engine.archiveTask(task.id)).changed, true);
  assert.equal((await engine.archiveTask(task.id)).changed, false);
  assert.equal(engine.getTask(task.id).title, task.title);
  assert.deepEqual(engine.getTaskWithTimeline(task.id).timeline.map(e => e.kind), ['archived']);
  assert.equal(read(file).tasks[task.id], undefined);
  assert.equal(engine.boardList()[0].archivedCount, 2);
  assert.equal(engine.listTasks({ archive: 'all' }).length, 3);
});

test('恢复主文件写入后崩溃：主文件及时间线优先，重试清理冷副本而不重复恢复', async () => {
  const { file, cold, engine } = fixture();
  const oldCold = read(cold);
  await engine.restoreTask('TASK-2');
  write(cold, oldCold);
  const timeline = engine.getTaskWithTimeline('TASK-2').timeline;
  assert.equal(timeline.at(-1)?.kind, 'restored');
  assert.equal(engine.listTasks({ archive: 'archived' }).length, 0);
  assert.equal(engine.listTasks({ archive: 'all' }).length, 3);
  assert.equal((await engine.restoreTask('TASK-2')).changed, false);
  assert.equal(read(cold).tasks['TASK-2'], undefined);
  assert.equal(read(cold).sessions['TASK-2'], undefined);
  assert.equal(read(file).tasks['TASK-2'].archivedAt, undefined);
  assert.deepEqual(engine.getTaskWithTimeline('TASK-2').timeline, timeline);
  assert.equal(engine.boardList()[0].archivedCount, 0);
});

test('恢复崩溃遗留冷副本后删除热任务，不会从归档复活', async () => {
  const { cold, engine } = fixture();
  const oldCold = read(cold);
  await engine.restoreTask('TASK-2');
  write(cold, oldCold);
  for (const status of ['review', 'doing', 'ready', 'backlog']) await engine.moveTask('TASK-2', status);
  await engine.deleteTask('TASK-2');
  assert.throws(() => engine.getTask('TASK-2'), code('TASK_NOT_FOUND'));
  assert.equal(engine.listTasks({ archive: 'all' }).some(t => t.id === 'TASK-2'), false);
  assert.equal(read(cold).sessions['TASK-2'], undefined);
  assert.equal(engine.boardList()[0].archivedCount, 0);
});

test('归档任务常规写入与执行回执保持 TASK_ARCHIVED，不误报任务不存在', async () => {
  const { engine } = fixture();
  for (const operation of [
    () => engine.updateTask({ id: 'TASK-2', title: '禁止' }),
    () => engine.moveTask('TASK-2', 'ready'),
    () => engine.assignTask('TASK-2', 'agent'),
    () => engine.reportExecution({ id: 'TASK-2', boardId: 'default', requestId: 'request-1', runId: 'run-1', threadId: 'thread-1', hostId: 'local', reportId: 'report-1', state: 'running' }),
  ]) await assert.rejects(operation(), code('TASK_ARCHIVED'));
});

test('归档任务 bound 绑定优先返回 TASK_ARCHIVED，过期运行或缺少认领不能改变错误码', async () => {
  for (const stale of [true, false]) {
    const { cold, engine } = fixture();
    const data = read(cold);
    data.tasks['TASK-2'].execution.runId = stale ? 'run-current' : 'run-old';
    data.tasks['TASK-2'].executionRequests = [{
      requestId: 'request-old', runId: 'run-old', taskId: 'TASK-2', boardId: 'default',
      purpose: 'implementation', action: 'start', workspaceMode: 'project', repo: '/repos/cold',
      status: 'pending', requestedAt: at, updatedAt: at,
    }];
    write(cold, data);
    await assert.rejects(engine.bindExecution({
      id: 'TASK-2', boardId: 'default', requestId: 'request-old', runId: 'run-old',
      claimId: 'missing-claim', phase: 'bound', threadId: 'native-thread', hostId: 'local',
      workspacePath: '/repos/cold', workspaceOwner: 'user',
    }), code('TASK_ARCHIVED'));
  }
});

test('热路径不读取损坏冷文件：看板计数、默认列表、单条及时间线读写、active 导出', async () => {
  const { cold, home, engine, store } = fixture();
  writeFileSync(cold, '{损坏冷文件');
  assert.equal(engine.boardList()[0].archivedCount, 1);
  assert.equal(engine.listTasks().length, 2);
  assert.equal(store.listTasks().length, 2);
  assert.equal(engine.getTask('TASK-1').title, '活跃任务');
  assert.deepEqual(engine.getTaskWithTimeline('TASK-1').timeline, []);
  assert.equal((await engine.updateTask({ id: 'TASK-1', title: '已更新' })).title, '已更新');
  assert.equal((await engine.exportTasks({ scope: 'active', path: path.join(home, 'active.md') })).stats.total, 1);
  const created = await engine.createTask({ title: '损坏冷文件不影响新建' });
  assert.equal(engine.getTask(created.id).title, created.title);
  assert.equal(engine.getTaskWithTimeline(created.id).timeline[0].kind, 'created');
  assert.throws(() => engine.listTasks({ archive: 'archived' }), code('STORE_ERROR'));
});

test('迁移后三种导出 scope 与拆分前 v4 golden 完整全等，文件读取不改写存储', async () => {
  const { home, file, cold, engine } = fixture();
  const before = [readFileSync(file, 'utf8'), readFileSync(cold, 'utf8')];
  for (const scope of ['all', 'active', 'archived'] as const) {
    const { path: outputPath, ...result } = await engine.exportTasks({ scope, start: '2026-09-01', end: '2026-10-04', path: path.join(home, `${scope}.md`) });
    assert.deepEqual(result, golden.outputs[scope]);
    assert.equal(readFileSync(outputPath, 'utf8'), result.markdown);
  }
  assert.deepEqual([readFileSync(file, 'utf8'), readFileSync(cold, 'utf8')], before);
});

test('冷文件结构、归属、标识、时间线和时间戳校验拒绝非法数据', () => {
  const corruptions: Array<(data: any) => void> = [
    data => { data.version = 999; },
    data => { data.boardId = 'board-other'; },
    data => { data.tasks['TASK-2'].boardId = 'board-other'; },
    data => { data.tasks['TASK-2'].id = 'TASK-999'; },
    data => { data.tasks['TASK-2'].archivedAt = ''; },
    data => { data.tasks['TASK-2'].createdAt = ''; },
    data => { data.sessions['TASK-2'].events[0].kind = 'unknown'; },
    data => { data.sessions['TASK-2'].taskId = 'TASK-999'; },
  ];
  for (const corrupt of corruptions) {
    const { cold, engine } = fixture();
    const data = read(cold);
    corrupt(data);
    write(cold, data);
    assert.throws(() => engine.listTasks({ archive: 'archived' }), code('STORE_ERROR'));
  }
});

test('非法看板标识不允许穿越归档目录', () => {
  const { home, file } = fixture();
  const data = read(file);
  data.boards[0].id = '../outside';
  data.archivedCounts = { '../outside': 1 };
  data.tasks = {};
  data.sessions = {};
  write(file, data);
  assert.throws(() => new JsonFileBoardStore(file).listTasks({ boardId: '../outside', archive: 'archived' }), code('STORE_ERROR'));
  assert.equal(existsSync(path.join(home, 'outside.json')), false);
});
