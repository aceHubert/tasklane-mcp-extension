#!/usr/bin/env node
/** 存储热路径基准：固定 100 个活跃任务，比较 0 / 5000 个归档任务。 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { BoardEngine, GitService, JsonFileBoardStore } from '../packages/core/dist/src/index.js';

// 父进程提供独立于同步文件 IO 的硬超时，避免事件循环阻塞使 timer 失效。
if (!process.argv.includes('--worker')) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
    stdio: 'inherit', timeout: 60000, killSignal: 'SIGKILL',
  });
  if (result.error) console.error(`存储基准失败：${result.error.message}`);
  process.exit(result.status ?? 1);
}

const home = mkdtempSync(path.join(tmpdir(), 'tasklane-bench-'));
const at = '2026-10-04T00:00:00.000Z';
const activeCount = 100;
const samples = 9;
const results = [];

function fixture(archivedCount) {
  const tasks = {};
  const sessions = {};
  for (let index = 0; index < activeCount + archivedCount; index += 1) {
    const id = `TASK-${101 + index}`;
    const task = {
      id, boardId: 'default', title: `基准任务 ${index}`, description: '合成任务说明。'.repeat(45),
      status: index < activeCount ? 'backlog' : 'done', priority: 'P2', assignee: 'human',
      createdAt: at, updatedAt: at, execution: { state: 'idle' },
      ...(index < activeCount ? {} : { archivedAt: at }),
    };
    if (index % 3 === 0) task.executionRequests = [{
      requestId: `request-${index}`, runId: `run-${index}`, taskId: id, boardId: 'default',
      action: 'start', workspaceMode: 'project', repo: home, status: 'pending',
      requestedAt: at, updatedAt: at,
    }];
    tasks[id] = task;
    sessions[id] = { taskId: id, events: Array.from({ length: 10 }, (_, event) => ({
      at, kind: event === 0 ? 'created' : 'activity', detail: `合成事件 ${event}：验证存储热路径。`,
    })) };
  }
  return { version: 4, boards: [{ id: 'default', name: '基准看板', repo: null, baseBranch: 'main' }], tasks, sessions, seq: 100 + activeCount + archivedCount };
}

async function measure(operation, cleanup = () => {}) {
  await cleanup(await operation());
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const result = await operation();
    durations.push(performance.now() - started);
    await cleanup(result);
  }
  durations.sort((a, b) => a - b);
  return Number(durations[Math.floor(durations.length / 2)].toFixed(3));
}

for (const archivedCount of [0, 5000]) {
  const scenarioHome = mkdtempSync(path.join(home, `archive-${archivedCount}-`));
  const filePath = path.join(scenarioHome, 'board.json');
  const input = JSON.stringify(fixture(archivedCount), null, 2);
  writeFileSync(filePath, input);
  // 合成数据、迁移、首次构造和预热均在计时外；同一个脚本可比较 v4 / v5。
  const store = new JsonFileBoardStore(filePath);
  const engine = new BoardEngine(store, new GitService(false));
  assert.equal(engine.listTasks({ boardId: 'default' }).length, activeCount);
  assert.equal(engine.boardList()[0].archivedCount, archivedCount);
  let updateIndex = 0;
  const medianMs = {
    boardList: await measure(() => engine.boardList()),
    listTasks: await measure(() => engine.listTasks({ boardId: 'default' })),
    updateTask: await measure(() => engine.updateTask({ id: 'TASK-101', title: `基准更新 ${++updateIndex}` })),
    // 每次创建完成后在计时外清理临时任务，保持下一样本仍有 100 个活跃任务。
    createTask: await measure(() => engine.createTask({ boardId: 'default', title: '基准新任务' }),
      (task) => engine.deleteTask(task.id, 'default')),
  };
  results.push({ activeCount, archivedCount, version: JSON.parse(readFileSync(filePath, 'utf8')).version,
    fixtureBytes: Buffer.byteLength(input), hotFileBytes: statSync(filePath).size, samples, medianMs });
}

console.log(JSON.stringify({ home, results, ratio: Object.fromEntries(Object.keys(results[0].medianMs)
  .map((key) => [key, Number((results[1].medianMs[key] / results[0].medianMs[key]).toFixed(2))])) }, null, 2));
