import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* 独立构建 host.ts：验证 Review 工作区预解析与入口守卫（纯函数，无 DOM） */
const hostOutput = path.join(mkdtempSync(path.join(tmpdir(), 'tasklane-review-host-')), 'entry.mjs');
await build({ stdin: { contents: "export * from './src/host';", resolveDir: path.resolve('ui'), loader: 'ts' },
  outfile: hostOutput, bundle: true, format: 'esm', platform: 'node' });
globalThis.localStorage = { getItem: () => 'zh' };
globalThis.navigator ??= { language: 'zh-CN' };
globalThis.window = { name: '' };
const host = await import(pathToFileURL(hostOutput).href);

const snapshot = {
  connected: true, identity: 'codex', info: { name: 'Codex', version: 'test' },
  capabilities: { message: { text: {} }, openLinks: {} },
  scope: { mode: 'project', lockedBoardId: 'b', repoRoot: '/repo' }, contextVersion: 1,
};

test('当前验收受阻拦截所有实现动作与继续修改；历史阻塞不影响本轮完成', () => {
  const base = { id: 'TASK-1', boardId: 'b', status: 'review', execution: { state: 'completed' },
    executionBinding: { provider: 'codex-desktop', threadId: 'impl', hostId: 'h', workspacePath: '/repo', workspaceOwner: 'user' },
    reviewBinding: { provider: 'codex-desktop', threadId: 'review', hostId: 'h', workspacePath: '/repo', workspaceOwner: 'user' },
    review: { status: 'changes_requested' } };
  const board = { repo: '/repo', projectDir: '/repo', repoKey: '/repo/.git' };
  for (const patch of [
    { reviewExecution: { state: 'blocked' } },
    { reviewExecution: { state: 'completed', runId: 'current-review' }, executionRequests: [
      { purpose: 'review', runId: 'current-review', status: 'blocked' },
    ] },
  ]) {
    const task = { ...base, ...patch };
    for (const action of ['start', 'continue', 'reply', 'retry']) {
      assert.equal(host.executionBlockReason(snapshot, task, board, action, 'project'), 'reviewBlocked');
      assert.equal(host.executionBlockReason(snapshot, { ...task, status: 'doing' }, board, action, 'project'), 'reviewBlocked');
    }
    assert.equal(host.reviewBlockReason(snapshot, task, 'review-fix'), 'reviewBlocked');
    assert.equal(host.reviewBlockReason(snapshot, task, 'review-continue'), null, '受阻验收的恢复路线应保留');
    assert.equal(host.openThreadBlockReason(snapshot, task, 'review'), null, '打开验收聊天应保留');
  }
  const ended = { ...base, reviewExecution: { state: 'completed', runId: 'current-review' }, executionRequests: [
    { purpose: 'review', runId: 'old-review', status: 'blocked' },
    { purpose: 'review', runId: 'current-review', status: 'completed', reports: [{ state: 'blocked' }, { state: 'completed' }] },
  ] };
  assert.equal(host.executionBlockReason(snapshot, ended, board, 'continue', 'project'), null);
  assert.equal(host.reviewBlockReason(snapshot, ended, 'review-fix'), null);
  assert.equal(host.executionBlockReason(snapshot, { ...ended, execution: { state: 'blocked', runId: 'impl-run' },
    executionRequests: [...ended.executionRequests, { purpose: 'implementation', runId: 'impl-run', status: 'blocked',
      workspaceMode: 'project', result: base.executionBinding }] }, board, 'continue', 'project'), null,
  '实现执行自身受阻仍遵守原恢复规则');
});

test('Review 工作区预解析：唯一来源 ok，无来源/冲突分别返回对应原因', () => {
  const none = { id: 'TASK-1', boardId: 'b', status: 'review', execution: { state: 'idle' } };
  assert.deepEqual(host.resolveReviewWorkspacePreview(none), { ok: false, reason: 'reviewWorkspace' });

  const bound = { ...none, executionBinding: { workspacePath: '/repo/.worktrees/TASK-1' } };
  assert.deepEqual(host.resolveReviewWorkspacePreview(bound), { ok: true, workspacePath: '/repo/.worktrees/TASK-1' });

  const conflict = { ...bound, externalExecutionSession: { workspacePath: '/repo' } };
  assert.deepEqual(host.resolveReviewWorkspacePreview(conflict), { ok: false, reason: 'reviewConflict' });

  // board.repo 不参与来源：worktreePath 是唯一来源时可用
  const worktreeOnly = { ...none, worktreePath: '/repo/.worktrees/TASK-1' };
  assert.deepEqual(host.resolveReviewWorkspacePreview(worktreeOnly), { ok: true, workspacePath: '/repo/.worktrees/TASK-1' });
});

