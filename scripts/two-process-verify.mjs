#!/usr/bin/env node
/**
 * 双进程数据竞争验证（P1 存储并发修复的验收复现）：
 * 两个 MCP server 进程共用同一 TASKLANE_HOME，各自 createTask，
 * 修复前会生成两个 TASK-101 且后写覆盖先写；修复后 ID 唯一、双方任务都可见。
 * 多仓库扩展：双进程并发 board_create 同一仓库不产生重复看板；
 * 多看板下双进程 task_create 各自带 boardId，ID 仍全局唯一。
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(path.join(tmpdir(), 'ck-twoproc-'));
const serverPath = new URL('../mcp/dist/src/index.js', import.meta.url);
const children = new Set();
const stopServers = () => {
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
};
const hardTimeout = setTimeout(() => {
  console.error('TWO-PROCESS VERIFY FAILED：超过 60 秒硬超时');
  stopServers();
  process.exit(1);
}, 60000);

/* 临时 Git 仓库：双进程并发注册目标（注册校验不受 TASKLANE_GIT=off 影响） */
const repoR = mkdtempSync(path.join(tmpdir(), 'ck-twoproc-repo-'));
{
  const g = (args) => execFileSync('git', args, { cwd: repoR, timeout: 5000 }).toString().trim();
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(path.join(repoR, 'base.txt'), 'hello\n');
  g(['add', '.']);
  g(['commit', '-qm', 'init']);
}

function startServer() {
  const child = spawn(process.execPath, [fileURLToPath(serverPath)], {
    env: { ...process.env, TASKLANE_HOME: home, TASKLANE_REPO: '', TASKLANE_BASE_BRANCH: 'main', TASKLANE_GIT: 'off' },
    stdio: ['pipe', 'pipe', 'inherit'],
    detached: true,
  });
  children.add(child);
  const pending = new Map();
  let seq = 0;
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* ignore */ }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 10000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const call = (name, args) => request('tools/call', { name, arguments: args });
  return { child, request, call };
}

