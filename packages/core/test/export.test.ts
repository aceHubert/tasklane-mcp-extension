import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BoardEngine,
  BoardError,
  EXPORT_DESCRIPTION_MAX,
  GitService,
  JsonFileBoardStore,
  collectExportStats,
  defaultExportFileName,
  resolveExportRange,
  selectExportTasks,
  type ExportScope,
  type WorkItem,
} from '../src/index.js';

/** 本地时间构造：断言与实现同用本地时区，测试不依赖运行环境的 TZ 设置 */
const localTime = (...parts: [number, number, number, number?, number?, number?]) =>
  new Date(parts[0], (parts[1] ?? 1) - 1, parts[2] ?? 1, parts[3] ?? 0, parts[4] ?? 0, parts[5] ?? 0);

// 文件级兜底：即使某个用例没有走 fixture，默认导出目录也必须落在临时目录
process.env.TASKLANE_HOME = mkdtempSync(path.join(tmpdir(), 'tasklane-export-guard-'));

const rejectsCode = (code: BoardError['code']) => (error: unknown) =>
  error instanceof BoardError && error.code === code;

function makeTask(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  const at = localTime(2026, 9, 20, 10, 0).toISOString();
  return {
    id,
    boardId: 'default',
    title: `任务 ${id}`,
    status: 'doing',
    priority: 'P2',
    assignee: 'human',
    execution: { state: 'idle', updatedAt: at },
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

async function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'tasklane-export-home-'));
  // 默认导出目录按调用时的 TASKLANE_HOME 解析：测试文件内始终指向临时目录，
  // 绝不写用户真实数据目录（node:test 每个文件独立进程，改环境变量不跨文件）
  process.env.TASKLANE_HOME = home;
  const file = path.join(home, 'board.json');
  const store = new JsonFileBoardStore(file);
  store.mutateBoard('default', (board) => ({ ...board, name: '测试看板', repo: '/repos/demo' }));
  const engine = new BoardEngine(store, new GitService(false), () => localTime(2026, 10, 4, 12, 0));
  return { home, file, store, engine };
}

test('导出区间：end 缺省为今天当天结束，start 缺省为往前一个自然月', () => {
  const range = resolveExportRange({}, localTime(2026, 10, 4, 12, 0));
  assert.equal(range.start, localTime(2026, 9, 4).toISOString());
  assert.equal(range.end, new Date(localTime(2026, 10, 4, 23, 59, 59).getTime() + 999).toISOString());
  assert.equal(range.startDate, '2026-09-04');
  assert.equal(range.endDate, '2026-10-04');
  assert.match(range.timezone, /^UTC[+-]\d{2}:\d{2}$/);

  // 月末回退：3 月 31 日往前一个月落在 2 月 28 日（2026 非闰年），不整体顺延到 3 月
  const monthEnd = resolveExportRange({}, localTime(2026, 3, 31, 8, 0));
  assert.equal(monthEnd.start, localTime(2026, 2, 28).toISOString());
  assert.equal(monthEnd.startDate, '2026-02-28');

  // 只给 end 时 start 以该日为准，不读当前时间
  const explicitEnd = resolveExportRange({ end: '2026-06-15' }, localTime(2026, 10, 4, 12, 0));
  assert.equal(explicitEnd.start, localTime(2026, 5, 15).toISOString());
  assert.equal(explicitEnd.end, new Date(localTime(2026, 6, 15, 23, 59, 59).getTime() + 999).toISOString());
});

