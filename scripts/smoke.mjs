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

function requestArgs(base, patch = {}) {
  const merged = { ...base, ...patch };
  const { action, ...rest } = merged;
  return { ...rest, action: 'request', requestAction: action };
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
  const appOnly = (name) => {
    const tool = tools.result.tools.find((t) => t.name === name);
    return Array.isArray(tool?._meta?.ui?.visibility) && tool._meta.ui.visibility.includes('app');
  };
  check(
    'tools/list 收敛为 16 个注册工具（11 模型可见 + 5 app-only；普通 stdio 不提供 UI 入口）',
    [
      'board_list', 'board_create', 'task_list', 'task_get', 'task_create',
      'task_update', 'task_move', 'task_archive', 'task_restore', 'task_execution', 'task_execution_recover',
      'task_export', 'dir_list', 'model_list', 'task_delete', 'task_archive_done',
    ].every((n) => names.includes(n)) && names.length === 16 && !names.includes('open_tasklane') &&
      appOnly('task_export') && appOnly('dir_list') && appOnly('model_list') && appOnly('task_delete') &&
      appOnly('task_archive_done') && appOnly('task_execution_recover') &&
      ['task_update', 'task_execution', 'task_list', 'task_archive'].every((n) => !appOnly(n)),
  );

  /* ---------- 单看板（default）：省略 boardId 自动解析 ---------- */
  const created = await call('task_create', { title: 'Implement OAuth callback', priority: 'P1' });
  const task = parseContent(created).task;
  check('task_create 生成 TASK-101（单看板自动归属 default）', task.id === 'TASK-101' && task.boardId === 'default');

  const assigned = await call('task_update', { action: 'assign', id: 'TASK-101', assignee: 'agent' });
  const assignedTask = parseContent(assigned).task;
  check(
    'task_update action=assign 只改负责人，不生成 session/绑定/worktree',
    assignedTask.execution.state === 'assigned' && !assignedTask.execution.sessionId && !assignedTask.execution.runId && !assignedTask.executionBinding && !assignedTask.worktreePath,
  );

  const moved = await call('task_move', { id: 'TASK-101', status: 'doing' });
  check('task_move 只改业务状态，不启动执行', parseContent(moved).task.status === 'doing' && JSON.stringify(parseContent(moved).task.execution) === JSON.stringify(assignedTask.execution));

  const updated = await call('task_update', {
    action: 'update',
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
  const missingBoard = await call('task_execution', requestArgs(withoutBoard));
  check('关联执行工具 boardId 必填', missingBoard.result.isError === true);
  const requestRes = await call('task_execution', requestArgs(input));
  const execution = parseContent(requestRes);
  check('执行工具 text 与 structuredContent 一致', JSON.stringify(execution) === JSON.stringify(requestRes.result.structuredContent));
  check('request 原子标记 Agent，返回 task/request/created，仅 starting 且无 session', execution.created === true && execution.task.assignee === 'agent' && execution.request.status === 'pending' && execution.task.execution.state === 'starting' && execution.task.execution.runId === execution.request.runId && !execution.task.execution.sessionId);
  const replay = parseContent(await call('task_execution', requestArgs(input)));
  check('request 幂等复用服务端 runId', replay.created === false && replay.request.runId === execution.request.runId);
  const receipt = { id: taskA.id, boardId: boardA.id, requestId: execution.request.requestId, runId: execution.request.runId };
  const delivered = parseContent(await call('task_execution', { action: 'delivery', ...receipt, status: 'delivered' }));
  check('delivery 不伪写 running', delivered.request.status === 'delivered' && delivered.task.execution.state === 'starting');
  const claim = { ...receipt, claimId: 'smoke-claim' };
  const claimed = parseContent(await call('task_execution', { action: 'claim', ...claim }));
  const claimAgain = parseContent(await call('task_execution', { action: 'claim', ...claim }));
  check('claim 返回 claimed 并幂等保留认领', claimed.claimed === true && claimed.request.claimId === claim.claimId && claimAgain.claimed === false);
  const conflict = await call('task_execution', { action: 'claim', ...claim, claimId: 'other-claim' });
  check('不同 claimId 不得抢占', conflict.result.isError === true && conflict.result.content[0].text.includes('EXECUTION_CONFLICT'));
  const binding = { ...claim, threadId: 'smoke-thread', hostId: input.hostId, workspacePath: realRepoA, workspaceOwner: 'user', branch: 'main' };
  const earlyBound = await call('task_execution', { action: 'bind', ...binding, phase: 'bound' });
  check('bound 必须先保存 created 结果', earlyBound.result.isError === true && earlyBound.result.content[0].text.includes('EXECUTION_CONFLICT'));
  const legacyThread = await call('task_execution', { action: 'bind', ...binding, phase: 'created', threadId: 'sess-not-native' });
  check('内部 sess-* 不得当作真实 threadId', legacyThread.result.isError === true && legacyThread.result.content[0].text.includes('VALIDATION'));
  const nativeCreated = parseContent(await call('task_execution', { action: 'bind', ...binding, phase: 'created' }));
  const nativeBound = parseContent(await call('task_execution', { action: 'bind', ...binding, phase: 'bound' }));
  check('created → bound 使用同一 claim/result 且不写 running', nativeCreated.request.status === 'created' && !nativeCreated.task.executionBinding && nativeBound.request.status === 'bound' && nativeBound.task.executionBinding.threadId === binding.threadId && nativeBound.task.execution.state === 'starting' && JSON.stringify(nativeCreated.request.result) === JSON.stringify(nativeBound.request.result));
  const report = { ...receipt, threadId: binding.threadId, hostId: input.hostId };
  const earlyComplete = await call('task_execution', { action: 'report', ...report, reportId: 'early-complete', state: 'completed' });
  check('completed 必须有本轮真实开始回执', earlyComplete.result.isError === true && earlyComplete.result.content[0].text.includes('EXECUTION_CONFLICT'));
  const running = parseContent(await call('task_execution', { action: 'report', ...report, reportId: 'smoke-running', state: 'running', activity: '协议测试回执' }));
  const runningAgain = parseContent(await call('task_execution', { action: 'report', ...report, reportId: 'smoke-running', state: 'running', activity: '协议测试回执' }));
  check('running 只由关联回执写入且 reportId 幂等', running.task.execution.state === 'running' && Boolean(running.request.startedAt) && runningAgain.request.reports.length === 1);
  const lateDelivery = parseContent(await call('task_execution', { action: 'delivery', ...receipt, status: 'uncertain', error: '模拟投递超时' }));
  check('迟到 uncertain 不覆盖运行回执', lateDelivery.request.status === 'running' && lateDelivery.task.execution.state === 'running');
  const completed = parseContent(await call('task_execution', { action: 'report', ...report, reportId: 'smoke-completed', state: 'completed' }));
  check('完成回执不替代 task_move', completed.request.status === 'completed' && completed.task.status === 'backlog');
  const terminalReplay = parseContent(await call('task_execution', requestArgs(input)));
  check('终态旧请求重放不新建运行', terminalReplay.created === false && terminalReplay.request.runId === receipt.runId && terminalReplay.task.execution.state === 'completed');
  const message = '完整回复\n'.repeat(100);
  const reply = parseContent(await call('task_execution', requestArgs({ ...input, requestId: 'smoke-reply', action: 'reply', message })));
  check('reply 完整持久化并生成新 runId，复用原绑定', reply.created === true && reply.request.message === message && reply.request.runId !== receipt.runId && reply.task.executionBinding.threadId === binding.threadId);
  const stale = await call('task_execution', { action: 'report', ...report, reportId: 'late-running', state: 'running' });
  check('旧 runId 回执不能覆盖当前请求', stale.result.isError === true && stale.result.content[0].text.includes('EXECUTION_STALE'));

  /* ---------- 等待解除：UI 人工确认旧会话结束（app-only 工具），模拟不证明真实路由 ---------- */
  const recoveryReceipt = { id: taskA.id, boardId: boardA.id, requestId: reply.request.requestId, runId: reply.request.runId };
  const staleRecovery = await call('task_execution_recover', { ...receipt, reason: '旧 runId 解除' });
  check('旧 runId 解除被拒绝', staleRecovery.result.isError === true && staleRecovery.result.isError !== undefined && staleRecovery.result.content[0].text.includes('EXECUTION_STALE'));
  const runningGuard = await call('task_execution_recover', { ...recoveryReceipt, reason: '' });
  check('解除原因必填', runningGuard.result.isError === true);
  const released = parseContent(await call('task_execution_recover', { ...recoveryReceipt, reason: '人工确认旧会话已结束' }));
  check('人工解除取消请求并复位执行，保留绑定/结果', released.changed === true && released.request.status === 'cancelled' &&
    released.request.recovery?.releasedBy === 'user' && JSON.stringify(released.request.result) === JSON.stringify(reply.request.result) &&
    released.task.executionBinding.threadId === binding.threadId && released.task.execution.state === 'assigned');
  const releaseReplay = parseContent(await call('task_execution_recover', { ...recoveryReceipt, reason: '重复点击' }));
  check('解除幂等重放零写入', releaseReplay.changed === false && JSON.stringify(releaseReplay.task) === JSON.stringify(released.task));
  const lateClaim = await call('task_execution', { action: 'claim', ...recoveryReceipt, claimId: 'late-claim', hostId: input.hostId, receiverThreadId: input.receiverThreadId });
  check('已解除请求不能再认领', lateClaim.result.isError === true && lateClaim.result.content[0].text.includes('EXECUTION_STALE'));

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

  /* ---------- Review 流程：独立验收会话 + 同实现工作区 + 多轮结论 ---------- */
  // TASK-101（default 无项目看板）：无项目任务不参与 Review 流转，请求直接拒绝
  await call('task_move', { id: 'TASK-101', status: 'review' });
  const noWorkspace = await call('task_execution', requestArgs({
    id: 'TASK-101', boardId: 'default', requestId: 'smoke-review-nows', action: 'start',
    workspaceMode: 'existing', purpose: 'review',
  }));
  check(
    '无项目看板任务 Review 请求被拒绝（不参与验收流转）',
    noWorkspace.result.isError === true && noWorkspace.result.content[0].text.includes('不参与 Review'),
  );
  await call('task_move', { id: 'TASK-101', status: 'doing' });

  // TASK-102 已有实现绑定（smoke-thread @ realRepoA）：进入 review 列后走完整验收闭环
  for (const s of ['doing', 'review']) await call('task_move', { id: taskA.id, status: s });
  const reviewDetail = parseContent(await call('task_get', { id: taskA.id, boardId: boardA.id }));
  check('进入 review 列惰性初始化 pending（不自动创建 Reviewer）', reviewDetail.task.review?.status === 'pending' && !reviewDetail.task.reviewBinding);

  const reviewRequestInput = {
    id: taskA.id, boardId: boardA.id, requestId: 'smoke-review-start', action: 'start',
    workspaceMode: 'existing', purpose: 'review', model: 'smoke-review-model',
  };
  const badPurpose = await call('task_execution', requestArgs({ ...reviewRequestInput, purpose: 'verification' }));
  check('非法 purpose 被 schema 拒绝', badPurpose.error !== undefined || badPurpose.result.isError === true);
  const reviewRequested = parseContent(await call('task_execution', requestArgs(reviewRequestInput)));
  check(
    'review 请求锁定服务端解析的实现工作区并写入 reviewExecution',
    reviewRequested.request.purpose === 'review' && reviewRequested.request.workspacePath === realRepoA &&
      reviewRequested.request.model === 'smoke-review-model' && reviewRequested.task.reviewExecution.state === 'starting' &&
      reviewRequested.task.execution.state === 'assigned',
  );
  const reviewReceipt = { id: taskA.id, boardId: boardA.id, requestId: reviewRequested.request.requestId, runId: reviewRequested.request.runId };
  await call('task_execution', { action: 'claim', ...reviewReceipt, claimId: 'smoke-review-claim', hostId: input.hostId, receiverThreadId: 'smoke-review-thread' });
  const reviewBinding = { ...reviewReceipt, claimId: 'smoke-review-claim', threadId: 'smoke-review-thread', hostId: input.hostId, workspacePath: realRepoA, workspaceOwner: 'user', branch: 'main' };
  const reuseImplThread = await call('task_execution', { action: 'bind', ...reviewBinding, phase: 'created', threadId: binding.threadId });
  check(
    'Review 会话禁止复用实现聊天',
    reuseImplThread.result.isError === true && reuseImplThread.result.content[0].text.includes('EXECUTION_CONFLICT'),
  );
  await call('task_execution', { action: 'bind', ...reviewBinding, phase: 'created' });
  const reviewBound = parseContent(await call('task_execution', { action: 'bind', ...reviewBinding, phase: 'bound' }));
  check(
    'review 绑定写入 reviewBinding，实现绑定不变',
    reviewBound.task.reviewBinding?.threadId === 'smoke-review-thread' &&
      reviewBound.task.reviewBinding.workspacePath === realRepoA &&
      reviewBound.task.executionBinding.threadId === binding.threadId,
  );
  const reviewReport = { ...reviewReceipt, threadId: 'smoke-review-thread', hostId: input.hostId };
  const reviewRunning = parseContent(await call('task_execution', { action: 'report', ...reviewReport, reportId: 'smoke-review-running', state: 'running', activity: '首轮验收' }));
  check(
    'review running 开 Round #1 并置 reviewing，不覆盖实现执行',
    reviewRunning.task.reviewExecution.state === 'running' && reviewRunning.task.review.status === 'reviewing' &&
      reviewRunning.task.review.rounds.length === 1 && reviewRunning.task.execution.state === 'assigned',
  );
  const reviewRevision = reviewRunning.task.review.revision;
  const noConclusion = await call('task_update', { action: 'review', id: taskA.id, boardId: boardA.id, expectedRevision: reviewRevision, status: 'changes_requested' });
  check('changes_requested 必须携带非空结论', noConclusion.result.isError === true && noConclusion.result.content[0].text.includes('VALIDATION'));
  const changes = parseContent(await call('task_update', { action: 'review',
    id: taskA.id, boardId: boardA.id, expectedRevision: reviewRevision, status: 'changes_requested',
    conclusion: '冒烟验收意见：补充失败路径测试', actor: { type: 'agent', provider: 'codex-desktop', sessionId: 'smoke-review-thread' },
  }));
  check('changes_requested 关闭 Round #1 并保存结论，任务保留 review 列', changes.task.review.status === 'changes_requested' &&
    changes.task.review.rounds[0].conclusion === '冒烟验收意见：补充失败路径测试' && changes.task.status === 'review');
  const staleReview = await call('task_update', { action: 'review',
    id: taskA.id, boardId: boardA.id, expectedRevision: reviewRevision, status: 'approved', conclusion: '过期提交',
  });
  check('过期 expectedRevision 返回 REVIEW_STALE', staleReview.result.isError === true && staleReview.result.content[0].text.includes('REVIEW_STALE'));
  const recheckPending = parseContent(await call('task_update', { action: 'review',
    id: taskA.id, boardId: boardA.id, expectedRevision: reviewRevision + 1, status: 'recheck_pending',
  }));
  check('recheck_pending 提交后进入复查等待', recheckPending.task.review.status === 'recheck_pending');
  // Reviewer 会话执行完成（结论已记录），验收代次进入终态后才能发起复查
  await call('task_execution', { action: 'report', ...reviewReport, reportId: 'smoke-review-completed-1', state: 'completed' });

  const reviewContinue = parseContent(await call('task_execution', requestArgs({
    id: taskA.id, boardId: boardA.id, requestId: 'smoke-review-continue', action: 'continue',
    workspaceMode: 'existing', purpose: 'review', message: '继续验收当前 TaskLane 修改。',
  })));
  check('review continue 复用同一实现工作区', reviewContinue.request.workspacePath === realRepoA);
  const recheckReceipt = { id: taskA.id, boardId: boardA.id, requestId: reviewContinue.request.requestId, runId: reviewContinue.request.runId };
  await call('task_execution', { action: 'claim', ...recheckReceipt, claimId: 'smoke-review-claim-2', hostId: input.hostId, receiverThreadId: 'smoke-review-thread' });
  const recheckBinding = { ...recheckReceipt, claimId: 'smoke-review-claim-2', threadId: 'smoke-review-thread', hostId: input.hostId, workspacePath: realRepoA, workspaceOwner: 'user', branch: 'main' };
  await call('task_execution', { action: 'bind', ...recheckBinding, phase: 'created' });
  await call('task_execution', { action: 'bind', ...recheckBinding, phase: 'bound' });
  const recheckRunning = parseContent(await call('task_execution', { action: 'report',
    ...recheckReceipt, threadId: 'smoke-review-thread', hostId: input.hostId, reportId: 'smoke-recheck-running', state: 'running', activity: '复查',
  }));
  check('复查开 Round #2 且 Round #1 结论留存', recheckRunning.task.review.rounds.length === 2 &&
    recheckRunning.task.review.rounds[0].conclusion === '冒烟验收意见：补充失败路径测试');
  await call('task_execution', { action: 'report',
    ...recheckReceipt, threadId: 'smoke-review-thread', hostId: input.hostId, reportId: 'smoke-recheck-completed', state: 'completed',
  });
  check('review completed 不自动 approved', parseContent(await call('task_get', { id: taskA.id, boardId: boardA.id })).task.review.status === 'reviewing');
  const approved = parseContent(await call('task_update', { action: 'review',
    id: taskA.id, boardId: boardA.id, expectedRevision: recheckRunning.task.review.revision, status: 'approved', conclusion: '复查通过',
  }));
  check('approved 保存本轮结论且不自动移动 Done', approved.task.review.status === 'approved' &&
    approved.task.review.rounds[1].conclusion === '复查通过' && approved.task.status === 'review');

  /* ---------- 非 Codex 实现会话记录：opaque sessionId，不产生 threadId 语义 ---------- */
  const externalInput = {
    id: taskA.id, boardId: boardA.id, provider: 'smoke-agent', sessionId: 'conv 冒烟-001',
    workspacePath: realRepoA, workspaceOwner: 'user',
  };
  const fakeCodex = await call('task_execution', { action: 'external_bind', ...externalInput, provider: 'codex-desktop', sessionId: 'thread-x' });
  check('外部会话 provider 禁止冒充 codex-desktop', fakeCodex.result.isError === true && fakeCodex.result.content[0].text.includes('VALIDATION'));
  const externalBound = parseContent(await call('task_execution', { action: 'external_bind', ...externalInput }));
  check('外部会话记录 opaque sessionId 且不写 threadId/running',
    externalBound.task.externalExecutionSession?.sessionId === 'conv 冒烟-001' &&
      externalBound.task.externalExecutionSession.provider === 'smoke-agent' &&
      externalBound.task.executionBinding.threadId === binding.threadId &&
      externalBound.task.reviewBinding.threadId === 'smoke-review-thread');
  const externalReplace = await call('task_execution', { action: 'external_bind', ...externalInput, sessionId: 'conv-002' });
  check('替换不同外部会话必须显式 force', externalReplace.result.isError === true && externalReplace.result.content[0].text.includes('EXECUTION_CONFLICT'));
  const externalForced = parseContent(await call('task_execution', { action: 'external_bind', ...externalInput, sessionId: 'conv-002', force: true }));
  check('无活跃执行时 force 替换成功', externalForced.task.externalExecutionSession.sessionId === 'conv-002');

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

  const updArchived = await call('task_update', { action: 'update', id: 'TASK-103', title: 'x' });
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
