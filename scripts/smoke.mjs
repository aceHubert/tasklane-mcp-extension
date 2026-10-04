#!/usr/bin/env node
/**
 * 端到端冒烟：通过 stdio JSON-RPC 驱动 MCP server，
 * 验证 initialize → tools/list → board_create / create/assign/move/list 全链路与错误通道。
 * 多看板场景使用临时 Git 仓库：注册校验在 TASKLANE_GIT=off 下仍需可用 Git（执行计划 §4.1）。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(path.join(tmpdir(), 'ck-smoke-'));
const serverPath = new URL('../mcp/dist/src/index.js', import.meta.url);
let child;
const stopServer = () => {
  if (child?.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
};
const hardTimeout = setTimeout(() => {
  console.error('SMOKE FAILED：超过 60 秒硬超时');
  stopServer();
  process.exit(1);
}, 60000);

/* 临时 Git 仓库：smoke 的 board_create 真实注册目标 */
const repoA = mkdtempSync(path.join(tmpdir(), 'ck-smoke-repo-'));
const git = (args, cwd = repoA) => execFileSync('git', args, { cwd, timeout: 5000 }).toString().trim();
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 't@t']);
git(['config', 'user.name', 't']);
writeFileSync(path.join(repoA, 'base.txt'), 'hello\n');
git(['add', '.']);
git(['commit', '-qm', 'init']);

child = spawn(process.execPath, [fileURLToPath(serverPath)], {
  env: { ...process.env, TASKLANE_HOME: home, TASKLANE_REPO: '', TASKLANE_BASE_BRANCH: 'main', TASKLANE_GIT: 'off' },
  stdio: ['pipe', 'pipe', 'inherit'],
  detached: true,
});

const pending = new Map();
let nextId = 0;
const logs = [];

const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  } catch {
    logs.push(`unparseable stdout: ${line.slice(0, 120)}`);
  }
});

function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 10000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

function call(name, args) {
  return request('tools/call', { name, arguments: args });
}

function parseContent(res) {
  return JSON.parse(res.result.content[0].text);
}

