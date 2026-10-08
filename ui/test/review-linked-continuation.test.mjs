import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 保留 Hook 状态和实际 JSX 事件处理器，验证入口显示与现有续接路由。
const hookMock = `
  const fixture = () => globalThis.__linkedReview;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  export function useState(initial) {
    const f = fixture(), i = f.index++;
    if (!(i in f.slots)) f.slots[i] = typeof initial === 'function' ? initial() : initial;
    return [f.slots[i], value => { f.slots[i] = typeof value === 'function' ? value(f.slots[i]) : value; f.dirty = true; }];
  }
  export function useRef(initial) { const f = fixture(), i = f.index++; return f.slots[i] ??= { current: initial }; }
  export function useMemo(fn, deps) {
    const f = fixture(), i = f.index++, old = f.slots[i];
    if (!old || !same(old.deps, deps)) f.slots[i] = { deps, value: fn() };
    return f.slots[i].value;
  }
  export function useCallback(fn, deps) { return useMemo(() => fn, deps); }
  export function useEffect(fn, deps) {
    const f = fixture(), i = f.index++, old = f.slots[i];
    if (!old || !same(old.deps, deps)) { f.slots[i] = { deps }; f.effects.push(fn); }
  }
  export function jsx(type, props) { return { type, props }; }
  export const jsxs = jsx;
  export const Fragment = 'fragment';
`;
const output = path.join(mkdtempSync(path.join(tmpdir(), 'tasklane-linked-review-')), 'entry.mjs');
const mocks = {
  hooks: hookMock,
  BoardContext: 'export const useBoard = () => globalThis.__linkedReview.board;',
  useTaskActions: 'export const useTaskActions = () => globalThis.__linkedReview.actions;',
  i18n: `import { nativeZh } from ${JSON.stringify(path.resolve('ui/src/i18n/nativeMessages.ts'))};
    export const useLang = () => ({ t: (key, params) => key.endsWith('PromptDefault') && nativeZh[key]
      ? nativeZh[key].replace(/\\{(\\w+)\\}/g, (_, name) => String(params?.[name] ?? ''))
      : key + (params ? ':' + JSON.stringify(params) : '') });`,
  HostConnection: 'export const HostConnection = () => null;',
};
await build({
  stdin: { contents: "export { TaskDetail } from './src/components/TaskDetail'; export * from './src/host';",
    resolveDir: path.resolve('ui'), loader: 'ts' },
  outfile: output, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
  plugins: [{ name: '审核联动交互测试', setup(builder) {
    builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$|BoardContext$|useTaskActions$|\/i18n$|HostConnection$/ }, ({ path: name }) => ({
      path: name.startsWith('react') ? 'hooks' : name.endsWith('/i18n') ? 'i18n' : name.split('/').at(-1), namespace: 'fixture',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({
      contents: mocks[name], loader: 'js', resolveDir: path.resolve('ui'),
    }));
  } }],
});
const { TaskDetail, executionBlockReason, reviewBlockReason, executionTarget, openThreadBlockReason } = await import(pathToFileURL(output).href);
const binding = { provider: 'codex-desktop', threadId: 'implementation-thread', hostId: 'local',
  workspacePath: '/plain-project', workspaceOwner: 'user', boundAt: '2026-10-06T00:00:00.000Z' };
const conclusion = '请补齐失败路径测试。\n并验证断连后重新连接能够恢复。';
const round = { id: 'round-1', number: 1, status: 'changes_requested', conclusion,
  workspacePath: '/plain-project', startedAt: '2026-10-06T00:00:00.000Z', updates: [] };

function taskFixture(patch = {}) {
  return { id: 'TASK-REVIEW', boardId: 'plain-board', title: '执行审核结论', description: '',
    status: 'review', priority: 'P2', assignee: 'agent', execution: { state: 'completed' },
    executionBinding: binding, reviewBinding: { ...binding, threadId: 'review-thread' }, executionRequests: [],
    review: { status: 'changes_requested', revision: 2, rounds: [round], updatedAt: '2026-10-06T00:01:00.000Z' }, ...patch };
}

