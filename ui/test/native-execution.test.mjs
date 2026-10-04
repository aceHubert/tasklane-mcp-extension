import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const output = path.join(mkdtempSync(path.join(tmpdir(), 'tasklane-ui-test-')), 'entry.mjs');
await build({ stdin: { contents: "export * from './src/host'; export * from './src/state/nativeExecution'; export * from './src/mcp/appsClient';", resolveDir: path.resolve('ui'), loader: 'ts' }, outfile: output, bundle: true, format: 'esm', platform: 'node' });
globalThis.localStorage = { getItem: () => 'zh' };
globalThis.navigator ??= { language: 'zh-CN' };
globalThis.window = { name: '' };
const h = await import(pathToFileURL(output).href);
const task = { id: 'TASK-101', boardId: 'b', status: 'ready', execution: { state: 'assigned' } };
const snapshot = { connected: true, identity: 'codex', info: { name: 'Codex', version: 'test' }, capabilities: { message: { text: {} }, openLinks: {} }, scope: { mode: 'project', lockedBoardId: 'b', repoRoot: '/repo' }, contextVersion: 1 };

function statusCheckFixture(status = 'running') {
  const request = { requestId: 'check-request', runId: 'check-run', action: 'start', workspaceMode: 'worktree', status,
    receiver: { threadId: 'receiver', hostId: 'host' }, result: { threadId: 'target', hostId: 'host', workspacePath: '/wt', workspaceOwner: 'codex' } };
  const current = { ...task, execution: { state: status, runId: request.runId }, executionRequests: [request] };
  return { request, current };
}

test('会话核对在运行和终态创建 status 请求，只发核对消息且不改原任务状态', async () => {
  for (const status of ['pending', 'claimed', 'running', 'waiting', 'blocked', 'completed', 'failed', 'rejected']) {
    const { request, current } = statusCheckFixture(status);
    const before = structuredClone(current);
    const calls = []; const messages = [];
    const outcome = await h.recoverPendingExecution({ task: current, request, snapshot,
      host: { getSnapshot: () => snapshot, sendMessage: async (text) => messages.push(text) },
      call: async (name, args) => { calls.push({ name, args }); return { created: true,
        request: { ...request, recoveryCheck: { checkId: args.checkId, purpose: args.purpose, status: 'pending' } } }; },
      confirmed: true, isCurrent: () => true });
    assert.equal(outcome, 'sent');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'task_execution_recovery_request');
    assert.equal(calls[0].args.purpose, 'status');
    assert.equal(calls[0].args.runId, request.runId);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].includes('仅核对会话状态并补齐看板回执'));
    assert.ok(messages[0].includes('idle 只说明聊天空闲，不证明任务完成'));
    assert.ok(messages[0].includes('直接 read_thread'));
    assert.ok(messages[0].includes('终态不因聊天仍活跃而回退'));
    assert.ok(messages[0].includes('补回执后重新 task_get'));
    assert.ok(messages[0].includes('禁止 outcome=stopped'));
    assert.ok(!messages[0].includes('按原授权恢复正文'));
    assert.deepEqual(current, before);
  }
});

test('会话核对未确认、宿主不支持、归档、取消、跨板或旧轮次时零写入', async () => {
  const { request, current } = statusCheckFixture();
  const variants = [
    { confirmed: false }, { host: null }, { snapshot: { ...snapshot, connected: false } },
    { snapshot: { ...snapshot, info: { name: 'Other', version: 'test' } } },
    { snapshot: { ...snapshot, capabilities: {} } }, { snapshot: { ...snapshot, scope: undefined } },
    { task: { ...current, archivedAt: '2026-10-04' } }, { task: { ...current, boardId: 'other' } },
    { task: { ...current, executionRequests: [{ ...request, status: 'cancelled' }] } },
    { request: { ...request, requestId: 'stale-request' } }, { request: { ...request, runId: 'stale-run' } },
    { isCurrent: () => false }, { hostSnapshot: { ...snapshot, contextVersion: 2 } },
    { hostSnapshot: { ...snapshot, connected: false } },
  ];
  for (const patch of variants) {
    let writes = 0; let messages = 0;
    const input = { task: current, request, snapshot, confirmed: true, isCurrent: () => true,
      host: { getSnapshot: () => patch.hostSnapshot ?? patch.snapshot ?? snapshot, sendMessage: async () => { messages++; } },
      call: async () => { writes++; }, ...patch };
    if (patch.confirmed === false) assert.equal(await h.recoverPendingExecution(input), 'existing');
    else await assert.rejects(h.recoverPendingExecution(input));
    assert.equal(writes, 0); assert.equal(messages, 0);
  }
});

test('会话核对已有 pending 检查不重复发送，写入失败不发送，宿主拒绝不伪造回执', async () => {
  const { request, current } = statusCheckFixture();
  let messages = 0;
  const base = { task: current, request, snapshot, confirmed: true, isCurrent: () => true,
    host: { getSnapshot: () => snapshot, sendMessage: async () => { messages++; } } };
  assert.equal(await h.recoverPendingExecution({ ...base, call: async () => ({ created: false, request }) }), 'existing');
  assert.equal(messages, 0);
  await assert.rejects(h.recoverPendingExecution({ ...base, call: async () => { throw new Error('写入失败'); } }), /写入失败/);
  assert.equal(messages, 0);
  const calls = [];
  await assert.rejects(h.recoverPendingExecution({ ...base,
    host: { getSnapshot: () => snapshot, sendMessage: async () => { throw new Error('宿主拒绝'); } },
    call: async (name, args) => { calls.push(name); return { created: true,
      request: { ...request, recoveryCheck: { checkId: args.checkId, purpose: 'status' } } }; },
  }), /宿主拒绝/);
  assert.deepEqual(calls, ['task_execution_recovery_request']);
  assert.equal(current.execution.state, 'running');
});