test('reviewBlockReason：宿主/工作区/绑定/在途守卫，fix 走实现会话口径', () => {
  const base = { id: 'TASK-1', boardId: 'b', status: 'review', execution: { state: 'completed' },
    executionBinding: { provider: 'codex-desktop', threadId: 'impl', hostId: 'h', workspacePath: '/repo', workspaceOwner: 'user', boundAt: '2026-10-05T00:00:00.000Z' } };
  assert.equal(host.reviewBlockReason(snapshot, base, 'review-start'), null);

  // 无实现工作区来源：start / continue 都被拒
  const bare = { id: 'TASK-2', boardId: 'b', status: 'review', execution: { state: 'idle' } };
  assert.equal(host.reviewBlockReason(snapshot, bare, 'review-start'), 'reviewWorkspace');

  // 首次验收已绑定 reviewBinding → 不能再 start；未绑定时不能 continue
  const reviewed = { ...base, reviewBinding: { provider: 'codex-desktop', threadId: 'review', hostId: 'h', workspacePath: '/repo', workspaceOwner: 'user', boundAt: '2026-10-05T00:00:00.000Z' } };
  assert.equal(host.reviewBlockReason(snapshot, reviewed, 'review-start'), 'reviewBinding');
  assert.equal(host.reviewBlockReason(snapshot, base, 'review-continue'), 'reviewBinding');

  // 验收请求在途：不得重复创建
  const pendingReview = { ...reviewed, reviewExecution: { state: 'starting', runId: 'run-r1' },
    executionRequests: [{ requestId: 'r1', runId: 'run-r1', purpose: 'review', status: 'pending' }] };
  assert.equal(host.reviewBlockReason(snapshot, pendingReview, 'review-continue'), 'reviewBusy');

  // 继续修改：实现执行在途、等待输入或未绑定实现会话时拒绝
  assert.equal(host.reviewBlockReason(snapshot, { ...base, execution: { state: 'running', runId: 'run-i' } }, 'review-fix'), 'busy');
  assert.equal(host.reviewBlockReason(snapshot, { ...base, execution: { state: 'waiting', runId: 'run-i' } }, 'review-fix'), 'busy');
  assert.equal(host.reviewBlockReason(snapshot, { ...bare, worktreePath: '/repo' }, 'review-fix'), 'binding');

  // 非 review 列 / 非 Codex 宿主 / 断连
  assert.equal(host.reviewBlockReason(snapshot, { ...base, status: 'doing' }, 'review-start'), 'context');
  assert.equal(host.reviewBlockReason({ ...snapshot, info: { name: 'Other', version: 'test' } }, base, 'review-start'), 'unknown');
  assert.equal(host.reviewBlockReason({ ...snapshot, connected: false }, base, 'review-start'), 'disconnected');
  // 无项目看板不参与验收流转（看板能力已知时由守卫直接拒绝）
  assert.equal(host.reviewBlockReason(snapshot, base, 'review-start', { repo: null, projectDir: null, repoKey: null }), 'reviewUnsupported');
});

test('reviewStatusOf / currentReviewRequest：review 列惰性 pending，请求按 purpose 分流', () => {
  const task = { id: 'TASK-1', boardId: 'b', status: 'review', execution: { state: 'completed', runId: 'run-i' }, reviewExecution: { state: 'running', runId: 'run-r' },
    executionRequests: [
      { requestId: 'impl', runId: 'run-i', purpose: 'implementation', status: 'completed' },
      { requestId: 'rev', runId: 'run-r', purpose: 'review', status: 'running' },
    ] };
  assert.equal(host.reviewStatusOf(task), 'pending');
  assert.equal(host.currentReviewRequest(task)?.requestId, 'rev');
  assert.equal(host.currentExecutionRequest(task)?.requestId, 'impl');
  assert.equal(host.currentReviewRequest({ ...task, reviewExecution: undefined }), undefined);
});