const failures = [];
function check(label, cond) {
  if (cond) {
    console.log(`  PASS ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL ${label}`);
  }
}

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.0' },
  });
  check('initialize 返回 server info', init.result?.serverInfo?.name === 'tasklane');
  notify('notifications/initialized', {});

  const tools = await request('tools/list', {});
  const names = tools.result.tools.map((t) => t.name);
  check(
    'tools/list 包含 15 个业务工具和 7 个关联执行工具（普通 stdio 不提供 UI 入口）',
    [
      'board_list', 'board_create', 'dir_list', 'model_list', 'task_list', 'task_get',
      'task_create', 'task_update', 'task_delete', 'task_move', 'task_assign',
      'task_archive', 'task_restore', 'task_archive_done', 'task_export',
      'task_execution_request', 'task_execution_delivery', 'task_execution_claim',
      'task_execution_bind', 'task_execution_report',
      'task_execution_recovery_request', 'task_execution_recover',
    ].every((n) => names.includes(n)) && names.length === 22 && !names.includes('open_tasklane'),
  );

  /* ---------- 单看板（default）：省略 boardId 自动解析 ---------- */
  const created = await call('task_create', { title: 'Implement OAuth callback', priority: 'P1' });
  const task = parseContent(created).task;
  check('task_create 生成 TASK-101（单看板自动归属 default）', task.id === 'TASK-101' && task.boardId === 'default');

  const assigned = await call('task_assign', { id: 'TASK-101', assignee: 'agent' });
  const assignedTask = parseContent(assigned).task;
  check(
    'task_assign 只改负责人，不生成 session/绑定/worktree',
    assignedTask.execution.state === 'assigned' && !assignedTask.execution.sessionId && !assignedTask.execution.runId && !assignedTask.executionBinding && !assignedTask.worktreePath,
  );

  const moved = await call('task_move', { id: 'TASK-101', status: 'doing' });
  check('task_move 只改业务状态，不启动执行', parseContent(moved).task.status === 'doing' && JSON.stringify(parseContent(moved).task.execution) === JSON.stringify(assignedTask.execution));

  const updated = await call('task_update', {
    id: 'TASK-101',
    execution: { state: 'waiting', activity: 'Waiting for input' },
  });
  check('task_update 无关联执行写入返回 EXECUTION_REPORT_REQUIRED', updated.result.isError === true && updated.result.content[0].text.includes('EXECUTION_REPORT_REQUIRED'));

  const detail = await call('task_get', { id: 'task-101' });
  check('task_get 大小写不敏感 + timeline', parseContent(detail).timeline.length >= 3);

  /* ---------- 多看板：board_create 注册与归属隔离 ---------- */
  const reg = await call('board_create', { repo: repoA, name: '项目 A', baseBranch: 'main' });
  const boardA = parseContent(reg).board;
  // macOS 临时目录带符号链接（/var → /private/var），Git 返回的是真实路径
  const realRepoA = realpathSync(repoA);
  check(
    'board_create 注册仓库（TASKLANE_GIT=off 下注册校验仍用 Git）',
    Boolean(boardA?.id) && boardA.repo === realRepoA && Boolean(boardA.repoKey?.endsWith('/.git')),
  );

  const badBranch = await call('board_create', { repo: repoA, baseBranch: 'no-such-branch' });
  check(
    'board_create 非法分支返回 VALIDATION',
    badBranch.result.isError === true && badBranch.result.content[0].text.includes('VALIDATION'),
  );

  // 同一仓库重复注册：幂等返回已有看板（不改名称/基线/任务归属）
  const regAgain = await call('board_create', { repo: repoA });
  check('board_create 重复注册幂等返回已有看板', parseContent(regAgain).board.id === boardA.id);

  const multiCreate = await call('task_create', { title: 'no boardId under multi-board' });
  check(
    '多看板下 task_create 省略 boardId 返回 VALIDATION',
    multiCreate.result.isError === true && multiCreate.result.content[0].text.includes('VALIDATION'),
  );

  const createA = await call('task_create', { title: 'Task in board A', boardId: boardA.id });
  const taskA = parseContent(createA).task;
  check('task_create 携带 boardId 归属新看板', taskA.id === 'TASK-102' && taskA.boardId === boardA.id);

  /* ---------- 关联执行协议：模拟回执，不代表真实原生工具已可用 ---------- */
  const input = {
    id: taskA.id, boardId: boardA.id, requestId: 'smoke-start', action: 'start',
    workspaceMode: 'project', hostId: 'smoke-host', receiverThreadId: 'smoke-receiver',
  };
  const { boardId: omittedBoard, ...withoutBoard } = input;
  const missingBoard = await call('task_execution_request', withoutBoard);
  check('关联执行工具 boardId 必填', missingBoard.result.isError === true);
  const requestRes = await call('task_execution_request', input);
  const execution = parseContent(requestRes);
  check('执行工具 text 与 structuredContent 一致', JSON.stringify(execution) === JSON.stringify(requestRes.result.structuredContent));
  check('request 原子标记 Agent，返回 task/request/created，仅 starting 且无 session', execution.created === true && execution.task.assignee === 'agent' && execution.request.status === 'pending' && execution.task.execution.state === 'starting' && execution.task.execution.runId === execution.request.runId && !execution.task.execution.sessionId);
  const replay = parseContent(await call('task_execution_request', input));
  check('request 幂等复用服务端 runId', replay.created === false && replay.request.runId === execution.request.runId);
  const receipt = { id: taskA.id, boardId: boardA.id, requestId: execution.request.requestId, runId: execution.request.runId };
  const delivered = parseContent(await call('task_execution_delivery', { ...receipt, status: 'delivered' }));
  check('delivery 不伪写 running', delivered.request.status === 'delivered' && delivered.task.execution.state === 'starting');
  const claim = { ...receipt, claimId: 'smoke-claim' };
  const claimed = parseContent(await call('task_execution_claim', claim));
  const claimAgain = parseContent(await call('task_execution_claim', claim));
  check('claim 返回 claimed 并幂等保留认领', claimed.claimed === true && claimed.request.claimId === claim.claimId && claimAgain.claimed === false);
  const conflict = await call('task_execution_claim', { ...claim, claimId: 'other-claim' });
  check('不同 claimId 不得抢占', conflict.result.isError === true && conflict.result.content[0].text.includes('EXECUTION_CONFLICT'));
  const binding = { ...claim, threadId: 'smoke-thread', hostId: input.hostId, workspacePath: realRepoA, workspaceOwner: 'user', branch: 'main' };
  const earlyBound = await call('task_execution_bind', { ...binding, phase: 'bound' });
  check('bound 必须先保存 created 结果', earlyBound.result.isError === true && earlyBound.result.content[0].text.includes('EXECUTION_CONFLICT'));
  const legacyThread = await call('task_execution_bind', { ...binding, phase: 'created', threadId: 'sess-not-native' });
  check('内部 sess-* 不得当作真实 threadId', legacyThread.result.isError === true && legacyThread.result.content[0].text.includes('VALIDATION'));
  const nativeCreated = parseContent(await call('task_execution_bind', { ...binding, phase: 'created' }));
  const nativeBound = parseContent(await call('task_execution_bind', { ...binding, phase: 'bound' }));
  check('created → bound 使用同一 claim/result 且不写 running', nativeCreated.request.status === 'created' && !nativeCreated.task.executionBinding && nativeBound.request.status === 'bound' && nativeBound.task.executionBinding.threadId === binding.threadId && nativeBound.task.execution.state === 'starting' && JSON.stringify(nativeCreated.request.result) === JSON.stringify(nativeBound.request.result));
  const report = { ...receipt, threadId: binding.threadId, hostId: input.hostId };
  const earlyComplete = await call('task_execution_report', { ...report, reportId: 'early-complete', state: 'completed' });
  check('completed 必须有本轮真实开始回执', earlyComplete.result.isError === true && earlyComplete.result.content[0].text.includes('EXECUTION_CONFLICT'));
  const running = parseContent(await call('task_execution_report', { ...report, reportId: 'smoke-running', state: 'running', activity: '协议测试回执' }));
  const runningAgain = parseContent(await call('task_execution_report', { ...report, reportId: 'smoke-running', state: 'running', activity: '协议测试回执' }));
  check('running 只由关联回执写入且 reportId 幂等', running.task.execution.state === 'running' && Boolean(running.request.startedAt) && runningAgain.request.reports.length === 1);
  const lateDelivery = parseContent(await call('task_execution_delivery', { ...receipt, status: 'uncertain', error: '模拟投递超时' }));
  check('迟到 uncertain 不覆盖运行回执', lateDelivery.request.status === 'running' && lateDelivery.task.execution.state === 'running');
  const completed = parseContent(await call('task_execution_report', { ...report, reportId: 'smoke-completed', state: 'completed' }));
  check('完成回执不替代 task_move', completed.request.status === 'completed' && completed.task.status === 'backlog');
  const terminalReplay = parseContent(await call('task_execution_request', input));
  check('终态旧请求重放不新建运行', terminalReplay.created === false && terminalReplay.request.runId === receipt.runId && terminalReplay.task.execution.state === 'completed');
  const message = '完整回复\n'.repeat(100);
  const reply = parseContent(await call('task_execution_request', { ...input, requestId: 'smoke-reply', action: 'reply', message }));
  check('reply 完整持久化并生成新 runId，复用原绑定', reply.created === true && reply.request.message === message && reply.request.runId !== receipt.runId && reply.task.executionBinding.threadId === binding.threadId);
  const stale = await call('task_execution_report', { ...report, reportId: 'late-running', state: 'running' });
  check('旧 runId 回执不能覆盖当前请求', stale.result.isError === true && stale.result.content[0].text.includes('EXECUTION_STALE'));

  /* ---------- 等待恢复：核对消息 + 宿主观测回报，模拟不证明真实路由 ---------- */
  // 恢复针对当前运行代次（reply 生成的 runId），旧 runId 的核对被 EXECUTION_STALE 拒绝。
  const recoveryReceipt = { id: taskA.id, boardId: boardA.id, requestId: reply.request.requestId, runId: reply.request.runId };
  const staleRecovery = await call('task_execution_recovery_request', { ...receipt, checkId: 'stale-check' });
  check('旧 runId 核对被拒绝', staleRecovery.result.isError === true && staleRecovery.result.content[0].text.includes('EXECUTION_STALE'));
  const checkId = 'smoke-check';
  const recoveryRequest = parseContent(await call('task_execution_recovery_request', { ...recoveryReceipt, checkId }));
  check('recovery_request 记录核对快照，不改执行状态', recoveryRequest.created === true &&
    recoveryRequest.request.recoveryCheck?.checkId === checkId && recoveryRequest.request.recoveryCheck.status === 'pending' &&
    recoveryRequest.request.status === 'pending' && recoveryRequest.task.execution.state === 'starting');
  const busyReport = parseContent(await call('task_execution_recover', { ...recoveryReceipt, checkId, checkerThreadId: input.receiverThreadId, hostId: input.hostId,
    outcome: 'busy', message: '原线程仍在处理', observations: [{ threadId: binding.threadId, hostId: input.hostId, state: 'active', observedAt: new Date().toISOString() }] }));
  check('busy 只审计不解除等待', busyReport.request.status === 'pending' && busyReport.request.recoveryCheck.status === 'busy' && busyReport.task.execution.state === 'starting');
  const badStop = await call('task_execution_recover', { ...recoveryReceipt, checkId: 'ghost-check', checkerThreadId: input.receiverThreadId, hostId: input.hostId,
    outcome: 'stopped', message: '过期核对', confirmedStopped: true, observations: [] });
  check('非当前核对报告被拒绝', badStop.result.isError === true && badStop.result.content[0].text.includes('EXECUTION_STALE'));
  const flipped = await call('task_execution_recover', { ...recoveryReceipt, checkId, checkerThreadId: input.receiverThreadId, hostId: input.hostId,
    outcome: 'stopped', message: '改变结论', confirmedStopped: true,
    observations: [{ threadId: binding.threadId, hostId: input.hostId, state: 'idle', observedAt: new Date().toISOString() }] });
  check('已报告 busy 的核对不能改口 stopped', flipped.result.isError === true && flipped.result.content[0].text.includes('EXECUTION_CONFLICT'));
  // busy 已有结论，显式重新核对应生成新代次；只有尚未超时的 pending 检查可合并。
  const nextCheckId = 'smoke-check-2';
  const nextCheck = parseContent(await call('task_execution_recovery_request', { ...recoveryReceipt, checkId: nextCheckId }));
  check('busy 后显式核对创建新 checkId', nextCheck.created === true && nextCheck.request.recoveryCheck.checkId === nextCheckId);
  const pendingCheck = parseContent(await call('task_execution_recovery_request', { ...recoveryReceipt, checkId: 'smoke-check-3' }));
  check('未超时 pending 核对复用同一 checkId', pendingCheck.created === false && pendingCheck.request.recoveryCheck.checkId === nextCheckId);
  const stopped = parseContent(await call('task_execution_recover', { ...recoveryReceipt, checkId: nextCheckId, checkerThreadId: input.receiverThreadId, hostId: input.hostId,
    outcome: 'stopped', message: '宿主已核对旧操作结束', confirmedStopped: true,
    observations: [
      { threadId: input.receiverThreadId, hostId: input.hostId, state: 'active', observedAt: new Date().toISOString(), priorOperationEnded: true },
      { threadId: binding.threadId, hostId: input.hostId, state: 'idle', observedAt: new Date().toISOString() },
    ] }));
  check('stopped 解除等待并保留绑定/结果', stopped.changed === true && stopped.request.status === 'cancelled' &&
    stopped.request.recovery?.checkId === nextCheckId && JSON.stringify(stopped.request.result) === JSON.stringify(reply.request.result) &&
    stopped.task.executionBinding.threadId === binding.threadId && stopped.task.execution.state === 'assigned');
  const lateClaim = await call('task_execution_claim', { ...recoveryReceipt, claimId: 'late-claim', hostId: input.hostId, receiverThreadId: input.receiverThreadId });
  check('已恢复请求不能再认领', lateClaim.result.isError === true && lateClaim.result.content[0].text.includes('EXECUTION_STALE'));

  const listA = await call('task_list', { boardId: boardA.id });
  check('task_list 按看板过滤', parseContent(listA).tasks.length === 1 && parseContent(listA).tasks[0].id === 'TASK-102');

  const boards = await call('board_list', {});
  const boardList = parseContent(boards).boards;
  const def = boardList.find((b) => b.id === 'default');
  const brd = boardList.find((b) => b.id === boardA.id);
  check(
    'board_list 各看板独立计数',
    boardList.length === 2 && def.counts.doing === 1 && def.total === 1 && brd.total === 1,
  );

  const ghostBoard = await call('task_list', { boardId: 'ghost' });
  check(
    '不存在的看板返回 BOARD_NOT_FOUND',
    ghostBoard.result.isError === true && ghostBoard.result.content[0].text.includes('BOARD_NOT_FOUND'),
  );

  const mismatch = await call('task_move', { id: 'TASK-102', status: 'ready', boardId: 'default' });
  check(
    '错误归属返回 BOARD_MISMATCH',
    mismatch.result.isError === true && mismatch.result.content[0].text.includes('BOARD_MISMATCH'),
  );

  // 省略 boardId：任务 ID 全局唯一，用任务自身归属完成流转
  const moveA = await call('task_move', { id: 'TASK-102', status: 'ready' });
  check('task_move 省略 boardId 用任务自身归属', parseContent(moveA).task.status === 'ready');

  const invalid = await call('task_move', { id: 'TASK-101', status: 'done' });
  check(
    'task_move 非法流转返回 isError',
    invalid.result.isError === true && invalid.result.content[0].text.includes('INVALID_TRANSITION'),
  );

  const listed = await call('task_list', { boardId: 'default', status: 'doing' });
  check('task_list 看板 + 状态叠加过滤', parseContent(listed).tasks.length === 1);

  /* ---------- 任务归档：单条 / 幂等 / 守卫 / 恢复 / 批量 ---------- */
  // TASK-101 doing/assigned、TASK-102 属于 boardA；default 下新建 TASK-103 推进到 done
  await call('task_create', { title: 'Archive flow task', boardId: 'default' });
  for (const s of ['ready', 'doing', 'review', 'done']) {
    await call('task_move', { id: 'TASK-103', status: s });
  }

  const archNonDone = await call('task_archive', { id: 'TASK-101' });
  check(
    'task_archive 非 done 任务返回 VALIDATION',
    archNonDone.result.isError === true && archNonDone.result.content[0].text.includes('VALIDATION'),
  );

  const archived = parseContent(await call('task_archive', { id: 'TASK-103' }));
  check(
    'task_archive done 任务：archivedAt + status 保持 done + changed=true',
    archived.changed === true && Boolean(archived.task.archivedAt) && archived.task.status === 'done',
  );

  const archAgain = parseContent(await call('task_archive', { id: 'TASK-103' }));
  check('task_archive 重复归档幂等 changed=false', archAgain.changed === false);

  const activeIds = parseContent(await call('task_list', { boardId: 'default' })).tasks.map((t) => t.id);
  check('task_list 默认排除归档任务', activeIds.includes('TASK-101') && !activeIds.includes('TASK-103'));

  const archivedIds = parseContent(await call('task_list', { boardId: 'default', archive: 'archived' })).tasks.map((t) => t.id);
  check('task_list archive=archived 只含归档任务', JSON.stringify(archivedIds) === JSON.stringify(['TASK-103']));

  const allIds = parseContent(await call('task_list', { boardId: 'default', archive: 'all' })).tasks.map((t) => t.id);
  check('task_list archive=all 含全部任务', allIds.length === 2 && allIds.includes('TASK-103'));

  const boardsAfterArch = parseContent(await call('board_list', {})).boards;
  const defAfterArch = boardsAfterArch.find((b) => b.id === 'default');
  const brdAfterArch = boardsAfterArch.find((b) => b.id === boardA.id);
  check(
    'board_list counts/total 排除归档且 archivedCount 单列',
    defAfterArch.counts.done === 0 && defAfterArch.total === 1 && defAfterArch.archivedCount === 1 && brdAfterArch.archivedCount === 0,
  );

  const updArchived = await call('task_update', { id: 'TASK-103', title: 'x' });
  check(
    '归档任务 task_update 返回 TASK_ARCHIVED',
    updArchived.result.isError === true && updArchived.result.content[0].text.includes('TASK_ARCHIVED'),
  );
  const mvArchived = await call('task_move', { id: 'TASK-103', status: 'review' });
  check(
    '归档任务 task_move 返回 TASK_ARCHIVED',
    mvArchived.result.isError === true && mvArchived.result.content[0].text.includes('TASK_ARCHIVED'),
  );
  const archMismatch = await call('task_archive', { id: 'TASK-103', boardId: boardA.id });
  check(
    'task_archive 错误归属返回 BOARD_MISMATCH',
    archMismatch.result.isError === true && archMismatch.result.content[0].text.includes('BOARD_MISMATCH'),
  );

  const archDetail = parseContent(await call('task_get', { id: 'TASK-103' }));
  check(
    'task_get 可读取归档任务及时间线（archived 事件）',
    Boolean(archDetail.task.archivedAt) && archDetail.timeline.some((e) => e.kind === 'archived'),
  );

  const restored = parseContent(await call('task_restore', { id: 'TASK-103' }));
  check('task_restore 恢复到 Done：移除 archivedAt', restored.changed === true && restored.task.archivedAt === undefined);
  const restoredIds = parseContent(await call('task_list', { boardId: 'default', status: 'done' })).tasks.map((t) => t.id);
  check('恢复后重新出现在 Done 列表', JSON.stringify(restoredIds) === JSON.stringify(['TASK-103']));

  // 批量：TASK-104 推进到 done 后与已恢复的 TASK-103 一起归档
  await call('task_create', { title: 'Batch archive task', boardId: 'default' });
  for (const s of ['ready', 'doing', 'review', 'done']) {
    await call('task_move', { id: 'TASK-104', status: s });
  }
  const batch = parseContent(await call('task_archive_done', { boardId: 'default' }));
  check(
    'task_archive_done 归档看板全部未归档 done 任务',
    batch.archivedCount === 2 && JSON.stringify(batch.archivedIds) === JSON.stringify(['TASK-103', 'TASK-104']),
  );
  const batchAgain = parseContent(await call('task_archive_done', { boardId: 'default' }));
  check('task_archive_done 重复请求幂等返回 0', batchAgain.archivedCount === 0);
  const batchGhost = await call('task_archive_done', { boardId: 'ghost' });
  check(
    'task_archive_done 不存在的看板返回 BOARD_NOT_FOUND',
    batchGhost.result.isError === true && batchGhost.result.content[0].text.includes('BOARD_NOT_FOUND'),
  );

  /* ---------- 任务删除：仅 backlog / 级联清理 / 守卫 ---------- */
  await call('task_create', { title: 'Delete flow task', boardId: 'default' }); // TASK-105
  const delReady = await call('task_delete', { id: 'TASK-101' });
  check(
    'task_delete 非 backlog 任务返回 VALIDATION',
    delReady.result.isError === true && delReady.result.content[0].text.includes('VALIDATION'),
  );
  const deleted = parseContent(await call('task_delete', { id: 'TASK-105', boardId: 'default' }));
  check('task_delete backlog 任务成功', deleted.deleted === true && deleted.id === 'TASK-105');
  const delGone = await call('task_get', { id: 'TASK-105' });
  check(
    'task_delete 删除后 task_get 返回 TASK_NOT_FOUND',
    delGone.result.isError === true && delGone.result.content[0].text.includes('TASK_NOT_FOUND'),
  );
  const delAgain = await call('task_delete', { id: 'TASK-105' });
  check(
    'task_delete 重复删除返回 TASK_NOT_FOUND',
    delAgain.result.isError === true && delAgain.result.content[0].text.includes('TASK_NOT_FOUND'),
  );

  /* ---------- 任务导出：默认最近一个月 / 落盘 / 只读 ---------- */
  const storeBefore = readFileSync(path.join(home, 'board.json'), 'utf8');
  const exported = parseContent(await call('task_export', { boardId: 'default' }));
  check(
    'task_export 默认最近一个月、落盘 Markdown 且返回统计',
    exported.path.startsWith(path.join(home, 'exports')) && exported.path.endsWith('.md') &&
      existsSync(exported.path) && readFileSync(exported.path, 'utf8') === exported.markdown &&
      exported.markdown.startsWith('# TaskLane 任务导出') && exported.bytes > 0 &&
      exported.range.startDate < exported.range.endDate && exported.stats.total >= 1,
  );
  const exportedEmpty = parseContent(await call('task_export', { boardId: 'default', start: '2000-01-01', end: '2000-01-31' }));
  check(
    'task_export 区间无任务仍生成空报告',
    exportedEmpty.stats.total === 0 && exportedEmpty.markdown.includes('该区间没有匹配的任务'),
  );
  const exportBadRange = await call('task_export', { boardId: 'default', start: '2026-10-05', end: '2026-10-04' });
  check(
    'task_export start 晚于 end 返回 VALIDATION',
    exportBadRange.result.isError === true && exportBadRange.result.content[0].text.includes('VALIDATION'),
  );
  const exportGhost = await call('task_export', { boardId: 'ghost' });
  check(
    'task_export 不存在的看板返回 BOARD_NOT_FOUND',
    exportGhost.result.isError === true && exportGhost.result.content[0].text.includes('BOARD_NOT_FOUND'),
  );
  check('task_export 不改任务数据（board.json 内容不变）', readFileSync(path.join(home, 'board.json'), 'utf8') === storeBefore);
} catch (err) {
  failures.push(`exception: ${err.message}`);
  console.error(err);
} finally {
  clearTimeout(hardTimeout);
  stopServer();
}

if (failures.length > 0) {
  console.error(`\nSMOKE FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nSMOKE PASSED');
process.exit(0);