test('会话核对请求保存后上下文或看板切换时不投递旧消息', async () => {
  const { request, current } = statusCheckFixture();
  for (const switchBoard of [true, false]) {
    let fresh = snapshot; let isCurrent = true; let messages = 0;
    await assert.rejects(h.recoverPendingExecution({ task: current, request, snapshot, confirmed: true,
      isCurrent: () => isCurrent,
      host: { getSnapshot: () => fresh, sendMessage: async () => { messages++; } },
      call: async (_name, args) => {
        if (switchBoard) isCurrent = false;
        else fresh = { ...snapshot, contextVersion: snapshot.contextVersion + 1 };
        return { created: true, request: { ...request, recoveryCheck: { checkId: args.checkId, purpose: 'status' } } };
      },
    }), /native.reason.context/);
    assert.equal(messages, 0);
  }
});

test('会话核对响应缺少purpose或关联身份错误时不投递', async () => {
  const { request, current } = statusCheckFixture();
  for (const patch of [{ requestId: 'other-request' }, { runId: 'other-run' }, { recoveryCheck: { checkId: 'check' } },
    { recoveryCheck: { checkId: 'check', purpose: 'recover' } }, { recoveryCheck: undefined }]) {
    let messages = 0;
    await assert.rejects(h.recoverPendingExecution({ task: current, request, snapshot, confirmed: true,
      isCurrent: () => true,
      host: { getSnapshot: () => snapshot, sendMessage: async () => { messages++; } },
      call: async (_name, args) => ({ created: true,
        request: { ...request, recoveryCheck: { checkId: args.checkId, purpose: 'status' }, ...patch } }),
    }), /native.reason.context/);
    assert.equal(messages, 0);
  }
});

test('未知/其他宿主/握手未完成/范围无效/无消息能力均零写入', async () => {
  for (const patch of [ { connected: false }, { info: { name: 'ChatGPT', version: 'test' } }, { scope: undefined }, { scope: { mode: 'project-error' } }, { capabilities: {} } ]) {
    let writes = 0; let messages = 0;
    const s = { ...snapshot, ...patch };
    await assert.rejects(h.dispatchNativeExecution({ task, repo: '/repo', snapshot: s, host: { getSnapshot: () => s, sendMessage: async () => { messages++; } }, call: async () => { writes++; }, action: 'start', workspaceMode: 'project', isCurrent: () => true }));
    assert.equal(writes, 0); assert.equal(messages, 0);
  }
  assert.equal(h.hostIdentity({ name: 'Codex clone', version: 'test' }), 'unknown');
  assert.equal(h.hostIdentity(snapshot.info), 'codex');
});

test('未选择工作方式/已有工作区错误方式/跨板均拒绝', () => {
  assert.equal(h.executionBlockReason(snapshot, task, '/repo', 'start'), 'selection');
  assert.equal(h.executionBlockReason(snapshot, { ...task, worktreePath: '/repo/.worktrees/old' }, '/repo', 'start', 'worktree'), 'workspace');
  assert.equal(h.executionBlockReason(snapshot, { ...task, boardId: 'other' }, '/repo', 'start', 'project'), 'context');
  assert.equal(h.executionBlockReason(snapshot, { ...task, worktreePath: '/repo/.worktrees/old' }, '/repo', 'start', 'existing'), null);
  assert.equal(h.executionBlockReason(snapshot, { ...task, archivedAt: '2026-10-04' }, '/repo', 'start', 'project'), 'archived');
  assert.equal(h.executionBlockReason(snapshot, { ...task, status: 'done' }, '/repo', 'start', 'project'), 'done');
  assert.equal(h.executionBlockReason(snapshot, { ...task, execution: { state: 'running', runId: 'actual-run' } }, '/repo', 'start', 'project'), 'busy');
});

function callFactory(created = true) {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    if (name === 'task_execution_request') return { task, created, request: { ...args, taskId: args.id, repo: '/repo', runId: 'run-real' } };
    if (name === 'task_execution_delivery') return { request: { ...args } };
    return {};
  };
  return { call, calls };
}

test('无声明的新请求直接投递，不伪造身份；重复请求不再次发送', async () => {
  for (const created of [true, false]) {
    const { call, calls } = callFactory(created); const messages = [];
    const outcome = await h.dispatchNativeExecution({ task, repo: '/repo', snapshot, host: { getSnapshot: () => snapshot, sendMessage: async (text) => messages.push(text) }, call, action: 'start', workspaceMode: 'project', isCurrent: () => true });
    assert.equal(outcome, created ? 'delivered' : 'existing'); assert.equal(messages.length, created ? 1 : 0);
    assert.ok(!calls.some((c) => c.args.execution?.state === 'running'));
    if (created) {
      assert.equal(calls.at(-1).args.status, 'delivered');
      assert.equal(Object.hasOwn(calls[0].args, 'hostId'), false);
      assert.equal(Object.hasOwn(calls[0].args, 'receiverThreadId'), false);
      assert.ok(messages[0].includes('create_thread'));
      assert.ok(!messages[0].includes('task_move'));
      assert.ok(messages[0].includes('创建发起后本次操作即结束'));
      assert.ok(messages[0].includes('clientThreadId'));
      assert.ok(messages[0].includes('异常也必须写回看板'));
      assert.ok(messages[0].includes('不能等所有准备成功才保存会话'));
      assert.ok(messages[0].includes('task_execution_report state=failed'));
      assert.ok(messages[0].includes('结束前 task_get 确认'));
      assert.ok(messages[0].includes('先使用宿主 list_threads/read_thread'));
    }
  }
});