test('首次验收明确分发失败后放行重发，未知结果或旧轮次不开放恢复', () => {
  const binding = { provider: 'codex-desktop', threadId: 'review-thread', hostId: 'h', workspacePath: '/repo', workspaceOwner: 'user' };
  const request = { requestId: 'review-request', purpose: 'review', runId: 'review-run', status: 'rejected', result: binding };
  const base = { id: 'TASK-1', boardId: 'b', status: 'review', execution: { state: 'completed' },
    executionBinding: { ...binding, threadId: 'implementation-thread' }, reviewBinding: binding,
    review: { status: 'pending' }, reviewExecution: { state: 'idle', runId: 'review-run' }, executionRequests: [request] };
  assert.equal(host.reviewRecoverySource(base), request);
  assert.equal(host.reviewBlockReason(snapshot, base, 'review-start'), null);
  for (const patch of [{ status: 'uncertain' }, { runId: 'old-run' }, { reports: [{ state: 'blocked' }] },
    { startedAt: '2026-10-08T00:00:00.000Z' }]) {
    const task = { ...base, executionRequests: [{ ...request, ...patch }] };
    assert.equal(host.reviewRecoverySource(task), undefined);
    assert.ok(host.reviewBlockReason(snapshot, task, 'review-start'));
  }
  assert.equal(host.executionRecoverySource({ ...base, executionBinding: undefined }), undefined,
    '实现恢复不得取用验收 purpose');
});