function setup(task = taskFixture(), { conn = 'connected', archived = false, projectless = false, identity = 'Codex' } = {}) {
  const calls = [];
  if (archived) task = { ...task, archivedAt: '2026-10-06T00:02:00.000Z' };
  const f = { slots: [], index: 0, effects: [], dirty: true, calls,
    board: { detail: { task, timeline: [] }, conn,
      board: projectless ? { repo: null, projectDir: null, repoKey: null }
        : { repo: null, projectDir: '/plain-project', repoKey: null },
      hostSnapshot: { connected: conn === 'connected', identity: identity === 'Codex' ? 'codex' : 'unknown',
        info: { name: identity, version: 'test' }, capabilities: { message: { text: {} }, openLinks: {} },
        scope: { mode: 'project', lockedBoardId: task.boardId, repoRoot: '/plain-project' }, contextVersion: 1 },
      call: async () => ({ models: [] }), mutate: async () => true, toast() {} },
  };
  const record = name => async text => { calls.push({ name, text }); };
  f.actions = { requests: task.executionRequests ?? [], agentName: 'Codex', status: 'completed', openReason: null,
    reason: (action, mode) => executionBlockReason(f.board.hostSnapshot, f.board.detail.task, f.board.board, action, mode),
    reviewReason: action => reviewBlockReason(f.board.hostSnapshot, f.board.detail.task, action, f.board.board),
    continueFix: record('continueFix'), continueReview: record('continueReview'),
    continueExecution: record('continueExecution'),
    startReview: async (model, text) => { calls.push({ name: 'startReview', model, text }); }, start: record('start'),
    openReviewReason: openThreadBlockReason(f.board.hostSnapshot, task, 'review'),
    openReviewSession: async () => { calls.push({ name: 'openReviewSession', threadId: executionTarget(task, 'review')?.threadId }); },
    move() {}, restore() {}, archive() {}, openSession() {} };
  globalThis.__linkedReview = f;
  return f;
}

function render() {
  const f = globalThis.__linkedReview;
  for (let i = 0; i < 30; i++) {
    f.index = 0; f.dirty = false;
    f.tree = TaskDetail({ onClose() {} });
    for (const effect of f.effects.splice(0)) effect();
    if (!f.dirty) return f.tree;
  }
  throw new Error('审核联动测试的 Hook 状态未收敛');
}

function nodes(node, result = []) {
  if (Array.isArray(node)) { for (const child of node) nodes(child, result); return result; }
  if (!node || typeof node !== 'object') return result;
  result.push(node);
  nodes(node.props?.children, result);
  return result;
}
function control(type, key) {
  const tree = nodes(render());
  if (type === 'textarea') {
    const label = tree.find(node => node.type === 'label' && nodes(node).some(child =>
      child.type === 'span' && child.props.children === key));
    return label ? nodes(label).find(node => node.type === 'textarea') : undefined;
  }
  return tree.find(node => node.type === type && typeof node.props.children === 'string' && node.props.children.startsWith(key + ':'));
}
const fixButton = () => control('button', 'native.review.fix');
const fixPrompt = () => control('textarea', 'native.review.fixPromptLabel');
const ordinaryButton = () => control('button', 'native.continue');
const ordinaryPrompt = () => control('textarea', 'native.continuePromptLabel');
test.after(() => { delete globalThis.__linkedReview; });

test('Review 打开按钮使用独立验收会话，已通过或归档仍可打开', async () => {
  for (const status of ['pending', 'reviewing', 'changes_requested', 'fixing', 'recheck_pending', 'approved']) {
    for (const archived of [false, true]) {
      const f = setup(taskFixture({ review: { ...taskFixture().review, status } }), { archived });
      const buttons = nodes(render()).filter(node => node.type === 'button' &&
        typeof node.props.children === 'string' && node.props.children.startsWith('native.open:'));
      const reviewButton = buttons.at(-1);
      assert.ok(reviewButton);
      await reviewButton.props.onClick();
      assert.deepEqual(f.calls, [{ name: 'openReviewSession', threadId: 'review-thread' }]);
    }
  }
});