test('导出区间：YYYY-MM-DD 按本地自然日展开，ISO 时间按精确时刻，非法输入拒绝', () => {
  const range = resolveExportRange({ start: '2026-09-04', end: '2026-10-04' }, localTime(2026, 10, 4, 12, 0));
  assert.equal(range.start, localTime(2026, 9, 4).toISOString());
  assert.equal(range.end, new Date(localTime(2026, 10, 4, 23, 59, 59).getTime() + 999).toISOString());

  const precise = resolveExportRange(
    { start: localTime(2026, 9, 4, 8, 30).toISOString(), end: localTime(2026, 9, 4, 9, 0).toISOString() },
    localTime(2026, 10, 4, 12, 0),
  );
  assert.equal(precise.start, localTime(2026, 9, 4, 8, 30).toISOString());
  assert.equal(precise.end, localTime(2026, 9, 4, 9, 0).toISOString());

  assert.throws(() => resolveExportRange({ start: '2026-02-30' }, localTime(2026, 10, 4)), rejectsCode('VALIDATION'));
  assert.throws(() => resolveExportRange({ end: 'not-a-date' }, localTime(2026, 10, 4)), rejectsCode('VALIDATION'));
  assert.throws(
    () => resolveExportRange({ start: '2026-10-05', end: '2026-10-04' }, localTime(2026, 10, 4)),
    rejectsCode('VALIDATION'),
  );
  // 只给未来的 start：end 仍缺省为今天，最终区间非法必须显式报错而不是猜测
  assert.throws(
    () => resolveExportRange({ start: '2027-01-01' }, localTime(2026, 10, 4)),
    rejectsCode('VALIDATION'),
  );
});

test('区间命中：创建、更新、归档任一落在闭区间内即导出，其余排除', () => {
  const range = resolveExportRange({ start: '2026-09-04', end: '2026-10-04' }, localTime(2026, 10, 4, 12, 0));
  const inside = localTime(2026, 9, 20, 10, 0).toISOString();
  const old = localTime(2026, 7, 1, 10, 0).toISOString();
  const tasks: WorkItem[] = [
    makeTask('TASK-1', { createdAt: inside, updatedAt: inside }),
    makeTask('TASK-2', { createdAt: old, updatedAt: inside }),
    makeTask('TASK-3', { createdAt: old, updatedAt: old, archivedAt: inside }),
    makeTask('TASK-4', { createdAt: old, updatedAt: old }),
    // 边界：起点当日 00:00 与终点当日 23:59:59.999 都算命中
    makeTask('TASK-5', { createdAt: range.start, updatedAt: range.end }),
  ];
  const entries = selectExportTasks(tasks, range);
  // 同状态内按更新时间倒序（TASK-5 命中终点当日），未命中任务的其余字段不参与排序
  assert.deepEqual(entries.map((e) => e.task.id), ['TASK-5', 'TASK-1', 'TASK-2', 'TASK-3']);
  assert.deepEqual(entries.find((e) => e.task.id === 'TASK-2')?.matched, ['updatedAt']);
  assert.deepEqual(entries.find((e) => e.task.id === 'TASK-3')?.matched, ['archivedAt']);
  assert.deepEqual(entries.find((e) => e.task.id === 'TASK-5')?.matched, ['createdAt', 'updatedAt']);

  const stats = collectExportStats(entries);
  assert.equal(stats.total, 4);
  assert.equal(stats.byStatus.doing, 4);
  assert.equal(stats.archived, 1);
  assert.equal(stats.human, 4);
  assert.equal(stats.agent, 0);
});