/* ---------- 详情渲染：Review 区块按状态分流 CTA 与提示词编辑器 ---------- */
const output = path.join(mkdtempSync(path.join(tmpdir(), 'tasklane-review-detail-')), 'entry.mjs');
const mocks = {
  BoardContext: 'export function useBoard() { return globalThis.__reviewFixture.board; }',
  useTaskActions: 'export function useTaskActions() { return globalThis.__reviewFixture.actions; }',
  nativeExecution: 'export function executionStatusCheckReason() { return null; } export function creationModelRequest() { return undefined; } export function normalizeExecutionModel(value) { return value.trim() || undefined; } export function toModelOptions() { return []; }',
  i18n: 'export function useLang() { return { t: (key, params) => key + (params ? ":" + JSON.stringify(params) : "") }; }',
  messages: 'export const translate = (key, params) => key + (params ? ":" + JSON.stringify(params) : ""); export const statusKey = value => "status." + value; export const eventKey = () => null; export const execKey = value => "exec." + value;',
  HostConnection: 'export function HostConnection() { return null; }',
};
await build({
  stdin: {
    contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import { TaskDetail } from './src/components/TaskDetail'; export function renderDetail(fixture) { globalThis.__reviewFixture = fixture; return renderToStaticMarkup(createElement(TaskDetail, { onClose() {} })); }`,
    resolveDir: path.resolve('ui'), loader: 'ts',
  },
  outfile: output, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  plugins: [{
    name: 'review-fixtures',
    setup(builder) {
      builder.onResolve({ filter: /BoardContext$|useTaskActions$|state\/nativeExecution$|\/i18n$|i18n\/messages$|HostConnection$/ }, ({ path: name }) => {
        const key = name.endsWith('/i18n') ? 'i18n' : name.split('/').at(-1);
        return { path: key, namespace: 'fixture' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({ contents: mocks[name], loader: 'js', resolveDir: path.resolve('ui') }));
    },
  }],
});
const { renderDetail } = await import(pathToFileURL(output).href);

const noop = () => {};
/** Git 项目看板能力（board_list 子集）：项目看板且 Git 能力可用 */
const gitBoard = { repo: '/repo', projectDir: '/repo', repoKey: '/repo/.git' };
function reviewFixture(task, board = gitBoard) {
  return {
    board: { detail: { task, timeline: [] }, conn: 'connected',
      hostSnapshot: { connected: true, identity: 'codex', info: { name: 'Codex', version: 'test' },
        capabilities: { message: { text: {} }, openLinks: {} }, scope: { mode: 'project', lockedBoardId: task.boardId }, contextVersion: 1 },
      board,
      mutate: noop, call: noop, toast: noop },
    actions: { requests: task.executionRequests ?? [], agentName: 'Codex', status: 'bound',
      reason: () => null, reviewReason: () => null, openReason: null,
      move: noop, restore: noop, archive: noop, start: noop, continueExecution: noop,
      startReview: noop, continueReview: noop, continueFix: noop, openSession: noop },
  };
}

const implBinding = { provider: 'codex-desktop', threadId: 'impl-thread', hostId: 'h', workspacePath: '/repo/.worktrees/T1', workspaceOwner: 'codex', boundAt: '2026-10-05T00:00:00.000Z', branch: 'codex/task' };
const reviewBinding = { provider: 'codex-desktop', threadId: 'review-thread', hostId: 'h', workspacePath: '/repo/.worktrees/T1', workspaceOwner: 'codex', boundAt: '2026-10-05T00:00:00.000Z', branch: 'codex/task' };
const roundOne = { id: 'round-1', number: 1, status: 'changes_requested', workspacePath: '/repo/.worktrees/T1',
  conclusion: '补充失败路径测试', startedAt: '2026-10-05T00:00:00.000Z', completedAt: '2026-10-05T00:10:00.000Z', updates: [] };

test('详情 Review 区块：pending 且无待验收工作区时整个区块隐藏，标记完成仍受门控', () => {
  const task = { id: 'TASK-1', boardId: 'default', title: 'R', status: 'review', priority: 'P2', assignee: 'agent',
    execution: { state: 'completed' }, executionRequests: [] };
  const html = renderDetail(reviewFixture(task));
  assert.ok(!html.includes('native.review.section'));
  assert.ok(!html.includes('native.review.workspaceRequired'));
  assert.ok(!html.includes('native.review.start'));
  // 未通过验收：标记完成被禁用并带提示
  assert.ok(html.includes('native.review.markDoneBlocked'));
});

test('详情 Review 区块：无项目看板整区隐藏，标记完成直接可用', () => {
  const task = { id: 'TASK-1', boardId: 'default', title: 'R', status: 'review', priority: 'P2', assignee: 'agent',
    execution: { state: 'completed' }, executionRequests: [] };
  const html = renderDetail(reviewFixture(task, { repo: null, projectDir: null, repoKey: null }));
  assert.ok(!html.includes('native.review.section'));
  assert.ok(!html.includes('native.review.markDoneBlocked'));
  assert.match(html, /<button\b(?![^>]*disabled)[^>]*>detail\.markDone<\/button>/);
});

test('详情 Review 区块：pending + 唯一工作区显示开始 Review 与首次模型选择', () => {
  const task = { id: 'TASK-1', boardId: 'default', title: 'R', status: 'review', priority: 'P2', assignee: 'agent',
    execution: { state: 'completed' }, executionBinding: implBinding, executionRequests: [] };
  const html = renderDetail(reviewFixture(task));
  assert.ok(html.includes('native.review.start'));
  assert.ok(html.includes('native.review.modelLabel'));
  assert.ok(html.includes('/repo/.worktrees/T1'));
  assert.ok(!html.includes('native.review.workspaceRequired'));
});

test('首次验收分发失败保留验收会话时展示重新发起入口并锁定模型', () => {
  const task = { id: 'TASK-1', boardId: 'default', title: 'R', status: 'review', priority: 'P2', assignee: 'agent',
    execution: { state: 'completed' }, executionBinding: implBinding, reviewBinding,
    reviewExecution: { state: 'idle', runId: 'review-run' }, review: { status: 'pending', revision: 0, rounds: [] },
    executionRequests: [{ purpose: 'review', requestId: 'failed', runId: 'review-run', status: 'rejected', result: reviewBinding }] };
  for (const binding of [reviewBinding, undefined]) {
    const html = renderDetail(reviewFixture({ ...task, reviewBinding: binding }));
    assert.match(html, /<button\b(?![^>]*disabled)[^>]*>native\.review\.start[^<]*<\/button>/);
    assert.ok(html.includes('native.review.startPromptLabel'));
    assert.ok(html.includes('native.recovery.preserved'));
    assert.ok(html.includes('native.review.modelLocked'));
    assert.ok(!html.includes('native.review.modelLabel'));
  }
});

test('详情 Review 区块：changes_requested 显示修改提示词编辑器与轮次结论', () => {
  const task = { id: 'TASK-1', boardId: 'default', title: 'R', status: 'review', priority: 'P2', assignee: 'agent',
    execution: { state: 'completed' }, executionBinding: implBinding, reviewBinding, executionRequests: [],
    review: { status: 'changes_requested', revision: 2, rounds: [roundOne], updatedAt: '2026-10-05T00:10:00.000Z' } };
  const html = renderDetail(reviewFixture(task));
  assert.ok(html.includes('native.review.fixPromptLabel'));
  assert.ok(html.includes('native.review.fix'));
  // 默认提示词带最新轮次编号与结论；系统协议封装不在可编辑文本内
  assert.ok(html.includes('native.review.fixPromptDefault:{&quot;number&quot;:1,&quot;conclusion&quot;:&quot;补充失败路径测试&quot;}'));
  assert.ok(html.includes('补充失败路径测试'));
  assert.ok(html.includes('native.review.round:{&quot;number&quot;:1}'));
  // 验收结论默认收起到两行，并保留原生 details 的展开/折叠入口。
  assert.ok(html.includes('review-conclusion'));
  assert.ok(html.includes('review-conclusion-text'));
  assert.ok(html.includes('native.review.expand'));
  assert.ok(html.includes('native.review.collapse'));
  const styles = readFileSync(path.resolve('ui/src/styles.css'), 'utf8');
  assert.match(styles, /\.review-conclusion-text\s*\{[^}]*-webkit-line-clamp:\s*2/s);
  assert.match(styles, /\.review-conclusion\[open\]\s+\.review-conclusion-text\s*\{[^}]*display:\s*block/s);
  // 已绑定验收会话：模型锁定提示，不再出现开始入口
  assert.ok(html.includes('native.review.modelLocked'));
  assert.ok(!html.includes('native.review.start'));
});

test('详情 Review 区块：recheck_pending 显示复查提示词与继续验收；无 reviewBinding 只显示说明', () => {
  const withBinding = { id: 'TASK-1', boardId: 'default', title: 'R', status: 'review', priority: 'P2', assignee: 'agent',
    execution: { state: 'completed' }, executionBinding: implBinding, reviewBinding, executionRequests: [],
    review: { status: 'recheck_pending', revision: 3, rounds: [roundOne], updatedAt: '2026-10-05T00:20:00.000Z' } };
  const html = renderDetail(reviewFixture(withBinding));
  assert.ok(html.includes('native.review.recheckPromptLabel'));
  assert.ok(html.includes('native.review.continue'));
  assert.ok(!html.includes('native.review.fix:'));

  const withoutBinding = { ...withBinding, reviewBinding: undefined };
  const html2 = renderDetail(reviewFixture(withoutBinding));
  assert.ok(html2.includes('native.review.noSession'));
  assert.ok(!html2.includes('native.review.continue'));
});

test('详情 Review 区块：approved 才开放标记完成；fixing 无实现绑定时只显示说明', () => {
  const approved = { id: 'TASK-1', boardId: 'default', title: 'R', status: 'review', priority: 'P2', assignee: 'agent',
    execution: { state: 'completed' }, executionBinding: implBinding, reviewBinding, executionRequests: [],
    review: { status: 'approved', revision: 4, rounds: [{ ...roundOne, status: 'approved', conclusion: '通过' }], updatedAt: '2026-10-05T00:30:00.000Z' } };
  const html = renderDetail(reviewFixture(approved));
  assert.ok(html.includes('native.review.approvedNote'));
  assert.ok(!html.includes('native.review.markDoneBlocked'));

  const fixingNoImpl = { ...approved, status: 'review', executionBinding: undefined,
    review: { status: 'fixing', revision: 3, rounds: [roundOne], updatedAt: '2026-10-05T00:25:00.000Z' } };
  const html2 = renderDetail(reviewFixture(fixingNoImpl));
  assert.ok(html2.includes('native.review.fixingNote'));
  assert.ok(!html2.includes('native.review.fix:'));
});