test('Review 打开目标只接受本轮真实验收结果，缺绑定不回退实现会话', () => {
  const task = taskFixture({ reviewBinding: undefined });
  assert.equal(executionTarget(task, 'review'), undefined);
  const f = setup(task);
  assert.equal(openThreadBlockReason(f.board.hostSnapshot, task, 'review'), 'binding');
  const created = { ...task, reviewExecution: { state: 'starting', runId: 'review-run' },
    executionRequests: [{ purpose: 'review', runId: 'review-run', result: { ...binding, threadId: 'created-review' } }] };
  assert.equal(executionTarget(created, 'review').threadId, 'created-review');
  for (const threadId of ['sess-internal', 'client-temporary']) {
    created.executionRequests[0].result.threadId = threadId;
    assert.equal(executionTarget(created, 'review'), undefined);
  }
  assert.equal(openThreadBlockReason({ ...f.board.hostSnapshot, connected: false }, taskFixture(), 'review'), 'disconnected');
  assert.equal(openThreadBlockReason({ ...f.board.hostSnapshot, capabilities: {} }, taskFixture(), 'review'), 'open');
});

test('首次 Review 提供可编辑提示词，模型和编辑全文独立传入开始请求', async () => {
  const f = setup(taskFixture({ reviewBinding: undefined,
    review: { status: 'pending', revision: 0, rounds: [] } }));
  const prompt = control('textarea', 'native.review.startPromptLabel');
  assert.ok(prompt);
  assert.ok(prompt.props.value.includes('独立验收当前 TaskLane 任务'));
  const model = nodes(render()).find(node => node.type === 'select' && node.props['aria-label'] === 'native.review.modelLabel');
  model.props.onChange({ target: { value: 'review-model' } });
  const edited = '只读检查边界条件。\n保留完整的验收结论与验证证据。';
  prompt.props.onChange({ target: { value: edited } });
  assert.equal(control('textarea', 'native.review.startPromptLabel').props.value, edited);
  control('button', 'native.review.start').props.onClick();
  await Promise.resolve();
  assert.deepEqual(f.calls, [{ name: 'startReview', model: 'review-model', text: edited }]);
  f.board.detail.task = taskFixture({ reviewBinding: undefined,
    review: { status: 'recheck_pending', revision: 1, rounds: [round] } });
  assert.equal(control('textarea', 'native.review.startPromptLabel'), undefined);
  f.board.detail.task = { ...taskFixture({ reviewBinding: undefined,
    review: { status: 'pending', revision: 0, rounds: [] } }), id: 'TASK-OTHER' };
  assert.ok(control('textarea', 'native.review.startPromptLabel').props.value.includes('独立验收当前 TaskLane 任务'));
});

test('首次验收明确分发失败后可重新提交，复用已保存聊天并锁定模型', async () => {
  const current = taskFixture({ review: { status: 'pending', revision: 0, rounds: [] },
    reviewExecution: { state: 'idle', runId: 'failed-review-run' } });
  current.executionRequests = [{ purpose: 'review', action: 'start', requestId: 'failed-review-request',
    runId: 'failed-review-run', status: 'rejected', result: current.reviewBinding, model: 'original-model' }];
  const f = setup(current);
  const button = control('button', 'native.review.start');
  assert.ok(button && !button.props.disabled);
  assert.equal(nodes(render()).find(node => node.type === 'select' && node.props['aria-label'] === 'native.review.modelLabel'), undefined);
  const prompt = control('textarea', 'native.review.startPromptLabel');
  assert.ok(prompt);
  const edited = '重新发起同一工作区验收，保留完整检查要求。';
  prompt.props.onChange({ target: { value: edited } });
  control('button', 'native.review.start').props.onClick();
  await Promise.resolve();
  assert.deepEqual(f.calls, [{ name: 'startReview', model: undefined, text: edited }]);
});

test('Review 要求修改/修改中保留已有修改入口，发送结论或编辑文本到实现会话', async () => {
  for (const status of ['changes_requested', 'fixing']) {
    const f = setup(taskFixture({ review: { ...taskFixture().review, status } }));
    const prompt = fixPrompt();
    assert.ok(prompt, '审核修改入口应提供可编辑提示词');
    assert.ok(prompt.props.value.includes(conclusion), '现有默认修改提示词应包含审核结论');
    assert.equal(ordinaryButton(), undefined);
    assert.equal(ordinaryPrompt(), undefined);
    fixButton().props.onClick();
    await Promise.resolve();
    assert.deepEqual(f.calls, [{ name: 'continueFix', text: prompt.props.value }]);
    const edited = '按审核结论执行，并额外验证断连恢复。\n' + conclusion;
    fixPrompt().props.onChange({ target: { value: edited } });
    assert.equal(fixPrompt().props.value, edited);
    fixButton().props.onClick();
    await Promise.resolve();
    assert.deepEqual(f.calls.at(-1), { name: 'continueFix', text: edited });
  }
});