test('三种工作方式仅创建一次即结束，绑定与回执交给执行会话，执行指令只分发任务 ID', async () => {
  for (const workspaceMode of ['project', 'worktree', 'existing']) {
    const current = { ...task, title: '仅 MCP 查询可读的任务标题', description: '仅 MCP 查询可读的任务步骤',
      ...(workspaceMode === 'existing' ? { worktreePath: '/wt' } : {}) };
    const { call, calls } = callFactory(); let text = '';
    await h.dispatchNativeExecution({ task: current, repo: '/repo', snapshot,
      host: { getSnapshot: () => snapshot, sendMessage: async value => { text = value; } },
      call: async (name, args) => {
        const response = await call(name, args);
        return name === 'task_execution_request' ? { ...response, task: current } : response;
      }, action: 'start', workspaceMode, isCurrent: () => true });
    assert.equal(Object.hasOwn(calls[0].args, 'receiverThreadId'), false);
    assert.equal(Object.hasOwn(calls[0].args, 'receiverHostId'), false);
    assert.equal(Object.hasOwn(calls[0].args, 'callbackThreadId'), false);
    assert.ok(text.includes('tasklane native-execution'));
    assert.ok(text.includes('create_thread'));
    assert.ok(text.includes('list_threads'));
    assert.ok(text.includes('read_thread'));
    assert.match(text, /(?:create_thread[^\n]*一次|一次[^\n]*create_thread)/);
    const templateStart = '独立执行请求开始：\n';
    const templateEnd = '\n独立执行请求结束。';
    assert.ok(text.includes(templateStart));
    const executionPrompt = text.split(templateStart)[1]?.split(templateEnd)[0];
    assert.ok(executionPrompt);
    const taskRef = /\{[^\n]*"id"[^\n]*"boardId"[^\n]*\}/.exec(executionPrompt);
    assert.ok(taskRef);
    assert.deepEqual(JSON.parse(taskRef[0]), { id: current.id, boardId: current.boardId });
    assert.match(executionPrompt, /执行 TaskLane 任务/);
    assert.match(executionPrompt, /状态和结果[^\n]*看板/);
    // 执行指令保持最小化：不含绑定/回执协议、身份核验、角色或先后关系等与执行无关的说明
    assert.ok(!executionPrompt.includes('create_thread'));
    assert.ok(!executionPrompt.includes('task_move'));
    assert.ok(!executionPrompt.includes('task_get'));
    assert.ok(!executionPrompt.includes('task_execution_'));
    assert.ok(!executionPrompt.includes('claimId'));
    assert.ok(!executionPrompt.includes('receiver'));
    assert.ok(!executionPrompt.includes('callback'));
    assert.ok(!executionPrompt.includes('CODEX_THREAD_ID'));
    assert.doesNotMatch(executionPrompt, /中间会话|目标会话|发起会话|父会话|子会话|等待再次投递|先后关系|会话角色|等待[^\n]*(?:消息|指令)/);
    // 创建即结束：不等待创建结果、不获取目标身份、不保存绑定、不移动看板列
    assert.ok(!text.includes('wait_threads'));
    assert.ok(!text.includes('task_execution_bind'));
    assert.ok(!text.includes('task_move'));
    assert.ok(!text.includes('5 分钟'));
    assert.match(text, /创建发起后本次操作即结束/);
    assert.match(text, /不等待[^\n]*不获取目标身份[^\n]*不保存绑定[^\n]*不移动/);
    assert.match(text, /clientThreadId[^\n]*正常返回[^\n]*不得[^\n]*(?:真实|绑定)/);
    assert.match(text, /(?:新会话|新聊天)[^\n]*(?:自行|自己)[^\n]*(?:核验|绑定)/);
    assert.match(text, /(?:拒绝|失败)[^\n]*task_execution_delivery[^\n]*(?:rejected|uncertain)/);
    assert.ok(text.includes('claimId'));
    assert.ok(text.includes('task_execution_report'));
    assert.ok(text.includes('phase=created'));
    assert.ok(text.includes('task_get'));
    assert.match(text, /task_get[^\n]*(?:完整任务|步骤|任务)/);
    assert.match(text, /原样使用[^\n]*独立执行请求/);
    assert.ok(!text.includes(current.title));
    assert.ok(!text.includes(current.description));
    assert.ok(!text.includes('callbackThreadId'));
    assert.ok(!text.includes('callbackHostId'));
    assert.doesNotMatch(text, /中间会话|目标会话|发起会话|父会话|子会话|等待再次投递/);
  }

});