const a = startServer();
const b = startServer();
const results = [];
const check = (label, cond) => { results.push([label, cond]); console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`); };
const text = (res) => res.result.content[0].text;

try {
  for (const s of [a, b]) {
    await s.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'two-proc-verify', version: '0.0.0' },
    });
    s.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  // 双进程并发创建（同一起始 seq，修复前双方都拿到 TASK-101）
  const [ca, cb] = await Promise.all([
    a.call('task_create', { title: 'created by process A' }),
    b.call('task_create', { title: 'created by process B' }),
  ]);
  const idA = JSON.parse(text(ca)).task.id;
  const idB = JSON.parse(text(cb)).task.id;
  console.log(`  process A → ${idA}, process B → ${idB}`);
  check('P1 双进程创建 ID 不撞号', idA !== idB);

  // 双方都能看到彼此的任务（无覆盖丢失）
  const listA = JSON.parse(text(await a.call('task_list', { boardId: 'default' }))).tasks.map((t) => t.id);
  const listB = JSON.parse(text(await b.call('task_list', { boardId: 'default' }))).tasks.map((t) => t.id);
  check('P1 进程 A 能看到 B 的任务', listA.includes(idB));
  check('P1 进程 B 能看到 A 的任务', listB.includes(idA));

  // 跨进程读-改-写只管理业务；无关联执行状态必须拒绝且不能覆盖标题。
  await Promise.all([
    a.call('task_update', { action: 'update', id: idB, title: 'renamed by A' }),
    b.call('task_update', { action: 'update', id: idB, priority: 'P0' }),
  ]);
  const rejected = await b.call('task_update', { action: 'update', id: idB, execution: { state: 'waiting' } });
  const final = JSON.parse(text(await a.call('task_get', { id: idB }))).task;
  check('P1 跨进程业务更新不互相覆盖', final.title === 'renamed by A' && final.priority === 'P0');
  check('P1 无关联执行写入拒绝且无副作用', rejected.result.isError === true && text(rejected).includes('EXECUTION_REPORT_REQUIRED') && final.execution.state === 'idle');

  /* ---------- 并发首次指派：不再创建内部 session 或工作区 ---------- */
  const [sa, sb] = await Promise.all([
    a.call('task_update', { action: 'assign', id: idA, assignee: 'agent' }),
    b.call('task_update', { action: 'assign', id: idA, assignee: 'agent' }),
  ]);
  const assignedA = JSON.parse(text(sa)).task;
  const assignedB = JSON.parse(text(sb)).task;
  const stored = JSON.parse(text(await a.call('task_get', { id: idA }))).task;
  check(
    'P3 并发指派只改负责人，不生成 session/绑定/worktree',
    [assignedA, assignedB, stored].every((task) => task.assignee === 'agent' && task.execution.state === 'assigned' && !task.execution.sessionId && !task.execution.runId && !task.executionBinding && !task.worktreePath),
  );

  /* ---------- 多仓库：双进程并发注册与归属任务 ---------- */
  const [ra, rb] = await Promise.all([
    a.call('board_create', { repo: repoR, name: '项目 R' }),
    b.call('board_create', { repo: repoR, name: '项目 R 副本' }),
  ]);
  const boardRa = JSON.parse(text(ra)).board;
  const boardRb = JSON.parse(text(rb)).board;
  console.log(`  A 注册 → ${boardRa.id}, B 注册 → ${boardRb.id}`);
  check('P2 双进程并发注册同一仓库返回同一看板', boardRa.id === boardRb.id);
  check(
    'P2 先到者定义保留（双方看到同一名称/基线）',
    boardRb.name === boardRa.name && ['项目 R', '项目 R 副本'].includes(boardRa.name),
  );

  const boardListRes = JSON.parse(text(await a.call('board_list', {})));
  check(
    'P2 存储中无重复看板',
    boardListRes.boards.filter((x) => x.repoKey === boardRa.repoKey).length === 1,
  );

  // 多看板下双进程并发创建（各带 boardId）：ID 全局唯一
  const [ma, mb] = await Promise.all([
    a.call('task_create', { title: 'multi A', boardId: boardRa.id }),
    b.call('task_create', { title: 'multi B', boardId: 'default' }),
  ]);
  const multiA = JSON.parse(text(ma)).task;
  const multiB = JSON.parse(text(mb)).task;
  check(
    'P2 多看板双进程创建 ID 唯一且归属正确',
    multiA.id !== multiB.id && multiA.boardId === boardRa.id && multiB.boardId === 'default',
  );

  const boardsAfter = JSON.parse(text(await b.call('board_list', {}))).boards;
  const boardR = boardsAfter.find((x) => x.id === boardRa.id);
  const boardDef = boardsAfter.find((x) => x.id === 'default');
  check(
    'P2 重启视角下仓库/看板/计数保持',
    Boolean(boardR) && boardR.total === 1 && boardDef.total === 3,
  );

  /* ---------- 原生执行协议并发：仅模拟关联回执，不证明真实宿主路由 ---------- */
  await a.call('task_move', { id: multiA.id, boardId: boardRa.id, status: 'ready' });
  const input = {
    id: multiA.id, boardId: boardRa.id, requestAction: 'start', workspaceMode: 'project',
    hostId: 'twoproc-host', receiverThreadId: 'twoproc-receiver',
  };
  const [requestA, requestB] = await Promise.all([
    a.call('task_execution', { action: 'request', ...input, requestId: 'request-A' }),
    b.call('task_execution', { action: 'request', ...input, requestId: 'request-B' }),
  ]);
  const requestedA = JSON.parse(text(requestA));
  const requestedB = JSON.parse(text(requestB));
  check('P5 双进程同意图请求只创建一次且返回同一 requestId/runId', Number(requestedA.created) + Number(requestedB.created) === 1 && requestedA.request.requestId === requestedB.request.requestId && requestedA.request.runId === requestedB.request.runId);
  check('P5 request 原子标记 Agent，仅 starting，无内部 session', [requestedA, requestedB].every((result) => result.task.assignee === 'agent' && result.task.execution.state === 'starting' && !result.task.execution.sessionId));
  const receipt = { id: multiA.id, boardId: boardRa.id, requestId: requestedA.request.requestId, runId: requestedA.request.runId };
  const [claimA, claimB] = await Promise.all([
    a.call('task_execution', { action: 'claim', ...receipt, claimId: 'claim-A' }),
    b.call('task_execution', { action: 'claim', ...receipt, claimId: 'claim-B' }),
  ]);
  const claimResults = [claimA, claimB];
  const winners = claimResults.filter((result) => !result.result.isError);
  const losers = claimResults.filter((result) => result.result.isError);
  check('P5 双进程不同 claimId 恰一认领成功，另一明确冲突', winners.length === 1 && losers.length === 1 && JSON.parse(text(winners[0])).claimed === true && text(losers[0]).includes('EXECUTION_CONFLICT'));
  if (winners.length !== 1) throw new Error('认领竞争没有唯一赢家');
  const claim = { ...receipt, claimId: JSON.parse(text(winners[0])).request.claimId };
  const [sameClaimA, sameClaimB] = await Promise.all([
    a.call('task_execution', { action: 'claim', ...claim }), b.call('task_execution', { action: 'claim', ...claim }),
  ]);
  check('P5 原 claimId 跨进程幂等，不抢占不再创建', [sameClaimA, sameClaimB].every((result) => JSON.parse(text(result)).claimed === false));
  const binding = { ...claim, threadId: 'twoproc-thread', hostId: input.hostId, workspacePath: boardRa.repo, workspaceOwner: 'user', branch: 'main' };
  const created = JSON.parse(text(await a.call('task_execution', { action: 'bind', ...binding, phase: 'created' })));
  check('P5 created 持久化原生结果但不绑定/不写 running', created.request.status === 'created' && created.request.result.threadId === binding.threadId && !created.task.executionBinding && created.task.execution.state === 'starting');
  const [boundA, boundB] = await Promise.all([
    a.call('task_execution', { action: 'bind', ...binding, phase: 'bound' }),
    b.call('task_execution', { action: 'bind', ...binding, phase: 'bound' }),
  ]);
  // Git 校验有异步间隙：同结果重复绑定可成功，也可要求重新读取后恢复。
  for (const result of [boundA, boundB]) {
    if (result.result.isError) {
      check('P5 并发绑定旧快照明确返回冲突', text(result).includes('EXECUTION_CONFLICT'));
    }
  }
  const bound = JSON.parse(text(await b.call('task_execution', { action: 'bind', ...binding, phase: 'bound' })));
  check('P5 bound 复用同 claim/result，仅 starting', bound.request.status === 'bound' && bound.task.executionBinding.threadId === binding.threadId && bound.task.execution.state === 'starting' && JSON.stringify(bound.request.result) === JSON.stringify(created.request.result));
  const report = { ...receipt, threadId: binding.threadId, hostId: input.hostId };
  await Promise.all([
    a.call('task_update', { action: 'update', id: multiA.id, boardId: boardRa.id, title: 'renamed during report' }),
    b.call('task_execution', { action: 'report', ...report, reportId: 'run-1', state: 'running', activity: '协议测试回执' }),
    a.call('task_execution', { action: 'report', ...report, reportId: 'run-1', state: 'running', activity: '协议测试回执' }),
  ]);
  const runningDetail = JSON.parse(text(await a.call('task_get', { id: multiA.id })));
  const runningTask = runningDetail.task;
  check('P5 跨进程标题与关联 running 回执不互相覆盖', runningTask.title === 'renamed during report' && runningTask.execution.state === 'running' && runningTask.executionBinding.threadId === binding.threadId);
  const autoMoves = runningDetail.timeline.filter((event) => event.kind === 'moved' && event.detail === 'ready → doing');
  check('P5 双进程重复 running 原子移到 Doing 且只记录一次 moved', runningTask.status === 'doing' && autoMoves.length === 1 && autoMoves[0].at === runningTask.execution.startedAt);
  const [lateDelivery, waiting] = await Promise.all([
    a.call('task_execution', { action: 'delivery', ...receipt, status: 'uncertain', error: '模拟传输超时' }),
    b.call('task_execution', { action: 'report', ...report, reportId: 'wait-1', state: 'waiting' }),
  ]);
  check('P5 迟到投递不会覆盖运行阶段', ['running', 'waiting'].includes(JSON.parse(text(lateDelivery)).request.status) && JSON.parse(text(waiting)).request.status === 'waiting');
  const [completeA, completeB] = await Promise.all([
    a.call('task_execution', { action: 'report', ...report, reportId: 'complete-1', state: 'completed' }),
    b.call('task_execution', { action: 'report', ...report, reportId: 'complete-1', state: 'completed' }),
  ]);
  const completeTask = JSON.parse(text(await b.call('task_get', { id: multiA.id }))).task;
  check('P5 双进程同 reportId 完成回执仅持久一次且保留 Doing', [completeA, completeB].every((result) => !result.result.isError) && completeTask.execution.state === 'completed' && completeTask.status === 'doing' && completeTask.executionRequests.length === 1 && completeTask.executionRequests[0].reports.length === 3);
  const message = '完整回复\n'.repeat(100);
  const reply = JSON.parse(text(await b.call('task_execution', { action: 'request', ...input, requestId: 'reply-2', requestAction: 'reply', message })));
  const stale = await a.call('task_execution', { action: 'report', ...report, reportId: 'late-run-1', state: 'running' });
  check('P5 新轮保存完整回复/新 runId，旧轮回执拒绝', reply.request.message === message && reply.request.runId !== receipt.runId && stale.result.isError === true && text(stale).includes('EXECUTION_STALE'));

  /* ---------- 归档并发：单条归档 / 守卫 / 双进程批量不重复 ---------- */
  // helper：default 看板下新建任务并推进到 done
  const makeDone = async (server, title) => {
    const id = JSON.parse(text(await server.call('task_create', { title, boardId: 'default' }))).task.id;
    for (const s of ['ready', 'doing', 'review', 'done']) {
      await server.call('task_move', { id, status: s });
    }
    return id;
  };

  const idDone = await makeDone(a, 'archive target');
  const archByA = JSON.parse(text(await a.call('task_archive', { id: idDone })));
  check('P4 A 归档 done 任务成功', archByA.changed === true && Boolean(archByA.task.archivedAt));

  // B 面对已归档任务的常规修改被核心层拒绝（跨进程不可绕过）
  const updByB = await b.call('task_update', { action: 'update', id: idDone, title: 'x' });
  check(
    'P4 B 修改归档任务返回 TASK_ARCHIVED',
    updByB.result.isError === true && text(updByB).includes('TASK_ARCHIVED'),
  );

  // B 恢复后 A 的修改恢复可用（跨进程状态一致）
  const restoreByB = JSON.parse(text(await b.call('task_restore', { id: idDone })));
  check('P4 B 恢复归档任务', restoreByB.changed === true && restoreByB.task.archivedAt === undefined);
  const updByA = await a.call('task_update', { action: 'update', id: idDone, title: 'renamed after restore' });
  check('P4 恢复后 A 可继续修改', updByA.result.isError !== true);

  // 双进程并发批量归档：文件锁串行化，每个任务只被归档一次，数量合计准确
  const idD2 = await makeDone(a, 'done 2');
  const idD3 = await makeDone(b, 'done 3');
  const [ba, bb] = await Promise.all([
    a.call('task_archive_done', { boardId: 'default' }),
    b.call('task_archive_done', { boardId: 'default' }),
  ]);
  const batchA = JSON.parse(text(ba));
  const batchB = JSON.parse(text(bb));
  const batchTotal = batchA.archivedCount + batchB.archivedCount;
  console.log(`  batch A → ${batchA.archivedCount}, B → ${batchB.archivedCount}`);
  check(
    'P4 双进程并发批量归档不重复不遗漏',
    batchTotal === 3 && new Set([...batchA.archivedIds, ...batchB.archivedIds]).size === 3,
  );

  // 并发回退 vs 批量归档：事务内选取目标，结果只能是二选一，无非法中间态
  const idRace = await makeDone(a, 'race target');
  const [mvRes, batchRes] = await Promise.all([
    a.call('task_move', { id: idRace, status: 'review' }),
    b.call('task_archive_done', { boardId: 'default' }),
  ]);
  const raceTask = JSON.parse(text(await a.call('task_get', { id: idRace }))).task;
  const archivedInRace = JSON.parse(text(batchRes)).archivedIds.includes(idRace);
  console.log(`  race → status=${raceTask.status}, archived=${Boolean(raceTask.archivedAt)}, archivedInBatch=${archivedInRace}`);
  check(
    'P4 并发回退与批量归档无非法中间态',
    (raceTask.status === 'review' && !raceTask.archivedAt && !archivedInRace) ||
      (raceTask.status === 'done' && Boolean(raceTask.archivedAt) && archivedInRace),
  );

  const finalBoards = JSON.parse(text(await a.call('board_list', {}))).boards;
  const finalDef = finalBoards.find((x) => x.id === 'default');
  check(
    'P4 board_list 归档计数与竞争最终结果一致',
    finalDef.archivedCount === 3 + Number(Boolean(raceTask.archivedAt)),
  );

  /* ---------- 冷存储：移动期间全量读取和导出不能丢失或重复任务 ---------- */
  const coldTarget = await makeDone(a, 'cold storage concurrent target');
  const beforeCold = JSON.parse(text(await a.call('task_list', { boardId: 'default', archive: 'all' }))).tasks;
  const expectedIds = beforeCold.map((task) => task.id).sort();
  const expectedArchived = beforeCold.filter((task) => task.archivedAt).length;
  const parse = (response) => {
    if (response.result.isError) throw new Error(text(response));
    return JSON.parse(text(response));
  };
  for (let round = 0; round < 6; round += 1) {
    for (const operation of ['task_archive', 'task_restore']) {
      const [changed, boards, listed, detail, exported] = await Promise.all([
        a.call(operation, { id: coldTarget }).then(parse),
        b.call('board_list', {}).then(parse),
        b.call('task_list', { boardId: 'default', archive: 'all' }).then(parse),
        b.call('task_get', { id: coldTarget }).then(parse),
        b.call('task_export', {
          boardId: 'default', scope: 'all', start: '2000-01-01', end: '2100-01-01',
          path: path.join(home, `concurrent-${round}-${operation}.md`),
        }).then(parse),
      ]);
      const board = boards.boards.find((item) => item.id === 'default');
      const ids = listed.tasks.map((task) => task.id).sort();
      const label = `P6 第 ${round + 1} 轮 ${operation}`;
      check(`${label} 与查询并发成功且任务不丢不重`, changed.changed === true &&
        JSON.stringify(ids) === JSON.stringify(expectedIds) && new Set(ids).size === ids.length);
      check(`${label} 看板计数属于完整的前后快照`,
        board.total + board.archivedCount === expectedIds.length &&
        [expectedArchived, expectedArchived + 1].includes(board.archivedCount));
      check(`${label} 全局详情和时间线始终可读`, detail.task.id === coldTarget &&
        detail.timeline.length >= 5 && detail.timeline.every((event) => Boolean(event.at && event.kind)));
      const exportedIds = [...exported.markdown.matchAll(/^#### `([^`]+)`/gm)].map((match) => match[1]).sort();
      check(`${label} 导出合并冷/热文件无丢失或重复`, exported.stats.total === expectedIds.length &&
        JSON.stringify(exportedIds) === JSON.stringify(expectedIds));
    }
  }
  const afterCold = parse(await b.call('task_get', { id: coldTarget }));
  const afterBoards = parse(await b.call('board_list', {}));
  check('P6 并发归档恢复后计数和时间线恰好各提交六次',
    !afterCold.task.archivedAt && afterCold.task.status === 'done' &&
    afterCold.timeline.filter((event) => event.kind === 'archived').length === 6 &&
    afterCold.timeline.filter((event) => event.kind === 'restored').length === 6 &&
    afterBoards.boards.find((board) => board.id === 'default').archivedCount === expectedArchived);
} catch (err) {
  check(`exception: ${err.message}`, false);
  console.error(err);
} finally {
  clearTimeout(hardTimeout);
  stopServers();
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? '\nTWO-PROCESS VERIFY PASSED' : `\nTWO-PROCESS VERIFY FAILED (${failed.length})`);
process.exit(failed.length === 0 ? 0 : 1);