test('验收受阻禁用详情继续修改并说明恢复路径，仍可打开验收聊天；结束后恢复修改', async () => {
  for (const patch of [
    { reviewExecution: { state: 'blocked', runId: 'review-run' } },
    { reviewExecution: { state: 'completed', runId: 'review-run' },
      executionRequests: [{ purpose: 'review', runId: 'review-run', status: 'blocked' }] },
  ]) {
    const f = setup(taskFixture(patch));
    const button = fixButton();
    assert.ok(button);
    assert.equal(button.props.disabled, true);
    assert.equal(button.props.title, 'native.reason.reviewBlocked');
    assert.ok(nodes(render()).some(node => node.props?.role === 'status' && node.props.children === 'native.reason.reviewBlocked'));
    assert.equal(ordinaryButton(), undefined);
    assert.deepEqual(f.calls, []);
    const reviewOpen = nodes(render()).filter(node => node.type === 'button' &&
      typeof node.props.children === 'string' && node.props.children.startsWith('native.open:')).at(-1);
    assert.ok(reviewOpen && !reviewOpen.props.disabled);
    await reviewOpen.props.onClick();
    assert.deepEqual(f.calls, [{ name: 'openReviewSession', threadId: 'review-thread' }]);

    f.board.detail.task = taskFixture({ reviewExecution: { state: 'completed', runId: 'review-run' },
      executionRequests: [{ purpose: 'review', runId: 'old-review', status: 'blocked' },
        { purpose: 'review', runId: 'review-run', status: 'completed', reports: [{ state: 'blocked' }, { state: 'completed' }] }] });
    assert.equal(fixButton().props.disabled, false);
    fixButton().props.onClick();
    await Promise.resolve();
    assert.equal(f.calls.at(-1).name, 'continueFix');
  }
});

test('Review 待复查保留已有继续验收入口并投递到验收会话', async () => {
  const f = setup(taskFixture({ review: { ...taskFixture().review, status: 'recheck_pending' } }));
  const prompt = control('textarea', 'native.review.recheckPromptLabel');
  assert.ok(prompt.props.value.includes(conclusion));
  assert.equal(ordinaryButton(), undefined);
  assert.equal(ordinaryPrompt(), undefined);
  // 复查按钮标注将开启的轮次号（已有 1 轮 → Round #2）
  assert.match(control('button', 'native.review.continue').props.children, /"number":2/);
  control('button', 'native.review.continue').props.onClick();
  await Promise.resolve();
  assert.deepEqual(f.calls, [{ name: 'continueReview', text: prompt.props.value }]);
});

test('待验收/验收中/待复查/已通过不提供绕过审核的实现续接', () => {
  for (const status of ['pending', 'reviewing', 'recheck_pending', 'approved']) {
    for (const executionBinding of [binding, undefined]) {
      setup(taskFixture({ executionBinding, review: { ...taskFixture().review, status } }));
      assert.equal(ordinaryButton(), undefined, status);
      assert.equal(ordinaryPrompt(), undefined, status);
      assert.equal(control('button', 'native.start'), undefined, 'Review 未绑定任务也不提供通用首次执行');
      assert.equal(fixButton(), undefined, status);
      if (status === 'recheck_pending') assert.ok(control('button', 'native.review.continue'));
    }
  }
});

test('普通 Doing 且具备待验收工作区时保留普通提示词和原会话续接', async () => {
  const f = setup(taskFixture({ status: 'doing' }));
  assert.equal(fixButton(), undefined);
  assert.ok(ordinaryPrompt());
  ordinaryPrompt().props.onChange({ target: { value: '完成当前任务剩余工作' } });
  assert.equal(ordinaryPrompt().props.value, '完成当前任务剩余工作');
  assert.equal(ordinaryButton().props.disabled, false);
  ordinaryButton().props.onClick();
  await Promise.resolve();
  assert.deepEqual(f.calls, [{ name: 'continueExecution', text: '完成当前任务剩余工作' }]);
});