test('续接和已创建恢复复用原聊天，不创建或重新准备新聊天', async () => {
  const binding = { provider: 'codex-desktop', threadId: 'target', hostId: 'host', workspacePath: '/wt', workspaceOwner: 'codex' };
  const original = { requestId: 'old', runId: 'old-run', action: 'start', workspaceMode: 'worktree', status: 'blocked', result: binding };
  const bound = { ...task, executionBinding: binding, execution: { state: 'waiting' }, executionRequests: [original] };
  for (const action of ['continue', 'retry', 'reply', 'start']) {
    let text = '';
    const current = action === 'start' ? { ...task, executionRequests: [{ ...original, status: 'cancelled' }] } : bound;
    await h.dispatchNativeExecution({ task: current, repo: '/repo', snapshot,
      host: { getSnapshot: () => snapshot, sendMessage: async value => { text = value; } },
      call: async (name, args) => name === 'task_execution_request'
        ? { task: current, created: true, request: { ...args, runId: 'new-run', repo: '/repo',
          ...(action === 'start' ? { recoveryOf: original.requestId, result: binding } : {}) } }
        : { request: { status: 'delivered' } },
      action, workspaceMode: 'worktree', ...(action === 'reply' ? { message: '完整回复' } : {}), isCurrent: () => true });
    assert.ok(!text.includes('SESSION_READY'));
    assert.ok(!text.includes('SESSION_BLOCKED'));
    assert.ok(!text.includes('callbackThreadId'));
    assert.ok(!text.includes('callbackHostId'));
    assert.ok(text.includes('禁止创建新聊天') || text.includes('禁止 create_thread'));
  }
});

test('创建请求保存规范化模型并在原生消息中要求原样传递，默认不传模型', async () => {
  for (const model of [undefined, '  available-model-id  ']) {
    const { call, calls } = callFactory(); let delivered = '';
    await h.dispatchNativeExecution({ task, repo: '/repo', snapshot,
      host: { getSnapshot: () => snapshot, sendMessage: async (text) => { delivered = text; } },
      call, action: 'start', workspaceMode: 'project', model, isCurrent: () => true });
    if (model) {
      assert.equal(calls[0].args.model, 'available-model-id');
      assert.ok(delivered.includes('"model":"available-model-id"'));
      assert.ok(delivered.includes('不得静默换用其他模型'));
    } else {
      assert.equal(Object.hasOwn(calls[0].args, 'model'), false);
      assert.ok(delivered.includes('创建聊天时不传 model'));
    }
  }
});

test('无效模型在写入和消息投递前拒绝', async () => {
  for (const model of ['', '  ', 'bad model', '$invalid', 'a'.repeat(129)]) {
    let writes = 0; let messages = 0;
    await assert.rejects(h.dispatchNativeExecution({ task, repo: '/repo', snapshot,
      host: { getSnapshot: () => snapshot, sendMessage: async () => { messages++; } },
      call: async () => { writes++; }, action: 'start', workspaceMode: 'project', model, isCurrent: () => true }),
    { message: 'native.model.invalid' });
    assert.equal(writes, 0); assert.equal(messages, 0);
  }
  assert.equal(h.normalizeExecutionModel('vendor/model-v1:preview'), 'vendor/model-v1:preview');
});

test('模型展示来自当前待处理请求或匹配绑定的创建记录，后续请求不覆盖模型', async () => {
  const original = { action: 'start', runId: 'original-run', status: 'delivered', model: 'creation-model', workspaceMode: 'worktree' };
  const pending = { ...task, execution: { ...task.execution, runId: original.runId }, executionRequests: [original] };
  assert.equal(h.creationModelRequest(pending), original);
  assert.equal(h.creationModelRequest(task), undefined);
  assert.equal(h.creationModelRequest({ ...pending, executionRequests: [{ ...original, status: 'failed' }] }), undefined);
  const binding = { provider: 'codex-desktop', threadId: 'thread', hostId: 'host', workspacePath: '/wt', workspaceOwner: 'codex' };
  const recorded = { ...original, result: binding };
  const bound = { ...task, executionBinding: binding, execution: { state: 'waiting' },
    executionRequests: [recorded, { action: 'continue', workspaceMode: 'worktree', result: binding }] };
  assert.equal(h.creationModelRequest(bound), recorded);
  assert.equal(h.creationModelRequest({ ...bound, executionBinding: { ...binding, threadId: 'other' } }), undefined);
  assert.equal(h.creationModelRequest({ ...bound, executionBinding: { ...binding, hostId: 'other' } }), undefined);
  for (const action of ['continue', 'retry', 'reply']) {
    const { call, calls } = callFactory(); let delivered = '';
    await h.dispatchNativeExecution({ task: bound, repo: '/repo', snapshot,
      host: { getSnapshot: () => snapshot, sendMessage: async (text) => { delivered = text; } },
      call, action, workspaceMode: 'worktree', model: 'another-model',
      ...(action === 'reply' ? { message: '完整回复' } : {}), isCurrent: () => true });
    assert.equal(Object.hasOwn(calls[0].args, 'model'), false);
    assert.equal(delivered.includes('another-model'), false);
  }
});

test('完整回复不截断，续接保持原工作区模式', async () => {
  const binding = { provider: 'codex-desktop', threadId: 'thread', hostId: 'host', workspacePath: '/wt', workspaceOwner: 'codex' };
  const bound = { ...task, executionBinding: binding, execution: { state: 'waiting' }, executionRequests: [{ result: binding, workspaceMode: 'worktree' }] };
  assert.equal(h.boundWorkspaceMode(bound), 'worktree');
  const message = '完整回复\n'.repeat(300); let delivered = '';
  const { call, calls } = callFactory();
  await h.dispatchNativeExecution({ task: bound, repo: '/repo', snapshot, host: { getSnapshot: () => snapshot, sendMessage: async (text) => { delivered = text; } }, call, action: 'reply', workspaceMode: 'worktree', message, isCurrent: () => true });
  assert.equal(calls[0].args.message, message); assert.ok(delivered.includes(message));
});