test('渲染报告：元信息、概览表、按状态分组明细与描述截断', async () => {
  const { home, store, engine } = await fixture();
  const inside = localTime(2026, 9, 20, 10, 0).toISOString();
  store.putTask(makeTask('TASK-101', {
    title: '实现导出',
    status: 'doing',
    priority: 'P1',
    assignee: 'agent',
    createdAt: inside,
    updatedAt: inside,
    branch: 'codex/task-101',
    worktreePath: '/repos/demo/.worktrees/task-101',
    execution: { state: 'completed', activity: 'Editing 3 files', startedAt: inside, updatedAt: inside },
    changes: {
      filesChanged: 2,
      additions: 42,
      deletions: 7,
      testStatus: 'passing',
      files: [
        { name: 'src/a.ts', added: 30, removed: 5 },
        { name: 'src/b.ts', added: 12, removed: 2 },
      ],
    },
    description: '第一行\n第二行',
  }));
  store.putTask(makeTask('TASK-102', {
    title: '已归档任务',
    status: 'done',
    createdAt: localTime(2026, 7, 1, 10, 0).toISOString(),
    updatedAt: inside,
    archivedAt: inside,
  }));
  store.putTask(makeTask('TASK-103', {
    title: '超长描述',
    createdAt: inside,
    updatedAt: inside,
    description: 'x'.repeat(EXPORT_DESCRIPTION_MAX + 50),
  }));
  store.putTask(makeTask('TASK-104', {
    title: '区间外',
    createdAt: localTime(2026, 1, 1, 10, 0).toISOString(),
    updatedAt: localTime(2026, 1, 2, 10, 0).toISOString(),
  }));

  const result = await engine.exportTasks({ start: '2026-09-04', end: '2026-10-04' });
  const { markdown } = result;
  assert.match(markdown, /^# TaskLane 任务导出 · 测试看板/);
  assert.match(markdown, /- 看板：`测试看板`（`default`）/);
  assert.match(markdown, /- 仓库：`\/repos\/demo`/);
  assert.match(markdown, /- 区间：2026-09-04 00:00 — 2026-10-04 23:59（UTC[+-]\d{2}:\d{2}，含边界）/);
  assert.match(markdown, /- 范围：全部任务（含归档）/);
  assert.match(markdown, /\| 任务总数 \| 3 \|/);
  assert.match(markdown, /\| 其中已归档 \| 1 \|/);
  assert.match(markdown, /- 命中口径：创建、更新或归档时间落在区间内/);
  assert.match(markdown, /### 执行中（doing） · 2/);
  assert.match(markdown, /### 已完成（done） · 1/);
  assert.match(markdown, /#### `TASK-101` 实现导出/);
  assert.match(markdown, /- 状态：执行中（doing） · 优先级：P1 · 负责人：agent/);
  assert.match(markdown, /- 区间命中：创建、更新/);
  assert.match(markdown, /- 分支：`codex\/task-101` · 工作区：`\/repos\/demo\/\.worktrees\/task-101`/);
  assert.match(markdown, /- 执行：completed · 摘要：Editing 3 files/);
  assert.match(markdown, /- 变更：2 个文件，\+42 \/ −7，测试 通过/);
  assert.match(markdown, /  - `src\/a\.ts` \+30 −5/);
  assert.match(markdown, /> 第一行\n> 第二行/);
  assert.match(markdown, / · 归档：2026-09-20 10:00/);
  assert.match(markdown, /…（内容已截断）/);
  assert.doesNotMatch(markdown, /区间外/);
  assert.equal(markdown.endsWith('\n'), true);
  assert.equal(result.stats.total, 3);
  assert.equal(result.stats.agent, 1);
  assert.equal(readFileSync(result.path, 'utf8'), markdown);
});

test('渲染报告：空区间仍有完整骨架，英文语言可切换', async () => {
  const { engine } = await fixture();
  const result = await engine.exportTasks({});
  assert.match(result.markdown, /该区间没有匹配的任务。/);
  assert.match(result.markdown, /\| 任务总数 \| 0 \|/);
  assert.equal(result.stats.total, 0);
  assert.deepEqual(result.range.startDate, '2026-09-04');

  const english = await engine.exportTasks({ lang: 'en' });
  assert.match(english.markdown, /^# TaskLane task export · 测试看板/);
  assert.match(english.markdown, /- Scope: All tasks \(incl\. archived\)/);
  assert.match(english.markdown, /- Match rule: Created, updated, or archived within the range/);
  assert.match(english.markdown, /\| Total tasks \| 0 \|/);
  assert.match(english.markdown, /No tasks matched this range\./);
});

test('落盘：默认写入数据目录 exports/，显式路径补目录与后缀，重复导出覆盖同一份', async () => {
  const { home, store, engine } = await fixture();
  const inside = localTime(2026, 9, 20, 10, 0).toISOString();
  store.putTask(makeTask('TASK-101', { createdAt: inside, updatedAt: inside }));

  const exportsDir = path.join(home, 'exports');
  // 引擎时钟固定在 2026-10-04 12:00（本地）：文件名携带生成时间戳 yyyyMMdd-HHmmss
  const fileName = '测试看板-2026-09-04_2026-10-04-20261004-120000.md';
  const result = await engine.exportTasks({});
  assert.equal(result.path, path.join(exportsDir, fileName));
  assert.equal(readFileSync(result.path, 'utf8'), result.markdown);
  assert.equal(result.bytes, Buffer.byteLength(result.markdown, 'utf8'));
  // 原子写入不留临时文件
  assert.deepEqual(readdirSync(exportsDir), [fileName]);

  const again = await engine.exportTasks({});
  assert.equal(again.path, result.path);
  assert.equal(readdirSync(exportsDir).length, 1);

  // 显式目录：补默认文件名；缺 .md 后缀：补全
  const outDir = mkdtempSync(path.join(tmpdir(), 'tasklane-export-dir-'));
  const intoDir = await engine.exportTasks({ path: outDir });
  assert.equal(intoDir.path, path.join(outDir, fileName));
  const noSuffix = await engine.exportTasks({ path: path.join(outDir, 'report') });
  assert.equal(noSuffix.path, path.join(outDir, 'report.md'));

  await assert.rejects(engine.exportTasks({ path: 'relative/report.md' }), rejectsCode('VALIDATION'));
});

test('导出是只读操作：不改任务数据，默认文件名口径稳定', async () => {
  const { home, file, store, engine } = await fixture();
  const inside = localTime(2026, 9, 20, 10, 0).toISOString();
  store.putTask(makeTask('TASK-101', { createdAt: inside, updatedAt: inside }));
  const before = readFileSync(file, 'utf8');

  const result = await engine.exportTasks({ start: '2026-09-01', end: '2026-09-30' });
  assert.equal(readFileSync(file, 'utf8'), before);
  // 文件名时间戳使用引擎时钟的生成时刻，与真实时间无关
  assert.equal(
    defaultExportFileName(store.getBoard('default')!, result.range, new Date(2026, 8, 30, 14, 30, 5)),
    '测试看板-2026-09-01_2026-09-30-20260930-143005.md',
  );
  assert.equal(result.scope, 'all');
});

test('导出范围：scope 收窄与多看板必须显式指定 boardId', async () => {
  const { home, store, engine } = await fixture();
  const inside = localTime(2026, 9, 20, 10, 0).toISOString();
  store.putTask(makeTask('TASK-101', { createdAt: inside, updatedAt: inside }));
  store.putTask(makeTask('TASK-102', {
    status: 'done',
    createdAt: localTime(2026, 7, 1, 10, 0).toISOString(),
    updatedAt: inside,
    archivedAt: inside,
  }));

  const active = await engine.exportTasks({ scope: 'active' });
  assert.equal(active.stats.total, 1);
  assert.match(active.markdown, /- 范围：仅未归档任务/);
  const archived = await engine.exportTasks({ scope: 'archived' });
  assert.equal(archived.stats.total, 1);
  assert.equal(archived.stats.archived, 1);
  await assert.rejects(engine.exportTasks({ scope: 'bogus' as ExportScope }), rejectsCode('VALIDATION'));

  store.registerBoard({ repoKey: '/repos/other/.git', repo: '/repos/other', name: '另一个看板', baseBranch: 'main' });
  await assert.rejects(engine.exportTasks({}), rejectsCode('VALIDATION'));
  const scoped = await engine.exportTasks({ boardId: 'default' });
  assert.equal(scoped.boardId, 'default');
});

test('导出失败不产生半截文件：目标父级不是目录时报 STORE_ERROR', async () => {
  const { home, engine } = await fixture();
  const blocker = path.join(home, 'not-a-dir');
  writeFileSync(blocker, 'x');
  await assert.rejects(
    engine.exportTasks({ path: path.join(blocker, 'report.md') }),
    rejectsCode('STORE_ERROR'),
  );
  // 失败没有在数据目录留下报告
  assert.equal(readdirSync(home).includes('exports'), false);
});