test('无项目任务在 Doing/Review 均隐藏已有会话续接按钮和编辑器', () => {
  for (const status of ['doing', 'review']) {
    const f = setup(taskFixture({ status, executionRequests: [{ requestId: 'request-projectless', status: 'completed',
      workspaceMode: 'projectless', result: { ...binding } }] }), { projectless: true });
    assert.equal(ordinaryButton(), undefined, status);
    assert.equal(ordinaryPrompt(), undefined, status);
    assert.equal(fixButton(), undefined, status);
    assert.equal(fixPrompt(), undefined, status);
    assert.equal(control('button', 'native.start'), undefined, '已有绑定不能绕回首次执行');
    assert.deepEqual(f.calls, []);
  }
});

test('Review 缺待验收工作区或来源冲突时仍隐藏执行区通用续接', () => {
  const patches = [
    { executionBinding: { ...binding, workspacePath: undefined } },
    { externalExecutionSession: { provider: 'other', sessionId: 'external-session', workspacePath: '/another-project' } },
  ];
  for (const patch of patches) {
    const f = setup(taskFixture(patch));
    assert.equal(ordinaryButton(), undefined);
    assert.equal(ordinaryPrompt(), undefined);
    assert.equal(control('button', 'native.start'), undefined, 'Review 不能绕回通用首次执行');
    assert.deepEqual(f.calls, []);
  }
});

test('项目 Doing 已创建但未绑定的阻塞请求保留原聊天恢复入口', async () => {
  const f = setup(taskFixture({ status: 'doing', executionBinding: undefined,
    execution: { state: 'blocked', runId: 'run-blocked' }, executionRequests: [{
      requestId: 'request-blocked', runId: 'run-blocked', action: 'start', status: 'blocked',
      workspaceMode: 'project', result: { ...binding }, updatedAt: '2026-10-06T00:00:00.000Z',
    }] }));
  const button = control('button', 'native.blocked.continue');
  assert.ok(button, '恢复入口不能因尚未写入 executionBinding 而被隐藏');
  assert.equal(button.props.disabled, false);
  assert.ok(ordinaryPrompt());
  ordinaryPrompt().props.onChange({ target: { value: '核对后复用原聊天继续' } });
  control('button', 'native.blocked.continue').props.onClick();
  await Promise.resolve();
  assert.deepEqual(f.calls, [{ name: 'continueExecution', text: '核对后复用原聊天继续' }]);
});

test('未绑定任务仍可首次执行，包括无项目看板', async () => {
  for (const projectless of [false, true]) {
    const f = setup(taskFixture({ status: 'ready', execution: { state: 'idle' },
      executionBinding: undefined, reviewBinding: undefined, review: undefined }), { projectless });
    const button = control('button', 'native.start');
    assert.ok(button);
    assert.equal(button.props.disabled, false);
    assert.equal(ordinaryButton(), undefined);
    assert.equal(ordinaryPrompt(), undefined);
    assert.equal(fixButton(), undefined);
    button.props.onClick();
    await Promise.resolve();
    assert.deepEqual(f.calls, [{ name: 'start', text: projectless ? 'projectless' : 'project' }]);
  }
});

test('归档/断连/未知宿主禁用审核修改；缺实现绑定隐藏入口且不回退普通续接', () => {
  for (const config of [{ archived: true }, { conn: 'disconnected' }, { identity: 'OtherHost' }]) {
    const f = setup(taskFixture(), config);
    const button = fixButton();
    assert.ok(!button || button.props.disabled, '无法执行的审核入口必须隐藏或禁用');
    if (button) assert.ok(button.props.title?.startsWith('native.reason.'));
    assert.equal(ordinaryButton(), undefined);
    assert.equal(ordinaryPrompt(), undefined);
    assert.deepEqual(f.calls, []);
  }
  const f = setup(taskFixture({ executionBinding: undefined }));
  assert.equal(fixButton(), undefined);
  assert.equal(fixPrompt(), undefined);
  assert.equal(ordinaryButton(), undefined);
  assert.equal(ordinaryPrompt(), undefined);
  assert.equal(control('button', 'native.start'), undefined, 'Review 未绑定时不提供通用首次执行');
  assert.deepEqual(f.calls, []);
});