test('传输错误/超时为uncertain；发送前上下文改变明确rejected且不发消息', async () => {
  const { call, calls } = callFactory(); let count = 0;
  const result = await h.dispatchNativeExecution({ task, repo: '/repo', snapshot, host: { getSnapshot: () => snapshot, sendMessage: async () => { count++; throw new Error('timeout'); } }, call, action: 'start', workspaceMode: 'project', isCurrent: () => true });
  assert.equal(result, 'uncertain'); assert.equal(count, 1); assert.equal(calls.at(-1).args.status, 'uncertain');
  const shifted = callFactory();
  const rejected = await h.dispatchNativeExecution({ task, repo: '/repo', snapshot, host: { getSnapshot: () => ({ ...snapshot, contextVersion: 2 }), sendMessage: async () => { count++; } }, call: shifted.call, action: 'start', workspaceMode: 'project', isCurrent: () => true });
  assert.equal(rejected, 'rejected');
  assert.equal(shifted.calls.at(-1).args.status, 'rejected');
  assert.equal(count, 1);
  await assert.rejects(h.hostRequest(async () => ({ isError: true })), (error) =>
    error.code === 'rejected' && error.message.includes('宿主明确拒绝') && error.message !== 'rejected');
  await assert.rejects(h.hostRequest(() => new Promise(() => {}), 5), { code: 'timeout' });
});

test('明确拒绝与结果未知分开，迟到拒绝不能断言已认领任务未执行', async () => {
  for (const code of ['rejected', 'unavailable', 'contextChanged', 'transport', 'timeout']) {
    const { call, calls } = callFactory();
    const outcome = await h.dispatchNativeExecution({ task, repo: '/repo', snapshot,
      host: { getSnapshot: () => snapshot, sendMessage: async () => { throw new h.HostOperationError(code); } },
      call, action: 'start', workspaceMode: 'project', isCurrent: () => true });
    const expected = ['rejected', 'unavailable', 'contextChanged'].includes(code) ? 'rejected' : 'uncertain';
    assert.equal(outcome, expected);
    assert.equal(calls.at(-1).args.status, expected);
    assert.ok(calls.at(-1).args.error.length > 0);
  }
  const original = callFactory();
  const outcome = await h.dispatchNativeExecution({ task, repo: '/repo', snapshot,
    host: { getSnapshot: () => snapshot, sendMessage: async () => { throw new h.HostOperationError('rejected'); } },
    call: async (name, args) => name === 'task_execution_delivery' ? { request: { status: 'claimed' } } : original.call(name, args),
    action: 'start', workspaceMode: 'project', isCurrent: () => true });
  assert.equal(outcome, 'uncertain');
});

test('投递与绑定均不表示running，只有匹配回执才显示实际运行', () => {
  const binding = { provider: 'codex-desktop', threadId: 'thread', hostId: 'host', workspacePath: '/repo' };
  const bound = { ...task, executionBinding: binding, execution: { state: 'running', runId: 'run' } };
  assert.equal(h.executionStatus({ ...bound, executionRequests: [{ runId: 'run', status: 'delivered' }] }), 'pending');
  assert.equal(h.executionStatus(bound), 'bound');
  assert.equal(h.executionStatus({ ...bound, executionRequests: [{ runId: 'run', status: 'running', reports: [{ state: 'running' }] }] }), 'running');
  assert.equal(h.openThreadBlockReason(snapshot, bound), null);
});

test('旧sess/running不显示真实绑定或已验证运行', () => {
  assert.equal(h.executionStatus({ ...task, execution: { state: 'running', sessionId: 'sess-old' } }), 'unbound');
  assert.equal(h.hasRealBinding({ provider: 'codex-desktop', threadId: 'sess-old', hostId: 'host', workspacePath: '/repo' }), false);
});

test('blocked 保存真实 created 结果后允许打开和核对继续，禁止重新创建与更换工作区', () => {
  const result = { threadId: 'created-real', hostId: 'host', workspacePath: '/wt', workspaceOwner: 'codex' };
  const request = { requestId: 'old', runId: 'old-run', action: 'start', workspaceMode: 'worktree', status: 'blocked', result, model: 'original-model' };
  const blocked = { ...task, execution: { state: 'blocked', runId: 'old-run', activity: '工作区待核验' }, executionRequests: [request] };
  assert.equal(h.executionStatus(blocked), 'blocked');
  assert.equal(h.executionPending(blocked), false);
  assert.equal(h.executionTarget(blocked), result);
  assert.equal(h.openThreadBlockReason(snapshot, blocked), null);
  assert.equal(h.boundWorkspaceMode(blocked), 'worktree');
  assert.equal(h.creationModelRequest(blocked), request);
  assert.equal(h.executionBlockReason(snapshot, blocked, '/repo', 'continue', 'worktree'), null);
  assert.equal(h.executionBlockReason(snapshot, blocked, '/repo', 'continue', 'project'), 'workspace');
  assert.equal(h.executionBlockReason(snapshot, blocked, '/repo', 'start', 'worktree'), 'blocked');
  const unknown = { ...blocked, executionRequests: [{ ...request, result: undefined }] };
  assert.equal(h.executionBlockReason(snapshot, unknown, '/repo', 'continue', 'worktree'), 'binding');
  assert.equal(h.openThreadBlockReason(snapshot, unknown), 'binding');
  assert.equal(h.executionStatus(unknown), 'blocked');
  const temporary = { ...blocked, executionRequests: [{ ...request, result: { ...result, threadId: 'client-new-thread:temporary' } }] };
  assert.equal(h.executionTarget(temporary), undefined);
  assert.equal(h.executionBlockReason(snapshot, temporary, '/repo', 'continue', 'worktree'), 'binding');
  assert.equal(h.openThreadBlockReason(snapshot, temporary), 'binding');
});

