import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BoardEngine, BoardError, GitService, JsonFileBoardStore, type ExportLang, type ExportScope } from '@tasklane/core';
import * as h from '../src/handlers.js';

const localTime = (...parts: [number, number, number, number?, number?]) =>
  new Date(parts[0], (parts[1] ?? 1) - 1, parts[2] ?? 1, parts[3] ?? 0, parts[4] ?? 0);

const rejectsCode = (code: BoardError['code']) => (error: unknown) =>
  error instanceof BoardError && error.code === code;

// 文件级兜底：默认导出目录按调用时 TASKLANE_HOME 解析，测试必须指向临时目录，
// 绝不写用户真实数据目录（node:test 每个文件独立进程，改环境变量不跨文件）
process.env.TASKLANE_HOME = mkdtempSync(path.join(tmpdir(), 'ck-export-guard-'));

async function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'ck-export-'));
  process.env.TASKLANE_HOME = home;
  const store = new JsonFileBoardStore(path.join(home, 'board.json'));
  const engine = new BoardEngine(store, new GitService(false), () => localTime(2026, 10, 4, 12, 0));
  return { home, store, engine };
}

test('tool 契约：task_export 默认最近一个月并返回 path/stats/markdown', async () => {
  const { home, engine } = await fixture();
  const created = await h.taskCreate(engine, { title: '导出契约任务' });
  const result = await engine.exportTasks({});

  assert.equal(result.boardId, created.task.boardId);
  assert.equal(result.scope, 'all');
  assert.equal(result.range.startDate, '2026-09-04');
  assert.equal(result.range.endDate, '2026-10-04');
  assert.equal(result.stats.total, 1);
  assert.equal(result.stats.byStatus.backlog, 1);
  assert.ok(result.path.startsWith(path.join(home, 'exports')));
  assert.ok(result.path.endsWith('.md'));
  assert.equal(readFileSync(result.path, 'utf8'), result.markdown);
  assert.equal(result.bytes, Buffer.byteLength(result.markdown, 'utf8'));
  assert.match(result.markdown, /#### `TASK-101` 导出契约任务/);
});

test('tool 契约：task_export 收窄 scope、切换语言并按 boardId 路由', async () => {
  const { home, store, engine } = await fixture();
  const active = await h.taskCreate(engine, { title: '未归档任务' });
  const done = await h.taskCreate(engine, { title: '待归档任务' });
  for (const status of ['ready', 'doing', 'review', 'done'] as const) {
    await h.taskMove(engine, { id: done.task.id, status });
  }
  await h.taskArchive(engine, { id: done.task.id });

  const all = await engine.exportTasks({});
  assert.equal(all.stats.total, 2);
  assert.equal(all.stats.archived, 1);

  const archivedOnly = await engine.exportTasks({ scope: 'archived' });
  assert.equal(archivedOnly.stats.total, 1);
  assert.match(archivedOnly.markdown, /#### `TASK-102` 待归档任务/);
  assert.doesNotMatch(archivedOnly.markdown, /TASK-101/);

  const english = await engine.exportTasks({ scope: 'active', lang: 'en' });
  assert.equal(english.stats.total, 1);
  assert.match(english.markdown, /^# TaskLane task export/);

  await assert.rejects(engine.exportTasks({ scope: 'bogus' as ExportScope }), rejectsCode('VALIDATION'));
  await assert.rejects(engine.exportTasks({ lang: 'fr' as ExportLang }), rejectsCode('VALIDATION'));
  assert.equal(active.task.status, 'backlog');

  store.registerBoard({ repoKey: '/repos/other/.git', repo: '/repos/other', name: '其它看板', baseBranch: 'main' });
  await assert.rejects(engine.exportTasks({}), rejectsCode('VALIDATION'));
  const scoped = await engine.exportTasks({ boardId: active.task.boardId });
  assert.equal(scoped.boardId, active.task.boardId);
});