test('blocked 继续提示必须核对原状态与原因，复用真实结果且不覆盖模型', async () => {
  const result = { threadId: 'created-real', hostId: 'host', workspacePath: '/wt', workspaceOwner: 'codex' };
  const source = { requestId: 'old', runId: 'old-run', action: 'start', workspaceMode: 'worktree', status: 'blocked', result, model: 'original-model', deliveryError: '工作区核验失败' };
  const blocked = { ...task, execution: { state: 'blocked', runId: 'old-run', activity: '当前缺少权限' }, executionRequests: [source] };
  const calls = []; let text = '';
  const outcome = await h.dispatchNativeExecution({ task: blocked, repo: '/repo', snapshot,
    host: { getSnapshot: () => snapshot, sendMessage: async value => { text = value; } },
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'task_execution_request') return { task: blocked, created: true,
        request: { ...source, ...args, runId: 'new-run', status: 'pending', recoveryOf: 'old' } };
      return { request: { status: 'delivered' } };
    }, action: 'continue', workspaceMode: 'worktree', model: 'replacement-model', isCurrent: () => true });
  assert.equal(outcome, 'delivered');
  assert.equal(Object.hasOwn(calls[0].args, 'model'), false);
  assert.ok(text.includes('当前缺少权限'));
  assert.ok(!text.includes('工作区核验失败'));
  assert.ok(text.includes('原 blocked 请求及原因'));
  assert.ok(text.includes('阻塞条件未解除时必须写回 blocked'));
  assert.ok(text.includes('无论是否已有 executionBinding，都必须复用本轮 request.result 按 phase=created→bound'));
  assert.ok(text.includes('旧 executionBinding 不代表本轮已 bound'));
  assert.ok(text.includes('禁止 create_thread、新建工作区、切换工作区或模型'));
  assert.ok(text.includes('phase=created→bound'));
  assert.ok(text.includes('"threadId":"created-real"'));
  assert.ok(!text.includes('replacement-model'));
});

const bridgeInfo = { name: 'OpenAI MCP Apps', version: 'bridge-test' };
const codexPeer = { name: 'codex-mcp-client', version: '0.155.0' };
const projectContext = { widget: 'tasklane-board', mode: 'project', lockedBoardId: 'b', repoRoot: '/repo', projectDir: '/repo' };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function installApp({ peer = codexPeer, readPeer, send, open } = {}) {
  let app;
  class FakeApp {
    constructor(info) { app = this; this.info = info; this.calls = []; }
    async connect() {}
    getHostVersion() { return bridgeInfo; }
    getHostCapabilities() { return snapshot.capabilities; }
    getHostContext() { return {}; }
    async callServerTool(args) {
      this.calls.push(args);
      return readPeer ? readPeer(args) : { structuredContent: { mcpClient: peer } };
    }
    async sendMessage(args) { return send ? send(args) : {}; }
    async openLink(args) { return open ? open(args) : {}; }
  }
  globalThis.__KANBAN_MCP_APPS__ = { App: FakeApp };
  const client = new h.McpAppsClient();
  client.connect();
  return { client, get app() { return app; } };
}

test('通用桥联合真实 MCP 客户端识别，缓存不恢复身份', () => {
  assert.equal(h.hostIdentity(bridgeInfo), 'unknown');
  assert.equal(h.hostIdentity(bridgeInfo, codexPeer), 'codex');
  assert.equal(h.hostIdentity(undefined, codexPeer), 'unknown');
  assert.equal(h.hostIdentity(bridgeInfo, { ...codexPeer, name: 'codex-mcp-client-clone' }), 'unknown');
  assert.equal(h.hostBlockReason({ ...snapshot, info: bridgeInfo, mcpClient: codexPeer }), null);
});

test('重载从只读 live host_info 恢复实际 peer，可直接发送且不创建验证聊天', async () => {
  window.name = `tasklane-ctx:${JSON.stringify({ ...projectContext, mcpClient: codexPeer, nativeExecution: { obsolete: true }, verificationPending: true })}`;
  const instance = installApp();
  assert.equal(instance.client.initialWidgetContext.mcpClient, undefined);
  assert.equal(instance.client.getSnapshot().identity, 'unknown');
  await flush();
  const live = instance.client.getSnapshot();
  assert.equal(live.identity, 'codex');
  assert.equal(h.hostBlockReason(live), null);
  assert.deepEqual(instance.app.calls, [{ name: 'tasklane_host_info', arguments: {} }]);
  assert.equal(instance.app.info.version, '0.3.14');
  assert.equal(typeof instance.client.verifyConnection, 'undefined');
  await instance.client.sendMessage('真实任务', live.contextVersion);
  instance.app.ontoolresult({ structuredContent: { ...projectContext, mcpClient: codexPeer } });
  assert.ok(!window.name.includes('mcpClient'));
  assert.ok(!window.name.includes('nativeExecution'));
  assert.ok(!window.name.includes('verificationPending'));
  delete globalThis.__KANBAN_MCP_APPS__;
});

test('非 Codex live peer 和 host_info 读取失败均不因旧缓存获得投递权限', async () => {
  for (const options of [{ peer: { name: 'other-client', version: 'test' } },
    { readPeer: async () => { throw new Error('unavailable'); } },
    { readPeer: async () => ({ isError: true, structuredContent: { mcpClient: codexPeer } }) }]) {
    window.name = `tasklane-ctx:${JSON.stringify({ ...projectContext, mcpClient: codexPeer })}`;
    let messages = 0;
    const instance = installApp({ ...options, send: async () => { messages++; return {}; } });
    await flush();
    assert.equal(instance.client.getSnapshot().identity, 'unknown');
    await assert.rejects(instance.client.sendMessage('真实任务', instance.client.getSnapshot().contextVersion), { code: 'unavailable' });
    assert.equal(messages, 0);
  }
  delete globalThis.__KANBAN_MCP_APPS__;
});

test('迟到 peer 不污染新 scope，实时工具结果的 peer 优先于恢复请求', async () => {
  window.name = '';
  const pending = [];
  const instance = installApp({ readPeer: () => new Promise((resolve) => pending.push(resolve)) });
  await flush();
  instance.app.ontoolresult({ structuredContent: { ...projectContext, mcpClient: { name: 'other-client', version: 'live' } } });
  pending[0]({ structuredContent: { mcpClient: codexPeer } });
  await flush();
  assert.equal(instance.client.getSnapshot().identity, 'unknown');
  assert.equal(instance.client.getSnapshot().mcpClient.version, 'live');
  instance.app.ontoolresult({ structuredContent: projectContext });
  instance.app.onhostcontextchanged({ toolInfo: { id: 'new' }, receiverThreadId: 'unknown-route' });
  pending[1]({ structuredContent: { mcpClient: codexPeer } });
  await flush();
  assert.equal(instance.client.getSnapshot().scope, undefined);
  assert.equal(instance.client.getSnapshot().mcpClient, undefined);
  instance.app.ontoolresult({ structuredContent: { widget: 'tasklane-board', mode: 'global', mcpClient: codexPeer } });
  pending[2]({ structuredContent: { mcpClient: { name: 'other-client', version: 'late' } } });
  await flush();
  assert.equal(instance.client.getSnapshot().identity, 'codex');
  assert.equal(instance.client.getSnapshot().scope.mode, 'global');
  delete globalThis.__KANBAN_MCP_APPS__;
});

test('标准宿主元数据更新保留项目范围，fresh peer 恢复发送且旧在途版本失效', async () => {
  window.name = '';
  const pendingPeers = [];
  let finishOldSend;
  let messages = 0;
  const instance = installApp({ readPeer: () => new Promise((resolve) => pendingPeers.push(resolve)),
    send: async (args) => {
      if (args.content[0].text === '旧在途请求') return new Promise((resolve) => { finishOldSend = resolve; });
      messages++;
      return {};
    } });
  await flush();
  instance.app.ontoolresult({ structuredContent: { ...projectContext, mcpClient: codexPeer } });
  const oldVersion = instance.client.getSnapshot().contextVersion;
  const oldOutcome = instance.client.sendMessage('旧在途请求', oldVersion).then(() => null, (error) => error);
  await flush();
  for (const update of [{ toolInfo: { id: 'updated' } }, { userAgent: 'Codex' },
    { platform: 'desktop', theme: 'dark' }, { deviceCapabilities: {} }]) {
    const previous = instance.client.getSnapshot().contextVersion;
    instance.app.onhostcontextchanged(update);
    const fresh = instance.client.getSnapshot();
    assert.equal(fresh.contextVersion, previous + 1);
    assert.equal(fresh.scope.lockedBoardId, 'b');
    assert.equal(fresh.scope.repoRoot, '/repo');
    assert.equal(fresh.identity, 'unknown');
    assert.ok(window.name.startsWith('tasklane-ctx:'));
    await assert.rejects(instance.client.sendMessage('旧版本请求', previous), { code: 'contextChanged' });
    pendingPeers.at(-1)({ structuredContent: { mcpClient: codexPeer } });
    await flush();
    assert.equal(h.hostBlockReason(instance.client.getSnapshot()), null);
    await instance.client.sendMessage('当前请求', fresh.contextVersion);
  }
  finishOldSend({});
  assert.equal((await oldOutcome).code, 'transport');
  assert.equal(messages, 4);
  pendingPeers[0]({ structuredContent: { mcpClient: { name: 'late-other-client', version: 'late' } } });
  await flush();
  assert.equal(instance.client.getSnapshot().identity, 'codex');
  delete globalThis.__KANBAN_MCP_APPS__;
});

test('标准元数据混合未知路由或范围更新，fresh peer 也不能恢复未经确认的范围', async () => {
  window.name = '';
  const instance = installApp();
  await flush();
  for (const update of [{ toolInfo: { id: 'new' }, receiverThreadId: 'unknown' },
    { platform: 'desktop', scope: { mode: 'global' } }, { userAgent: 'Codex', custom: {} }]) {
    instance.app.ontoolresult({ structuredContent: { ...projectContext, mcpClient: codexPeer } });
    instance.app.onhostcontextchanged(update);
    await flush();
    assert.equal(instance.client.getSnapshot().scope, undefined);
    assert.equal(h.hostBlockReason(instance.client.getSnapshot()), 'context');
    await assert.rejects(instance.client.sendMessage('未知范围请求', instance.client.getSnapshot().contextVersion), { code: 'unavailable' });
  }
  delete globalThis.__KANBAN_MCP_APPS__;
});

test('展示通知保持scope，实际上下文变化与断连阻止旧请求投递', async () => {
  window.name = '';
  const instance = installApp();
  await flush();
  instance.app.ontoolresult({ structuredContent: { ...projectContext, mcpClient: codexPeer } });
  const version = instance.client.getSnapshot().contextVersion;
  for (const update of [{ theme: 'dark' }, { containerDimensions: { width: 420, height: 800 } },
    { styles: {}, locale: 'zh-CN', timeZone: 'Asia/Shanghai', displayMode: 'fullscreen' }]) {
    instance.app.onhostcontextchanged(update);
    assert.equal(instance.client.getSnapshot().contextVersion, version);
    assert.equal(h.hostBlockReason(instance.client.getSnapshot()), null);
  }
  instance.app.onhostcontextchanged({});
  assert.equal(instance.client.getSnapshot().scope, undefined);
  await assert.rejects(instance.client.sendMessage('旧请求', version), { code: 'contextChanged' });
  instance.app.onclose();
  assert.equal(instance.client.getSnapshot().connected, false);
  assert.equal(instance.client.getSnapshot().mcpClient, undefined);
  delete globalThis.__KANBAN_MCP_APPS__;
});

test('未知上下文同步清除自己的范围缓存，重载后fresh peer不能恢复旧项目范围', async () => {
  window.name = '';
  const original = installApp();
  await flush();
  original.app.ontoolresult({ structuredContent: { ...projectContext, mcpClient: codexPeer } });
  assert.ok(window.name.includes('"lockedBoardId":"b"'));
  original.app.onhostcontextchanged({ toolInfo: { id: 'new' }, receiverThreadId: 'unknown-route' });
  assert.equal(window.name, '');
  const reloaded = installApp();
  assert.equal(reloaded.client.initialWidgetContext, null);
  await flush();
  assert.equal(reloaded.client.getSnapshot().identity, 'codex');
  assert.equal(reloaded.client.getSnapshot().scope, undefined);
  assert.equal(h.hostBlockReason(reloaded.client.getSnapshot()), 'context');
  await assert.rejects(reloaded.client.sendMessage('旧范围请求', reloaded.client.getSnapshot().contextVersion), { code: 'unavailable' });
  reloaded.app.ontoolresult({ structuredContent: { ...projectContext, mcpClient: codexPeer } });
  assert.equal(h.hostBlockReason(reloaded.client.getSnapshot()), null);
  await reloaded.client.sendMessage('重新确认范围的请求', reloaded.client.getSnapshot().contextVersion);
  window.name = 'other-widget-cache';
  reloaded.app.onhostcontextchanged({ unknownRoute: true });
  assert.equal(window.name, 'other-widget-cache');
  delete globalThis.__KANBAN_MCP_APPS__;
});

test('实时 widget 元数据兼容范围，错误上下文始终禁止投递', async () => {
  window.name = '';
  const instance = installApp();
  await flush();
  instance.app.ontoolresult({ _meta: { widgetData: { ...projectContext, mcpClient: codexPeer } } });
  assert.equal(h.hostBlockReason(instance.client.getSnapshot()), null);
  instance.app.ontoolresult({ isError: true, structuredContent: projectContext });
  assert.equal(instance.client.getSnapshot().scope.mode, 'project-error');
  assert.ok(h.hostBlockReason(instance.client.getSnapshot()));
  await assert.rejects(instance.client.sendMessage('真实任务', instance.client.getSnapshot().contextVersion), { code: 'unavailable' });
  delete globalThis.__KANBAN_MCP_APPS__;
});

test('投递后上下文改变为结果未知，SDK打开真实深链接并显示明确拒绝', async () => {
  window.name = '';
  let instance;
  instance = installApp({ send: async () => { instance.app.onhostcontextchanged({}); return {}; },
    open: async () => ({ isError: true }) });
  await flush();
  instance.app.ontoolresult({ structuredContent: { ...projectContext, mcpClient: codexPeer } });
  await assert.rejects(instance.client.openLink('codex://threads/real-thread', instance.client.getSnapshot().contextVersion), { code: 'rejected' });
  await assert.rejects(instance.client.sendMessage('真实任务', instance.client.getSnapshot().contextVersion), { code: 'transport' });
  delete globalThis.__KANBAN_MCP_APPS__;
});

test('握手期间关闭连接后，迟到握手成功不重新恢复权限', async () => {
  let app;
  let complete;
  let reads = 0;
  class DelayedApp {
    constructor() { app = this; }
    connect() { return new Promise((resolve) => { complete = resolve; }); }
    getHostVersion() { return snapshot.info; }
    getHostCapabilities() { return snapshot.capabilities; }
    async callServerTool() { reads++; return { structuredContent: { mcpClient: codexPeer } }; }
  }
  window.name = '';
  globalThis.__KANBAN_MCP_APPS__ = { App: DelayedApp };
  const client = new h.McpAppsClient();
  client.connect();
  app.onclose();
  complete();
  await flush();
  assert.equal(client.getSnapshot().connected, false);
  assert.equal(reads, 0);
  await assert.rejects(client.sendMessage('真实任务', client.getSnapshot().contextVersion), { code: 'unavailable' });
  delete globalThis.__KANBAN_MCP_APPS__;
});

test('toModelOptions：映射目录候选，去重并丢弃无效条目', () => {
  assert.deepEqual(h.toModelOptions(null), []);
  assert.deepEqual(h.toModelOptions({}), []);
  assert.deepEqual(h.toModelOptions({ models: 'not-array' }), []);
  assert.deepEqual(
    h.toModelOptions({
      models: [
        { id: 'gpt-6-astra', displayName: 'GPT-6-Astra' },
        { id: 'gpt-6-astra', displayName: '重复项' },
        { displayName: '缺少 ID 被丢弃' },
        { id: '  ' },
        { id: 'zcode/glm-5.3' },
        { id: 'same-label', displayName: 'same-label' },
      ],
    }),
    [
      { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
      { id: 'zcode/glm-5.3', label: 'zcode/glm-5.3' },
      { id: 'same-label', label: 'same-label' },
    ],
  );
});
